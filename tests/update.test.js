const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { updateDeployment } = require("../src/update");
const { startWorker } = require("../src/worker");
const { createServiceUsername } = require("../src/serviceUser");
const { createStateStore } = require("../src/stateStore");

const commit = "a".repeat(40);
const request = { requestId: "request-1", slug: "tienda", hostname: "tienda.vidkar.com", updateId: "b".repeat(32) };

const fixture = async (t, overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vidkar-update-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    stateDir: path.join(root, "state"), deployRoot: path.join(root, "sites"),
    nginxSitesAvailable: "/etc/nginx/sites-available", nginxSitesEnabled: "/etc/nginx/sites-enabled",
    portRangeStart: 5200, portRangeEnd: 5899,
    repositoryRef: "main", repositoryUrl: "git@example.test:commerce.git",
    helperHmacSecret: "test-hmac-secret", privilegedHelper: "/test-helper",
    commandTimeoutMs: 1000, npmTimeoutMs: 2000,
  };
  const stateStore = createStateStore(config.stateDir);
  const journal = {
    requestId: request.requestId, slug: request.slug, hostname: request.hostname,
    resourceVersion: 2, state: "ACTIVE", port: 5201,
    runUser: createServiceUsername(request.slug, request.requestId),
    siteDirectory: path.join(config.deployRoot, `${request.slug}--${request.requestId}`),
    pm2Name: `vidkar-comercio-tienda-${request.requestId}`,
    nginxAvailablePath: "/etc/nginx/sites-available/tienda.vidkar.com.conf",
    nginxEnabledPath: "/etc/nginx/sites-enabled/tienda.vidkar.com.conf",
    completedSteps: ["verify_site"],
    ...overrides,
  };
  await stateStore.write(request.requestId, journal);
  const calls = [];
  const runner = { runCommand: async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdoutTail: args.includes("rev-parse") ? `${commit}\n` : "", stderrTail: "" };
  } };
  return { config, stateStore, journal, calls, runner, request, fetchImpl: async () => ({ status: 200 }), logger: { error() {}, warn() {} } };
};

test("prepara dependencias antes de activar, reinicia solo la tienda y persiste el commit", async (t) => {
  const f = await fixture(t);
  const result = await updateDeployment(f);
  assert.equal(result.succeeded, true);
  assert.equal(result.commit, commit);
  assert.deepEqual(f.calls.filter((call) => call.command === "sudo").map((call) => call.args[4]),
    ["prepare-update", "activate-update", "pm2-restart", "pm2-save"]);
  for (const call of f.calls.filter((call) => call.command === "sudo")) {
    assert.deepEqual(call.args.slice(5), [request.slug, request.requestId, f.journal.runUser]);
  }
  const journal = await f.stateStore.read(request.requestId);
  assert.equal(journal.state, "ACTIVE");
  assert.equal(journal.port, 5201);
  assert.equal(journal.codeUpdate.phase, "COMPLETED");
  assert.deepEqual(journal.completedSteps, ["verify_site"]);
  assert.equal(f.calls.some((call) => call.args.includes("write-env") || call.args.includes("install-https")), false);
});

test("un error instalando dependencias no sustituye ni reinicia el sitio activo", async (t) => {
  const f = await fixture(t);
  const run = f.runner.runCommand;
  f.runner.runCommand = async (...args) => {
    const result = await run(...args);
    if (args[1].includes("prepare-update")) throw new Error("npm fixture failed");
    return result;
  };
  const result = await updateDeployment(f);
  assert.equal(result.succeeded, false);
  assert.match(result.message, /No se sustituyó/);
  assert.equal(f.calls.some((call) => call.args.includes("activate-update") || call.args.includes("pm2-restart")), false);
  assert.equal((await f.stateStore.read(request.requestId)).codeUpdate.phase, "FAILED");
});

test("un fallo de reinicio restaura la copia anterior sin rollback destructivo", async (t) => {
  const f = await fixture(t);
  const run = f.runner.runCommand;
  let restarts = 0;
  f.runner.runCommand = async (...args) => {
    const result = await run(...args);
    if (args[1].includes("pm2-restart") && ++restarts === 1) throw new Error("new version failed");
    return result;
  };
  const result = await updateDeployment(f);
  assert.equal(result.succeeded, false);
  assert.match(result.message, /Se restauró la versión anterior/);
  assert.equal(f.calls.filter((call) => call.args.includes("restore-update")).length, 1);
  assert.equal(restarts, 2);
  assert.equal(f.calls.some((call) => call.args.includes("remove-site")), false);
});

test("reporta explícitamente una restauración fallida y permite recuperarla en el siguiente intento", async (t) => {
  const f = await fixture(t);
  const run = f.runner.runCommand;
  f.runner.runCommand = async (...args) => {
    const result = await run(...args);
    if (args[1].includes("pm2-restart")) throw new Error("PM2 unavailable");
    return result;
  };
  const failed = await updateDeployment(f);
  assert.equal(failed.succeeded, false);
  assert.equal((await f.stateStore.read(request.requestId)).codeUpdate.phase, "RESTORE_FAILED");
  f.runner.runCommand = run;
  const recovered = await updateDeployment({ ...f, request: { ...request, updateId: "c".repeat(32) } });
  assert.equal(recovered.succeeded, false);
  assert.match(recovered.message, /recuperó la versión anterior/);
  assert.equal((await f.stateStore.read(request.requestId)).codeUpdate.phase, "FAILED");
});

test("reconcilia una activación interrumpida y un finish perdido sin volver a desplegar", async (t) => {
  const f = await fixture(t, { codeUpdate: { id: request.updateId, phase: "VERIFYING", commit } });
  const recovery = await updateDeployment(f);
  assert.equal(recovery.succeeded, false);
  assert.deepEqual(f.calls.filter((call) => call.command === "sudo").map((call) => call.args[4]),
    ["restore-update", "pm2-restart", "pm2-save"]);
  f.calls.length = 0;
  await f.stateStore.write(request.requestId, { ...f.journal, codeUpdate: { id: request.updateId, phase: "COMPLETED", commit, message: "Actualizado" } });
  assert.equal((await updateDeployment(f)).succeeded, true);
  assert.equal(f.calls.length, 0);
});

test("rechaza journals ajenos o inactivos antes de ejecutar comandos", async (t) => {
  for (const overrides of [{ slug: "otra" }, { siteDirectory: "/other" }, { state: "CLOSED" }]) {
    const f = await fixture(t, overrides);
    await assert.rejects(updateDeployment(f), /journal|tienda|rutas/i);
    assert.equal(f.calls.length, 0);
  }
});

test("al perder el lease no activa ni restaura recursos bajo un propietario vencido", async (t) => {
  const f = await fixture(t);
  const run = f.runner.runCommand;
  let lost = false;
  f.runner.runCommand = async (...args) => {
    const result = await run(...args);
    if (args[1].includes("prepare-update")) lost = true;
    return result;
  };
  await assert.rejects(updateDeployment({ ...f, assertLease() {
    if (lost) throw new Error("lease perdido");
  } }), /lease perdido/);
  assert.equal(f.calls.some((call) => call.args.includes("activate-update") || call.args.includes("restore-update")), false);
});

test("el helper activa y restaura archivos reales sin modificar el entorno ni otra tienda", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vidkar-update-helper-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const site = path.join(root, "tienda");
  await fs.mkdir(site);
  await fs.mkdir(`${site}.update`);
  await fs.mkdir(path.join(root, "otra"));
  await fs.writeFile(path.join(site, "index.html"), "old");
  await fs.writeFile(path.join(site, ".env"), "PORT='5201'\n");
  await fs.writeFile(`${site}.update/index.html`, "new");
  await fs.writeFile(`${site}.update/.env`, "PORT='5201'\n");
  await fs.writeFile(path.join(root, "otra", "index.html"), "untouched");
  const source = await fs.readFile(path.join(__dirname, "../scripts/vidkar-commerce-helper"), "utf8");
  const body = source.match(/update_site\(\) \{([\s\S]*?)\n\}/)[1];
  const script = [
    "set -eu", 'fail() { echo "$1" >&2; exit 1; }',
    "valid_slug() { :; }", "valid_request_id() { :; }", "validate_deploy_root() { :; }",
    "validate_service_user() { :; }", "require_request() { :; }",
    'site_directory_for() { printf "%s\\n" "$SITE"; }',
    'validate_update_directory() { [ -d "$1" ] && [ ! -L "$1" ] || fail "unsafe"; }',
    'remove_update_directory() { [ ! -e "$1" ] || { validate_update_directory "$1"; rm -r -- "$1"; }; }',
    'mv() { python3 -c \'import os,sys; os.rename(sys.argv[1],sys.argv[2])\' "$3" "$4"; }',
    `update_site() {${body}\n}`,
    'update_site "$OPERATION" tienda request-1 service-user',
  ].join("\n");
  const run = (operation) => {
    const result = spawnSync("sh", ["-s"], { input: script, encoding: "utf8", env: { ...process.env, SITE: site, OPERATION: operation } });
    assert.equal(result.status, 0, result.stderr);
  };
  run("activate");
  assert.equal(await fs.readFile(path.join(site, "index.html"), "utf8"), "new");
  assert.equal(await fs.readFile(`${site}.previous/index.html`, "utf8"), "old");
  assert.equal(await fs.readFile(path.join(site, ".env"), "utf8"), "PORT='5201'\n");
  run("restore");
  assert.equal(await fs.readFile(path.join(site, "index.html"), "utf8"), "old");
  assert.equal(await fs.readFile(path.join(root, "otra", "index.html"), "utf8"), "untouched");
});

test("el worker nunca enruta una actualización al despliegue o al cierre y reintenta un finish incierto", async () => {
  const calls = [];
  let worker;
  let claimed = false;
  let finishAttempts = 0;
  worker = startWorker({
    client: {
      connect: async () => {}, disconnect: async () => {},
      call: async (method, ...args) => {
        calls.push([method, ...args]);
        if (method.endsWith(".claimNext")) {
          if (!claimed) { claimed = true; return { ...request, operation: "update", leaseToken: "lease" }; }
          worker.stop();
          return null;
        }
        if (method.endsWith(".finishCodeUpdate") && ++finishAttempts === 1) throw new Error("DDP timeout");
        return { success: true, status: "COMPLETADA" };
      },
    },
    config: { token: "worker-token", workerId: "worker-a", publicIpv4: "192.0.2.1", heartbeatIntervalMs: 60000, pollIntervalMs: 1 },
    logger: { error() {}, info() {}, warn() {} }, runner: {}, stateStore: {},
    taskLock: { acquire: async () => ({ release: async () => {} }) },
    update: async () => ({ succeeded: true, message: "Updated", commit }),
    deploy: () => assert.fail("must not deploy"),
    close: () => assert.fail("must not close"),
    rollback: () => assert.fail("must not rollback"),
  });
  await worker.done;
  assert.equal(finishAttempts, 2);
  const finish = calls.find(([method]) => method.endsWith(".finishCodeUpdate"));
  assert.equal(finish[4], "lease");
  assert.equal(finish[5], request.updateId);
});

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadConfig } = require("../src/config");
const { createSafeEnvironment } = require("../src/commandRunner");
const {
  assertNoTrackedEnvironmentFile,
  deployRequest,
  serializeCommerceEnv,
} = require("../src/deployment");
const { dnsPointsToVps, resolveA } = require("../src/dns");
const { renderHttpNginxConfig, renderHttpsNginxConfig } = require("../src/nginxConfig");
const { signOperation } = require("../src/privilegedHelper");
const { rollbackDeployment } = require("../src/rollback");
const { createStateStore, isSafeRequestId } = require("../src/stateStore");

const validEnvironment = (root) => ({
  COMERCIO_REPOSITORY_REF: "main",
  COMERCIO_REPOSITORY_URL: "git@github.com:vidkar/comercio-web.git",
  COMERCIO_VITE_GOOGLE_MAPS_API_KEY: "public-map-key",
  COMERCIO_VITE_METEOR_DDP_URL: "wss://www.vidkar.com/websocket",
  COMERCIO_VITE_METEOR_HTTP_URL: "https://www.vidkar.com",
  METEOR_DDP_ENDPOINT: "wss://www.vidkar.com/websocket",
  PROVISIONER_ACME_WEBROOT: "/var/www/letsencrypt",
  PROVISIONER_CERTBOT_EMAIL: "ops@example.test",
  PROVISIONER_COMMAND_TIMEOUT_MS: "90000",
  PROVISIONER_DEPLOY_ROOT: "/opt/vidkar/comercios",
  PROVISIONER_HEARTBEAT_INTERVAL_MS: "30000",
  PROVISIONER_NGINX_SITES_AVAILABLE: "/etc/nginx/sites-available",
  PROVISIONER_NGINX_SITES_ENABLED: "/etc/nginx/sites-enabled",
  PROVISIONER_NPM_TIMEOUT_MS: "90000",
  PROVISIONER_POLL_INTERVAL_MS: "5000",
  PROVISIONER_PORT_END: "5899",
  PROVISIONER_PORT_START: "5200",
  PROVISIONER_PUBLIC_IPV4: "192.0.2.20",
  PROVISIONER_PRIVILEGED_HELPER: "/usr/local/sbin/vidkar-commerce-helper",
  PROVISIONER_HELPER_HMAC_SECRET: "helper-secret-" + "h".repeat(48),
  PROVISIONER_STATE_DIR: "/var/lib/vidkar-provisioner/state",
  PROVISIONER_TOKEN: "worker-token-" + "x".repeat(48),
  PROVISIONER_ID: "worker-fixture",
});

test("la configuración central valida WSS, token, IPv4, repo y rutas absolutas", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vidkar-provisioner-config-"));
  try {
    const config = loadConfig(validEnvironment(root));
    assert.equal(config.publicIpv4, "192.0.2.20");
    assert.equal(config.repositoryRef, "main");
    assert.throws(() => loadConfig({ ...validEnvironment(root), METEOR_DDP_ENDPOINT: "ws://vidkar.invalid/websocket" }), /WSS/);
    assert.throws(() => loadConfig({ ...validEnvironment(root), PROVISIONER_PUBLIC_IPV4: "not-an-ip" }), /IPv4/);
    assert.throws(() => loadConfig({ ...validEnvironment(root), PROVISIONER_TOKEN: "short" }), /32 caracteres/);
    assert.throws(() => loadConfig({ ...validEnvironment(root), COMERCIO_REPOSITORY_URL: "https://user:password@example.test/repo.git" }), /credenciales/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("los procesos hijos reciben una allowlist que excluye tokens y credenciales", () => {
  const safe = createSafeEnvironment({
    HOME: "/home/worker",
    PATH: "/usr/bin",
    PROVISIONER_TOKEN: "ddp-secret-fixture",
    AWS_SECRET_ACCESS_KEY: "cloud-secret-fixture",
    MONGO_URL: "mongodb://secret-fixture",
  });
  assert.deepEqual(safe, { HOME: "/home/worker", PATH: "/usr/bin" });
});

test("firma cada operación privilegiada vinculando acción y argumentos", () => {
  const secret = "helper-secret-" + "h".repeat(48);
  const signature = signOperation(secret, "remove-site", ["mercado-norte", "request-123"]);
  assert.match(signature, /^[a-f0-9]{64}$/);
  assert.notEqual(signature, signOperation(secret, "remove-site", ["otro", "request-123"]));
  assert.notEqual(signature, signOperation(secret, "install-http", ["mercado-norte", "request-123"]));
});

test("genera un .env de comercio con valores VITE escapados y sin credenciales de worker", () => {
  const output = serializeCommerceEnv({
    config: {
      commerceDdpUrl: "wss://www.vidkar.com/websocket",
      commerceGoogleMapsApiKey: "maps-public-key",
      commerceHttpUrl: "https://www.vidkar.com",
    },
    displayName: 'Mercado "Norte"',
    ownerId: "owner-123",
    pm2Name: "vidkar-comercio-mercado-norte",
    port: 5210,
  });

  assert.match(output, /VITE_COMERCIO_EMPRESA_ID="owner-123"/);
  assert.match(output, /VITE_COMERCIO_NOMBRE="Mercado \\"Norte\\""/);
  assert.match(output, /VITE_METEOR_DDP_URL="wss:\/\/www\.vidkar\.com\/websocket"/);
  assert.match(output, /PM2_APP_NAME="vidkar-comercio-mercado-norte"/);
  assert.doesNotMatch(output, /PROVISIONER_TOKEN|MONGO_URL|CERTBOT_EMAIL/);
});

test("el worker se detiene antes de clonar si la resolución DNS no coincide", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vidkar-provisioner-dns-gate-"));
  const stateStore = createStateStore(path.join(root, "state"));
  const config = {
    ...loadConfig(validEnvironment(root)),
    stateDir: path.join(root, "state"),
    deployRoot: path.join(root, "sites"),
    commandTimeoutMs: 5000,
    portRangeEnd: 5899,
    portRangeStart: 5200,
  };
  const calls = [];
  const commands = [];
  const client = { call: async (...args) => { calls.push(args); return { success: true }; } };
  const runner = {
    runCommand: async (...args) => { commands.push(args); throw new Error("El DNS gate no debía invocar comandos"); },
    runSudoCommand: async (...args) => { commands.push(args); throw new Error("El DNS gate no debía invocar comandos privilegiados"); },
  };

  try {
    const result = await deployRequest({
      client,
      config,
      logger: { error() {}, info() {}, warn() {} },
      portProbe: async () => true,
      request: {
        displayName: "Mercado Norte",
        hostname: "mercado-norte.vidkar.com",
        ownerId: "owner-123",
        requestId: "request-123",
        slug: "mercado-norte",
      },
      resolveAImpl: async () => ["198.51.100.99"],
      runner,
      stateStore,
    });

    assert.deepEqual(result, { blockedDns: true });
    assert.equal(commands.length, 0, "no debe ejecutar Git, npm, PM2, Nginx ni Certbot");
    assert.ok(calls.some(([method]) => method === "comercio.provisioning.worker.dnsBlocked"));
    assert.equal(await fs.stat(path.join(root, "sites", "mercado-norte")).then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("rechaza deploy si la copia Git conserva un .env versionado", async () => {
  let gitArgs;
  await assert.rejects(
    () => assertNoTrackedEnvironmentFile({
      config: { commandTimeoutMs: 5000 },
      runner: { runCommand: async (_command, args) => {
        gitArgs = args;
        return { stdoutTail: ".env\0apps/comercio/.env.production\0" };
      } },
      siteDirectory: "/tmp/site",
    }),
    /\.env versionados/,
  );
  assert.deepEqual(gitArgs, ["-C", "/tmp/site", "ls-tree", "-r", "-z", "--name-only", "HEAD"]);
  await assert.doesNotReject(() => assertNoTrackedEnvironmentFile({
    config: { commandTimeoutMs: 5000 },
    runner: { runCommand: async () => ({ stdoutTail: ".env.example\0apps/comercio/.env.sample\0README.md\0" }) },
    siteDirectory: "/tmp/site",
  }));
});

test("emite Nginx para host válido y rechaza hostname/payload de inyección", () => {
  const input = {
    acmeWebroot: "/var/www/letsencrypt",
    hostname: "mercado-norte.vidkar.com",
    port: 5210,
    requestId: "request-123",
  };
  const httpConfig = renderHttpNginxConfig(input);
  const httpsConfig = renderHttpsNginxConfig(input);
  assert.match(httpConfig, /server_name mercado-norte\.vidkar\.com/);
  assert.match(httpConfig, /127\.0\.0\.1:5210/);
  assert.match(httpsConfig, /ssl_certificate_key/);
  assert.throws(() => renderHttpNginxConfig({ ...input, hostname: "evil.example" }), /Hostname/);
  assert.throws(() => renderHttpNginxConfig({ ...input, acmeWebroot: "/tmp; include /etc/passwd" }), /Ruta ACME/);
});

test("consulta DNS solo para subdominios de VIDKAR y admite verificación exacta del VPS", async () => {
  assert.deepEqual(await resolveA("shop.vidkar.com", async () => ["192.0.2.20"]), ["192.0.2.20"]);
  await assert.rejects(() => resolveA("evil.example", async () => ["192.0.2.20"]), /dominio permitido/);
  assert.equal(dnsPointsToVps(["192.0.2.20"], "192.0.2.20"), true);
  assert.equal(dnsPointsToVps(["192.0.2.20", "198.51.100.1"], "192.0.2.20"), false);
});

test("el helper root rechaza operaciones y argumentos desconocidos antes de tocar el sistema", () => {
  const helperPath = path.resolve(__dirname, "../scripts/vidkar-commerce-helper");
  const unsupported = spawnSync("sh", [helperPath, "--signature", "0".repeat(64), "shell", "id"], { encoding: "utf8" });
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /Privileged helper key is not installed/);
});

test("el rollback reporta cada etapa terminada sin ejecutar operaciones privilegiadas inexistentes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vidkar-provisioner-rollback-"));
  const reports = [];
  const journal = {
    hostname: "mercado-norte.vidkar.com",
    nginxChanged: false,
    pm2StartAttempted: false,
    requestId: "request-rollback",
    siteDirectory: path.join(root, "sites", "mercado-norte"),
    siteDirectoryCreated: false,
    slug: "mercado-norte",
  };
  const config = {
    commandTimeoutMs: 5000,
    deployRoot: path.join(root, "sites"),
    stateDir: path.join(root, "state"),
  };
  try {
    const result = await rollbackDeployment({
      config,
      journal,
      logger: { warn() {} },
      onRollbackStep: async (...report) => reports.push(report),
      runner: {
        runCommand: async () => { throw new Error("No debe haber procesos PM2 que detener"); },
        runSudoCommand: async () => { throw new Error("No debe invocarse sudo para un sitio no creado"); },
      },
      stateStore: { write: async () => {} },
    });

    assert.equal(result.rollbackSucceeded, true);
    assert.deepEqual(reports.map(([stepId, outcome]) => `${stepId}:${outcome}`), [
      "stop_pm2:STARTED", "stop_pm2:COMPLETED",
      "remove_nginx:STARTED", "remove_nginx:COMPLETED",
      "remove_site:STARTED", "remove_site:COMPLETED",
    ]);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("una recuperación de journal ya revertido vuelve a publicar los pasos como completados", async () => {
  const reports = [];
  const result = await rollbackDeployment({
    assertLease() {},
    config: {},
    journal: { requestId: "request-already-rolled-back", state: "ROLLED_BACK" },
    logger: { warn() {} },
    onRollbackStep: async (...entry) => reports.push(entry),
    runner: {},
    stateStore: { write: async () => {} },
  });

  assert.equal(result.rollbackSucceeded, true);
  assert.deepEqual(reports.map(([stepId, outcome]) => `${stepId}:${outcome}`), [
    "stop_pm2:STARTED", "stop_pm2:COMPLETED",
    "remove_nginx:STARTED", "remove_nginx:COMPLETED",
    "remove_site:STARTED", "remove_site:COMPLETED",
  ]);
});

test("el journal valida identificadores y conserva estado sin divulgar configuración", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vidkar-provisioner-state-"));
  const stateStore = createStateStore(root);
  const journal = { requestId: "request-123", secret: undefined, state: "STARTING" };
  try {
    assert.equal(isSafeRequestId("request-123"), true);
    assert.equal(isSafeRequestId("../escape"), false);
    await stateStore.write(journal.requestId, journal);
    assert.equal((await stateStore.read(journal.requestId)).state, "STARTING");
    assert.equal((await stateStore.list()).length, 1);
    await stateStore.remove(journal.requestId);
    assert.equal(await stateStore.read(journal.requestId), null);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

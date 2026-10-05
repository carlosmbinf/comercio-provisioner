const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const dotenv = require("dotenv");

const { loadConfig } = require("../src/config");
const { createSafeEnvironment } = require("../src/commandRunner");
const {
  assertNoTrackedEnvironmentFile,
  certificateNameForRequest,
  deployRequest,
  findAvailablePort,
  serializeCommerceEnv,
} = require("../src/deployment");
const { closeDeployment, isRetryableCloseFailure } = require("../src/closure");
const { dnsPointsToVps, resolveA } = require("../src/dns");
const { renderHttpNginxConfig, renderHttpsNginxConfig } = require("../src/nginxConfig");
const { createPrivilegedHelperRunner, signOperation } = require("../src/privilegedHelper");
const { rollbackDeployment } = require("../src/rollback");
const { createLegacyServiceUsername, createServiceUsername } = require("../src/serviceUser");
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

test("el helper privilegiado acepta acciones PM2 con dígitos y sigue rechazando argumentos inseguros", async () => {
  const calls = [];
  const helper = createPrivilegedHelperRunner({
    config: {
      helperHmacSecret: "helper-secret-" + "h".repeat(48),
      privilegedHelper: "/usr/local/sbin/vidkar-commerce-helper",
    },
    runner: { runCommand: async (...args) => { calls.push(args); return { code: 0 }; } },
  });

  await helper.run("pm2-delete", ["tienda", "request-123", "vcommerce-123456789abc"]);
  await helper.run("remove-certificate", [
    "tienda", "request-123", "/etc/nginx/sites-available", "/etc/nginx/sites-enabled",
    "vcommerce-123456789abc", "1",
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "sudo");
  assert.ok(calls[0][1].includes("pm2-delete"));
  assert.throws(() => helper.run("pm2 delete", ["tienda"]), /Operación privilegiada no válida/);
  assert.throws(() => helper.run("remove-site", ["tienda\nroot"]), /Operación privilegiada no válida/);
});

test("genera un .env dotenv-compatible con valores escapados y sin credenciales de worker", () => {
  const output = serializeCommerceEnv({
    config: {
      commerceDdpUrl: "wss://www.vidkar.com/websocket",
      commerceGoogleMapsApiKey: "maps-public-key",
      commerceHttpUrl: "https://www.vidkar.com",
    },
    commerceHostname: "mercado-norte.vidkar.com",
    displayName: 'Mercado "Norte" \\n',
    ownerId: "owner-123",
    pm2Name: "vidkar-comercio-mercado-norte",
    port: 5210,
  });

  assert.match(output, /VITE_COMERCIO_EMPRESA_ID='owner-123'/);
  assert.match(output, /COMERCIO_HOST='mercado-norte\.vidkar\.com'/);
  assert.match(output, /PORT='5210'/);
  assert.match(output, /VITE_COMERCIO_NOMBRE='Mercado "Norte" \\n'/);
  assert.match(output, /VITE_METEOR_DDP_URL='wss:\/\/www\.vidkar\.com\/websocket'/);
  assert.match(output, /PM2_APP_NAME='vidkar-comercio-mercado-norte'/);
  assert.equal(dotenv.parse(output).VITE_COMERCIO_NOMBRE, 'Mercado "Norte" \\n');
  assert.doesNotMatch(output, /PROVISIONER_TOKEN|MONGO_URL|CERTBOT_EMAIL/);
});

test("asigna puertos libres excluyendo tiendas activas y en curso", async () => {
  const probed = [];
  const port = await findAvailablePort({
    config: { portRangeStart: 5200, portRangeEnd: 5203 },
    portProbe: async (candidate) => { probed.push(candidate); return true; },
    stateStore: { list: async () => [
      { port: 5200, state: "STARTING" },
      { port: 5201, state: "ACTIVE" },
      { port: 5202, state: "ROLLED_BACK" },
    ] },
  });

  assert.equal(port, 5202);
  assert.deepEqual(probed, [5202]);
});

test("reserva puertos antes de liberar el allocator para solicitudes concurrentes", async () => {
  const journals = [];
  const allocate = () => findAvailablePort({
    config: { portRangeStart: 5200, portRangeEnd: 5202 },
    portProbe: async () => true,
    stateStore: { list: async () => journals },
    onReserve: async (port) => { journals.push({ port, state: "STARTING" }); },
  });

  assert.deepEqual(await Promise.all([allocate(), allocate()]), [5200, 5201]);
  assert.deepEqual(journals.map(({ port }) => port), [5200, 5201]);
});

test("libera puertos de tiendas cerradas y mantiene reservados los cierres incompletos", async () => {
  const probed = [];
  const port = await findAvailablePort({
    config: { portRangeStart: 5200, portRangeEnd: 5202 },
    portProbe: async (candidate) => { probed.push(candidate); return true; },
    stateStore: { list: async () => [
      { port: 5200, state: "CLOSED" },
      { port: 5201, state: "CLOSE_FAILED" },
    ] },
  });

  assert.equal(port, 5200);
  assert.deepEqual(probed, [5200]);
});

test("el cierre elimina solo recursos ligados al journal y conserva certificados compartidos", async () => {
  const calls = [];
  const reports = [];
  const journalWrites = [];
  const config = {
    acmeWebroot: "/var/www/letsencrypt",
    commandTimeoutMs: 5000,
    deployRoot: "/opt/vidkar/comercios",
    helperHmacSecret: "helper-secret-" + "h".repeat(48),
    nginxSitesAvailable: "/etc/nginx/sites-available",
    nginxSitesEnabled: "/etc/nginx/sites-enabled",
    portRangeEnd: 5899,
    portRangeStart: 5200,
    privilegedHelper: "/usr/local/sbin/vidkar-commerce-helper",
  };
  const request = {
    hostname: "mercado-norte.vidkar.com",
    operation: "close",
    requestId: "request-close-123",
    slug: "mercado-norte",
  };
  const journal = {
    certificateName: certificateNameForRequest(request.slug, request.requestId),
    hostname: request.hostname,
    nginxAvailablePath: `/etc/nginx/sites-available/${request.hostname}.conf`,
    nginxEnabledPath: `/etc/nginx/sites-enabled/${request.hostname}.conf`,
    pm2Name: `vidkar-comercio-${request.slug}-${request.requestId.slice(0, 12)}`,
    port: 5210,
    requestId: request.requestId,
    runUser: createLegacyServiceUsername(request.slug),
    siteDirectory: `/opt/vidkar/comercios/${request.slug}`,
    siteDirectoryCreated: true,
    slug: request.slug,
    state: "ACTIVE",
  };

  const result = await closeDeployment({
    config,
    journal,
    logger: { error() {}, info() {}, warn() {} },
    onCloseStep: async (...report) => reports.push(report),
    portProbe: async () => true,
    request,
    runner: {
      runCommand: async (_command, args) => {
        calls.push(args);
        return { code: 0, stdoutTail: args[4] === "remove-certificate" ? "CERTIFICATE_PRESERVED_IN_USE\n" : "" };
      },
    },
    stateStore: { write: async (_requestId, value) => journalWrites.push(value) },
  });

  assert.equal(result.closeSucceeded, true);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(calls.map((args) => args[4]), ["pm2-delete", "remove-nginx", "remove-certificate", "remove-site"]);
  assert.ok(calls.every((args) => args[5] === request.slug && args[6] === request.requestId));
  assert.equal(calls.find((args) => args[4] === "remove-certificate").at(-1), "2");
  assert.deepEqual(reports.filter(([, outcome]) => outcome === "COMPLETED").map(([stepId]) => stepId), [
    "stop_pm2", "remove_nginx", "remove_certificate", "remove_site",
  ]);
  assert.equal(journalWrites.at(-1).state, "CLOSED");
  assert.equal(journalWrites.at(-1).closeWarnings.length, 1);
});

test("el reintento de cierre omite pasos completados y repite solo certificado y sitio", async () => {
  const calls = [];
  const reports = [];
  const request = {
    closeSteps: [
      { id: "stop_pm2", status: "COMPLETADO" },
      { id: "remove_nginx", status: "COMPLETADO" },
      { id: "remove_certificate", status: "FALLIDO" },
      { id: "remove_site", status: "FALLIDO" },
    ],
    hostname: "mercado-norte.vidkar.com",
    requestId: "request-close-retry",
    slug: "mercado-norte",
  };
  const result = await closeDeployment({
    closeSteps: request.closeSteps,
    config: {
      acmeWebroot: "/var/www/letsencrypt",
      commandTimeoutMs: 5000,
      deployRoot: "/opt/vidkar/comercios",
      helperHmacSecret: "helper-secret-" + "h".repeat(48),
      nginxSitesAvailable: "/etc/nginx/sites-available",
      nginxSitesEnabled: "/etc/nginx/sites-enabled",
      portRangeEnd: 5899,
      portRangeStart: 5200,
      privilegedHelper: "/usr/local/sbin/vidkar-commerce-helper",
    },
    journal: {
      certificateName: certificateNameForRequest(request.slug, request.requestId),
      hostname: request.hostname,
      nginxAvailablePath: `/etc/nginx/sites-available/${request.hostname}.conf`,
      nginxEnabledPath: `/etc/nginx/sites-enabled/${request.hostname}.conf`,
      pm2Name: `vidkar-comercio-${request.slug}-${request.requestId.slice(0, 12)}`,
      port: 5210,
      requestId: request.requestId,
      runUser: createLegacyServiceUsername(request.slug),
      siteDirectory: `/opt/vidkar/comercios/${request.slug}`,
      siteDirectoryCreated: true,
      slug: request.slug,
      state: "CLOSE_FAILED",
    },
    logger: { error() {}, info() {}, warn() {} },
    onCloseStep: async (...report) => reports.push(report),
    portProbe: async () => { assert.fail("no debe repetir PM2 ya completado"); },
    request,
    runner: {
      runCommand: async (_command, args) => {
        calls.push(args);
        return { stdoutTail: "" };
      },
    },
    stateStore: { write: async () => {} },
  });

  assert.equal(result.closeSucceeded, true);
  assert.deepEqual(calls.map((args) => args[4]), ["remove-certificate", "remove-site"]);
  assert.deepEqual(reports.filter(([, outcome]) => outcome === "STARTED").map(([stepId]) => stepId), [
    "remove_certificate", "remove_site",
  ]);
});

test("un cierre reanudado conserva la advertencia de un certificado ya preservado", async () => {
  const calls = [];
  const request = {
    closeSteps: [
      { id: "stop_pm2", status: "COMPLETADO" },
      { id: "remove_nginx", status: "COMPLETADO" },
      { id: "remove_certificate", status: "COMPLETADO", message: "Certbot conservó un certificado compartido." },
      { id: "remove_site", status: "FALLIDO" },
    ],
    hostname: "mercado-norte.vidkar.com",
    requestId: "request-close-preserved-cert",
    slug: "mercado-norte",
  };
  const result = await closeDeployment({
    closeSteps: request.closeSteps,
    config: {
      commandTimeoutMs: 5000,
      deployRoot: "/opt/vidkar/comercios",
      helperHmacSecret: "helper-secret-" + "h".repeat(48),
      nginxSitesAvailable: "/etc/nginx/sites-available",
      nginxSitesEnabled: "/etc/nginx/sites-enabled",
      portRangeEnd: 5899,
      portRangeStart: 5200,
      privilegedHelper: "/usr/local/sbin/vidkar-commerce-helper",
    },
    journal: {
      certificateName: certificateNameForRequest(request.slug, request.requestId),
      hostname: request.hostname,
      nginxAvailablePath: `/etc/nginx/sites-available/${request.hostname}.conf`,
      nginxEnabledPath: `/etc/nginx/sites-enabled/${request.hostname}.conf`,
      pm2Name: `vidkar-comercio-${request.slug}-${request.requestId.slice(0, 12)}`,
      port: 5213,
      requestId: request.requestId,
      runUser: createLegacyServiceUsername(request.slug),
      siteDirectory: `/opt/vidkar/comercios/${request.slug}`,
      siteDirectoryCreated: true,
      slug: request.slug,
      state: "CLOSE_FAILED",
    },
    logger: { error() {}, info() {}, warn() {} },
    onCloseStep: async () => {},
    request,
    runner: { runCommand: async (_command, args) => { calls.push(args); return {}; } },
    stateStore: { write: async () => {} },
  });

  assert.equal(result.closeSucceeded, true);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(calls.map((args) => args[4]), ["remove-site"]);
});

test("el cierre bloquea Nginx, certificado y archivos si PM2 no libera el puerto", async () => {
  const calls = [];
  const reports = [];
  const request = {
    hostname: "tienda-norte.vidkar.com",
    requestId: "request-close-safe",
    slug: "tienda-norte",
  };
  const result = await closeDeployment({
    config: {
      acmeWebroot: "/var/www/letsencrypt",
      commandTimeoutMs: 5000,
      deployRoot: "/opt/vidkar/comercios",
      helperHmacSecret: "helper-secret-" + "h".repeat(48),
      nginxSitesAvailable: "/etc/nginx/sites-available",
      nginxSitesEnabled: "/etc/nginx/sites-enabled",
      portRangeEnd: 5899,
      portRangeStart: 5200,
      privilegedHelper: "/usr/local/sbin/vidkar-commerce-helper",
    },
    journal: {
      hostname: request.hostname,
      nginxAvailablePath: `/etc/nginx/sites-available/${request.hostname}.conf`,
      nginxEnabledPath: `/etc/nginx/sites-enabled/${request.hostname}.conf`,
      pm2Name: `vidkar-comercio-${request.slug}-${request.requestId.slice(0, 12)}`,
      port: 5211,
      requestId: request.requestId,
      runUser: createLegacyServiceUsername(request.slug),
      siteDirectory: `/opt/vidkar/comercios/${request.slug}`,
      slug: request.slug,
      state: "ACTIVE",
    },
    logger: { error() {}, info() {}, warn() {} },
    onCloseStep: async (...report) => reports.push(report),
    portProbe: async () => false,
    request,
    runner: { runCommand: async (_command, args) => { calls.push(args); return { code: 0 }; } },
    stateStore: { write: async () => {} },
  });

  assert.equal(result.closeSucceeded, false);
  assert.equal(result.retryable, true);
  assert.deepEqual(calls.map((args) => args[4]), ["pm2-delete"]);
  assert.deepEqual(reports.filter(([, outcome]) => outcome === "FAILED").map(([stepId]) => stepId), [
    "stop_pm2", "remove_nginx", "remove_certificate", "remove_site",
  ]);
});

test("solo reintenta automáticamente fallos operativos identificados", () => {
  assert.equal(isRetryableCloseFailure(Object.assign(new Error("operational"), {
    commandFailure: { command: "sudo", exitCode: 75, stderr: "AUTO_RETRY: transient failure" },
  })), true);
  assert.equal(isRetryableCloseFailure(Object.assign(new Error("user busy"), {
    commandFailure: { command: "sudo", exitCode: 8, stderr: "userdel: user vcommerce-test is currently used by process 123" },
  })), true);
  assert.equal(isRetryableCloseFailure(Object.assign(new Error("ownership mismatch"), {
    commandFailure: { command: "sudo", exitCode: 1, stderr: "Service home has unexpected ownership." },
  })), false);
  assert.equal(isRetryableCloseFailure(Object.assign(new Error("journal mismatch"), {
    code: "CLOSE_BLOCKED",
  })), false);
});

test("rechaza un journal que apunta a otra tienda antes de invocar el helper root", async () => {
  const calls = [];
  const request = { hostname: "tienda-norte.vidkar.com", requestId: "request-close-mismatch", slug: "tienda-norte" };
  await assert.rejects(() => closeDeployment({
    config: {
      deployRoot: "/opt/vidkar/comercios",
      nginxSitesAvailable: "/etc/nginx/sites-available",
      nginxSitesEnabled: "/etc/nginx/sites-enabled",
      portRangeEnd: 5899,
      portRangeStart: 5200,
    },
    journal: {
      hostname: request.hostname,
      nginxAvailablePath: "/etc/nginx/sites-available/otra.vidkar.com.conf",
      nginxEnabledPath: `/etc/nginx/sites-enabled/${request.hostname}.conf`,
      pm2Name: `vidkar-comercio-${request.slug}-${request.requestId.slice(0, 12)}`,
      port: 5212,
      requestId: request.requestId,
      runUser: createLegacyServiceUsername(request.slug),
      siteDirectory: `/opt/vidkar/comercios/${request.slug}`,
      slug: request.slug,
      state: "ACTIVE",
    },
    request,
    runner: { runCommand: async (...args) => calls.push(args) },
    stateStore: { write: async () => {} },
  }), /rutas o identidades distintas/);
  assert.equal(calls.length, 0);
});

test("cierra un journal resourceVersion 2 solo con identidad y ruta por requestId", async () => {
  const calls = [];
  const request = { hostname: "tienda-norte.vidkar.com", requestId: "request-close-v2", slug: "tienda-norte" };
  const siteDirectory = `/opt/vidkar/comercios/${request.slug}--${request.requestId}`;
  const result = await closeDeployment({
    config: {
      acmeWebroot: "/var/www/letsencrypt",
      commandTimeoutMs: 5000,
      deployRoot: "/opt/vidkar/comercios",
      helperHmacSecret: "helper-secret-" + "h".repeat(48),
      nginxSitesAvailable: "/etc/nginx/sites-available",
      nginxSitesEnabled: "/etc/nginx/sites-enabled",
      portRangeEnd: 5899,
      portRangeStart: 5200,
      privilegedHelper: "/usr/local/sbin/vidkar-commerce-helper",
    },
    journal: {
      certificateName: certificateNameForRequest(request.slug, request.requestId),
      hostname: request.hostname,
      nginxAvailablePath: `/etc/nginx/sites-available/${request.hostname}.conf`,
      nginxEnabledPath: `/etc/nginx/sites-enabled/${request.hostname}.conf`,
      pm2Name: `vidkar-comercio-${request.slug}-${request.requestId.slice(0, 12)}`,
      port: 5210,
      requestId: request.requestId,
      resourceVersion: 2,
      runUser: createServiceUsername(request.slug, request.requestId),
      siteDirectory,
      siteDirectoryCreated: true,
      slug: request.slug,
      state: "ACTIVE",
    },
    logger: { error() {}, info() {}, warn() {} },
    onCloseStep: async () => {},
    portProbe: async () => true,
    request,
    runner: { runCommand: async (_command, args) => { calls.push(args); return {}; } },
    stateStore: { write: async () => {} },
  });

  assert.equal(result.closeSucceeded, true);
  assert.deepEqual(calls.map((args) => args[4]), ["pm2-delete", "remove-nginx", "remove-certificate", "remove-site"]);
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
  assert.match(httpsConfig, new RegExp(`/etc/letsencrypt/live/${certificateNameForRequest("mercado-norte", input.requestId)}/fullchain\\.pem`));
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

test("el helper limita Certbot al lineage de una solicitud y preserva certificados compartidos o referenciados", async () => {
  const helperPath = path.resolve(__dirname, "../scripts/vidkar-commerce-helper");
  const helper = await fs.readFile(helperPath, "utf8");

  assert.match(helper, /certificate_name_for_request\(\)/);
  assert.match(helper, /--cert-name "\$certificate_name"/);
  assert.match(helper, /certificate_has_only_hostname/);
  assert.match(helper, /certificate_is_referenced\(\)/);
  assert.match(helper, /reference_archive_root/);
  assert.match(helper, /for config_root in \/etc\/nginx \/etc\/apache2/);
  assert.match(helper, /reference_private_key/);
  assert.match(helper, /CERTIFICATE_PRESERVED_UNOWNED/);
  assert.match(helper, /validate_deploy_root\(\)/);
  assert.match(helper, /validate_directory_not_group_writable/);
  assert.match(helper, /run_as_commerce "\$run_user" "\$service_home" "\$pm2_binary" delete/);
  assert.match(helper, /stop_pm2_daemon\(\) \{/);
  assert.match(helper, /run_as_commerce "\$run_user" "\$service_home" "\$pm2_binary" kill/);
  assert.match(helper, /fail_retryable\(\) \{[\s\S]*?exit 75/);
  assert.match(helper, /while \[ "\$delete_attempt" -le 3 \]/);
  assert.match(helper, /record_service_uid\(\)/);
  assert.match(helper, /validate_orphaned_service_home\(\)/);
  assert.match(helper, /getent passwd "\$orphan_uid"/);
  assert.match(helper, /certbot delete --cert-name "\$certificate_name" --non-interactive/);
  assert.match(helper, /CERTIFICATE_PRESERVED_SHARED_SAN/);
  assert.match(helper, /CERTIFICATE_PRESERVED_IN_USE/);
  assert.match(helper, /case "\$allow_legacy" in 0\|1\|2/);
  assert.match(helper, /elif \[ "\$allow_legacy" = "2" \]; then\s+owned_certificate_name=\$hostname/);
  assert.doesNotMatch(helper, /rm -rf[^\n]*\/etc\/letsencrypt/);

  const removeSiteFunction = helper.match(/remove_site\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(removeSiteFunction, "debe encontrar la función que retira la tienda");
  assert.match(removeSiteFunction, /remove_service_account "\$run_user" "\$service_home" "\$pm2_binary"/);
  const processTerminationFunction = helper.match(/terminate_service_user_processes\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(processTerminationFunction, "debe encontrar la limpieza de procesos de la cuenta aislada");
  assert.match(processTerminationFunction, /while \[ "\$process_signal_attempt" -le 5 \]/);
  assert.match(processTerminationFunction, /process_signal=TERM/);
  assert.match(processTerminationFunction, /process_signal=KILL/);
  assert.match(processTerminationFunction, /still owns processes after bounded TERM\/KILL shutdown/);
  assert.match(helper, /ps_binary" -eo ruid=,euid=,pid=/);

  const processStopPosition = removeSiteFunction.indexOf('terminate_service_user_processes "$run_user"');
  const siteDeletePosition = removeSiteFunction.indexOf('rm -rf -- "$site_directory"');
  const checkoutDeletePosition = removeSiteFunction.indexOf('rm -rf -- "$checkout_directory"');
  assert.ok(
    processStopPosition >= 0
      && processStopPosition < siteDeletePosition
      && processStopPosition < checkoutDeletePosition,
    "debe detener los procesos residuales antes de eliminar archivos de la tienda",
  );

  const removeServiceAccountFunction = helper.match(/remove_service_account\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(removeServiceAccountFunction, "debe encontrar el reintento de eliminación de la cuenta");
  const pm2StopPosition = removeServiceAccountFunction.indexOf('stop_pm2_daemon "$run_user" "$service_home" "$pm2_binary"');
  const processStopBeforeDeletePosition = removeServiceAccountFunction.indexOf('terminate_service_user_processes "$run_user"');
  const userDeletePosition = removeServiceAccountFunction.indexOf('userdel --remove "$run_user"');
  assert.ok(
    pm2StopPosition >= 0
      && processStopBeforeDeletePosition > pm2StopPosition
      && userDeletePosition > processStopBeforeDeletePosition,
    "debe detener PM2 y los procesos residuales antes de eliminar la cuenta",
  );
  assert.match(removeServiceAccountFunction, /fail_retryable "The commerce service account is still in use/);

  const removeNginxFunction = helper.match(/remove_nginx\(\) \{([\s\S]*?)\n\}/)?.[1];
  const unregisteredBranch = removeNginxFunction?.match(/if \[ ! -f "\$permit_file" \] \|\| \[ -L "\$permit_file" \]; then([\s\S]*?)\n  fi/)?.[1];
  assert.ok(unregisteredBranch, "debe validar la rama sin registro root");
  assert.match(unregisteredBranch, /restore_request_registration_from_domain/);
  assert.match(unregisteredBranch, /Resources exist without a verifiable root-owned request registration/);
  assert.doesNotMatch(unregisteredBranch, /nginx -t|systemctl reload nginx/);
});

test("la limpieza termina procesos residuales del UID de la tienda antes de eliminarlo", async () => {
  const helperPath = path.resolve(__dirname, "../scripts/vidkar-commerce-helper");
  const helper = await fs.readFile(helperPath, "utf8");
  const listProcessesFunction = helper.match(/list_service_user_processes\(\) \{[\s\S]*?\n\}/)?.[0];
  const terminateProcessesFunction = helper.match(/terminate_service_user_processes\(\) \{([\s\S]*?)\n\}/)?.[0];
  assert.ok(listProcessesFunction);
  assert.ok(terminateProcessesFunction);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vidkar-service-process-cleanup-"));
  const processListFile = path.join(root, "processes");
  const signalLogFile = path.join(root, "signals");
  await fs.writeFile(processListFile, "4321\n");
  try {
    const script = [
      'trusted_binary() { printf "%s\\n" "$1"; }',
      'id() { printf "4242\\n"; }',
      'ps() { printf "9999 9999 1111\\n"; while IFS= read -r process_pid; do [ -n "$process_pid" ] && printf "4242 4242 %s\\n" "$process_pid"; done < "$PROCESS_LIST_FILE"; }',
      'kill() { printf "%s:%s\\n" "$1" "$2" >> "$SIGNAL_LOG_FILE"; if [ "$1" = "-KILL" ]; then : > "$PROCESS_LIST_FILE"; fi; }',
      'sleep() { :; }',
      'fail_retryable() { printf "AUTO_RETRY: %s\\n" "$1" >&2; exit 75; }',
      'fail() { printf "%s\\n" "$1" >&2; exit 1; }',
      listProcessesFunction,
      terminateProcessesFunction,
      "terminate_service_user_processes vcommerce-test",
    ].join("\n");
    const result = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, PROCESS_LIST_FILE: processListFile, SIGNAL_LOG_FILE: signalLogFile },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await fs.readFile(signalLogFile, "utf8"),
      "-TERM:4321\n-TERM:4321\n-TERM:4321\n-KILL:4321\n",
    );
    assert.equal(await fs.readFile(processListFile, "utf8"), "");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("el helper evita str.removeprefix para ser compatible con Python 3.8", async () => {
  const helperPath = path.resolve(__dirname, "../scripts/vidkar-commerce-helper");
  const helper = await fs.readFile(helperPath, "utf8");
  const pythonBlock = helper.match(/python3 - "\$archive_file" "\$site_directory" <<'PY'\n([\s\S]*?)\nPY/);

  assert.doesNotMatch(helper, /\.removeprefix\(/);
  assert.match(helper, /name = member\.name\[2:\] if member\.name\.startswith\("\.\/"\) else member\.name/);
  assert.ok(pythonBlock, "debe encontrar el bloque Python que materializa el archivo");
  const parsed = spawnSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
    encoding: "utf8",
    input: pythonBlock[1],
  });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test("el helper instala dependencias de desarrollo necesarias para compilar Vite", async () => {
  const helperPath = path.resolve(__dirname, "../scripts/vidkar-commerce-helper");
  const helper = await fs.readFile(helperPath, "utf8");

  assert.match(helper, /run_as_commerce "\$run_user" "\$directory" "\$npm_binary" install -f --include=dev/);
});

test("el helper exige COMERCIO_HOST igual al dominio solicitado", async () => {
  const helperPath = path.resolve(__dirname, "../scripts/vidkar-commerce-helper");
  const helper = await fs.readFile(helperPath, "utf8");

  assert.match(helper, /COMERCIO_HOST HOST NODE_ENV PM2_APP_NAME PORT/);
  assert.match(helper, /COMERCIO_HOST=.*\$slug\.vidkar\.com/);
  assert.doesNotMatch(helper, /wc -l < "\$decoded_file"/);
});

test("el .env se instala con file descriptors sin seguir symlinks controlados por el comercio", async () => {
  const helperPath = path.resolve(__dirname, "../scripts/vidkar-commerce-helper");
  const helper = await fs.readFile(helperPath, "utf8");
  const writer = helper.match(/python3 - "\$site_directory" "\$run_user" "\$decoded_file" <<'PY'\n([\s\S]*?)\nPY/);

  assert.match(helper, /useradd .*--gid vidkar-commerce "\$run_user"/);
  assert.match(helper, /mktemp "\$HELPER_STATE_DIR\/\.environment\.XXXXXX"/);
  assert.ok(writer, "debe existir el escritor seguro del .env");
  assert.match(writer[1], /os\.O_EXCL \| os\.O_NOFOLLOW/);
  assert.match(writer[1], /os\.fchown\(environment_fd, expected_uid, expected_gid\)/);
  assert.match(writer[1], /os\.fchmod\(environment_fd, 0o600\)/);
  assert.doesNotMatch(helper, /chown "\$run_user:vidkar-commerce" "\$environment_file"/);
  const parsed = spawnSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
    encoding: "utf8",
    input: writer[1],
  });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test("el helper deriva cuenta, carpeta, home y unidad nuevas desde requestId y conserva layout legacy", async () => {
  const helperPath = path.resolve(__dirname, "../scripts/vidkar-commerce-helper");
  const helper = await fs.readFile(helperPath, "utf8");
  assert.match(helper, /Legacy subdomain resources remain; reconcile the previous flow before creating a request-scoped site/);
  const extractFunction = (name) => {
    const match = helper.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"));
    assert.ok(match, `debe existir la función ${name}`);
    return match[0];
  };
  const script = [
    extractFunction("service_user_for_slug"),
    extractFunction("service_user_for_request"),
    extractFunction("validate_service_user"),
    extractFunction("service_layout_for"),
    extractFunction("site_directory_for"),
    extractFunction("service_home_for"),
    extractFunction("service_unit_for"),
    'fail() { printf "%s\\n" "$1" >&2; exit 1; }',
    'DEPLOY_ROOT="/opt/vidkar/comercios"',
    'legacy_user="$(service_user_for_slug tienda)"',
    'flow_a_user="$(service_user_for_request tienda request-a)"',
    'flow_b_user="$(service_user_for_request tienda request-b)"',
    '[ "$flow_a_user" != "$flow_b_user" ] || exit 2',
    '[ "$(site_directory_for tienda request-a "$flow_a_user")" = "/opt/vidkar/comercios/tienda--request-a" ] || exit 3',
    '[ "$(service_home_for tienda request-a "$flow_a_user")" = "/var/lib/vidkar-commerce/$flow_a_user" ] || exit 4',
    '[ "$(service_unit_for tienda request-a "$flow_a_user")" = "/etc/systemd/system/vidkar-commerce-$flow_a_user.service" ] || exit 5',
    '[ "$(site_directory_for tienda request-b "$flow_b_user")" != "$(site_directory_for tienda request-a "$flow_a_user")" ] || exit 6',
    '[ "$(site_directory_for tienda request-a "$legacy_user")" = "/opt/vidkar/comercios/tienda" ] || exit 7',
    '[ "$(service_home_for tienda request-a "$legacy_user")" = "/var/lib/vidkar-commerce/tienda" ] || exit 8',
    '[ "$(service_unit_for tienda request-a "$legacy_user")" = "/etc/systemd/system/vidkar-commerce-tienda.service" ] || exit 9',
    'validate_service_user tienda request-a "$flow_a_user"',
    'validate_service_user tienda request-a "$legacy_user"',
  ].join("\n");
  const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
});

test("el helper restaura un permiso perdido solo desde el registro root-owned del mismo dominio y requestId", async () => {
  const helperPath = path.resolve(__dirname, "../scripts/vidkar-commerce-helper");
  const helper = await fs.readFile(helperPath, "utf8");
  const extractFunction = (name) => {
    const match = helper.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"));
    assert.ok(match, `debe existir la función ${name}`);
    return match[0];
  };
  const rootOwnedStateFunction = extractFunction("root_owned_private_state_file");
  const matchingDomainFunction = extractFunction("domain_registration_matches_request");
  const restoreFunction = extractFunction("restore_request_registration_from_domain");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vidkar-request-registration-recovery-"));
  let scenario = 0;

  const runRecovery = async ({
    requestId = "request-recovery",
    recordedRequestId = requestId,
    owner = "0:0",
    mode = "600",
    symlink = false,
    missing = false,
  } = {}) => {
    const stateDirectory = path.join(root, `scenario-${scenario}`);
    scenario += 1;
    await fs.mkdir(stateDirectory);
    const domainFile = path.join(stateDirectory, "domain-tienda");
    if (!missing) {
      if (symlink) {
        await fs.writeFile(path.join(stateDirectory, "domain-target"), `${recordedRequestId}\n`);
        await fs.symlink("domain-target", domainFile);
      } else {
        await fs.writeFile(domainFile, `${recordedRequestId}\n`);
      }
    }

    const script = [
      "stat() {",
      '  [ "$1" = "-c" ] || return 1',
      '  [ "$3" = "$DOMAIN_FILE" ] || return 1',
      '  case "$2" in',
      '    "%u:%g") printf "%s\\n" "$STATE_OWNER" ;;',
      '    "%a") printf "%s\\n" "$STATE_MODE" ;;',
      "    *) return 1 ;;",
      "  esac",
      "}",
      rootOwnedStateFunction,
      matchingDomainFunction,
      restoreFunction,
      'register_request() { printf "%s:%s:%s\\n" "$1" "$2" "$3" > "$HELPER_STATE_DIR/restored"; }',
      'require_request() { :; }',
      'restore_request_registration_from_domain "$REQUEST_ID" "$SLUG" "$RUN_USER"',
    ].join("\n");
    const result = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        DOMAIN_FILE: domainFile,
        HELPER_STATE_DIR: stateDirectory,
        REQUEST_ID: requestId,
        RUN_USER: "vcommerce-123456789abc",
        SLUG: "tienda",
        STATE_MODE: mode,
        STATE_OWNER: owner,
      },
    });
    const restored = await fs.readFile(path.join(stateDirectory, "restored"), "utf8").catch(() => null);
    return { restored, status: result.status, stderr: result.stderr };
  };

  try {
    const recovered = await runRecovery();
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(recovered.restored, "request-recovery:tienda:vcommerce-123456789abc\n");

    for (const invalidProof of [
      { recordedRequestId: "different-request" },
      { owner: "1000:1000" },
      { mode: "644" },
      { symlink: true },
      { missing: true },
    ]) {
      const refused = await runRecovery(invalidProof);
      assert.equal(refused.status, 1, JSON.stringify(invalidProof));
      assert.equal(refused.restored, null, JSON.stringify(invalidProof));
    }

    assert.match(helper, /Site resources exist without a verifiable root-owned request registration/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("el helper elimina solo un directorio huérfano ligado al slug y requestId por su .env", async () => {
  const helperPath = path.resolve(__dirname, "../scripts/vidkar-commerce-helper");
  const helper = await fs.readFile(helperPath, "utf8");
  const extractFunction = (name) => {
    const match = helper.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"));
    assert.ok(match, `debe existir la función ${name}`);
    return match[0];
  };
  const serviceUserForSlug = extractFunction("service_user_for_slug");
  const serviceUserForRequest = extractFunction("service_user_for_request");
  const serviceLayoutFor = extractFunction("service_layout_for");
  const siteDirectoryFor = extractFunction("site_directory_for");
  const orphanSiteBlock = extractFunction("orphan_site_block");
  const validUidFunction = extractFunction("valid_service_uid");
  const removeOrphanFunction = extractFunction("remove_orphaned_site_directory");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vidkar-orphan-site-recovery-"));
  const requestId = "roM9TFGwhWfHy5Mrg";
  const slug = "tienda";
  let scenario = 0;

  const runRecovery = async ({
    activeProcess = false,
    accountExists = false,
    domainMarker = false,
    environmentRequestId = requestId,
    mode = "700",
    requestScopedAccount = false,
    reusedUid = false,
    siteGroup = "vidkar-commerce",
  } = {}) => {
    const scenarioRoot = path.join(root, `case-${scenario}`);
    scenario += 1;
    const deployRoot = path.join(scenarioRoot, "deploy");
    const requestRunUser = requestScopedAccount
      ? createServiceUsername(slug, requestId)
      : createLegacyServiceUsername(slug);
    const siteDirectory = path.join(deployRoot, requestScopedAccount ? `${slug}--${requestId}` : slug);
    const environmentFile = path.join(siteDirectory, ".env");
    const serviceHome = path.join(scenarioRoot, "home", requestScopedAccount ? requestRunUser : slug);
    const stateDirectory = path.join(scenarioRoot, "state");
    const siteUid = "996";
    const groupId = "2222";
    await fs.mkdir(siteDirectory, { recursive: true });
    if (accountExists) {
      await fs.mkdir(serviceHome, { recursive: true, mode: 0o700 });
      await fs.chmod(serviceHome, 0o700);
    }
    await fs.writeFile(environmentFile, [
      `COMERCIO_HOST='${slug}.vidkar.com'`,
      `PM2_APP_NAME='vidkar-comercio-${slug}-${environmentRequestId.slice(0, 12)}'`,
      "",
    ].join("\n"), { mode: 0o600 });
    if (domainMarker) {
      await fs.mkdir(stateDirectory, { recursive: true });
      await fs.writeFile(path.join(stateDirectory, `domain-${slug}`), "another-request\n");
    }

    const script = [
      serviceUserForSlug,
      serviceUserForRequest,
      serviceLayoutFor,
      siteDirectoryFor,
      orphanSiteBlock,
      validUidFunction,
      "validate_deploy_root() { :; }",
      "getent() {",
      '  if [ "$1" = "group" ] && [ "$2" = "vidkar-commerce" ]; then printf "vidkar-commerce:x:%s:\\n" "$GROUP_ID"; return 0; fi',
      '  if [ "$1" = "passwd" ]; then',
      '    if [ "$2" = "$RUN_USER" ] && [ "$ACCOUNT_EXISTS" = "1" ]; then printf "%s:x:%s:%s::%s:/usr/sbin/nologin\\n" "$RUN_USER" "$SITE_UID" "$GROUP_ID" "$SERVICE_HOME"; return 0; fi',
      '    if [ "$2" = "$SITE_UID" ] && [ "$UID_REUSED" = "1" ]; then printf "reused:x:%s:2222::/tmp/home:/usr/sbin/nologin\\n" "$SITE_UID"; return 0; fi',
      "  fi",
      "  return 2",
      "}",
      "stat() {",
      '  [ "$1" = "-c" ] || return 2',
      '  case "$2:$3" in',
      '    "%u:$SITE_DIRECTORY") printf "%s\\n" "$SITE_UID" ;;',
      '    "%g:$SITE_DIRECTORY") printf "%s\\n" "$SITE_GROUP" ;;',
      '    "%a:$SITE_DIRECTORY") printf "%s\\n" "$SITE_MODE" ;;',
      '    "%u:%g:%a:$SITE_DIRECTORY") printf "%s:%s:700\\n" "$SITE_UID" "$GROUP_ID" ;;',
      '    "%u:%g:%a:%h:$ENVIRONMENT_FILE") printf "%s:%s:600:1\\n" "$SITE_UID" "$GROUP_ID" ;;',
      '    "%u:%g:%a:$SERVICE_HOME") printf "%s:%s:700\\n" "$SITE_UID" "$GROUP_ID" ;;',
      "    *) return 2 ;;",
      "  esac",
      "}",
      'list_service_user_processes() { [ "$ACTIVE_PROCESS" = "1" ] && printf "4321\\n"; return 0; }',
      "validate_service_home_parent() { :; }",
      'userdel() { [ "$1" = "--remove" ] && [ "$2" = "$RUN_USER" ] || return 1; ACCOUNT_EXISTS=0; rm -rf -- "$SERVICE_HOME"; }',
      removeOrphanFunction,
      "remove_orphaned_site_directory",
    ].join("\n");
    const result = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        ACCOUNT_EXISTS: accountExists ? "1" : "0",
        ACTIVE_PROCESS: activeProcess ? "1" : "0",
        certificate_marker: path.join(stateDirectory, `certificate-${requestId}`),
        config_file: path.join(scenarioRoot, "nginx", `${slug}.conf`),
        DEPLOY_ROOT: deployRoot,
        domain_file: path.join(stateDirectory, `domain-${slug}`),
        enabled_link: path.join(scenarioRoot, "nginx-enabled", `${slug}.conf`),
        ENVIRONMENT_FILE: environmentFile,
        GROUP_ID: groupId,
        orphan_site_directory: siteDirectory,
        permit_file: path.join(stateDirectory, requestId),
        request_id: requestId,
        RUN_USER: requestRunUser,
        run_user: requestRunUser,
        service_home: serviceHome,
        service_unit: path.join(scenarioRoot, "systemd", `vidkar-commerce-${slug}.service`),
        site_directory: siteDirectory,
        SITE_DIRECTORY: siteDirectory,
        SITE_GROUP: siteGroup === "vidkar-commerce" ? groupId : "3333",
        SITE_MODE: mode,
        SITE_UID: siteUid,
        SERVICE_HOME: serviceHome,
        slug,
        SLUG: slug,
        UID_REUSED: reusedUid ? "1" : "0",
      },
    });
    return {
      exists: await fs.stat(siteDirectory).then(() => true, () => false),
      result,
    };
  };

  try {
    const removed = await runRecovery();
    assert.equal(removed.result.status, 0, removed.result.stderr);
    assert.match(removed.result.stdout, /ORPHAN_SITE_DIRECTORY_REMOVED/);
    assert.equal(removed.exists, false);

    for (const invalidProof of [
      { environmentRequestId: "another-request" },
      { activeProcess: true },
      { accountExists: true, requestScopedAccount: false },
      { reusedUid: true },
      { domainMarker: true },
      { mode: "755" },
      { siteGroup: "other-group" },
    ]) {
      const refused = await runRecovery(invalidProof);
      assert.equal(refused.result.status, 1, JSON.stringify(invalidProof));
      assert.equal(refused.exists, true, JSON.stringify(invalidProof));
    }

    const recoveredRequestAccount = await runRecovery({ accountExists: true, requestScopedAccount: true });
    assert.equal(recoveredRequestAccount.result.status, 0, recoveredRequestAccount.result.stderr);
    assert.match(recoveredRequestAccount.result.stdout, /ORPHAN_SITE_DIRECTORY_REMOVED/);
    assert.equal(recoveredRequestAccount.exists, false);

    const activeRequestAccount = await runRecovery({
      accountExists: true,
      activeProcess: true,
      requestScopedAccount: true,
    });
    assert.equal(activeRequestAccount.result.status, 1);
    assert.equal(activeRequestAccount.exists, true);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("el helper acepta staging root-owned o del worker legacy, pero rechaza otros propietarios", async () => {
  const helperPath = path.resolve(__dirname, "../scripts/vidkar-commerce-helper");
  const helper = await fs.readFile(helperPath, "utf8");
  const match = helper.match(/^worker_storage_owner_allowed\(\) \{\n[\s\S]*?^\}/m);
  assert.ok(match, "debe existir la validación de propietario del staging");

  const result = spawnSync("sh", ["-c", [
    match[0],
    "worker_storage_owner_allowed root",
    "worker_storage_owner_allowed vidkar-provisioner",
    "! worker_storage_owner_allowed cloud",
  ].join("\n")], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(helper, /validate_worker_storage_directory "\$checkout_directory"/);
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
      "remove_certificate:STARTED", "remove_certificate:COMPLETED",
      "remove_site:STARTED", "remove_site:COMPLETED",
    ]);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("el rollback informa cuando conserva un certificado no exclusivo", async () => {
  const commands = [];
  const reports = [];
  const warnings = [];
  const config = {
    acmeWebroot: "/var/www/letsencrypt",
    commandTimeoutMs: 5000,
    deployRoot: "/opt/vidkar/comercios",
    helperHmacSecret: "helper-secret-" + "h".repeat(48),
    nginxSitesAvailable: "/etc/nginx/sites-available",
    nginxSitesEnabled: "/etc/nginx/sites-enabled",
    privilegedHelper: "/usr/local/sbin/vidkar-commerce-helper",
    stateDir: "/var/lib/vidkar-provisioner/state",
  };
  const journal = {
    certificateIssued: true,
    hostname: "mercado-norte.vidkar.com",
    nginxChanged: true,
    pm2StartAttempted: false,
    requestId: "request-shared-certificate",
    runUser: "vcommerce-123456789abc",
    siteDirectoryCreated: true,
    slug: "mercado-norte",
    state: "ROLLING_BACK",
  };

  const result = await rollbackDeployment({
    config,
    journal,
    logger: { error() {}, info() {}, warn: (...entry) => warnings.push(entry) },
    onRollbackStep: async (...report) => reports.push(report),
    runner: {
      runCommand: async (_command, args) => {
        commands.push(args);
        return { stdoutTail: args.includes("remove-certificate") ? "CERTIFICATE_PRESERVED_IN_USE\n" : "" };
      },
    },
    stateStore: { write: async () => {} },
  });

  assert.equal(result.rollbackSucceeded, true);
  assert.ok(commands.some((args) => args.includes("remove-certificate")), JSON.stringify(commands));
  const certificateReport = reports.find(([stepId, outcome]) => stepId === "remove_certificate" && outcome === "COMPLETED");
  assert.match(certificateReport[2], /Certbot conservó el certificado/);
  assert.match(certificateReport[2], /CERTIFICATE_PRESERVED_IN_USE/);
  assert.ok(warnings.some(([message]) => /Certbot conservó el certificado/.test(message)));
});

test("el rollback conserva Nginx y la cuenta si no puede confirmar que PM2 se detuvo", async () => {
  const calls = [];
  const reports = [];
  const result = await rollbackDeployment({
    config: {
      acmeWebroot: "/var/www/letsencrypt",
      commandTimeoutMs: 5000,
      deployRoot: "/opt/vidkar/comercios",
      helperHmacSecret: "helper-secret-" + "h".repeat(48),
      nginxSitesAvailable: "/etc/nginx/sites-available",
      nginxSitesEnabled: "/etc/nginx/sites-enabled",
      privilegedHelper: "/usr/local/sbin/vidkar-commerce-helper",
      stateDir: "/var/lib/vidkar-provisioner/state",
    },
    journal: {
      hostname: "tienda.vidkar.com",
      nginxChanged: true,
      pm2StartAttempted: true,
      requestId: "request-pm2-stop-failed",
      runUser: "vcommerce-123456789abc",
      siteDirectoryCreated: true,
      slug: "tienda",
      state: "ROLLING_BACK",
    },
    logger: { error() {}, info() {}, warn() {} },
    onRollbackStep: async (...entry) => reports.push(entry),
    runner: { runCommand: async (...args) => { calls.push(args); throw new Error("pm2 helper failed"); } },
    stateStore: { write: async () => {} },
  });

  assert.equal(result.rollbackSucceeded, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1][4], "pm2-delete");
  assert.deepEqual(reports.filter(([, outcome]) => outcome === "FAILED").map(([stepId]) => stepId), [
    "stop_pm2", "remove_nginx", "remove_certificate", "remove_site",
  ]);
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
    "remove_certificate:STARTED", "remove_certificate:COMPLETED",
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

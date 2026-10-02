const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { dnsPointsToVps, resolveA } = require("./dns");
const { createPrivilegedHelperRunner } = require("./privilegedHelper");
const { createServiceUsername } = require("./serviceUser");

let portAllocationQueue = Promise.resolve();

const safeRequestId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const safeSlug = (value) => typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(value);
const cleanEnvValue = (value) => `'${String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ")}'`;

const serializeCommerceEnv = ({ commerceHostname, displayName, ownerId, port, pm2Name, config }) => {
  const values = {
    COMERCIO_HOST: commerceHostname,
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    PM2_APP_NAME: pm2Name,
    PORT: String(port),
    VITE_COMERCIO_EMPRESA_ID: ownerId,
    VITE_COMERCIO_NOMBRE: displayName,
    VITE_GOOGLE_MAPS_API_KEY: config.commerceGoogleMapsApiKey,
    VITE_METEOR_DDP_URL: config.commerceDdpUrl,
    VITE_METEOR_HTTP_URL: config.commerceHttpUrl,
  };
  return `${Object.entries(values).map(([key, value]) => `${key}=${cleanEnvValue(value)}`).join("\n")}\n`;
};

const isPortAvailable = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once("error", () => resolve(false));
  server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
});

const findAvailablePort = async ({ config, onReserve = async () => {}, portProbe = isPortAvailable, stateStore }) => {
  let releaseAllocation;
  const previousAllocation = portAllocationQueue;
  portAllocationQueue = new Promise((resolve) => { releaseAllocation = resolve; });
  await previousAllocation;

  try {
    const activeJournals = await stateStore.list();
    const reserved = new Set(activeJournals
      .filter((journal) => journal.state !== "ROLLED_BACK")
      .map((journal) => journal.port)
      .filter(Number.isInteger));

    for (let port = config.portRangeStart; port <= config.portRangeEnd; port += 1) {
      if (reserved.has(port) || !(await portProbe(port))) continue;
      await onReserve(port);
      return port;
    }
    throw new Error("No quedan puertos libres en el rango configurado para comercios.");
  } finally {
    releaseAllocation();
  }
};

const assertNoTrackedEnvironmentFile = async ({ runner, siteDirectory, config }) => {
  const result = await runner.runCommand("git", [
    "-C", siteDirectory, "ls-tree", "-r", "-z", "--name-only", "HEAD",
  ], {
    captureTailLength: 65536,
    envOverrides: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    timeoutMs: config.commandTimeoutMs,
  });
  const tracked = result.stdoutTail.split("\0").map((entry) => entry.trim()).filter(Boolean)
    .filter((filename) => /(?:^|\/)\.env(?:\..*)?$/.test(filename))
    .filter((filename) => ![".env.example", ".env.sample"].includes(path.posix.basename(filename)));
  if (tracked.length) {
    throw new Error("El repositorio comercio-web contiene archivos .env versionados. Sácalos del índice de Git y vuelve a desplegar.");
  }
};

const createHttpResponseCheck = async (url, fetchImpl = fetch, timeoutMs = 10000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: "manual", signal: controller.signal });
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`La comprobación de ${new URL(url).hostname} respondió ${response.status}.`);
    }
    return response.status;
  } catch (_error) {
    throw new Error(`No se pudo comprobar ${new URL(url).hostname}.`);
  } finally {
    clearTimeout(timeout);
  }
};

const deployRequest = async ({
  client,
  config,
  fetchImpl = fetch,
  logger = console,
  portProbe = isPortAvailable,
  resolveAImpl = resolveA,
  assertLease = () => {},
  request,
  runner,
  stateStore,
}) => {
  if (!request || !safeRequestId(request.requestId) || !safeSlug(request.slug)
    || request.hostname !== `${request.slug}.vidkar.com`
    || typeof request.ownerId !== "string" || !request.ownerId
    || typeof request.displayName !== "string" || request.displayName.trim().length < 2) {
    throw new Error("La tarea recibida no cumple el contrato de aprovisionamiento.");
  }

  const requestId = request.requestId;
  const privilegedHelper = createPrivilegedHelperRunner({ config, runner });
  const runUser = createServiceUsername(request.slug);
  const siteDirectory = path.resolve(config.deployRoot, request.slug);
  if (path.dirname(siteDirectory) !== path.resolve(config.deployRoot)) {
    throw new Error("La ruta calculada de la tienda queda fuera del directorio de despliegue.");
  }
  const pm2Name = `vidkar-comercio-${request.slug}-${requestId.slice(0, 12)}`;
  const checkoutDirectory = path.join(config.stateDir, "checkouts", requestId);
  const availablePath = path.join(config.nginxSitesAvailable, `${request.hostname}.conf`);
  const enabledPath = path.join(config.nginxSitesEnabled, `${request.hostname}.conf`);
  const journal = {
    completedSteps: [],
    checkoutDirectory,
    checkoutDirectoryCreated: false,
    hostname: request.hostname,
    nginxAvailablePath: availablePath,
    nginxAvailableCreated: false,
    nginxChanged: false,
    nginxEnabledPath: enabledPath,
    nginxSymlinkCreated: false,
    pm2Name,
    pm2Started: false,
    port: null,
    requestId,
    runUser,
    siteDirectory,
    siteDirectoryCreated: false,
    slug: request.slug,
    state: "STARTING",
  };
  await stateStore.write(requestId, journal);

  const reportStep = async (stepId, outcome, message) => client.call(
    "comercio.provisioning.worker.reportStep",
    config.token,
    config.workerId,
    requestId,
    stepId,
    outcome,
    message,
  );
  const runStep = async (stepId, message, action) => {
    const startedAt = Date.now();
    logger.info?.(`STAGE START step=${stepId} detail=${message}`);
    try {
      assertLease();
      await reportStep(stepId, "STARTED", message);
      await stateStore.write(requestId, { ...journal, currentStep: stepId });
      const result = await action();
      assertLease();
      journal.completedSteps.push(stepId);
      await stateStore.write(requestId, { ...journal, currentStep: null });
      await reportStep(stepId, "COMPLETED", message);
      logger.info?.(`STAGE OK step=${stepId} durationMs=${Date.now() - startedAt}`);
      return result;
    } catch (error) {
      logger.error?.(`STAGE FAIL step=${stepId} durationMs=${Date.now() - startedAt} reason=${error?.message || "error inesperado"}`);
      throw error;
    }
  };

  const dnsAddresses = await runStep(
    "preflight_dns",
    `Verificando que ${request.hostname} apunta a ${config.publicIpv4}.`,
    async () => resolveAImpl(request.hostname),
  );
  if (!dnsPointsToVps(dnsAddresses, config.publicIpv4)) {
    await client.call(
      "comercio.provisioning.worker.dnsBlocked",
      config.token,
      config.workerId,
      requestId,
      dnsAddresses,
    );
    return { blockedDns: true };
  }

  const port = await findAvailablePort({
    config,
    portProbe,
    stateStore,
    onReserve: async (reservedPort) => {
      journal.port = reservedPort;
      await stateStore.write(requestId, journal);
    },
  });

  try {
    await runStep("prepare_directory", "Preparando una carpeta aislada para este comercio.", async () => {
      journal.siteDirectoryCreated = true;
      await stateStore.write(requestId, journal);
      await privilegedHelper.run("prepare-site", [
        request.slug,
        requestId,
        runUser,
      ], { timeoutMs: config.commandTimeoutMs });
    });

    await runStep("clone_repository", "Clonando el repositorio autorizado de comercio-web y comprobando que no incluya .env versionados.", async () => {
        await fs.mkdir(path.dirname(checkoutDirectory), { recursive: true, mode: 0o700 });
        try {
          await fs.lstat(checkoutDirectory);
          throw new Error("Ya existe una copia Git temporal para esta solicitud.");
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        await fs.mkdir(checkoutDirectory, { mode: 0o700 });
        journal.checkoutDirectoryCreated = true;
        await stateStore.write(requestId, journal);
        await runner.runCommand("git", [
          "clone", "--depth", "1", "--filter=blob:none", "--no-checkout", "--branch",
          config.repositoryRef, config.repositoryUrl, checkoutDirectory,
        ], {
          cwd: path.dirname(checkoutDirectory),
          envOverrides: { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
          timeoutMs: config.commandTimeoutMs,
        });
        await assertNoTrackedEnvironmentFile({
          runner,
          siteDirectory: checkoutDirectory,
          config,
        });
        await runner.runCommand("git", ["-C", checkoutDirectory, "checkout", "--force"], {
          cwd: path.dirname(checkoutDirectory),
          envOverrides: { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
          timeoutMs: config.commandTimeoutMs,
        });
        await privilegedHelper.run("materialize-site", [request.slug, requestId, runUser], {
          timeoutMs: config.commandTimeoutMs,
        });
        journal.checkoutDirectoryCreated = false;
        await stateStore.write(requestId, journal);
      });

    await runStep("install_dependencies", "Instalando dependencias de la tienda para iniciar Vite con PM2.", () =>
      privilegedHelper.run("npm-install", [request.slug, requestId, runUser], { timeoutMs: config.npmTimeoutMs }));

    await runStep("generate_environment", "Generando el .env exclusivo de esta tienda.", async () => {
      const envContent = serializeCommerceEnv({
        config,
        commerceHostname: request.hostname,
        displayName: request.displayName,
        ownerId: request.ownerId,
        pm2Name,
        port,
      });
      await privilegedHelper.run("write-env", [
        request.slug,
        requestId,
        runUser,
        String(port),
        Buffer.from(envContent, "utf8").toString("base64"),
      ], { timeoutMs: config.commandTimeoutMs });
      journal.environmentCreated = true;
      await stateStore.write(requestId, journal);
    });

    await runStep("start_pm2", "Iniciando el servidor Vite sin compilación con PM2.", async () => {
      journal.pm2StartAttempted = true;
      await stateStore.write(requestId, journal);
      await privilegedHelper.run("pm2-start", [request.slug, requestId, runUser], { timeoutMs: config.commandTimeoutMs });
      journal.pm2Started = true;
      await stateStore.write(requestId, journal);
      await privilegedHelper.run("pm2-save", [request.slug, requestId, runUser], { timeoutMs: config.commandTimeoutMs });
      await waitForHealth(`http://127.0.0.1:${port}/`, fetchImpl);
    });

    await runStep("enable_autostart", "Configurando el inicio automático del sitio después de un reinicio.", () =>
      privilegedHelper.run("enable-pm2", [request.slug, requestId, runUser], { timeoutMs: config.commandTimeoutMs }));

    await runStep("configure_nginx_http", "Creando y validando el sitio HTTP de Nginx para Certbot.", async () => {
      journal.nginxAvailableCreated = true;
      journal.nginxSymlinkCreated = true;
      journal.nginxChanged = true;
      await stateStore.write(requestId, journal);
      await privilegedHelper.run("install-http", [
        request.slug, String(port), requestId,
        config.nginxSitesAvailable, config.nginxSitesEnabled,
        config.acmeWebroot, config.publicIpv4, runUser,
      ], { timeoutMs: config.commandTimeoutMs });
    });

    await runStep("issue_certificate", "Solicitando un certificado HTTPS con validación HTTP-01.", async () => {
      await privilegedHelper.run("issue-certificate", [
        request.slug, String(port), requestId,
        config.certbotEmail, config.nginxSitesAvailable,
        config.nginxSitesEnabled, config.acmeWebroot, config.publicIpv4, runUser,
      ], { timeoutMs: config.certbotTimeoutMs });
      journal.certificateIssued = true;
      await stateStore.write(requestId, journal);
    });

    await runStep("configure_nginx_https", "Activando HTTPS y validando la configuración final de Nginx.", async () => {
      await privilegedHelper.run("install-https", [
        request.slug, String(port), requestId,
        config.nginxSitesAvailable, config.nginxSitesEnabled,
        config.acmeWebroot, config.publicIpv4, runUser,
      ], { timeoutMs: config.commandTimeoutMs });
    });

    await runStep("verify_site", "Comprobando la URL HTTPS de la tienda.", () =>
      waitForHealth(`https://${request.hostname}/`, fetchImpl));

    journal.state = "ACTIVE";
    journal.completedAt = new Date().toISOString();
    await stateStore.write(requestId, journal);
    logger.info?.("FLOW OK deployment completed");
    return { blockedDns: false, publicUrl: `https://${request.hostname}` };
  } catch (error) {
    error.provisionerJournal = journal;
    logger.error?.(`FLOW FAIL reason=${error.message}`);
    throw error;
  }
};

const waitForHealth = async (url, fetchImpl = fetch, options = {}) => {
  const attempts = options.attempts || 15;
  const delayMs = options.delayMs || 1000;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchImpl(url, { redirect: "manual", signal: controller.signal });
      if (response.status >= 200 && response.status < 400) {
        clearTimeout(timeout);
        return response.status;
      }
      lastError = new Error(`Respuesta HTTP ${response.status}.`);
    } catch (_error) {
      lastError = new Error("El servidor web todavía no responde.");
    } finally {
      clearTimeout(timeout);
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError || new Error("La comprobación de salud venció.");
};

module.exports = {
  assertNoTrackedEnvironmentFile,
  createHttpResponseCheck,
  deployRequest,
  findAvailablePort,
  isPortAvailable,
  serializeCommerceEnv,
  waitForHealth,
};

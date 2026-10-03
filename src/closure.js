const path = require("node:path");
const { certificateNameForRequest, isPortAvailable } = require("./deployment");
const { createPrivilegedHelperRunner } = require("./privilegedHelper");
const { createServiceUsername } = require("./serviceUser");

const safeRequestId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const safeSlug = (value) => typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(value);

const validateCloseTarget = ({ config, journal, request }) => {
  if (!request || !safeRequestId(request.requestId) || !safeSlug(request.slug)
    || request.hostname !== `${request.slug}.vidkar.com`) {
    throw new Error("La tarea de cierre no identifica una tienda VIDKAR válida.");
  }
  if (!journal || journal.requestId !== request.requestId || journal.slug !== request.slug
    || journal.hostname !== request.hostname) {
    throw new Error("El journal no coincide exactamente con la tienda que se solicitó cerrar.");
  }

  const expectedSiteDirectory = path.resolve(config.deployRoot, request.slug);
  const expectedAvailablePath = path.resolve(config.nginxSitesAvailable, `${request.hostname}.conf`);
  const expectedEnabledPath = path.resolve(config.nginxSitesEnabled, `${request.hostname}.conf`);
  const expectedPm2Name = `vidkar-comercio-${request.slug}-${request.requestId.slice(0, 12)}`;
  const expectedCertificateName = certificateNameForRequest(request.slug, request.requestId);
  const expectedRunUser = createServiceUsername(request.slug);
  if (path.resolve(journal.siteDirectory || "") !== expectedSiteDirectory
    || path.resolve(journal.nginxAvailablePath || "") !== expectedAvailablePath
    || path.resolve(journal.nginxEnabledPath || "") !== expectedEnabledPath
    || journal.pm2Name !== expectedPm2Name
    || (journal.certificateName && journal.certificateName !== expectedCertificateName)
    || journal.runUser !== expectedRunUser) {
    throw new Error("El journal contiene rutas o identidades distintas a las asignadas a esta tienda.");
  }
  if (!Number.isInteger(journal.port)
    || journal.port < config.portRangeStart
    || journal.port > config.portRangeEnd) {
    throw new Error("El journal no contiene un puerto reservado válido para esta tienda.");
  }
  if (!["ACTIVE", "CLOSING", "CLOSE_FAILED", "CLOSED"].includes(journal.state)) {
    throw new Error("El journal no está en un estado seguro para cerrar una tienda activa.");
  }
};

const closeDeployment = async ({
  assertLease = () => {},
  config,
  journal,
  logger = console,
  onCloseStep = async () => {},
  portProbe = isPortAvailable,
  request,
  runner,
  stateStore,
}) => {
  validateCloseTarget({ config, journal, request });
  const errors = [];
  const warnings = [];
  const privilegedHelper = createPrivilegedHelperRunner({ config, runner });
  const labels = {
    stop_pm2: "Detener PM2",
    remove_nginx: "Retirar Nginx y systemd",
    remove_certificate: "Retirar el certificado exclusivo",
    remove_site: "Eliminar archivos y cuenta de servicio",
  };

  const runStep = async (stepId, action, formatSuccess = () => `${labels[stepId]}: completado.`) => {
    const label = labels[stepId];
    const startedAt = Date.now();
    assertLease();
    logger.info?.(`CLOSE START step=${stepId}`);
    await onCloseStep(stepId, "STARTED", `${label}: iniciado.`);
    try {
      assertLease();
      const result = await action();
      assertLease();
      await onCloseStep(stepId, "COMPLETED", formatSuccess(result));
      logger.info?.(`CLOSE OK step=${stepId} durationMs=${Date.now() - startedAt}`);
      return { result, succeeded: true };
    } catch (error) {
      if (error?.code === "WORKER_LEASE_LOST") throw error;
      assertLease();
      errors.push(`${label}: no se pudo completar.`);
      try {
        await onCloseStep(stepId, "FAILED", `${label}: requiere revisión manual.`);
      } catch (reportError) {
        if (reportError?.code === "WORKER_LEASE_LOST") throw reportError;
        logger.warn?.(`[comercio-provisioner] No se pudo reportar el paso de cierre ${stepId}.`);
      }
      logger.error?.(`CLOSE FAIL step=${stepId} durationMs=${Date.now() - startedAt} reason=${error?.message || "error inesperado"}`);
      return { result: null, succeeded: false };
    }
  };

  await stateStore.write(request.requestId, {
    ...journal,
    closeErrors: [],
    closeWarnings: [],
    state: "CLOSING",
  });

  const pm2Stopped = await runStep("stop_pm2", async () => {
    await privilegedHelper.run("pm2-delete", [request.slug, request.requestId, journal.runUser], {
      timeoutMs: config.commandTimeoutMs,
    });
    if (!(await portProbe(journal.port))) {
      throw new Error("El puerto de esta tienda sigue ocupado después de detener PM2.");
    }
  });

  const nginxRemoved = await runStep("remove_nginx", async () => {
    if (!pm2Stopped.succeeded) throw new Error("PM2 no se detuvo; se conserva Nginx y el sitio.");
    await privilegedHelper.run("remove-nginx", [
      request.slug,
      request.requestId,
      config.nginxSitesAvailable,
      config.nginxSitesEnabled,
      config.acmeWebroot,
      journal.runUser,
    ], { timeoutMs: config.commandTimeoutMs });
  });

  const certificateRemoved = await runStep("remove_certificate", async () => {
    if (!pm2Stopped.succeeded || !nginxRemoved.succeeded) {
      throw new Error("Se conserva el certificado mientras PM2 o la configuración Nginx no estén retirados.");
    }
    const result = await privilegedHelper.run("remove-certificate", [
      request.slug,
      request.requestId,
      config.nginxSitesAvailable,
      config.nginxSitesEnabled,
      journal.runUser,
      "1",
    ], { timeoutMs: config.commandTimeoutMs });
    const preservedCertificate = (result?.stdoutTail || "").split(/\r?\n/u)
      .some((line) => /^CERTIFICATE_PRESERVED(?:_[A-Z_]+)?$/u.test(line));
    if (preservedCertificate) {
      warnings.push("Certbot conservó un certificado compartido, legacy sin marcador, referenciado por otro servicio o no verificable.");
    }
    return { preservedCertificate };
  }, (result) => result?.preservedCertificate
    ? "Certbot conservó un certificado compartido, legacy sin propiedad verificable o referenciado por otro servicio."
    : "Se retiró el certificado exclusivo de este dominio, o no había uno que retirar.");

  await runStep("remove_site", async () => {
    if (!pm2Stopped.succeeded || !nginxRemoved.succeeded || !certificateRemoved.succeeded) {
      throw new Error("Se conservan los archivos y la cuenta mientras haya recursos previos sin reconciliar.");
    }
    await privilegedHelper.run("remove-site", [request.slug, request.requestId, journal.runUser], {
      timeoutMs: config.commandTimeoutMs,
    });
  });

  const closeSucceeded = errors.length === 0;
  const nextJournal = {
    ...journal,
    closeErrors: errors,
    closeWarnings: warnings,
    state: closeSucceeded ? "CLOSED" : "CLOSE_FAILED",
    updatedAt: new Date().toISOString(),
  };
  try {
    await stateStore.write(request.requestId, nextJournal);
  } catch (_error) {
    errors.push("No se pudo actualizar el journal local del cierre.");
  }

  return {
    closeSucceeded: errors.length === 0,
    errors,
    warnings,
  };
};

module.exports = { closeDeployment, validateCloseTarget };
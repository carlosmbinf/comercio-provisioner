const path = require("node:path");
const { certificateNameForRequest, isPortAvailable } = require("./deployment");
const { createPrivilegedHelperRunner } = require("./privilegedHelper");
const { createLegacyServiceUsername, createServiceUsername } = require("./serviceUser");

const safeRequestId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const safeSlug = (value) => typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(value);

const closeBlockedError = (message) => Object.assign(new Error(message), { code: "CLOSE_BLOCKED" });

const isRetryableCloseFailure = (error) => {
  if (error?.code === "CLOSE_BLOCKED") return false;
  if (error?.code === "CLOSE_RETRYABLE") return true;
  const commandFailure = error?.commandFailure;
  if (commandFailure?.command === "sudo") {
    return commandFailure.exitCode === 75
      || (commandFailure.exitCode === 8 && /userdel:.*currently used by process/i.test(commandFailure.stderr || ""));
  }
  return !commandFailure;
};

const closeDependencyFailure = (message, dependencies) => {
  const failedDependencies = dependencies.filter((dependency) => !dependency.succeeded);
  const retryable = failedDependencies.length > 0 && failedDependencies.every((dependency) => dependency.retryable);
  return Object.assign(new Error(message), { code: retryable ? "CLOSE_RETRYABLE" : "CLOSE_BLOCKED" });
};

const validateCloseTarget = ({ config, journal, request }) => {
  if (!request || !safeRequestId(request.requestId) || !safeSlug(request.slug)
    || request.hostname !== `${request.slug}.vidkar.com`) {
    throw closeBlockedError("La tarea de cierre no identifica una tienda VIDKAR válida.");
  }
  if (!journal || journal.requestId !== request.requestId || journal.slug !== request.slug
    || journal.hostname !== request.hostname) {
    throw closeBlockedError("El journal no coincide exactamente con la tienda que se solicitó cerrar.");
  }

  const legacyResources = journal.resourceVersion !== 2;
  const expectedSiteDirectory = path.resolve(
    config.deployRoot,
    legacyResources ? request.slug : `${request.slug}--${request.requestId}`,
  );
  const expectedAvailablePath = path.resolve(config.nginxSitesAvailable, `${request.hostname}.conf`);
  const expectedEnabledPath = path.resolve(config.nginxSitesEnabled, `${request.hostname}.conf`);
  const expectedPm2Name = `vidkar-comercio-${request.slug}-${request.requestId.slice(0, 12)}`;
  const expectedCertificateName = certificateNameForRequest(request.slug, request.requestId);
  const expectedRunUser = legacyResources
    ? createLegacyServiceUsername(request.slug)
    : createServiceUsername(request.slug, request.requestId);
  if (path.resolve(journal.siteDirectory || "") !== expectedSiteDirectory
    || path.resolve(journal.nginxAvailablePath || "") !== expectedAvailablePath
    || path.resolve(journal.nginxEnabledPath || "") !== expectedEnabledPath
    || journal.pm2Name !== expectedPm2Name
    || (journal.certificateName && journal.certificateName !== expectedCertificateName)
    || journal.runUser !== expectedRunUser) {
    throw closeBlockedError("El journal contiene rutas o identidades distintas a las asignadas a esta tienda.");
  }
  if (!Number.isInteger(journal.port)
    || journal.port < config.portRangeStart
    || journal.port > config.portRangeEnd) {
    throw closeBlockedError("El journal no contiene un puerto reservado válido para esta tienda.");
  }
  if (!["ACTIVE", "CLOSING", "CLOSE_FAILED", "CLOSED"].includes(journal.state)) {
    throw closeBlockedError("El journal no está en un estado seguro para cerrar una tienda activa.");
  }
};

const closeDeployment = async ({
  assertLease = () => {},
  config,
  closeSteps = [],
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
  const failures = [];
  const warnings = [];
  const previousSteps = new Map((Array.isArray(closeSteps) ? closeSteps : []).map((step) => [step.id, step]));
  const previousCertificateStep = previousSteps.get("remove_certificate");
  const certificatePreviouslyPreserved = previousCertificateStep?.status === "COMPLETADO"
    && /Certbot conservó/u.test(previousCertificateStep.message || "");
  if (certificatePreviouslyPreserved) {
    warnings.push("Certbot conservó un certificado compartido, legacy sin propiedad verificable, referenciado por otro servicio o no verificable.");
  }
  const privilegedHelper = createPrivilegedHelperRunner({ config, runner });
  const labels = {
    stop_pm2: "Detener PM2",
    remove_nginx: "Retirar Nginx y systemd",
    remove_certificate: "Retirar el certificado exclusivo",
    remove_site: "Eliminar archivos y cuenta de servicio",
  };

  const runStep = async (
    stepId,
    action,
    formatSuccess = () => `${labels[stepId]}: completado.`,
    onAlreadyCompleted = () => null,
  ) => {
    const label = labels[stepId];
    const previousStep = previousSteps.get(stepId);
    if (previousStep?.status === "COMPLETADO") {
      assertLease();
      logger.info?.(`CLOSE SKIP step=${stepId} reason=already_completed`);
      return { result: onAlreadyCompleted(previousStep), retryable: false, succeeded: true, skipped: true };
    }
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
      return { result, retryable: false, succeeded: true };
    } catch (error) {
      if (error?.code === "WORKER_LEASE_LOST") throw error;
      assertLease();
      const retryable = isRetryableCloseFailure(error);
      errors.push(`${label}: no se pudo completar.`);
      failures.push({ retryable, stepId });
      try {
        await onCloseStep(stepId, "FAILED", retryable
          ? `${label}: el sistema reintentará automáticamente.`
          : `${label}: bloqueo de seguridad o propiedad; requiere revisión.`);
      } catch (reportError) {
        if (reportError?.code === "WORKER_LEASE_LOST") throw reportError;
        logger.warn?.(`[comercio-provisioner] No se pudo reportar el paso de cierre ${stepId}.`);
      }
      logger.error?.(`CLOSE FAIL step=${stepId} durationMs=${Date.now() - startedAt} reason=${error?.message || "error inesperado"}`);
      return { result: null, retryable, succeeded: false };
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
      throw Object.assign(new Error("El puerto de esta tienda sigue ocupado después de detener PM2."), {
        code: "CLOSE_RETRYABLE",
      });
    }
  });

  const nginxRemoved = await runStep("remove_nginx", async () => {
    if (!pm2Stopped.succeeded) {
      throw closeDependencyFailure("PM2 no se detuvo; se conserva Nginx y el sitio.", [pm2Stopped]);
    }
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
      throw closeDependencyFailure(
        "Se conserva el certificado mientras PM2 o la configuración Nginx no estén retirados.",
        [pm2Stopped, nginxRemoved],
      );
    }
    const result = await privilegedHelper.run("remove-certificate", [
      request.slug,
      request.requestId,
      config.nginxSitesAvailable,
      config.nginxSitesEnabled,
      journal.runUser,
      "2",
    ], { timeoutMs: config.commandTimeoutMs });
    const preservedCertificate = (result?.stdoutTail || "").split(/\r?\n/u)
      .some((line) => /^CERTIFICATE_PRESERVED(?:_[A-Z_]+)?$/u.test(line));
    if (preservedCertificate) {
      warnings.push("Certbot conservó un certificado compartido, legacy sin marcador, referenciado por otro servicio o no verificable.");
    }
    return { preservedCertificate };
  }, (result) => result?.preservedCertificate
    ? "Certbot conservó un certificado compartido, legacy sin propiedad verificable o referenciado por otro servicio."
    : "Se retiró el certificado exclusivo de este dominio, o no había uno que retirar.",
  () => ({ preservedCertificate: certificatePreviouslyPreserved }));

  await runStep("remove_site", async () => {
    if (!pm2Stopped.succeeded || !nginxRemoved.succeeded || !certificateRemoved.succeeded) {
      throw closeDependencyFailure(
        "Se conservan los archivos y la cuenta mientras haya recursos previos sin reconciliar.",
        [pm2Stopped, nginxRemoved, certificateRemoved],
      );
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
    failures.push({ retryable: true, stepId: "journal" });
  }

  return {
    closeSucceeded: errors.length === 0,
    errors,
    retryable: errors.length > 0 && failures.length > 0 && failures.every((failure) => failure.retryable),
    warnings,
  };
};

module.exports = { closeDeployment, isRetryableCloseFailure, validateCloseTarget };
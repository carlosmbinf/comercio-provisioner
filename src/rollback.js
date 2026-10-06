const fs = require("node:fs/promises");
const path = require("node:path");
const { isPortAvailable } = require("./deployment");
const { createPrivilegedHelperRunner } = require("./privilegedHelper");

const isInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const rollbackDeployment = async ({ assertLease = () => {}, config, journal, logger = console, onRollbackStep = async () => {}, runner, stateStore }) => {
  const errors = [];
  const privilegedHelper = createPrivilegedHelperRunner({ config, runner });
  const runRollbackStep = async (stepId, label, operation) => {
    const startedAt = Date.now();
    const report = async (outcome, message) => {
      try {
        await onRollbackStep(stepId, outcome, message);
      } catch (error) {
        if (error?.code === "WORKER_LEASE_LOST") throw error;
        logger.warn?.(`[comercio-provisioner] No se pudo reportar la etapa rollback ${stepId}.`);
      }
    };
    assertLease();
    logger.info?.(`ROLLBACK START step=${stepId} detail=${label}`);
    await report("STARTED", `${label}: iniciado.`);
    try {
      assertLease();
      const operationResult = await operation();
      assertLease();
      const completedMessage = typeof operationResult === "string"
        ? operationResult
        : `${label}: completado.`;
      await report("COMPLETED", completedMessage);
      logger.info?.(`ROLLBACK OK step=${stepId} durationMs=${Date.now() - startedAt}`);
      return true;
    } catch (error) {
      if (error?.code === "WORKER_LEASE_LOST") throw error;
      assertLease();
      errors.push(`${label}: no se pudo completar.`);
      await report("FAILED", `${label}: requiere revisión.`);
      logger.error?.(`ROLLBACK FAIL step=${stepId} durationMs=${Date.now() - startedAt} reason=${error?.message || "error inesperado"}`);
      return false;
    }
  };

  if (journal.state === "ROLLED_BACK") {
    for (const [stepId, label] of [
      ["stop_pm2", "Detener PM2"],
      ["remove_nginx", "Retirar Nginx"],
      ["remove_certificate", "Retirar el certificado exclusivo"],
      ["remove_site", "Eliminar la copia"],
    ]) {
      await runRollbackStep(stepId, label, async () => {});
    }
    return { errors, rollbackSucceeded: true };
  }

  const pm2MayBeRunning = Boolean(journal.pm2StartAttempted || journal.pm2Started);
  const pm2Stopped = await runRollbackStep("stop_pm2", "Detener PM2", async () => {
    if (journal.pm2StartAttempted || journal.pm2Started) {
      await privilegedHelper.run("pm2-delete", [journal.slug, journal.requestId, journal.runUser], {
        timeoutMs: config.commandTimeoutMs,
      });
      if (Number.isInteger(journal.port) && !(await isPortAvailable(journal.port))) {
        throw new Error("PM2 no pudo detener el proceso que ocupa el puerto reservado.");
      }
    }
  });

  const nginxRemoved = await runRollbackStep("remove_nginx", "Retirar Nginx", async () => {
    if (pm2MayBeRunning && !pm2Stopped) {
      throw new Error("Se conserva Nginx y el sitio porque no se pudo confirmar que PM2 esté detenido.");
    }
    if (journal.nginxChanged || journal.siteDirectoryCreated) {
      await privilegedHelper.run("remove-nginx", [
        journal.slug,
        journal.requestId,
        config.nginxSitesAvailable,
        config.nginxSitesEnabled,
        config.acmeWebroot,
        journal.runUser,
      ], { timeoutMs: config.commandTimeoutMs });
    }
  });

  const certificateRemoved = await runRollbackStep("remove_certificate", "Retirar el certificado exclusivo", async () => {
    if (pm2MayBeRunning && !pm2Stopped) {
      throw new Error("Se conserva el certificado porque no se pudo confirmar que PM2 esté detenido.");
    }
    if (!nginxRemoved) throw new Error("Se conserva el certificado mientras no se retire Nginx.");
    if (journal.siteDirectoryCreated || journal.certificateIssued) {
      const result = await privilegedHelper.run("remove-certificate", [
        journal.slug,
        journal.requestId,
        config.nginxSitesAvailable,
        config.nginxSitesEnabled,
        journal.runUser,
        "3",
      ], { timeoutMs: config.commandTimeoutMs });
      if ((result?.stdoutTail || "").split(/\r?\n/).includes("CERTIFICATE_CACHED_FOR_RETRY")) {
        return `Se conservó el certificado válido de ${journal.hostname} en la caché privada de esta solicitud para reutilizarlo al reintentar.`;
      }
      const preserved = (result?.stdoutTail || "").split(/\r?\n/)
        .filter((line) => /^CERTIFICATE_PRESERVED(?:_[A-Z_]+)?$/.test(line));
      if (preserved.length) {
        const message = `Certbot conservó el certificado de ${journal.hostname}; no se pudo demostrar que fuera exclusivo de esta solicitud (${[...new Set(preserved)].join(", ")}).`;
        logger.warn?.(`[comercio-provisioner] ${message}`);
        return message;
      }
      return `Se retiró el certificado exclusivo de ${journal.hostname}, o no había uno que retirar.`;
    }
  });

  await runRollbackStep("remove_site", "Eliminar la copia", async () => {
    if (pm2MayBeRunning && !pm2Stopped) {
      throw new Error("Se conserva la cuenta y el sitio porque no se pudo confirmar que PM2 esté detenido.");
    }
    if (!nginxRemoved || !certificateRemoved) {
      throw new Error("Se conservan la cuenta y el sitio mientras Nginx o el certificado no estén reconciliados.");
    }
    if (journal.siteDirectoryCreated) {
      await privilegedHelper.run("remove-site", [journal.slug, journal.requestId, journal.runUser], {
        timeoutMs: config.commandTimeoutMs,
      });
    }
    if (journal.checkoutDirectoryCreated && journal.checkoutDirectory) {
      if (!isInside(config.stateDir, journal.checkoutDirectory)) {
        throw new Error("La ruta de staging quedó fuera del directorio de estado.");
      }
      const info = await fs.lstat(journal.checkoutDirectory).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (info?.isSymbolicLink() || (info && !info.isDirectory())) {
        throw new Error("La ruta de staging no es un directorio regular.");
      }
      if (info) await fs.rm(journal.checkoutDirectory, { force: true, recursive: true });
    }
  });

  const rollbackSucceeded = errors.length === 0;
  const nextJournal = {
    ...journal,
    rollbackErrors: errors,
    state: rollbackSucceeded ? "ROLLED_BACK" : "ROLLBACK_FAILED",
    updatedAt: new Date().toISOString(),
  };
  try {
    await stateStore.write(journal.requestId, nextJournal);
  } catch (_error) {
    errors.push("No se pudo actualizar el journal local del rollback.");
  }

  return { errors, rollbackSucceeded: errors.length === 0 };
};

module.exports = { isInside, rollbackDeployment };

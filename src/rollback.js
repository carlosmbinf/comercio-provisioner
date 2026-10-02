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
    const report = async (outcome, message) => {
      try {
        await onRollbackStep(stepId, outcome, message);
      } catch (error) {
        if (error?.code === "WORKER_LEASE_LOST") throw error;
        logger.warn?.(`[comercio-provisioner] No se pudo reportar la etapa rollback ${stepId}.`);
      }
    };
    assertLease();
    await report("STARTED", `${label}: iniciado.`);
    try {
      assertLease();
      await operation();
      assertLease();
      await report("COMPLETED", `${label}: completado.`);
    } catch (error) {
      if (error?.code === "WORKER_LEASE_LOST") throw error;
      assertLease();
      errors.push(`${label}: no se pudo completar.`);
      await report("FAILED", `${label}: requiere revisión.`);
    }
  };

  if (journal.state === "ROLLED_BACK") {
    for (const [stepId, label] of [
      ["stop_pm2", "Detener PM2"],
      ["remove_nginx", "Retirar Nginx"],
      ["remove_site", "Eliminar la copia"],
    ]) {
      await runRollbackStep(stepId, label, async () => {});
    }
    return { errors, rollbackSucceeded: true };
  }

  await runRollbackStep("stop_pm2", "Detener PM2", async () => {
    if (journal.pm2StartAttempted || journal.pm2Started) {
      await privilegedHelper.run("pm2-delete", [journal.slug, journal.requestId, journal.runUser], {
        timeoutMs: config.commandTimeoutMs,
      });
      if (Number.isInteger(journal.port) && !(await isPortAvailable(journal.port))) {
        throw new Error("PM2 no pudo detener el proceso que ocupa el puerto reservado.");
      }
    }
  });

  await runRollbackStep("remove_nginx", "Retirar Nginx", async () => {
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

  await runRollbackStep("remove_site", "Eliminar la copia", async () => {
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

  if (!journal.certificateIssued) {
    // Certbot puede dejar metadatos locales de una emisión interrumpida; no se borran
    // certificados sin validar que pertenecen exclusivamente a esta solicitud.
  } else {
    logger.warn?.(`[comercio-provisioner] Se conserva el certificado de ${journal.hostname}; Certbot registra su propio ciclo de vida.`);
  }

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

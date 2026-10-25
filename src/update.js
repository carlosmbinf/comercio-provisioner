const fs = require("node:fs/promises");
const path = require("node:path");
const { validateCloseTarget } = require("./closure");
const { checkoutRepository, waitForHealth } = require("./deployment");
const { createPrivilegedHelperRunner } = require("./privilegedHelper");
const { sanitizeMessage } = require("./workerUtils");

const updateDeployment = async ({
  assertLease = () => {},
  config,
  fetchImpl = fetch,
  logger = console,
  request,
  runner,
  stateStore,
}) => {
  const journal = await stateStore.read(request.requestId);
  validateCloseTarget({ config, journal, request });
  if (journal.state !== "ACTIVE" || !/^[a-f0-9]{32}$/.test(request.updateId || "")) {
    throw new Error("La tienda no tiene un journal activo o la actualización no es válida.");
  }
  const helper = createPrivilegedHelperRunner({ config, runner });
  const args = [request.slug, request.requestId, journal.runUser];
  const runHelper = (operation, timeoutMs = config.commandTimeoutMs) => {
    assertLease();
    return helper.run(operation, args, { timeoutMs });
  };
  const persist = async (phase, extra = {}) => {
    assertLease();
    journal.codeUpdate = { ...journal.codeUpdate, ...extra, id: request.updateId, phase };
    await stateStore.write(request.requestId, journal);
  };
  const checkSite = async () => {
    assertLease();
    await waitForHealth(`http://127.0.0.1:${journal.port}/`, fetchImpl);
    assertLease();
    await waitForHealth(`https://${request.hostname}/`, fetchImpl);
    assertLease();
  };
  const restore = async () => {
    await runHelper("restore-update");
    await runHelper("pm2-restart");
    await runHelper("pm2-save");
    await checkSite();
  };
  const previous = journal.codeUpdate;
  if (previous && !["COMPLETED", "FAILED", "RESTORE_FAILED"].includes(previous.phase)) {
    logger.warn?.("UPDATE RECOVERY se reconciliará la versión anterior antes de aceptar otra actualización");
    if (["ACTIVATING", "VERIFYING", "RESTORING"].includes(previous.phase)) {
      await persist("RESTORING");
      await restore();
    }
    await persist("FAILED", { message: "La actualización se interrumpió; se conservó o restauró la versión anterior." });
    return { succeeded: false, message: journal.codeUpdate.message, commit: "" };
  }
  if (previous?.phase === "RESTORE_FAILED") {
    await persist("RESTORING");
    await restore();
    await persist("FAILED", { message: "Se recuperó la versión anterior. Solicita nuevamente la actualización." });
    return { succeeded: false, message: journal.codeUpdate.message, commit: "" };
  }
  if (previous?.id === request.updateId && ["COMPLETED", "FAILED"].includes(previous.phase)) {
    return { succeeded: previous.phase === "COMPLETED", message: previous.message, commit: previous.commit || "" };
  }

  const checkoutDirectory = path.join(config.stateDir, "checkouts", request.requestId);
  let activating = false;
  try {
    await persist("PREPARING", { commit: "", message: "" });
    await fs.mkdir(path.dirname(checkoutDirectory), { recursive: true, mode: 0o700 });
    try {
      const stat = await fs.lstat(checkoutDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw new Error("El checkout temporal no tiene una propiedad segura.");
      }
      await fs.rm(checkoutDirectory, { recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assertLease();
    await checkoutRepository({ config, directory: checkoutDirectory, runner });
    const revision = await runner.runCommand("git", ["-C", checkoutDirectory, "rev-parse", "HEAD"], {
      captureTailLength: 128,
      envOverrides: { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      timeoutMs: config.commandTimeoutMs,
    });
    const commit = revision.stdoutTail.trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Git no devolvió una revisión válida.");
    await persist("PREPARING", { commit });
    await runHelper("prepare-update", config.npmTimeoutMs);
    await persist("ACTIVATING");
    activating = true;
    await runHelper("activate-update");
    await runHelper("pm2-restart");
    await runHelper("pm2-save");
    await persist("VERIFYING");
    await checkSite();
    const message = `Código actualizado a ${commit.slice(0, 12)}; solo se reinició esta tienda.`;
    await persist("COMPLETED", { message });
    return { succeeded: true, commit, message };
  } catch (error) {
    assertLease();
    let message = sanitizeMessage(error.message || "Falló la actualización del código.");
    if (activating) {
      try {
        await persist("RESTORING");
        await restore();
        message += " Se restauró la versión anterior.";
      } catch (restoreError) {
        assertLease();
        message += ` No se pudo confirmar la restauración: ${sanitizeMessage(restoreError.message)}. Requiere revisión o un nuevo intento de recuperación.`;
        await persist("RESTORE_FAILED", { message });
        logger.error?.(`UPDATE RESTORE_FAILED ${message}`);
        return { succeeded: false, message, commit: "" };
      }
    } else {
      message += " No se sustituyó la versión activa.";
    }
    await persist("FAILED", { message });
    logger.error?.(`UPDATE FAILED ${message}`);
    return { succeeded: false, message, commit: "" };
  }
};

module.exports = { updateDeployment };

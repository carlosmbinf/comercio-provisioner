const { deployRequest } = require("./deployment");
const { rollbackDeployment } = require("./rollback");
const { createLogger } = require("./logger");
const { sanitizeMessage } = require("./workerUtils");
const { sleep } = require("./taskLock");

const shouldFinishRecoveredDeployment = (task, journal) => !task.rollbackOnly
  && (journal.state === "ACTIVE" || journal.completedSteps?.includes("verify_site"));

const confirmFinishOrDefer = async ({ finish, logger = console, onUnconfirmed = () => {}, wait = sleep }) => {
  const finishConfirmed = async () => {
    const result = await finish();
    if (result?.success === true && result?.status === "COMPLETADA") return result;
    const error = new Error("El servidor no confirmó la finalización de la tienda.");
    error.code = "FINISH_UNCONFIRMED";
    throw error;
  };
  const throwIfStepsIncomplete = (error) => {
    if (error?.error === "provisioner-steps-incomplete" || error?.code === "provisioner-steps-incomplete") {
      throw error;
    }
  };
  try {
    await finishConfirmed();
    return true;
  } catch (firstError) {
    throwIfStepsIncomplete(firstError);
    try {
      await wait(500);
      await finishConfirmed();
      return true;
    } catch (retryError) {
      throwIfStepsIncomplete(retryError);
      onUnconfirmed(retryError);
      logger.error("[comercio-provisioner] No se pudo confirmar finish después del reintento; se conservan los recursos y se esperará a reconciliar el estado con VIDKAR.");
      return false;
    }
  }
};

const createFencedClient = ({ client, config, task, assertLease, onLeaseLost = () => {} }) => ({
  call: async (...args) => {
    const [method, token, workerId, requestId, ...rest] = args;
    if (!method.startsWith("comercio.provisioning.worker.")) {
      return client.call(...args);
    }
    if (token !== config.token || workerId !== config.workerId || requestId !== task.requestId) {
      throw new Error("La llamada DDP no coincide con la tarea y el worker asignados.");
    }
    assertLease();
    try {
      return await client.call(method, token, workerId, requestId, task.leaseToken, ...rest);
    } catch (error) {
      if (["provisioner-lease-lost", "provisioner-request-not-owned"].includes(error?.error)
        || /lease (?:vencido|perdido)|ya no posee el lease/i.test(String(error?.reason || error?.message || ""))) {
        onLeaseLost();
        const leaseError = new Error("El backend confirmó que esta ejecución perdió el lease.");
        leaseError.code = "WORKER_LEASE_LOST";
        throw leaseError;
      }
      throw error;
    }
  },
});

const startWorker = ({
  client,
  config,
  logger = console,
  runner,
  stateStore,
  taskLock,
  deploy = deployRequest,
  rollback = rollbackDeployment,
}) => {
  const rootLogger = createLogger({ workerId: config.workerId }, logger);
  let stopping = false;
  let activeRequestId = "";
  let activeLeaseToken = "";
  let activeLeaseLost = false;
  let activeAbortController = null;
  let heartbeatBusy = false;
  let loopPromise;

  const callWorker = (method, ...args) => client.call(method, config.token, config.workerId, ...args);
  const setActiveTask = (task) => {
    activeRequestId = task.requestId;
    activeLeaseToken = task.leaseToken;
    activeLeaseLost = false;
    activeAbortController = new AbortController();
  };
  const clearActiveTask = () => {
    activeRequestId = "";
    activeLeaseToken = "";
    activeLeaseLost = false;
    activeAbortController = null;
  };
  const assertLease = () => {
    if (!activeRequestId || !activeLeaseToken || activeLeaseLost) {
      const error = new Error("El worker perdió el lease de la solicitud.");
      error.code = "WORKER_LEASE_LOST";
      throw error;
    }
  };
  const markLeaseLost = () => {
    activeLeaseLost = true;
    activeAbortController?.abort();
  };
  const createTaskRunner = (lock, taskLogger) => ({
    runCommand: (command, args, options = {}) => {
      assertLease();
      return runner.runCommand(command, args, {
        ...options,
        logger: taskLogger,
        signal: activeAbortController?.signal,
        onSpawn: (processGroupId) => {
          lock.registerProcessGroup(processGroupId);
          return options.onSpawn?.(processGroupId);
        },
        onClose: async (processGroupId) => {
          lock.unregisterProcessGroup(processGroupId);
          await options.onClose?.(processGroupId);
        },
      });
    },
  });
  const acquireTaskLock = async (requestId) => {
    while (!stopping) {
      try {
        return await taskLock.acquire(requestId);
      } catch (error) {
        if (error?.code !== "TASK_LOCK_BUSY") throw error;
        if (activeRequestId === requestId) await sendHeartbeat();
        if (activeLeaseLost) throw new Error("El worker perdió el lease mientras esperaba el lock local.");
        await sleep(1000);
      }
    }
    throw new Error("El worker está cerrando; no se iniciará una tarea nueva.");
  };

  const processRecovery = async (task) => {
    const taskLogger = rootLogger.child({
      flow: task.rollbackOnly ? "rollback-retry" : "recovery",
      hostname: task.hostname,
      requestId: task.requestId,
      slug: task.slug,
    });
    taskLogger.info("FLOW START recuperación");
    setActiveTask(task);
    let lock;
    const fencedClient = createFencedClient({ assertLease, client, config, onLeaseLost: markLeaseLost, task });
    try {
      lock = await acquireTaskLock(task.requestId);
      assertLease();
      const taskRunner = createTaskRunner(lock, taskLogger);
      await fencedClient.call(
        "comercio.provisioning.worker.heartbeat",
        config.token,
        config.workerId,
        task.requestId,
      );
      const journal = await stateStore.read(task.requestId);
      if (!journal) {
        taskLogger.error("RECOVERY FAIL journal local ausente; requiere revisión manual");
        await fencedClient.call(
          "comercio.provisioning.worker.beginRollback",
          config.token,
          config.workerId,
          task.requestId,
          "No existe journal local; no se puede confirmar qué recursos se crearon.",
        );
        await fencedClient.call(
          "comercio.provisioning.worker.finishRecovery",
          config.token,
          config.workerId,
          task.requestId,
          false,
          "No existe journal de cambios; no se puede confirmar qué recursos se crearon y se requiere revisión manual.",
        );
        return;
      }
      if (shouldFinishRecoveredDeployment(task, journal)) {
        try {
          const finishResult = await fencedClient.call(
            "comercio.provisioning.worker.finish",
            config.token,
            config.workerId,
            task.requestId,
          );
          if (finishResult?.success === true && finishResult?.status === "COMPLETADA") return;
          const error = new Error("VIDKAR no confirmó la finalización de la tarea recuperada.");
          error.code = "FINISH_UNCONFIRMED";
          throw error;
        } catch (error) {
          if (error?.error !== "provisioner-steps-incomplete" && error?.code !== "provisioner-steps-incomplete") {
            throw error;
          }
        }
      }
      await fencedClient.call(
        "comercio.provisioning.worker.beginRollback",
        config.token,
        config.workerId,
        task.requestId,
        "El journal indica una instalación incompleta; se iniciará su rollback.",
      );
      const result = await rollback({
        assertLease,
        config,
        journal,
        logger: taskLogger,
        onRollbackStep: (stepId, outcome, message) => fencedClient.call(
          "comercio.provisioning.worker.reportRollbackStep",
          config.token,
          config.workerId,
          task.requestId,
          stepId,
          outcome,
          message,
        ),
        runner: taskRunner,
        stateStore,
      });
      taskLogger.info(`FLOW ${result.rollbackSucceeded ? "OK" : "FAIL"} recuperación de rollback`);
      await fencedClient.call(
        "comercio.provisioning.worker.finishRecovery",
        config.token,
        config.workerId,
        task.requestId,
        result.rollbackSucceeded,
        result.errors.join(" "),
      );
    } catch (error) {
      taskLogger.error(`RECOVERY FAIL reason=${sanitizeMessage(error?.message || "error inesperado")}`);
      throw error;
    } finally {
      await lock?.release();
      clearActiveTask();
    }
  };

  const processDeployment = async (task) => {
    const taskLogger = rootLogger.child({
      flow: "deploy",
      hostname: task.hostname,
      requestId: task.requestId,
      slug: task.slug,
    });
    taskLogger.info("FLOW START aprovisionamiento");
    setActiveTask(task);
    let lock;
    const fencedClient = createFencedClient({ assertLease, client, config, onLeaseLost: markLeaseLost, task });
    try {
      lock = await acquireTaskLock(task.requestId);
      assertLease();
      const taskRunner = createTaskRunner(lock, taskLogger);
      const result = await deploy({
        assertLease,
        client: fencedClient,
        config,
        logger: taskLogger,
        runner: taskRunner,
        stateStore,
        request: task,
      });
      if (result?.blockedDns) {
        taskLogger.warn("FLOW BLOCKED DNS no apunta al VPS; se detuvo antes de clonar");
        return;
      }
      assertLease();
      const finishConfirmed = await confirmFinishOrDefer({
        finish: () => fencedClient.call(
          "comercio.provisioning.worker.finish",
          config.token,
          config.workerId,
          task.requestId,
        ),
        logger: taskLogger,
        onUnconfirmed: () => {
          activeLeaseLost = true;
          activeAbortController?.abort();
        },
      });
      if (!finishConfirmed) return;
      taskLogger.info("FLOW OK aprovisionamiento confirmado por VIDKAR");
    } catch (error) {
      if (error?.code === "TASK_LOCK_BUSY") {
        taskLogger.warn("FLOW SKIP otra ejecución local posee el lock");
        return;
      }
      if (activeLeaseLost || error?.error === "provisioner-lease-lost" || error?.code === "WORKER_LEASE_LOST") {
        activeLeaseLost = true;
        activeAbortController?.abort();
        taskLogger.warn("FLOW ABORTED lease perdido; comandos cancelados y recuperación delegada al nuevo propietario");
        return;
      }
      taskLogger.error(`FLOW FAIL reason=${sanitizeMessage(error?.message || "error inesperado")}; inicia rollback`);
      const journal = error?.provisionerJournal || await stateStore.read(task.requestId).catch(() => null);
      let rollbackResult = {
        errors: ["No se pudo leer el journal; no se puede confirmar el rollback."],
        rollbackSucceeded: false,
      };

      if (lock && journal) {
        try {
          await fencedClient.call(
            "comercio.provisioning.worker.beginRollback",
            config.token,
            config.workerId,
            task.requestId,
            sanitizeMessage(error?.message || "Falló una tarea del aprovisionamiento."),
          );
        } catch (_beginRollbackError) {
          taskLogger.warn("ROLLBACK no se pudo publicar el inicio; se continuará bajo el lock local");
        }
        try {
          rollbackResult = await rollback({
            assertLease,
            config,
            journal,
            logger: taskLogger,
            onRollbackStep: (stepId, outcome, message) => fencedClient.call(
              "comercio.provisioning.worker.reportRollbackStep",
              config.token,
              config.workerId,
              task.requestId,
              stepId,
              outcome,
              message,
            ),
            runner: createTaskRunner(lock, taskLogger),
            stateStore,
          });
        } catch (_rollbackError) {
          rollbackResult = { errors: ["El proceso de rollback lanzó un error inesperado."], rollbackSucceeded: false };
        }
      }
      taskLogger.info(`FLOW ${rollbackResult.rollbackSucceeded ? "ROLLED_BACK" : "ROLLBACK_FAILED"}`);

      const publicMessage = sanitizeMessage(error?.message || "Falló una tarea del aprovisionamiento.");
      const combinedMessage = [publicMessage, ...rollbackResult.errors].filter(Boolean).join(" ").slice(0, 500);
      try {
        await fencedClient.call(
          "comercio.provisioning.worker.fail",
          config.token,
          config.workerId,
          task.requestId,
          combinedMessage,
          rollbackResult.rollbackSucceeded,
        );
      } catch (_reportError) {
        taskLogger.warn("FLOW REPORT_FAILED el lease vigente permitirá recuperar la tarea");
      }
    } finally {
      await lock?.release();
      clearActiveTask();
    }
  };

  const sendHeartbeat = async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      await callWorker("comercio.provisioning.worker.heartbeat", activeRequestId, activeLeaseToken);
    } catch (_error) {
      if (activeRequestId) {
        activeLeaseLost = true;
        activeAbortController?.abort();
      }
      rootLogger.warn("HEARTBEAT FAIL; se intentará de nuevo");
    } finally {
      heartbeatBusy = false;
    }
  };

  const runLoop = async () => {
    const processLock = await taskLock.acquire("worker-process");
    let heartbeatTimer;
    try {
      await client.connect();
      await client.call(
        "comercio.provisioning.worker.register",
        config.token,
        config.workerId,
        config.publicIpv4,
      );
      rootLogger.info("WORKER registrado; esperando tareas con DNS verificado");

      heartbeatTimer = setInterval(sendHeartbeat, Math.min(config.heartbeatIntervalMs, 30000));
      heartbeatTimer.unref?.();
      while (!stopping) {
        try {
          const task = await callWorker("comercio.provisioning.worker.claimNext");
          if (!task) {
            await sleep(config.pollIntervalMs);
            continue;
          }
          if (!task.leaseToken) throw new Error("El backend no asignó un fencing token al trabajo.");
          if (task.recoveryRequired) await processRecovery(task);
          else await processDeployment(task);
        } catch (error) {
          rootLogger.warn(`QUEUE FAIL reason=${sanitizeMessage(error?.message || "error de conexión")}`);
          await sleep(config.pollIntervalMs);
        }
      }
    } finally {
      clearInterval(heartbeatTimer);
      await processLock.release();
    }
  };

  loopPromise = runLoop();
  loopPromise.catch(() => {});
  return {
    done: loopPromise,
    stop: () => { stopping = true; },
  };
};

module.exports = { confirmFinishOrDefer, createFencedClient, shouldFinishRecoveredDeployment, startWorker };

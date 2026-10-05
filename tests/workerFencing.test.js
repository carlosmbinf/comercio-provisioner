const assert = require("node:assert/strict");
const test = require("node:test");

const {
  confirmCloseOrDefer,
  confirmFinishOrDefer,
  createFencedClient,
  runCloseWithAutomaticRetries,
  shouldFinishRecoveredDeployment,
  startWorker,
} = require("../src/worker");

test("un retry manual de rollback nunca finaliza un journal de deployment activo", () => {
  const activeJournal = { completedSteps: ["verify_site"], state: "ACTIVE" };

  assert.equal(shouldFinishRecoveredDeployment({ rollbackOnly: true }, activeJournal), false);
  assert.equal(shouldFinishRecoveredDeployment({ rollbackOnly: false }, activeJournal), true);
  assert.equal(shouldFinishRecoveredDeployment({}, { completedSteps: [], state: "STARTING" }), false);
});

test("el cliente DDP añade el lease firmado a operaciones de la tarea actual", async () => {
  const calls = [];
  const task = { leaseToken: "lease-secret", requestId: "request-1" };
  const config = { token: "worker-token", workerId: "worker-a" };
  const client = { call: async (...args) => { calls.push(args); return true; } };
  const fenced = createFencedClient({ assertLease() {}, client, config, task });

  await fenced.call("comercio.provisioning.worker.finish", "worker-token", "worker-a", "request-1");
  assert.deepEqual(calls[0], [
    "comercio.provisioning.worker.finish",
    "worker-token",
    "worker-a",
    "request-1",
    "lease-secret",
  ]);
});

test("el fencing rechaza identidad, request distinto o lease local perdido", async () => {
  const calls = [];
  const task = { leaseToken: "lease-secret", requestId: "request-1" };
  const config = { token: "worker-token", workerId: "worker-a" };
  const client = { call: async (...args) => { calls.push(args); return true; } };
  const active = createFencedClient({ assertLease() {}, client, config, task });

  await assert.rejects(
    () => active.call("comercio.provisioning.worker.finish", "worker-token", "worker-a", "request-2"),
    /no coincide/,
  );
  await assert.rejects(
    () => active.call("comercio.provisioning.worker.finish", "wrong-token", "worker-a", "request-1"),
    /no coincide/,
  );
  const lost = createFencedClient({ assertLease() { throw new Error("lease perdido"); }, client, config, task });
  await assert.rejects(
    () => lost.call("comercio.provisioning.worker.finish", "worker-token", "worker-a", "request-1"),
    /lease perdido/,
  );
  assert.equal(calls.length, 0);
});

test("un rechazo del servidor por lease vencido dispara la cancelación local", async () => {
  let leaseWasLost = false;
  const task = { leaseToken: "lease-secret", requestId: "request-1" };
  const config = { token: "worker-token", workerId: "worker-a" };
  const client = {
    call: async () => {
      throw Object.assign(new Error("not owner"), { error: "provisioner-request-not-owned" });
    },
  };
  const fenced = createFencedClient({
    assertLease() {},
    client,
    config,
    onLeaseLost: () => { leaseWasLost = true; },
    task,
  });

  await assert.rejects(
    () => fenced.call("comercio.provisioning.worker.reportStep", "worker-token", "worker-a", "request-1", "step", "STARTED", "start"),
    (error) => error?.code === "WORKER_LEASE_LOST",
  );
  assert.equal(leaseWasLost, true);
});

test("un finish incierto se reintenta una vez y nunca se convierte en rollback automático", async () => {
  let attempts = 0;
  let unconfirmed = 0;
  const confirmed = await confirmFinishOrDefer({
    finish: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Timeout conectando con VIDKAR DDP.");
      return { success: true, status: "COMPLETADA" };
    },
    logger: { error() {} },
    onUnconfirmed: () => { unconfirmed += 1; },
    wait: async () => {},
  });
  assert.equal(confirmed, true);
  assert.equal(attempts, 2);
  assert.equal(unconfirmed, 0);

  attempts = 0;
  const uncertain = await confirmFinishOrDefer({
    finish: async () => { attempts += 1; throw new Error("Timeout de red"); },
    logger: { error() {} },
    onUnconfirmed: () => { unconfirmed += 1; },
    wait: async () => {},
  });
  assert.equal(uncertain, false);
  assert.equal(attempts, 2);
  assert.equal(unconfirmed, 1);
});

test("un finish con pasos incompletos permite que el flujo inicie rollback", async () => {
  await assert.rejects(
    () => confirmFinishOrDefer({
      finish: async () => { throw Object.assign(new Error("pasos pendientes"), { error: "provisioner-steps-incomplete" }); },
      logger: { error() {} },
      onUnconfirmed() { assert.fail("Un error explícito no es un finish incierto"); },
      wait: async () => {},
    }),
    (error) => error?.error === "provisioner-steps-incomplete",
  );
});

test("una respuesta inesperada de finish se reintenta y se difiere sin rollback", async () => {
  let attempts = 0;
  let unconfirmed = 0;
  const confirmed = await confirmFinishOrDefer({
    finish: async () => {
      attempts += 1;
      return attempts === 1 ? { success: true, status: "PENDIENTE" } : { success: true, status: "COMPLETADA" };
    },
    logger: { error() {} },
    onUnconfirmed: () => { unconfirmed += 1; },
    wait: async () => {},
  });

  assert.equal(confirmed, true);
  assert.equal(attempts, 2);
  assert.equal(unconfirmed, 0);
});

test("una respuesta no concluyente repetida se difiere sin rollback", async () => {
  let attempts = 0;
  let unconfirmed = 0;
  const confirmed = await confirmFinishOrDefer({
    finish: async () => { attempts += 1; return { success: true, status: "PENDIENTE" }; },
    logger: { error() {} },
    onUnconfirmed: () => { unconfirmed += 1; },
    wait: async () => {},
  });

  assert.equal(confirmed, false);
  assert.equal(attempts, 2);
  assert.equal(unconfirmed, 1);
});

test("un cierre incierto se reintenta una vez y se deja a recuperación sin repetir borrados", async () => {
  let attempts = 0;
  let deferred = 0;
  const confirmed = await confirmCloseOrDefer({
    finish: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Timeout DDP");
      return { success: true, status: "CERRADA" };
    },
    logger: { error() {} },
    onUnconfirmed: () => { deferred += 1; },
    wait: async () => {},
  });
  assert.equal(confirmed, true);
  assert.equal(attempts, 2);
  assert.equal(deferred, 0);

  attempts = 0;
  const uncertain = await confirmCloseOrDefer({
    finish: async () => { attempts += 1; throw new Error("Timeout DDP"); },
    logger: { error() {} },
    onUnconfirmed: () => { deferred += 1; },
    wait: async () => {},
  });
  assert.equal(uncertain, false);
  assert.equal(attempts, 2);
  assert.equal(deferred, 1);
});

test("el cierre reintenta fallos operativos tres veces con esperas acotadas", async () => {
  const attempts = [];
  const waits = [];
  const result = await runCloseWithAutomaticRetries({
    logger: { warn() {} },
    run: async (attempt) => {
      attempts.push(attempt);
      return attempt < 3
        ? { closeSucceeded: false, retryable: true }
        : { closeSucceeded: true, retryable: false };
    },
    wait: async (delay) => waits.push(delay),
  });

  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(waits, [3000, 10000]);
  assert.equal(result.closeSucceeded, true);
});

test("el cierre no reintenta fallos bloqueados y limita los intentos si persiste el error", async () => {
  let attempts = 0;
  const blocked = await runCloseWithAutomaticRetries({
    logger: { warn() {} },
    run: async () => {
      attempts += 1;
      return { closeSucceeded: false, retryable: false };
    },
    wait: async () => assert.fail("un bloqueo no debe esperar otro intento"),
  });
  assert.equal(attempts, 1);
  assert.equal(blocked.retryable, false);

  attempts = 0;
  const persistent = await runCloseWithAutomaticRetries({
    logger: { warn() {} },
    run: async () => {
      attempts += 1;
      return { closeSucceeded: false, retryable: true };
    },
    wait: async () => {},
  });
  assert.equal(attempts, 3);
  assert.equal(persistent.closeSucceeded, false);
  assert.equal(persistent.retryable, true);
});

test("al detener PM2 el worker se desregistra, desconecta DDP y libera el lock local", async () => {
  const calls = [];
  let resolveRegistered;
  let resolveFirstClaim;
  const registered = new Promise((resolve) => { resolveRegistered = resolve; });
  const firstClaim = new Promise((resolve) => { resolveFirstClaim = resolve; });
  const worker = startWorker({
    client: {
      connect: async () => {},
      disconnect: async () => { calls.push("disconnect"); },
      call: async (method, ...args) => {
        calls.push([method, ...args]);
        if (method === "comercio.provisioning.worker.register") resolveRegistered();
        if (method === "comercio.provisioning.worker.claimNext") {
          resolveFirstClaim();
          return null;
        }
        return { success: true };
      },
    },
    config: {
      heartbeatIntervalMs: 60000,
      pollIntervalMs: 60000,
      publicIpv4: "192.0.2.44",
      token: "worker-token",
      workerId: "worker-session-123",
      workerIdentity: "provisioner-install-1",
    },
    logger: { error() {}, info() {}, warn() {} },
    runner: {},
    stateStore: {},
    taskLock: {
      acquire: async () => ({ release: async () => { calls.push("release-lock"); } }),
    },
  });

  await registered;
  await firstClaim;
  worker.stop();
  await worker.done;

  const methodCalls = calls.filter(Array.isArray);
  assert.deepEqual(methodCalls.map(([method]) => method), [
    "comercio.provisioning.worker.register",
    "comercio.provisioning.worker.claimNext",
    "comercio.provisioning.worker.unregister",
  ]);
  assert.deepEqual(methodCalls[0].slice(1), [
    "worker-token", "worker-session-123", "192.0.2.44", true, "provisioner-install-1",
  ]);
  assert.ok(calls.indexOf("disconnect") < calls.indexOf("release-lock"));
});

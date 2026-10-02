const assert = require("node:assert/strict");
const test = require("node:test");

const { confirmFinishOrDefer, createFencedClient } = require("../src/worker");

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

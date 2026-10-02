const assert = require("node:assert/strict");
const test = require("node:test");

const { createWorkerInstanceId, isValidWorkerId } = require("../src/workerIdentity");

test("cada arranque obtiene identidad efímera distinta para el fencing del backend", () => {
  const suffixes = ["a".repeat(32), "b".repeat(32)];
  const first = createWorkerInstanceId({ configuredId: "worker-prod-1", randomBytes: () => Buffer.from(suffixes.shift(), "hex") });
  const second = createWorkerInstanceId({ configuredId: "worker-prod-1", randomBytes: () => Buffer.from(suffixes.shift(), "hex") });
  assert.notEqual(first, second);
  assert.match(first, /^worker-prod-1-[a-f0-9]{32}$/);
  assert.equal(isValidWorkerId(first), true);
});

test("rechaza identidad configurada insegura", () => {
  assert.throws(() => createWorkerInstanceId({ configuredId: "../root" }), /PROVISIONER_ID/);
});

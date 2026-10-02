const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createTaskLock, isProcessAlive } = require("../src/taskLock");

test("adquiere, bloque una segunda ejecución y libera solo su propio lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vidkar-task-lock-"));
  const lock = createTaskLock({ rootDirectory: root, pid: process.pid, workerId: "worker-a" });
  const secondWorker = createTaskLock({ rootDirectory: root, pid: process.pid + 100000, workerId: "worker-b", kill: () => {} });
  try {
    const acquired = await lock.acquire("request-1");
    await assert.rejects(
      () => secondWorker.acquire("request-1"),
      (error) => error?.code === "TASK_LOCK_BUSY",
    );
    await acquired.release();
    const second = await secondWorker.acquire("request-1");
    await second.release();
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("rechaza identificadores que pudieran escapar de locks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vidkar-task-lock-"));
  const lock = createTaskLock({ rootDirectory: root, workerId: "worker-a" });
  try {
    await assert.rejects(() => lock.acquire("../outside"), /Identificador/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("conserva un lock huérfano mientras queden grupos de comandos del request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vidkar-task-lock-process-"));
  let groupAlive = true;
  const deadOwner = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
  const groupProbe = () => {
    if (!groupAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
  };
  const owner = createTaskLock({ rootDirectory: root, pid: 91001, workerId: "worker-a", kill: deadOwner, killGroup: groupProbe });
  const recovery = createTaskLock({ rootDirectory: root, pid: 91002, workerId: "worker-b", kill: deadOwner, killGroup: groupProbe });
  try {
    const lock = await owner.acquire("request-orphan");
    await lock.registerProcessGroup(91003);
    await lock.release();
    await assert.rejects(
      () => recovery.acquire("request-orphan"),
      (error) => error?.code === "TASK_LOCK_BUSY" && error.activeProcessGroups.includes(91003),
    );
    groupAlive = false;
    const recovered = await recovery.acquire("request-orphan");
    await recovered.release();
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("considera procesos vivos solo con pid válido", () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(100, () => {}), true);
  assert.equal(isProcessAlive(100, () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }), false);
  assert.equal(isProcessAlive(100, () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }), true);
});

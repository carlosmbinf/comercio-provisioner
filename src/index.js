const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

const { loadConfig } = require("./config");
const { runCommand } = require("./commandRunner");
const { createMeteorClient } = require("./meteorClient");
const { createStateStore } = require("./stateStore");
const { createTaskLock } = require("./taskLock");
const { startWorker } = require("./worker");
const { createWorkerInstanceId } = require("./workerIdentity");

let worker;

const start = async () => {
  const config = loadConfig(process.env);
  config.workerIdentity = config.workerId;
  config.workerId = createWorkerInstanceId({ configuredId: config.workerIdentity });
  delete process.env.PROVISIONER_TOKEN;
  delete process.env.PROVISIONER_HELPER_HMAC_SECRET;
  const client = createMeteorClient({
    callTimeoutMs: config.ddpCallTimeoutMs,
    connectTimeoutMs: config.meteorConnectTimeoutMs,
    endpoint: config.meteorDdpEndpoint,
  });
  const runner = { runCommand };
  const stateStore = createStateStore(config.stateDir);
  const taskLock = createTaskLock({ rootDirectory: path.join(config.stateDir, "locks"), workerId: config.workerId });
  worker = startWorker({ client, config, runner, stateStore, taskLock });
  worker.done.catch((error) => {
    console.error(`[comercio-provisioner] El worker se detuvo: ${error?.message || "error inesperado"}`);
    process.exitCode = 1;
  });
};

start().catch((error) => {
  console.error(`[comercio-provisioner] Configuración inválida: ${error?.message || "revisa el .env"}`);
  process.exitCode = 1;
});

const shutdown = async () => {
  worker?.stop();
  try {
    await worker?.done;
  } catch (_error) {
    process.exitCode = 1;
  }
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

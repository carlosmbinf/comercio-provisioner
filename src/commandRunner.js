const { spawn } = require("node:child_process");
const path = require("node:path");

const SAFE_ENVIRONMENT_KEYS = new Set([
  "CI",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_TERMINAL_PROMPT",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NODE_ENV",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
]);

const appendTail = (current, next, maxLength) => `${current}${next}`.slice(-maxLength);
const createSafeEnvironment = (source = process.env, overrides = {}) => {
  const result = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : source[key];
    if (typeof value === "string" && !/[\0\r\n]/.test(value)) result[key] = value;
  }
  if (!result.PATH) result.PATH = "/usr/local/bin:/usr/bin:/bin";
  return result;
};

const runCommand = (command, args = [], options = {}) => new Promise((resolve, reject) => {
  const {
    cwd,
    env = process.env,
    envOverrides = {},
    logger = console,
    timeoutMs = 900000,
    spawnImpl = spawn,
    allowFailure = false,
    captureTailLength = 2048,
    signal,
    onSpawn,
    onClose,
  } = options;
  const safeCommand = path.basename(command);
  let stdoutTail = "";
  let stderrTail = "";
  let settled = false;
  let timeout;
  let killTimeout;
  let processGroupTerminationRequested = false;

  logger.info?.(`[comercio-provisioner] Ejecutando ${safeCommand}.`);
  let child;
  try {
    child = spawnImpl(command, args, {
      cwd,
      env: createSafeEnvironment(env, envOverrides),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (_error) {
    reject(new Error(`No se pudo iniciar ${safeCommand}.`));
    return;
  }

  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(killTimeout);
    signal?.removeEventListener?.("abort", onAbort);
    if (error) reject(error);
    else resolve(result);
  };
  const terminateProcessGroup = (signalName) => {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signalName);
        return;
      } catch (_error) {
        // Fall back to terminating the direct child if the process group is gone.
      }
    }
    child.kill(signalName);
  };
  const onAbort = () => {
    processGroupTerminationRequested = true;
    terminateProcessGroup("SIGTERM");
    killTimeout = setTimeout(() => terminateProcessGroup("SIGKILL"), 3000);
  };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener?.("abort", onAbort, { once: true });
  }

  child.stdout?.on("data", (chunk) => { stdoutTail = appendTail(stdoutTail, chunk.toString(), captureTailLength); });
  child.stderr?.on("data", (chunk) => { stderrTail = appendTail(stderrTail, chunk.toString(), captureTailLength); });
  const notifyClose = async () => {
    try {
      await onClose?.(child.pid);
    } catch (_error) {
      // A local bookkeeping failure must not mask the command result.
    }
  };
  child.once("error", async () => {
    await notifyClose();
    finish(new Error(`No se pudo iniciar ${safeCommand}.`));
  });
  child.once("close", async (code, signal) => {
    if (processGroupTerminationRequested) terminateProcessGroup("SIGKILL");
    await notifyClose();
    const result = { code, signal: signal || null, stderrTail, stdoutTail };
    if (code === 0 || allowFailure) finish(null, result);
    else finish(new Error(`${safeCommand} terminó con código ${code ?? "desconocido"}.`));
  });

  try {
    Promise.resolve(onSpawn?.(child.pid)).catch(() => terminateProcessGroup("SIGTERM"));
  } catch (_error) {
    terminateProcessGroup("SIGTERM");
  }

  timeout = setTimeout(() => {
    processGroupTerminationRequested = true;
    terminateProcessGroup("SIGTERM");
    killTimeout = setTimeout(() => terminateProcessGroup("SIGKILL"), 5000);
  }, timeoutMs);
});

module.exports = { createSafeEnvironment, runCommand };

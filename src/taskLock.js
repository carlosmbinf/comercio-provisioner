const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const isSafeRequestId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readOwner = async (lockPath) => {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const owner = JSON.parse(raw);
    if ((Number.isInteger(owner.pid) && owner.pid > 0)
      || (owner.pid === 0 && Array.isArray(owner.commandGroups))) return owner;
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs < 5000) return { initializing: true, pid: -1 };
    return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    const stat = await fs.stat(lockPath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs < 5000) return { initializing: true, pid: -1 };
    return null;
  }
};

const isProcessAlive = (pid, kill = process.kill) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const isProcessGroupAlive = (pgid, killGroup = process.kill) => {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    killGroup(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const createTaskLock = ({ rootDirectory, pid = process.pid, workerId, kill = process.kill, killGroup = process.kill }) => {
  const root = path.resolve(rootDirectory);

  const acquire = async (requestId) => {
    if (!isSafeRequestId(requestId)) throw new Error("Identificador de tarea no válido para lock local.");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const rootInfo = await fs.lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
      || (typeof process.getuid === "function" && rootInfo.uid !== process.getuid())) {
      throw new Error("El directorio de locks debe ser real y pertenecer al worker.");
    }
    await fs.chmod(root, 0o700);
    const lockPath = path.join(root, `${requestId}.lock`);
    const startedAt = new Date().toISOString();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await fs.open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ commandGroups: [], pid, startedAt, workerId }));
        await handle.close();
        let released = false;
        const updateGroups = (update) => {
          const owner = JSON.parse(fsSync.readFileSync(lockPath, "utf8"));
          if (!owner || owner.pid !== pid || owner.startedAt !== startedAt || owner.workerId !== workerId) {
            throw new Error("El lock local ya no pertenece a esta ejecución.");
          }
          const commandGroups = new Set(owner.commandGroups || []);
          update(commandGroups);
          const temporaryPath = `${lockPath}.${process.pid}.${Date.now()}.tmp`;
          fsSync.writeFileSync(temporaryPath, JSON.stringify({ ...owner, commandGroups: [...commandGroups] }), { mode: 0o600, flag: "wx" });
          fsSync.renameSync(temporaryPath, lockPath);
        };
        return {
          lockPath,
          registerProcessGroup: (processGroupId) => updateGroups((groups) => groups.add(processGroupId)),
          unregisterProcessGroup: (processGroupId) => updateGroups((groups) => {
            if (!isProcessGroupAlive(processGroupId, killGroup)) groups.delete(processGroupId);
          }),
          release: async () => {
            if (released) return;
            released = true;
            const owner = await readOwner(lockPath);
            if (owner?.pid === pid && owner?.startedAt === startedAt && owner?.workerId === workerId) {
              const liveGroups = (owner.commandGroups || []).filter((groupId) => isProcessGroupAlive(groupId, killGroup));
              if (liveGroups.length) {
                const temporaryPath = `${lockPath}.${process.pid}.orphan`;
                await fs.writeFile(temporaryPath, JSON.stringify({ ...owner, commandGroups: liveGroups, pid: 0 }), { mode: 0o600 });
                await fs.rename(temporaryPath, lockPath);
              } else {
                await fs.rm(lockPath, { force: true });
              }
            }
          },
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const owner = await readOwner(lockPath);
        const liveCommandGroups = (owner?.commandGroups || []).filter((groupId) => isProcessGroupAlive(groupId, killGroup));
        if (owner && (owner.initializing || isProcessAlive(owner.pid, kill) || liveCommandGroups.length > 0)) {
          const busy = new Error("Otra ejecución todavía mantiene el lock de esta tarea; no se iniciará un rollback concurrente.");
          busy.code = "TASK_LOCK_BUSY";
          busy.ownerPid = owner.pid;
          busy.activeProcessGroups = liveCommandGroups;
          throw busy;
        }
        await fs.rm(lockPath, { force: true });
      }
    }

    const busy = new Error("No se pudo adquirir el lock local de la tarea.");
    busy.code = "TASK_LOCK_BUSY";
    throw busy;
  };

  return { acquire };
};

module.exports = { createTaskLock, isProcessAlive, isProcessGroupAlive, isSafeRequestId, sleep };

const fs = require("node:fs/promises");
const path = require("node:path");

const isSafeRequestId = (requestId) =>
  typeof requestId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId);

const createStateStore = (rootDirectory, fsApi = fs) => {
  const root = path.resolve(rootDirectory);
  const ensurePrivateRoot = async () => {
    await fsApi.mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await fsApi.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("El stateDir debe ser un directorio real, no un symlink.");
    }
    const processUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (processUid !== null && stat.uid !== processUid) {
      throw new Error(processUid === 0
        ? "El stateDir debe pertenecer a root; migra el estado con el worker detenido antes de ejecutarlo como root."
        : "El stateDir debe pertenecer al usuario del worker.");
    }
    await fsApi.chmod(root, 0o700);
  };
  const statePath = (requestId) => {
    if (!isSafeRequestId(requestId)) throw new Error("Identificador de tarea no válido para el diario local.");
    const resolved = path.resolve(root, `${requestId}.json`);
    if (path.dirname(resolved) !== root) throw new Error("Ruta de diario fuera del directorio permitido.");
    return resolved;
  };

  const read = async (requestId) => {
    await ensurePrivateRoot();
    try {
      const raw = await fsApi.readFile(statePath(requestId), "utf8");
      const journal = JSON.parse(raw);
      if (journal.requestId !== requestId) throw new Error("El diario no coincide con la tarea.");
      return journal;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error("El diario local de aprovisionamiento no es válido.");
    }
  };

  const write = async (requestId, journal) => {
    await ensurePrivateRoot();
    const destination = statePath(requestId);
    const temporary = `${destination}.${process.pid}.tmp`;
    const safeJournal = { ...journal, requestId, updatedAt: new Date().toISOString() };
    await fsApi.writeFile(temporary, JSON.stringify(safeJournal, null, 2), { mode: 0o600 });
    await fsApi.rename(temporary, destination);
    return safeJournal;
  };

  const remove = async (requestId) => {
    await fsApi.rm(statePath(requestId), { force: true });
  };

  const list = async () => {
    await ensurePrivateRoot();
    let entries;
    try {
      entries = await fsApi.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const journals = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const requestId = entry.name.slice(0, -5);
      if (!isSafeRequestId(requestId)) continue;
      const journal = await read(requestId);
      if (journal) journals.push(journal);
    }
    return journals;
  };

  return { list, read, remove, write };
};

module.exports = { createStateStore, isSafeRequestId };

const crypto = require("node:crypto");

const isValidWorkerId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9._-]{3,64}$/.test(value);

const createWorkerInstanceId = ({ configuredId, randomBytes = crypto.randomBytes }) => {
  if (!isValidWorkerId(configuredId)) throw new Error("PROVISIONER_ID no es válido.");
  const suffix = randomBytes(16).toString("hex");
  const workerId = `${configuredId.slice(0, 15)}-${suffix}`;
  if (!isValidWorkerId(workerId)) throw new Error("No se pudo generar una identidad efímera válida.");
  return workerId;
};

module.exports = { createWorkerInstanceId, isValidWorkerId };

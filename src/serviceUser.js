const crypto = require("node:crypto");

const createServiceUsername = (slug) => {
  if (typeof slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(slug)) {
    throw new Error("No se puede crear un usuario de servicio para un slug inválido.");
  }
  return `vcommerce-${crypto.createHash("sha256").update(slug).digest("hex").slice(0, 12)}`;
};

module.exports = { createServiceUsername };

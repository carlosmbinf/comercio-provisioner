const crypto = require("node:crypto");

const validateSlug = (slug) => {
  if (typeof slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(slug)) {
    throw new Error("No se puede crear un usuario de servicio para un slug inválido.");
  }
};

const createLegacyServiceUsername = (slug) => {
  validateSlug(slug);
  return `vcommerce-${crypto.createHash("sha256").update(slug).digest("hex").slice(0, 12)}`;
};

const createServiceUsername = (slug, requestId) => {
  validateSlug(slug);
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) {
    throw new Error("No se puede crear un usuario de servicio sin un requestId válido.");
  }
  const flowHash = crypto.createHash("sha256").update(`${slug}\n${requestId}`).digest("hex").slice(0, 16);
  return `vcomreq-${flowHash}`;
};

module.exports = { createLegacyServiceUsername, createServiceUsername };

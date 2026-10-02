const net = require("node:net");
const path = require("node:path");

const read = (env, key, fallback = "") => String(env[key] ?? fallback).trim();
const isPlaceholder = (value) => !value || /^(?:REEMPLAZAR|CHANGE_ME|<)/i.test(value);
const parseInteger = (env, key, fallback) => {
  const value = Number(read(env, key, String(fallback)));
  return Number.isInteger(value) ? value : NaN;
};
const isSafeAbsolutePath = (value) => path.isAbsolute(value)
  && !/[\r\n\0;$`]/.test(value)
  && !value.split(path.sep).includes("..");

const loadConfig = (env = process.env) => {
  const config = {
    acmeWebroot: read(env, "PROVISIONER_ACME_WEBROOT"),
    certbotEmail: read(env, "PROVISIONER_CERTBOT_EMAIL"),
    commerceDdpUrl: read(env, "COMERCIO_VITE_METEOR_DDP_URL"),
    commerceGoogleMapsApiKey: read(env, "COMERCIO_VITE_GOOGLE_MAPS_API_KEY"),
    commerceHttpUrl: read(env, "COMERCIO_VITE_METEOR_HTTP_URL"),
    deployRoot: read(env, "PROVISIONER_DEPLOY_ROOT"),
    heartbeatIntervalMs: parseInteger(env, "PROVISIONER_HEARTBEAT_INTERVAL_MS", 30000),
    ddpCallTimeoutMs: parseInteger(env, "PROVISIONER_DDP_CALL_TIMEOUT_MS", 12000),
    helperHmacSecret: read(env, "PROVISIONER_HELPER_HMAC_SECRET"),
    meteorConnectTimeoutMs: parseInteger(env, "PROVISIONER_CONNECT_TIMEOUT_MS", 30000),
    meteorDdpEndpoint: read(env, "METEOR_DDP_ENDPOINT"),
    nginxSitesAvailable: read(env, "PROVISIONER_NGINX_SITES_AVAILABLE"),
    nginxSitesEnabled: read(env, "PROVISIONER_NGINX_SITES_ENABLED"),
    privilegedHelper: read(env, "PROVISIONER_PRIVILEGED_HELPER"),
    npmTimeoutMs: parseInteger(env, "PROVISIONER_NPM_TIMEOUT_MS", 900000),
    pollIntervalMs: parseInteger(env, "PROVISIONER_POLL_INTERVAL_MS", 5000),
    portRangeEnd: parseInteger(env, "PROVISIONER_PORT_END", 5899),
    portRangeStart: parseInteger(env, "PROVISIONER_PORT_START", 5200),
    publicIpv4: read(env, "PROVISIONER_PUBLIC_IPV4"),
    repositoryRef: read(env, "COMERCIO_REPOSITORY_REF", "main"),
    repositoryUrl: read(env, "COMERCIO_REPOSITORY_URL"),
    stateDir: read(env, "PROVISIONER_STATE_DIR"),
    token: read(env, "PROVISIONER_TOKEN"),
    workerId: read(env, "PROVISIONER_ID", "vidkar-comercio-provisioner-1"),
    commandTimeoutMs: parseInteger(env, "PROVISIONER_COMMAND_TIMEOUT_MS", 900000),
    certbotTimeoutMs: parseInteger(env, "PROVISIONER_CERTBOT_TIMEOUT_MS", 180000),
  };

  const missing = [];
  for (const key of ["meteorDdpEndpoint", "token", "helperHmacSecret", "publicIpv4", "repositoryUrl", "certbotEmail"]) {
    if (isPlaceholder(config[key])) missing.push(key);
  }
  if (missing.length) throw new Error(`Falta configurar en .env: ${missing.join(", ")}.`);
  if (!/^wss:\/\/.+\/websocket\/?$/i.test(config.meteorDdpEndpoint)) {
    throw new Error("METEOR_DDP_ENDPOINT debe ser WSS y terminar en /websocket.");
  }
  if (config.token.length < 32) throw new Error("PROVISIONER_TOKEN debe tener al menos 32 caracteres aleatorios.");
  if (config.helperHmacSecret.length < 32) throw new Error("PROVISIONER_HELPER_HMAC_SECRET debe tener al menos 32 caracteres aleatorios.");
  if (net.isIP(config.publicIpv4) !== 4) throw new Error("PROVISIONER_PUBLIC_IPV4 debe ser una IPv4 válida.");
  if (!/^git@[^\s:]+:[^\s]+$/.test(config.repositoryUrl) && !/^https:\/\//i.test(config.repositoryUrl)) {
    throw new Error("COMERCIO_REPOSITORY_URL debe usar SSH o HTTPS.");
  }
  if (/^https:\/\//i.test(config.repositoryUrl)) {
    const repositoryUrl = new URL(config.repositoryUrl);
    if (repositoryUrl.username || repositoryUrl.password) {
      throw new Error("No incluyas credenciales dentro de COMERCIO_REPOSITORY_URL.");
    }
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/.test(config.repositoryRef) || config.repositoryRef.includes("..")) {
    throw new Error("COMERCIO_REPOSITORY_REF no es válido.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.certbotEmail)) {
    throw new Error("PROVISIONER_CERTBOT_EMAIL debe ser un correo válido.");
  }

  for (const key of ["deployRoot", "stateDir", "acmeWebroot", "nginxSitesAvailable", "nginxSitesEnabled"]) {
    if (!isSafeAbsolutePath(config[key]) || path.resolve(config[key]) === path.parse(config[key]).root) {
      throw new Error(`${key} debe ser una ruta absoluta segura dentro del VPS.`);
    }
  }
  if (!/^https:\/\//i.test(config.commerceHttpUrl)) {
    throw new Error("COMERCIO_VITE_METEOR_HTTP_URL debe usar HTTPS.");
  }
  if (!/^wss:\/\//i.test(config.commerceDdpUrl)) {
    throw new Error("COMERCIO_VITE_METEOR_DDP_URL debe usar WSS.");
  }
  if (config.portRangeStart < 1024 || config.portRangeEnd > 65535 || config.portRangeStart > config.portRangeEnd) {
    throw new Error("El rango de puertos debe estar entre 1024 y 65535 y en orden ascendente.");
  }
  if (config.nginxSitesAvailable !== "/etc/nginx/sites-available" || config.nginxSitesEnabled !== "/etc/nginx/sites-enabled") {
    throw new Error("Las rutas de Nginx deben ser los directorios estándar sites-available y sites-enabled.");
  }
  if (config.deployRoot !== "/opt/vidkar/comercios") {
    throw new Error("PROVISIONER_DEPLOY_ROOT debe coincidir con la ruta de despliegue protegida por el helper root.");
  }
  if (config.stateDir !== "/var/lib/vidkar-provisioner/state") {
    throw new Error("PROVISIONER_STATE_DIR debe coincidir con el staging aislado del worker del VPS.");
  }
  if (config.acmeWebroot !== "/var/www/letsencrypt" || config.privilegedHelper !== "/usr/local/sbin/vidkar-commerce-helper") {
    throw new Error("PROVISIONER_ACME_WEBROOT y PROVISIONER_PRIVILEGED_HELPER deben coincidir con el helper raíz instalado.");
  }
  for (const key of ["heartbeatIntervalMs", "ddpCallTimeoutMs", "meteorConnectTimeoutMs", "npmTimeoutMs", "pollIntervalMs", "commandTimeoutMs", "certbotTimeoutMs"]) {
    if (!Number.isInteger(config[key]) || config[key] < 1000 || config[key] > 3600000) {
      throw new Error(`${key} debe estar entre 1000 y 3600000 milisegundos.`);
    }
  }

  return config;
};

module.exports = { loadConfig };

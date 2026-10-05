const simpleDDP = require("simpleddp");
const WebSocket = require("isomorphic-ws");

const createMeteorClient = ({ endpoint, connectTimeoutMs, callTimeoutMs = 15000, logger = console }) => {
  const server = new simpleDDP({
    endpoint,
    SocketConstructor: WebSocket,
    reconnectInterval: 10000,
  });
  let connectPromise = null;

  const connect = () => {
    if (server.connected) return Promise.resolve(server);
    if (connectPromise) return connectPromise;

    connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new Error("Timeout conectando con VIDKAR DDP."));
      }, connectTimeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        server.off?.("connected", onConnected);
        server.off?.("error", onError);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        connectPromise = null;
        if (error) reject(error);
        else resolve(server);
      };
      const onConnected = () => {
        logger.info("[comercio-provisioner] Conectado a VIDKAR por DDP.");
        finish();
      };
      const onError = () => finish(new Error("No se pudo conectar al WebSocket de VIDKAR."));

      server.on("connected", onConnected);
      server.on("error", onError);
      try {
        server.connect();
      } catch (_error) {
        finish(new Error("No se pudo iniciar la conexión DDP de VIDKAR."));
      }
    });

    return connectPromise;
  };

  const call = async (methodName, ...args) => {
    const ddp = await connect();
    let timer;
    try {
      return await Promise.race([
        ddp.call(methodName, ...args),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timeout esperando respuesta DDP de ${methodName}.`)), callTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const disconnect = async () => {
    connectPromise = null;
    await server.disconnect();
  };

  server.on("disconnected", () => {
    connectPromise = null;
    logger.warn("[comercio-provisioner] Conexión DDP interrumpida; se reintentará.");
  });
  server.on("error", () => {
    logger.warn("[comercio-provisioner] Error en transporte DDP.");
  });

  return { call, connect, disconnect, server };
};

module.exports = { createMeteorClient };

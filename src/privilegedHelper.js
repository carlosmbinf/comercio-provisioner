const crypto = require("node:crypto");

const serializeOperation = (operation, args) => `${[operation, ...args.map((value) => String(value))].join("\n")}\n`;

const signOperation = (secret, operation, args) => crypto
  .createHmac("sha256", String(secret))
  .update(serializeOperation(operation, args))
  .digest("hex");

const createPrivilegedHelperRunner = ({ config, runner }) => ({
  run: (operation, args, options = {}) => {
    if (!/^[a-z0-9-]+$/.test(operation) || !Array.isArray(args) || args.some((value) => /[\0\r\n]/.test(String(value)))) {
      throw new Error("Operación privilegiada no válida.");
    }
    const signature = signOperation(config.helperHmacSecret, operation, args);
    return runner.runCommand("sudo", ["-n", config.privilegedHelper,
      "--signature",
      signature,
      operation,
      ...args.map((value) => String(value)),
    ], options);
  },
});

module.exports = { createPrivilegedHelperRunner, serializeOperation, signOperation };

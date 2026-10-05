const path = require("node:path");

module.exports = {
  apps: [
    {
      name: process.env.PROVISIONER_ID || "vidkar-comercio-provisioner",
      script: path.join(__dirname, "src/index.js"),
      cwd: __dirname,
      interpreter: process.execPath,
      autorestart: true,
      kill_timeout: 60000,
      max_memory_restart: "512M",
      restart_delay: 3000,
      env: { NODE_ENV: process.env.NODE_ENV || "production" },
    },
  ],
};

const crypto = require("node:crypto");

const validate = ({ hostname, port, acmeWebroot }) => {
  if (typeof hostname !== "string" || !/^[a-z0-9-]+\.vidkar\.com$/.test(hostname)) {
    throw new Error("Hostname no válido para generar Nginx.");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Puerto no válido para generar Nginx.");
  }
  if (typeof acmeWebroot !== "string" || !/^\/[a-zA-Z0-9_./-]+$/.test(acmeWebroot) || acmeWebroot.includes("..")) {
    throw new Error("Ruta ACME no válida para generar Nginx.");
  }
};

const renderProxyLocation = (port) => `    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 90s;
    }
`;

const renderChallengeLocation = (acmeWebroot) => `    location ^~ /.well-known/acme-challenge/ {
        root ${acmeWebroot};
        default_type text/plain;
        try_files $uri =404;
    }
`;

const renderHttpNginxConfig = ({ hostname, port, acmeWebroot, requestId }) => {
  validate({ hostname, port, acmeWebroot });
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) {
    throw new Error("Identificador no válido para generar Nginx.");
  }
  return `# Managed by VIDKAR commerce provisioner; request ${requestId}\nserver {\n    listen 80;\n    server_name ${hostname};\n\n${renderChallengeLocation(acmeWebroot)}\n${renderProxyLocation(port)}}\n`;
};

const renderHttpsNginxConfig = ({ hostname, port, acmeWebroot, requestId }) => {
  validate({ hostname, port, acmeWebroot });
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) {
    throw new Error("Identificador no válido para generar Nginx.");
  }
  const slug = hostname.slice(0, -".vidkar.com".length);
  const requestHash = crypto.createHash("sha256").update(requestId).digest("hex").slice(0, 16);
  const certificateRoot = `/etc/letsencrypt/live/vidkar-commerce-${slug}-${requestHash}`;
  return `# Managed by VIDKAR commerce provisioner; request ${requestId}\nserver {\n    listen 80;\n    server_name ${hostname};\n\n${renderChallengeLocation(acmeWebroot)}\n    location / {\n        return 301 https://$host$request_uri;\n    }\n}\n\nserver {\n    listen 443 ssl http2;\n    server_name ${hostname};\n\n    ssl_certificate ${certificateRoot}/fullchain.pem;\n    ssl_certificate_key ${certificateRoot}/privkey.pem;\n    ssl_protocols TLSv1.2 TLSv1.3;\n\n${renderProxyLocation(port)}}\n`;
};

module.exports = { renderHttpNginxConfig, renderHttpsNginxConfig };

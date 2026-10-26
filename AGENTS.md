# Codex: comercio-provisioner

Lee `../AGENTS.md`, el `README.md` y el `package.json` de este proyecto antes de trabajar. Para reglas de COMERCIO y contratos con Meteor, consulta `../.github/memory/business-rules.md` y localiza los consumidores backend/mobile pertinentes.

Este worker Node es un proyecto separado. Conserva sus límites de aprovisionamiento, identidad, locks, idempotencia y rollback; no deduzcas permisos solo desde la interfaz ni uses credenciales de producción. No alteres despliegues, DNS, Nginx o servicios del sistema sin autorización explícita.

Valida con `npm run check` y `npm test` desde esta carpeta.

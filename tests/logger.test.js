const assert = require("node:assert/strict");
const test = require("node:test");

const { createLogger, sanitizeGitDiagnostic } = require("../src/logger");

test("formatea eventos PM2 en una sola línea con contexto por tienda", () => {
  const lines = [];
  const sink = { info: (line) => lines.push(line) };
  const root = createLogger({ workerId: "worker-fixture" }, sink);

  root.child({ requestId: "request-a", slug: "tienda-a", hostname: "tienda-a.vidkar.com", flow: "deploy" })
    .info("ETAPA clone_repository iniciada\nmensaje continuado");
  root.child({ requestId: "request-b", slug: "tienda-b", hostname: "tienda-b.vidkar.com", flow: "rollback" })
    .info("ETAPA remove_nginx completada");

  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T.* INFO \[comercio-provisioner\] worker=worker-fixture request=request-a slug=tienda-a host=tienda-a\.vidkar\.com flow=deploy /);
  assert.match(lines[0], /ETAPA clone_repository iniciada mensaje continuado$/);
  assert.doesNotMatch(lines[0], /\n/);
  assert.match(lines[1], /request=request-b slug=tienda-b host=tienda-b\.vidkar\.com flow=rollback/);
  assert.doesNotMatch(lines[1], /request=request-a|tienda-a/);
});

test("sanitiza diagnóstico Git y omite credenciales de URL y valores sensibles", () => {
  const result = sanitizeGitDiagnostic(
    "fatal: https://worker:secret@example.test/repo.git?token=abc failed\nAuthorization: Bearer bearer-secret",
  );

  assert.match(result, /https:\/\/example\.test\/repo\.git/);
  assert.doesNotMatch(result, /worker|secret|token=abc|bearer-secret/);
  assert.doesNotMatch(result, /\n/);
});

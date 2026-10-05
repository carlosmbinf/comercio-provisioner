const assert = require("node:assert/strict");
const test = require("node:test");
const { createLegacyServiceUsername, createServiceUsername } = require("../src/serviceUser.js");

test("cada flujo recibe una cuenta Linux única y el layout legacy sigue siendo reconocible", () => {
  const slug = "mercado-norte";
  const first = createServiceUsername(slug, "request-flow-1");
  assert.equal(first, createServiceUsername(slug, "request-flow-1"));
  assert.match(first, /^vcomreq-[a-f0-9]{16}$/);
  assert.notEqual(first, createServiceUsername(slug, "request-flow-2"));
  assert.notEqual(first, createServiceUsername("mercado-sur", "request-flow-1"));
  assert.match(createLegacyServiceUsername(slug), /^vcommerce-[a-f0-9]{12}$/);
  assert.throws(() => createServiceUsername("../root", "request-flow-1"), /slug inválido/);
  assert.throws(() => createServiceUsername(slug, "../root"), /requestId válido/);
});

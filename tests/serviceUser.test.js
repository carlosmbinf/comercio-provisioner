const assert = require("node:assert/strict");
const test = require("node:test");
const { createServiceUsername } = require("../src/serviceUser.js");

test("cada subdominio recibe una cuenta Linux estable y aislada", () => {
  const first = createServiceUsername("mercado-norte");
  assert.equal(first, createServiceUsername("mercado-norte"));
  assert.match(first, /^vcommerce-[a-f0-9]{12}$/);
  assert.notEqual(first, createServiceUsername("mercado-sur"));
  assert.throws(() => createServiceUsername("../root"), /slug inválido/);
});

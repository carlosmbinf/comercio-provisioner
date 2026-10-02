const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { runCommand } = require("../src/commandRunner");

test("runner sin shell registra y libera el grupo del comando hijo", async () => {
  let spawned;
  let closed;
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('worker-fixture')"], {
    timeoutMs: 5000,
    onSpawn: (pid) => { spawned = pid; },
    onClose: (pid) => { closed = pid; },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdoutTail, "worker-fixture");
  assert.ok(Number.isInteger(spawned) && spawned > 0);
  assert.equal(closed, spawned);
});

test("runner filtra entorno y no transmite credenciales al proceso hijo", async () => {
  const result = await runCommand(process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify({ token: process.env.PROVISIONER_TOKEN || null, path: Boolean(process.env.PATH) }))",
  ], {
    env: { PATH: "/usr/bin", PROVISIONER_TOKEN: "private-fixture" },
    timeoutMs: 5000,
  });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdoutTail), { token: null, path: true });
});

test("runner permite overrides Git seguros sin heredar secretos", async () => {
  const result = await runCommand(process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify({ global: process.env.GIT_CONFIG_GLOBAL, prompt: process.env.GIT_TERMINAL_PROMPT, token: process.env.PROVISIONER_TOKEN || null }))",
  ], {
    env: { PATH: "/usr/bin", PROVISIONER_TOKEN: "private-fixture" },
    envOverrides: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: 5000,
  });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdoutTail), { global: "/dev/null", prompt: "0", token: null });
});

test("runner registra duración y diagnóstico Git sin filtrar credenciales", async () => {
  const lines = [];
  const logger = {
    error: (line) => lines.push(line),
    info: (line) => lines.push(line),
  };
  const spawnImpl = (_command, _args, options) => spawn(process.execPath, [
    "-e",
    "process.stderr.write('fatal: https://worker:secret@example.test/repo.git?token=abc failed\\n'); process.exit(128)",
  ], options);

  await assert.rejects(
    () => runCommand("git", ["clone"], { logger, spawnImpl, timeoutMs: 5000 }),
    /git terminó con código 128/,
  );

  assert.match(lines[0], /CMD START command=git/);
  assert.match(lines[1], /CMD FAIL command=git exit=128 durationMs=\d+ detail=/);
  assert.match(lines[1], /https:\/\/example\.test\/repo\.git/);
  assert.doesNotMatch(lines.join("\n"), /worker:secret|token=abc/);
});

'use strict';

const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const test = require('node:test');
const { runSession } = require('./package-runtime.cjs');

function connection() {
  const output = [];
  const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { output.push(chunk.toString()); callback(); } });
  return { socket, output };
}

test('packaged host restores environment and passes startup settings without shell parsing', async () => {
  const environment = { ...process.env };
  const cwd = process.cwd();
  const { socket, output } = connection();
  try {
    const settings = { environment: { CODEX_HOME: 'C:\\custom home', QUOTED: 'a"b\\' }, cwd,
      executable: 'C:\\Program Files\\Codex\\ChatGPT.exe', codexCli: 'C:\\cli.exe', logPath: 'C:\\a b\\patch.log' };
    const session = runSession(socket, async options => {
      assert.deepEqual({ ...process.env }, settings.environment);
      if (process.platform === 'win32') assert.equal(process.env.codex_home, settings.environment.CODEX_HOME);
      assert.equal(options.executable, settings.executable);
      assert.equal(options.codexCli, settings.codexCli);
      assert.equal(options.logPath, settings.logPath);
      options.writeLog('test log\n');
      socket.emit('close');
      assert.equal(options.signal.aborted, true);
    });
    socket.push(JSON.stringify(settings) + '\n');
    await session;
    assert.deepEqual(output, ['test log\n']);
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, environment);
    process.chdir(cwd);
    socket.destroy();
  }
});

test('packaged host rejects missing settings and non-string environment values', async () => {
  for (const settings of [{}, { environment: { INVALID: 42 } }]) {
    const { socket } = connection();
    const session = runSession(socket, () => assert.fail('must not start'));
    socket.push(JSON.stringify(settings) + '\n');
    await assert.rejects(session, /environment/);
    socket.destroy();
  }
});

test('packaged host rejects a disconnect before receiving settings', async () => {
  const { socket } = connection();
  const session = runSession(socket, () => assert.fail('must not start'));
  socket.push(null);
  await assert.rejects(session, /disconnected/);
  socket.destroy();
});

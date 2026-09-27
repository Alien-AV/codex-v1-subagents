'use strict';

const net = require('node:net');
const readline = require('node:readline');
const fs = require('node:fs');

async function runSession(socket, runPatch = require('./runtime-patch.cjs').main) {
  const controller = new AbortController();
  const disconnected = () => controller.abort(new Error('The launcher connection closed'));
  socket.on('error', disconnected);
  socket.on('end', disconnected);
  socket.on('close', disconnected);
  const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
  let settings;
  try {
    const { value, done } = await lines[Symbol.asyncIterator]().next();
    if (done) throw new Error('The launcher disconnected before sending startup settings');
    lines.close();
    socket.resume();
    settings = JSON.parse(value);
    if (!settings || typeof settings !== 'object') throw new Error('Invalid launcher settings');
    if (!settings.environment || typeof settings.environment !== 'object' || Array.isArray(settings.environment))
      throw new Error('The launcher did not provide an environment');
    for (const [name, value] of Object.entries(settings.environment)) {
      if (typeof value !== 'string' || name.includes('\0') || value.includes('\0'))
        throw new Error('The launcher provided an invalid environment');
    }
    for (const name of Object.keys(process.env)) delete process.env[name];
    for (const [name, value] of Object.entries(settings.environment)) process.env[name] = value;
    process.chdir(settings.cwd);
    await runPatch({
      executable: settings.executable,
      logPath: settings.logPath,
      codexCli: settings.codexCli,
      signal: controller.signal,
      writeLog: line => { if (!socket.destroyed) socket.write(line); },
    });
  } catch (error) {
    if (typeof settings?.logPath === 'string') {
      try { fs.appendFileSync(settings.logPath, `${new Date().toISOString()} PATCH FAILED: ${error.message}\n`); }
      catch { /* The parent still receives the error over the launcher pipe. */ }
    }
    throw error;
  } finally {
    lines.close();
  }
}

if (require.main === module) {
  const name = process.argv[2];
  if (!/^codex-v1-launch-[a-f0-9]{32}$/.test(name || '')) {
    process.stderr.write('This helper must be started by launch.ps1.\n');
    process.exitCode = 1;
  } else {
    const socket = net.connect(`\\\\.\\pipe\\${name}`);
    runSession(socket).catch(error => {
      process.exitCode = 1;
      if (!socket.destroyed) socket.write(`PACKAGED LAUNCH FAILED: ${error.message}\n`);
    }).finally(() => socket.end());
  }
}

module.exports = { runSession };

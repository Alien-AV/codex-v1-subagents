'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { runSession } = require('../package-runtime.cjs');
const socket = net.connect(`\\\\.\\pipe\\${process.argv[2]}`);
runSession(socket, async ({ writeLog }) => {
  assert.equal(process.env.CODEX_V1_LAUNCH_TEST, 'preserved "quoted" value');
  const probe = spawnSync(path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-File', path.join(__dirname, 'package-identity.ps1')], { encoding: 'utf8', windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /OpenAI\.Codex_/);
  writeLog(`Verified child package identity: ${probe.stdout.trim()}\n`);
  writeLog('Verified private-pipe environment transfer. No Codex window launched.\n');
}).catch(error => {
  process.exitCode = 1;
  socket.write(`TEST FAILED: ${error.stack}\n`);
}).finally(() => socket.end());

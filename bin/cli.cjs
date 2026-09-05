#!/usr/bin/env node
'use strict';

const { existsSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.error('codex-v1-subagents currently supports Windows only.');
  process.exit(1);
}

const packageRoot = path.resolve(__dirname, '..');
const command = (process.argv[2] || 'run').toLowerCase();
const scriptByCommand = {
  run: path.join(packageRoot, 'launch.ps1'),
  install: path.join(packageRoot, 'scripts', 'install.ps1'),
  update: path.join(packageRoot, 'scripts', 'install.ps1'),
  uninstall: path.join(packageRoot, 'scripts', 'uninstall.ps1'),
};

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`codex-v1-subagents

Usage:
  codex-v1-subagents             Run Codex with the patch in the foreground
  codex-v1-subagents install     Install Desktop and Start Menu shortcuts
  codex-v1-subagents install --auto-update
                                 Install shortcuts that run npm's latest release
  codex-v1-subagents update      Refresh the locally installed shortcuts and files
  codex-v1-subagents uninstall   Remove the installed shortcuts and files`);
  process.exit(0);
}

const script = scriptByCommand[command];
if (!script) {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

const pwsh = path.join(process.env.ProgramFiles || String.raw`C:\Program Files`, 'PowerShell', '7', 'pwsh.exe');
const powershell = existsSync(pwsh) ? pwsh : 'powershell.exe';
const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
const options = process.argv.slice(3);
if (command === 'run') {
  args.push('-NodeExe', process.execPath);
  const logFileIndex = options.indexOf('--log-file');
  if (logFileIndex >= 0 && options[logFileIndex + 1])
    args.push('-LogFile', options[logFileIndex + 1]);
}
if (command === 'install' || command === 'update') {
  args.push('-PackageRoot', packageRoot, '-NodeExe', process.execPath);
  if (options.includes('--auto-update'))
    args.push('-AutoUpdate');
}

const result = spawnSync(powershell, args, { stdio: 'inherit', windowsHide: false });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);

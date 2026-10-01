'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { beginConfigTransaction, recoverConfigTransaction } = require('./catalog-override.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-retry-'));
  const config = path.join(directory, 'config.toml');
  const original = 'model = "sol"\n';
  fs.writeFileSync(config, original);
  const transaction = beginConfigTransaction(config, path.join(directory, 'models.json'));
  t.after(() => { t.mock.restoreAll(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, config, original, transaction };
}

function denyRenames(t, config, failures) {
  const rename = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, 'renameSync', (source, dest) => {
    if (dest === config) {
      const code = failures(calls++);
      if (code) throw Object.assign(new Error('simulated file lock'), { code, syscall: 'rename', path: source, dest });
    }
    return rename(source, dest);
  });
  return () => calls;
}

test('temporary Windows access failures recover automatically with a bounded backoff', t => {
  const f = fixture(t);
  const calls = denyRenames(t, f.config, n => ['EPERM', 'EACCES', 'EBUSY'][n]);
  const waits = [], logs = [];
  recoverConfigTransaction(f.config, line => logs.push(line), { sleep: ms => waits.push(ms) });
  assert.equal(calls(), 4);
  assert.deepEqual(waits, [50, 100, 200]);
  assert.equal(fs.readFileSync(f.config, 'utf8'), f.original);
  assert.deepEqual(fs.readdirSync(f.directory), ['config.toml']);
  assert.equal(logs.filter(x => x.includes('retrying')).length, 3);
});

test('the normal transaction restore path retries a lock without failing the launch', t => {
  const f = fixture(t);
  const calls = denyRenames(t, f.config, n => n === 0 && 'EPERM');
  f.transaction.restore();
  assert.equal(calls(), 2);
  assert.equal(fs.readFileSync(f.config, 'utf8'), f.original);
});

test('permanent access failure stops after seven attempts and preserves recovery files', t => {
  const f = fixture(t);
  const modified = fs.readFileSync(f.config, 'utf8');
  const calls = denyRenames(t, f.config, () => 'EPERM');
  const waits = [];
  assert.throws(() => recoverConfigTransaction(f.config, () => {}, { sleep: ms => waits.push(ms) }), error => {
    assert.equal(error.code, 'CONFIG_FILE_BUSY');
    assert.match(error.message, /7 automatic attempts/);
    assert.equal(error.cause.code, 'EPERM');
    return true;
  });
  assert.equal(calls(), 7);
  assert.equal(waits.reduce((sum, n) => sum + n, 0), 2550);
  assert.equal(fs.readFileSync(f.config, 'utf8'), modified);
  assert.equal(fs.readFileSync(f.transaction.paths.backupPath, 'utf8'), f.original);
  assert.ok(fs.existsSync(f.transaction.paths.markerPath));
  assert.ok(!fs.readdirSync(f.directory).some(name => name.includes('.tmp-')));
});

test('a non-overlapping config edit during the wait is re-read and preserved', t => {
  const f = fixture(t);
  denyRenames(t, f.config, n => n === 0 && 'EPERM');
  recoverConfigTransaction(f.config, () => {}, { sleep() {
    fs.writeFileSync(f.config, fs.readFileSync(f.config, 'utf8').replace('model = "sol"', 'model = "astra"'));
  } });
  assert.equal(fs.readFileSync(f.config, 'utf8'), 'model = "astra"\n');
});

test('an overlapping edit during the wait is preserved and stops retries', t => {
  const f = fixture(t);
  const calls = denyRenames(t, f.config, () => 'EPERM');
  let edited;
  assert.throws(() => recoverConfigTransaction(f.config, () => {}, { sleep() {
    edited = fs.readFileSync(f.config, 'utf8').replace('multi_agent = true', 'multi_agent = false');
    fs.writeFileSync(f.config, edited);
  } }), /Temporary features.multi_agent setting changed/);
  assert.equal(calls(), 1);
  assert.equal(fs.readFileSync(f.config, 'utf8'), edited);
  assert.ok(fs.existsSync(f.transaction.paths.backupPath));
});

test('non-access failures are not retried', t => {
  const f = fixture(t);
  const calls = denyRenames(t, f.config, () => 'EIO');
  assert.throws(() => recoverConfigTransaction(f.config, () => {}, { sleep() { assert.fail('must not wait'); } }), { code: 'EIO' });
  assert.equal(calls(), 1);
});

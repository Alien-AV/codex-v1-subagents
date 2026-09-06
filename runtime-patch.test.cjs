'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  beginConfigTransaction,
  createRuntimeDirectory,
  forceV1Catalog,
  recoverConfigTransaction,
  rewriteConfig,
} = require('./catalog-override.cjs');
const {
  applyPatch,
  CdpPipe,
  PATCHES,
  packageVersionFromExecutable,
  patchForUrl,
} = require('./runtime-patch.cjs');

test('changes only V2-capable catalog entries to V1', () => {
  const source = {
    models: [
      { slug: 'sol', multi_agent_version: 'v2' },
      { slug: 'luna', multi_agent_version: 'v1' },
      { slug: 'single-agent', multi_agent_version: null },
      { slug: 'unspecified' },
    ],
  };
  const result = forceV1Catalog(source);
  assert.equal(result.changed, 1);
  assert.deepEqual(source.models.map(model => model.multi_agent_version), ['v1', 'v1', null, undefined]);
});

test('creates per-launch state below the per-user application directory', () => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-v1-subagents-test-'));
  try {
    const runtimeDirectory = createRuntimeDirectory({ LOCALAPPDATA: localAppData });
    assert.equal(
      path.dirname(runtimeDirectory),
      path.join(localAppData, 'CodexV1Subagents', 'runtime'),
    );
    assert.match(path.basename(runtimeDirectory), /^launch-/);
  } finally {
    fs.rmSync(localAppData, { recursive: true, force: true });
  }
});

test('rewrites only the intended settings while preserving file style', () => {
  const original = '\ufeffmodel = "sol"\r\n# keep me\r\n[features]\r\nmulti_agent = false\r\nmulti_agent_v2 = true\r\n[other]\r\nx = 1\r\n';
  const rewritten = rewriteConfig(original, String.raw`C:\runtime\models-v1.json`);
  assert.ok(rewritten.startsWith('\ufeff'));
  assert.match(rewritten, /^model_catalog_json = "C:\\\\runtime\\\\models-v1\.json"$/m);
  assert.match(rewritten, /^multi_agent = true$/m);
  assert.match(rewritten, /^multi_agent_v2 = false$/m);
  assert.match(rewritten, /^# keep me\r$/m);
  assert.match(rewritten, /^\[other\]\r\nx = 1\r$/m);
  assert.doesNotMatch(rewritten.replaceAll('\r\n', ''), /\n/);
});

test('config transaction restores the exact original bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-v1-subagents-config-test-'));
  const configPath = path.join(directory, 'config.toml');
  const catalogPath = path.join(directory, 'models-v1.json');
  const original = Buffer.from('\ufeffmodel = "astra"\r\n# original\r\n', 'utf8');
  fs.writeFileSync(configPath, original);
  try {
    const transaction = beginConfigTransaction(configPath, catalogPath);
    assert.notDeepEqual(fs.readFileSync(configPath), original);
    assert.ok(fs.existsSync(transaction.paths.backupPath));
    assert.ok(fs.existsSync(transaction.paths.markerPath));
    assert.ok(fs.existsSync(transaction.paths.lockPath));
    transaction.restore();
    assert.deepEqual(fs.readFileSync(configPath), original);
    assert.equal(fs.existsSync(transaction.paths.backupPath), false);
    assert.equal(fs.existsSync(transaction.paths.markerPath), false);
    assert.equal(fs.existsSync(transaction.paths.lockPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stale config transaction is recovered on the next launch', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-v1-subagents-recovery-test-'));
  const configPath = path.join(directory, 'config.toml');
  const original = Buffer.from('model = "luna"\n', 'utf8');
  fs.writeFileSync(configPath, original);
  try {
    beginConfigTransaction(configPath, path.join(directory, 'models-v1.json'));
    assert.equal(recoverConfigTransaction(configPath), true);
    assert.deepEqual(fs.readFileSync(configPath), original);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('config transaction refuses to overwrite a concurrent user edit', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-v1-subagents-conflict-test-'));
  const configPath = path.join(directory, 'config.toml');
  fs.writeFileSync(configPath, 'model = "sol"\n');
  try {
    const transaction = beginConfigTransaction(configPath, path.join(directory, 'models-v1.json'));
    fs.writeFileSync(configPath, 'model = "user-edit"\n');
    assert.throws(() => transaction.restore(), /Temporary .* setting is missing/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), 'model = "user-edit"\n');
    assert.ok(fs.existsSync(transaction.paths.backupPath));
    assert.ok(fs.existsSync(transaction.paths.markerPath));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('config transaction preserves a non-overlapping Codex startup edit', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-v1-subagents-merge-test-'));
  const configPath = path.join(directory, 'config.toml');
  const original = 'SKY_CUA_NATIVE_PIPE_DIRECTORY = "old"\n\n[features]\nmulti_agent = false\nmulti_agent_v2 = true\n';
  fs.writeFileSync(configPath, original);
  try {
    const transaction = beginConfigTransaction(configPath, path.join(directory, 'models-v1.json'));
    const changedByCodex = fs.readFileSync(configPath, 'utf8').replace(
      'SKY_CUA_NATIVE_PIPE_DIRECTORY = "old"',
      'SKY_CUA_NATIVE_PIPE_DIRECTORY = "new"',
    );
    fs.writeFileSync(configPath, changedByCodex);
    transaction.restore();
    assert.equal(
      fs.readFileSync(configPath, 'utf8'),
      original.replace('SKY_CUA_NATIVE_PIPE_DIRECTORY = "old"', 'SKY_CUA_NATIVE_PIPE_DIRECTORY = "new"'),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('config transaction rejects an edit to one of its owned settings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-v1-subagents-owned-conflict-test-'));
  const configPath = path.join(directory, 'config.toml');
  fs.writeFileSync(configPath, '[features]\nmulti_agent = false\n');
  try {
    const transaction = beginConfigTransaction(configPath, path.join(directory, 'models-v1.json'));
    const conflicting = fs.readFileSync(configPath, 'utf8').replace('multi_agent = true', 'multi_agent = false');
    fs.writeFileSync(configPath, conflicting);
    assert.throws(() => transaction.restore(), /Temporary features\.multi_agent setting changed/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), conflicting);
    assert.ok(fs.existsSync(transaction.paths.backupPath));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('config transaction removes a config file that did not exist originally', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-v1-subagents-new-config-test-'));
  const configPath = path.join(directory, 'config.toml');
  try {
    const transaction = beginConfigTransaction(configPath, path.join(directory, 'models-v1.json'));
    assert.ok(fs.existsSync(configPath));
    transaction.restore();
    assert.equal(fs.existsSync(configPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('config transaction preserves unrelated settings created by Codex', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-v1-subagents-created-config-test-'));
  const configPath = path.join(directory, 'config.toml');
  try {
    const transaction = beginConfigTransaction(configPath, path.join(directory, 'models-v1.json'));
    const changedByCodex = `SKY_CUA_NATIVE_PIPE_DIRECTORY = "new"\n${fs.readFileSync(configPath, 'utf8')}`;
    fs.writeFileSync(configPath, changedByCodex);
    transaction.restore();
    assert.equal(fs.readFileSync(configPath, 'utf8'), 'SKY_CUA_NATIVE_PIPE_DIRECTORY = "new"');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unsafe config syntax fails without leaving transaction files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-v1-subagents-invalid-config-test-'));
  const configPath = path.join(directory, 'config.toml');
  fs.writeFileSync(configPath, 'features = { multi_agent = false }\n');
  try {
    assert.throws(
      () => beginConfigTransaction(configPath, path.join(directory, 'models-v1.json')),
      /inline features table/,
    );
    assert.deepEqual(fs.readdirSync(directory), ['config.toml']);
    assert.equal(fs.readFileSync(configPath, 'utf8'), 'features = { multi_agent = false }\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('extracts the installed package version for diagnostics', () => {
  const executable = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.901.5003.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`;
  assert.equal(packageVersionFromExecutable(executable), '26.901.5003.0');
});

test('recognizes hashed renderer chunks without pinning their hashes', () => {
  assert.equal(patchForUrl('file:///app/resources/app.asar/webview/assets/local-conversation-page-9f587f272584.js')[0], 'legacyThreadRoute');
  assert.equal(patchForUrl('file:///app/resources/app.asar/webview/assets/open-local-conversation-background-agent-5306c5486ea3.js')[0], 'interactiveSubagent');
  assert.equal(patchForUrl('file:///app/resources/app.asar/webview/assets/open-local-conversation-background-agent-e68f617b5227.js')[0], 'interactiveSubagent');
  assert.equal(patchForUrl('file:///app/resources/app.asar/webview/assets/unrelated.js'), undefined);
});

test('patches both known builds using structural identifiers', () => {
  const routeFixtures = [
    'if(!e.canInteract){$a(o,{hostId:h,parentConversationId:r,selectedConversationId:e.conversationId,selectedDisplayName:e.displayName});return}Qa(o,{backgroundAgent:e,hostId:h,TabComponent:Ea})',
    'if(!agent.canInteract){openTask(tabs,{hostId:host,parentConversationId:parent,selectedConversationId:agent.conversationId,selectedDisplayName:agent.displayName});return}openLegacy(tabs,{backgroundAgent:agent,hostId:host,TabComponent:LegacyTab})',
  ];
  for (const fixture of routeFixtures) {
    const result = applyPatch(`prefix${fixture}suffix`, PATCHES.legacyThreadRoute);
    assert.equal(result.changed, true);
    assert.doesNotMatch(result.source, /if\(!.*\.canInteract\)/);
    assert.match(result.source, /backgroundAgent:/);
  }

  for (const agent of ['n', 'backgroundAgent']) {
    const result = applyPatch(`prefixprops:{canInteract:${agent}.canInteract,conversationId:${agent}.conversationIdsuffix`, PATCHES.interactiveSubagent);
    assert.equal(result.changed, true);
    assert.equal(result.source, `prefixprops:{canInteract:!0,conversationId:${agent}.conversationIdsuffix`);
  }
});

test('irrelevant candidate chunks are skipped and ambiguous signatures fail closed', () => {
  const patch = PATCHES.interactiveSubagent;
  assert.deepEqual(applyPatch('export{value as x}', patch), { source: 'export{value as x}', changed: false });
  const signature = 'props:{canInteract:n.canInteract,conversationId:n.conversationId';
  assert.throws(() => applyPatch(`${signature}${signature}`, patch), /found 2/);
});

test('CDP pipe frames requests and resolves split NUL-delimited responses', async () => {
  const outbound = new PassThrough();
  const inbound = new PassThrough();
  const cdp = new CdpPipe(outbound, inbound, () => {});
  let request = '';
  outbound.on('data', chunk => { request += chunk.toString('utf8'); });

  const resultPromise = cdp.send('Target.getTargets');
  await new Promise(resolve => setImmediate(resolve));
  const sent = JSON.parse(request.slice(0, -1));
  assert.equal(sent.method, 'Target.getTargets');
  assert.equal(request.charCodeAt(request.length - 1), 0);

  const response = `${JSON.stringify({ id: sent.id, result: { targetInfos: [] } })}\0`;
  inbound.write(response.slice(0, 7));
  inbound.write(response.slice(7));
  assert.deepEqual(await resultPromise, { targetInfos: [] });
});

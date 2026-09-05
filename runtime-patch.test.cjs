'use strict';

const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  applyPatch,
  CdpPipe,
  PATCHES,
  packageVersionFromExecutable,
  patchForUrl,
} = require('./runtime-patch.cjs');

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

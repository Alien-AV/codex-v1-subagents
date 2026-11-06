'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { prepareCatalogOverride } = require('./catalog-override.cjs');

const PATCH_TIMEOUT_MS = 90_000;
const IDENTIFIER = '[$A-Z_a-z][$\\w]*';
const TESTED_CODEX_VERSIONS = Object.freeze([
  '26.825.6671.0',
  '26.901.4073.0',
  '26.901.5003.0',
  '26.901.6511.0',
  '26.903.8094.0',
  '26.924.2738.0',
  '26.928.2636.0',
  '26.1027.3384.0',
  '26.1029.7803.0',
  '26.1103.3517.0',
]);
const HOOK_BASELINE_VERSION = TESTED_CODEX_VERSIONS.at(-1);

class PatchFailure extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PatchFailure';
    this.cause = cause;
  }
}

function hookFailure(installedVersion, detail) {
  return new PatchFailure(
    `Couldn't hook the Codex UI (version expected ${HOOK_BASELINE_VERSION}, got ${installedVersion || 'unknown'}): ${detail}`,
  );
}

const PATCHES = Object.freeze({
  legacyThreadRoute: Object.freeze({
    displayName: 'local-conversation-page-*.js',
    fileNamePattern: /^local-conversation-page-[\da-f]+\.js$/i,
    urlPatterns: ['*local-conversation-page-*.js'],
    sourcePattern: new RegExp(
      `if\\(!(?<agent>${IDENTIFIER})\\.canInteract\\)\\{${IDENTIFIER}\\((?<tabs>${IDENTIFIER}),\\{hostId:(?<host>${IDENTIFIER}),parentConversationId:${IDENTIFIER},selectedConversationId:\\k<agent>\\.conversationId,selectedDisplayName:\\k<agent>\\.displayName\\}\\);return\\}(?<open>${IDENTIFIER}\\(\\k<tabs>,\\{backgroundAgent:\\k<agent>,hostId:\\k<host>(?:,TabComponent:${IDENTIFIER})?\\}\\))`
        + `|(?<ternaryAgent>${IDENTIFIER})\\.canInteract\\?(?<ternaryOpen>${IDENTIFIER}\\((?<ternaryTabs>${IDENTIFIER}),\\{backgroundAgent:\\k<ternaryAgent>,hostId:(?<ternaryHost>${IDENTIFIER})\\}\\)):${IDENTIFIER}\\(\\k<ternaryTabs>,\\{hostId:\\k<ternaryHost>,parentConversationId:${IDENTIFIER},selectedConversationId:\\k<ternaryAgent>\\.conversationId,selectedDisplayName:\\k<ternaryAgent>\\.displayName\\}\\)`,
      'g',
    ),
    replacement: groups => groups.open ?? groups.ternaryOpen,
  }),
  interactiveSubagent: Object.freeze({
    displayName: 'interactive subagent (app-initial/open-local-conversation-background-agent)',
    fileNamePattern: /^(?:app-initial|open-local-conversation-background-agent)-[\da-f]+\.js$/i,
    urlPatterns: ['*app-initial-*.js', '*open-local-conversation-background-agent-*.js'],
    sourcePattern: new RegExp(
      `props:\\{canInteract:(?<agent>${IDENTIFIER})\\.canInteract,conversationId:\\k<agent>\\.conversationId`,
      'g',
    ),
    replacement: groups => `props:{canInteract:!0,conversationId:${groups.agent}.conversationId`,
  }),
});

function applyPatch(source, patch) {
  const matches = [...source.matchAll(patch.sourcePattern)];
  if (matches.length === 0)
    return { source, changed: false };
  if (matches.length !== 1)
    throw new Error(`${patch.displayName}: expected exactly 1 structural match, got ${matches.length}`);

  const replacement = patch.replacement(matches[0].groups);
  return {
    source: source.replace(patch.sourcePattern, replacement),
    changed: true,
  };
}

class CdpPipe {
  constructor(pipeWrite, pipeRead, log) {
    this.pipeWrite = pipeWrite;
    this.pipeRead = pipeRead;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = Buffer.alloc(0);
    this.closed = false;

    pipeRead.on('data', chunk => this.onData(chunk));
    pipeRead.on('error', error => this.close(error));
    pipeRead.on('close', () => this.close(new Error('Codex closed the debugging pipe')));
    pipeWrite.on('error', error => this.close(error));
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}, sessionId) {
    if (this.closed)
      return Promise.reject(new Error('Debugging pipe is closed'));

    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId)
      message.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.pipeWrite.write(`${JSON.stringify(message)}\0`, error => {
        if (!error)
          return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf(0);
      if (end < 0)
        return;

      const frame = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      if (!frame)
        continue;

      let message;
      try {
        message = JSON.parse(frame);
      } catch (error) {
        this.close(new Error(`Invalid CDP message: ${error.message}`));
        return;
      }

      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending)
          continue;
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else
          pending.resolve(message.result || {});
        continue;
      }

      for (const listener of this.listeners) {
        Promise.resolve(listener(message)).catch(error => {
          this.log(`Event handler failed: ${error.stack || error}`);
        });
      }
    }
  }

  close(error) {
    if (this.closed)
      return;
    this.closed = true;
    for (const { reject } of this.pending.values())
      reject(error);
    this.pending.clear();
  }
}

function packageVersionFromExecutable(executable) {
  const match = executable.match(/OpenAI\.Codex_([^_\\/]+)_/i);
  return match && match[1];
}

function patchForUrl(url) {
  const fileName = url.split(/[\\/]/).pop().split(/[?#]/, 1)[0];
  return Object.entries(PATCHES).find(([, patch]) => patch.fileNamePattern.test(fileName));
}

// Rspack emits both hooks in the conversation page, plus the same composer
// module in a second lazy entry. Only the page establishes patch readiness.
const asyncAssetRoot = 'app://-/assets/async/';
const numberedChunks = {
  '596785': ['legacyThreadRoute', 'interactiveSubagent'],
  '953502': ['legacyThreadRoute', 'interactiveSubagent'],
  '27319': ['interactiveSubagent'],
};
const rspackRoute = {
  displayName: 'subagent full-tab route',
  sourcePattern: new RegExp(
    'if\\(!(?<agent>' + IDENTIFIER + ')\\.canInteract\\)return void\\(0,' + IDENTIFIER
    + '\\.openLocalConversationSubagentsPanel\\)\\((?<tabs>' + IDENTIFIER + '),\\{hostId:(?<host>' + IDENTIFIER
    + '),parentConversationId:' + IDENTIFIER + ',selectedConversationId:\\k<agent>\\.conversationId,selectedDisplayName:\\k<agent>\\.displayName\\}\\);'
    + '(?<open>\\(0,' + IDENTIFIER + '\\.openLocalConversationBackgroundAgent\\)\\(\\k<tabs>,\\{backgroundAgent:\\k<agent>,hostId:\\k<host>\\}\\))', 'g'),
  replacement: groups => groups.open,
};

function planForUrl(url) {
  if (url.startsWith(asyncAssetRoot)) {
    const id = /^(\d+)\.[a-f\d]{10}\.js$/.exec(url.slice(asyncAssetRoot.length))?.[1];
    const names = numberedChunks[id];
    if (names) return { names, strict: true, mirror: id === '27319' };
  }
  const match = patchForUrl(url);
  return match && { names: [match[0]], strict: false, mirror: false };
}

function rewriteResponse(source, plan) {
  const original = source;
  for (const name of plan.names) {
    const rule = plan.strict && name === 'legacyThreadRoute' ? rspackRoute : PATCHES[name];
    const result = applyPatch(source, rule);
    if (plan.strict && !result.changed)
      throw new Error('Numbered renderer chunk: expected one ' + name + ' match, got 0');
    source = result.source;
  }
  return { source, changed: source !== original };
}

async function main({ executable, logPath = path.join(__dirname, 'runtime-patch.log'), codexCli, signal, writeLog = line => process.stdout.write(line) }) {
  signal?.throwIfAborted();
  if (!executable)
    throw new Error('The Codex executable path is required');
  if (!fs.existsSync(executable))
    throw new Error(`Codex executable not found: ${executable}`);
  if (!codexCli)
    throw new Error('The bundled Codex CLI path is required');

  const packageVersion = packageVersionFromExecutable(executable);
  fs.writeFileSync(logPath, '', 'utf8');
  const log = message => {
    const line = `${new Date().toISOString()} ${message}`;
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
    writeLog(`${line}\n`);
  };

  if (TESTED_CODEX_VERSIONS.includes(packageVersion))
    log(`Compatibility: Codex ${packageVersion} is a tested version`);
  else
    log(`VERSION WARNING: hook baseline expected ${HOOK_BASELINE_VERSION}, got ${packageVersion || 'unknown'}; attempting structural compatibility checks`);

  let catalogOverride;
  try {
    catalogOverride = prepareCatalogOverride(codexCli, log);
  } catch (error) {
    const failure = new PatchFailure(
      `Couldn't prepare the V1 model catalog for Codex ${packageVersion || 'unknown'}: ${error.message}`,
      error,
    );
    log(`PATCH FAILED: ${failure.message}`);
    if (error.stack)
      log(`DETAILS: ${error.stack}`);
    throw failure;
  }
  let overrideCleaned = false;
  let cleanupFailureLogged = false;
  const cleanupOverride = () => {
    if (overrideCleaned)
      return;
    try {
      catalogOverride.cleanup();
      overrideCleaned = true;
    } catch (error) {
      if (!cleanupFailureLogged) {
        cleanupFailureLogged = true;
        log(`Could not restore the temporary config override automatically: ${error.message}`);
      }
    }
  };
  process.once('exit', cleanupOverride);
  log(`Launching Codex ${packageVersion || '(unknown version)'} with private CDP pipe`);
  const child = spawn(executable, ['--remote-debugging-pipe'], {
    detached: false,
    env: catalogOverride.environment,
    windowsHide: false,
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const stopForLauncherExit = () => {
    cleanupOverride();
    if (!child.killed) child.kill();
  };
  signal?.addEventListener('abort', stopForLauncherExit, { once: true });
  child.once('exit', () => signal?.removeEventListener('abort', stopForLauncherExit));
  if (signal?.aborted) stopForLauncherExit();

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => {
    for (const line of data.trim().split(/\r?\n/))
      if (line)
        log(`[Codex] ${line}`);
  });

  const cdp = new CdpPipe(child.stdio[3], child.stdio[4], log);
  const sessions = new Map();
  const targetSessions = new Map();
  const attachingTargets = new Set();
  const preparingSessions = new Map();
  const pendingRequests = new Set();
  const candidateCounts = new Map(Object.keys(PATCHES).map(name => [name, 0]));
  let primaryPatched = false;
  let fatalError;
  let resolveSuccess;
  let rejectSuccess;

  const success = new Promise((resolve, reject) => {
    resolveSuccess = resolve;
    rejectSuccess = reject;
  });
  // Startup can fail while the first CDP calls are still pending.
  success.catch(() => {});
  const timer = setTimeout(() => {
    const bestSession = [...sessions.values()].sort((left, right) => right.patches.size - left.patches.size)[0];
    const installed = bestSession?.patches || new Set();
    const missing = Object.entries(PATCHES)
      .filter(([name]) => !installed.has(name))
      .map(([name, patch]) => `${patch.displayName}: saw ${candidateCounts.get(name)} candidate response(s), installed 0 hooks`)
      .join('; ');
    abortPatch(hookFailure(packageVersion, `timed out after ${PATCH_TIMEOUT_MS / 1000}s; ${missing || 'the two hooks never appeared in one renderer'}`));
  }, PATCH_TIMEOUT_MS);
  timer.unref();

  function abortPatch(error) {
    if (fatalError)
      return;
    fatalError = error instanceof PatchFailure
      ? error
      : hookFailure(packageVersion, error.message || String(error));
    clearTimeout(timer);
    rejectSuccess(fatalError);
    cdp.close(fatalError);
    if (!child.killed)
      child.kill();
  }

  async function patchPausedResponse(message) {
    const url = message.params.request?.url || '';
    const plan = planForUrl(url);
    if (!plan) {
      await cdp.send('Fetch.continueRequest', { requestId: message.params.requestId }, message.sessionId);
      return;
    }
    if (message.params.responseStatusCode == null)
      throw new Error(url + ': expected a completed script response, got an incomplete request');

    const requestKey = `${message.sessionId}:${message.params.requestId}`;
    if (pendingRequests.has(requestKey))
      return;
    pendingRequests.add(requestKey);

    try {
      for (const name of plan.names)
        candidateCounts.set(name, candidateCounts.get(name) + 1);
      const response = await cdp.send('Fetch.getResponseBody', { requestId: message.params.requestId }, message.sessionId);
      const source = response.base64Encoded
        ? Buffer.from(response.body, 'base64').toString('utf8')
        : response.body;
      const replacement = rewriteResponse(source, plan);
      const responseHeaders = (message.params.responseHeaders || []).filter(header => {
        const name = header.name.toLowerCase();
        return name !== 'content-length' && name !== 'content-encoding';
      });
      const fulfill = {
        requestId: message.params.requestId,
        responseCode: message.params.responseStatusCode,
        responseHeaders,
        body: Buffer.from(replacement.source, 'utf8').toString('base64'),
      };
      if (message.params.responseStatusText)
        fulfill.responsePhrase = message.params.responseStatusText;
      await cdp.send('Fetch.fulfillRequest', fulfill, message.sessionId);

      if (!replacement.changed) {
        log(url + ': expected 1 structural match, got 0; waiting for another candidate');
        return;
      }

      const session = sessions.get(message.sessionId);
      if (!session)
        return;
      for (const name of plan.names) {
        const slot = plan.mirror ? 'mirror:' + name : name;
        const previousUrl = session.patchUrls.get(slot);
        if (previousUrl && previousUrl !== url)
          throw new Error(name + ': unexpected duplicate hook in ' + previousUrl + ' and ' + url);
        session.patchUrls.set(slot, url);
        if (!plan.mirror) session.patches.add(name);
      }
      log(url + ': ' + plan.names.join(', ') + ' rewritten in target ' + session.targetId);
      if (!primaryPatched && session.patches.size === Object.keys(PATCHES).length) {
        primaryPatched = true;
        clearTimeout(timer);
        resolveSuccess();
      }
    } finally {
      pendingRequests.delete(requestKey);
    }
  }

  async function prepareSession(sessionId, targetInfo, waitingForDebugger) {
    if (preparingSessions.has(sessionId))
      return preparingSessions.get(sessionId);

    const preparation = (async () => {
      targetSessions.set(targetInfo.targetId, sessionId);
      sessions.set(sessionId, { targetId: targetInfo.targetId, patches: new Set(), patchUrls: new Map() });
      const urls = Object.values(PATCHES).flatMap(patch => patch.urlPatterns)
        .concat(Object.keys(numberedChunks).map(id => asyncAssetRoot + id + '.*.js'));
      const patterns = urls.map(urlPattern => ({
        urlPattern,
        resourceType: 'Script',
        requestStage: 'Response',
      }));
      try {
        await cdp.send('Fetch.enable', { patterns }, sessionId);
        log(`Intercepting renderer target ${targetInfo.targetId}`);
        if (waitingForDebugger) {
          await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
        } else {
          await cdp.send('Page.enable', {}, sessionId);
          await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
          log(`Reloaded existing renderer target ${targetInfo.targetId} through interception`);
        }
      } catch (error) {
        if (waitingForDebugger)
          await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        throw error;
      }
    })();
    preparingSessions.set(sessionId, preparation);
    try {
      await preparation;
    } finally {
      preparingSessions.delete(sessionId);
    }
  }

  cdp.onEvent(async message => {
    try {
      if (message.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo, waitingForDebugger } = message.params;
        await prepareSession(sessionId, targetInfo, waitingForDebugger);
        return;
      }
      if (message.method === 'Target.targetDestroyed') {
        const sessionId = targetSessions.get(message.params.targetId);
        if (sessionId)
          sessions.delete(sessionId);
        targetSessions.delete(message.params.targetId);
        return;
      }
      if (message.method === 'Fetch.requestPaused' && message.sessionId)
        await patchPausedResponse(message);
    } catch (error) {
      abortPatch(error);
    }
  });

  async function attachTarget(targetInfo) {
    if (!targetInfo || !['page', 'webview'].includes(targetInfo.type))
      return;
    if (targetSessions.has(targetInfo.targetId))
      return;
    if (attachingTargets.has(targetInfo.targetId))
      return;

    attachingTargets.add(targetInfo.targetId);
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true });
      await prepareSession(sessionId, targetInfo, false);
    } catch (error) {
      abortPatch(error);
    } finally {
      attachingTargets.delete(targetInfo.targetId);
    }
  }

  child.once('error', error => {
    fatalError = new PatchFailure(`Couldn't launch Codex ${packageVersion || 'unknown'}: ${error.message}`, error);
    cdp.close(fatalError);
    cleanupOverride();
  });

  const childExit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      cleanupOverride();
      if (!primaryPatched && !fatalError)
        fatalError = hookFailure(
          packageVersion,
          `Codex exited before both hooks were installed (exit code ${code}, signal ${signal || 'none'})`,
        );
      if (fatalError)
        reject(fatalError);
      else
        resolve({ code, signal });
    });
  });
  childExit.catch(() => {});

  let phase = 'hooking the renderer';
  try {
    const targetFilter = [
      { type: 'page' },
      { type: 'webview' },
      { exclude: true },
    ];
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: targetFilter,
    });
    await cdp.send('Target.setDiscoverTargets', { discover: true, filter: targetFilter });
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    await Promise.all(targetInfos.map(attachTarget));
    await Promise.race([success, childExit]);
    phase = 'restoring the Codex config';
    try {
      catalogOverride.restoreConfig();
    } catch (error) {
      throw new PatchFailure(`Couldn't restore config.toml after installing the UI hooks: ${error.message}`, error);
    }
    phase = 'running Codex';
    log('PATCH ACTIVE: subagents now open as interactive legacy task tabs. Keep this launcher running.');
    await childExit;
  } catch (error) {
    const failure = error instanceof PatchFailure
      ? error
      : phase === 'hooking the renderer'
        ? hookFailure(packageVersion, error.message || String(error))
        : new PatchFailure(`Codex patch failed while ${phase}: ${error.message || error}`, error);
    fatalError = failure;
    log(`PATCH FAILED: ${failure.message}`);
    const details = failure.cause?.stack || (error !== failure && error.stack);
    if (details)
      log(`DETAILS: ${details}`);
    cleanupOverride();
    if (!child.killed)
      child.kill();
    throw failure;
  } finally {
    clearTimeout(timer);
    process.removeListener('exit', cleanupOverride);
    cleanupOverride();
  }
}

module.exports = {
  main,
  applyPatch,
  CdpPipe,
  hookFailure,
  HOOK_BASELINE_VERSION,
  PatchFailure,
  PATCHES,
  packageVersionFromExecutable,
  patchForUrl,
  planForUrl,
  rewriteResponse,
};

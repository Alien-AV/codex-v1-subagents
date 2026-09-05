'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PATCH_TIMEOUT_MS = 90_000;
const IDENTIFIER = '[$A-Z_a-z][$\\w]*';

const PATCHES = Object.freeze({
  legacyThreadRoute: Object.freeze({
    displayName: 'local-conversation-page-*.js',
    fileNamePattern: /^local-conversation-page-[\da-f]+\.js$/i,
    urlPattern: '*local-conversation-page-*.js',
    sourcePattern: new RegExp(
      `if\\(!(?<agent>${IDENTIFIER})\\.canInteract\\)\\{${IDENTIFIER}\\((?<tabs>${IDENTIFIER}),\\{hostId:(?<host>${IDENTIFIER}),parentConversationId:${IDENTIFIER},selectedConversationId:\\k<agent>\\.conversationId,selectedDisplayName:\\k<agent>\\.displayName\\}\\);return\\}(?<open>${IDENTIFIER}\\(\\k<tabs>,\\{backgroundAgent:\\k<agent>,hostId:\\k<host>,TabComponent:${IDENTIFIER}\\}\\))`,
      'g',
    ),
    replacement: groups => groups.open,
  }),
  interactiveSubagent: Object.freeze({
    displayName: 'open-local-conversation-background-agent-*.js',
    fileNamePattern: /^open-local-conversation-background-agent-[\da-f]+\.js$/i,
    urlPattern: '*open-local-conversation-background-agent-*.js',
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
    throw new Error(`${patch.displayName}: expected at most one structural signature; found ${matches.length}`);

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

async function main() {
  const executable = process.argv[2];
  const logPath = process.argv[3] || path.join(__dirname, 'runtime-patch.log');
  if (!executable)
    throw new Error('Usage: node runtime-patch.cjs <ChatGPT.exe> [log-file]');
  if (!fs.existsSync(executable))
    throw new Error(`Codex executable not found: ${executable}`);

  const packageVersion = packageVersionFromExecutable(executable);
  fs.writeFileSync(logPath, '', 'utf8');
  const log = message => {
    const line = `${new Date().toISOString()} ${message}`;
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
    process.stdout.write(`${line}\n`);
  };

  log(`Launching Codex ${packageVersion || '(unknown version)'} with private CDP pipe`);
  const child = spawn(executable, ['--remote-debugging-pipe'], {
    detached: false,
    windowsHide: false,
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });

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
  let primaryPatched = false;
  let fatalError;
  let resolveSuccess;
  let rejectSuccess;

  const success = new Promise((resolve, reject) => {
    resolveSuccess = resolve;
    rejectSuccess = reject;
  });
  const timer = setTimeout(() => rejectSuccess(new Error('Timed out waiting for both renderer chunks to pass through interception.')), PATCH_TIMEOUT_MS);
  timer.unref();

  function abortPatch(error) {
    if (fatalError)
      return;
    fatalError = error;
    clearTimeout(timer);
    rejectSuccess(error);
    if (primaryPatched && !child.killed)
      child.kill();
  }

  async function patchPausedResponse(message) {
    const matched = patchForUrl(message.params.request?.url || '');
    if (!matched) {
      await cdp.send('Fetch.continueRequest', { requestId: message.params.requestId }, message.sessionId);
      return;
    }
    if (message.params.responseStatusCode == null)
      throw new Error(`${matched[1].fileName}: interception occurred before the response was available`);

    const requestKey = `${message.sessionId}:${message.params.requestId}`;
    if (pendingRequests.has(requestKey))
      return;
    pendingRequests.add(requestKey);

    try {
      const [patchName, patch] = matched;
      const response = await cdp.send('Fetch.getResponseBody', { requestId: message.params.requestId }, message.sessionId);
      const source = response.base64Encoded
        ? Buffer.from(response.body, 'base64').toString('utf8')
        : response.body;
      const replacement = applyPatch(source, patch);
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
        log(`${patch.displayName}: candidate ${message.params.request.url} did not contain the structural signature; passed through`);
        return;
      }

      const session = sessions.get(message.sessionId);
      if (!session)
        return;
      const previousUrl = session.patchUrls.get(patchName);
      if (previousUrl && previousUrl !== message.params.request.url)
        throw new Error(`${patch.displayName}: structural signature also appeared in ${message.params.request.url}`);
      session.patchUrls.set(patchName, message.params.request.url);
      session.patches.add(patchName);
      log(`${patch.displayName}: response rewritten in target ${session.targetId}`);
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
      const patterns = Object.values(PATCHES).map(patch => ({
        urlPattern: patch.urlPattern,
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
    fatalError = error;
    cdp.close(error);
  });

  const childExit = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (!primaryPatched && !fatalError)
        fatalError = new Error(`Codex exited before patching (code ${code}, signal ${signal || 'none'})`);
      if (fatalError)
        reject(fatalError);
      else
        resolve({ code, signal });
    });
  });

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
    log('PATCH ACTIVE: subagents now open as interactive legacy task tabs. Keep this launcher running.');
    await childExit;
  } catch (error) {
    fatalError = error;
    log(`PATCH FAILED: ${error.stack || error}`);
    if (!child.killed)
      child.kill();
    throw error;
  }
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  applyPatch,
  CdpPipe,
  PATCHES,
  packageVersionFromExecutable,
  patchForUrl,
};

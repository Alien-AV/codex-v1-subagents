'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIRECTORY_NAME = 'CodexV1Subagents';
const BACKUP_SUFFIX = '.codex-v1-subagents.backup';
const MARKER_SUFFIX = '.codex-v1-subagents.transaction.json';
const LOCK_SUFFIX = '.codex-v1-subagents.lock';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function atomicWrite(filePath, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', mode);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined)
      fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function transactionPaths(configPath) {
  return {
    backupPath: `${configPath}${BACKUP_SUFFIX}`,
    lockPath: `${configPath}${LOCK_SUFFIX}`,
    markerPath: `${configPath}${MARKER_SUFFIX}`,
  };
}

function resolveConfigPath(environment = process.env) {
  const codexHome = environment.CODEX_HOME || (
    environment.USERPROFILE && path.join(environment.USERPROFILE, '.codex')
  );
  if (!codexHome)
    throw new Error('Neither CODEX_HOME nor USERPROFILE is set');
  const configPath = path.resolve(codexHome, 'config.toml');
  if (path.basename(configPath).toLowerCase() !== 'config.toml')
    throw new Error(`Unexpected Codex config path: ${configPath}`);
  return configPath;
}

function rewriteConfig(original, catalogPath) {
  const document = splitConfig(original);
  const lines = document.lines;

  const tableHeader = /^\s*\[.*\]\s*(?:#.*)?$/;
  const firstTable = lines.findIndex(line => tableHeader.test(line));
  const topLevelEnd = firstTable < 0 ? lines.length : firstTable;
  const catalogSetting = `model_catalog_json = ${JSON.stringify(path.resolve(catalogPath))}`;
  const catalogIndexes = [];
  for (let index = 0; index < topLevelEnd; index += 1) {
    if (/^\s*model_catalog_json\s*=/.test(lines[index]))
      catalogIndexes.push(index);
  }
  if (catalogIndexes.length > 1)
    throw new Error('config.toml contains multiple top-level model_catalog_json settings');
  if (catalogIndexes.length === 1)
    lines[catalogIndexes[0]] = catalogSetting;
  else
    lines.splice(topLevelEnd, 0, catalogSetting);

  const featureHeaders = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[\s*features\s*\]\s*(?:#.*)?$/.test(lines[index]))
      featureHeaders.push(index);
  }
  if (featureHeaders.length > 1)
    throw new Error('config.toml contains multiple [features] tables');

  if (featureHeaders.length === 1) {
    const start = featureHeaders[0] + 1;
    let end = lines.length;
    for (let index = start; index < lines.length; index += 1) {
      if (tableHeader.test(lines[index])) {
        end = index;
        break;
      }
    }
    for (const [key, value] of [
      ['multi_agent', 'true'],
      ['multi_agent_v2', 'false'],
    ]) {
      const indexes = [];
      for (let index = start; index < end; index += 1) {
        if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index]))
          indexes.push(index);
      }
      if (indexes.length > 1)
        throw new Error(`config.toml contains multiple features.${key} settings`);
      if (indexes.length === 1)
        lines[indexes[0]] = `${key} = ${value}`;
      else {
        lines.splice(end, 0, `${key} = ${value}`);
        end += 1;
      }
    }
  } else {
    const dotted = new Map();
    const currentFirstTable = lines.findIndex(line => tableHeader.test(line));
    const currentTopLevelEnd = currentFirstTable < 0 ? lines.length : currentFirstTable;
    for (let index = 0; index < currentTopLevelEnd; index += 1) {
      const match = lines[index].match(/^\s*features\.(multi_agent|multi_agent_v2)\s*=/);
      if (match) {
        if (dotted.has(match[1]))
          throw new Error(`config.toml contains multiple features.${match[1]} settings`);
        dotted.set(match[1], index);
      }
      if (/^\s*features\s*=\s*\{/.test(lines[index]))
        throw new Error('config.toml uses an inline features table, which cannot be safely patched');
    }
    if (dotted.size > 0) {
      const additions = [];
      for (const [key, value] of [
        ['multi_agent', 'true'],
        ['multi_agent_v2', 'false'],
      ]) {
        if (dotted.has(key))
          lines[dotted.get(key)] = `features.${key} = ${value}`;
        else
          additions.push(`features.${key} = ${value}`);
      }
      lines.splice(currentTopLevelEnd, 0, ...additions);
    } else {
      if (lines.length > 0 && lines.at(-1) !== '')
        lines.push('');
      lines.push('[features]', 'multi_agent = true', 'multi_agent_v2 = false');
    }
  }

  return joinConfig(document);
}

function splitConfig(original) {
  const hadBom = original.startsWith('\ufeff');
  const source = hadBom ? original.slice(1) : original;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /(?:\r\n|\n)$/.test(source);
  const lines = source === '' ? [] : source.split(/\r?\n/);
  if (hadTrailingNewline)
    lines.pop();
  return { hadBom, hadTrailingNewline, lines, newline };
}

function joinConfig(document) {
  return `${document.hadBom ? '\ufeff' : ''}${document.lines.join(document.newline)}${document.hadTrailingNewline ? document.newline : ''}`;
}

function tableHeaderIndex(lines, name) {
  const indexes = [];
  const pattern = new RegExp(`^\\s*\\[\\s*${name}\\s*\\]\\s*(?:#.*)?$`);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index]))
      indexes.push(index);
  }
  if (indexes.length > 1)
    throw new Error(`config.toml contains multiple [${name}] tables`);
  return indexes.length === 1 ? indexes[0] : -1;
}

function tableEnd(lines, start) {
  const tableHeader = /^\s*\[.*\]\s*(?:#.*)?$/;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (tableHeader.test(lines[index]))
      return index;
  }
  return lines.length;
}

function topLevelEnd(lines) {
  const tableHeader = /^\s*\[.*\]\s*(?:#.*)?$/;
  const index = lines.findIndex(line => tableHeader.test(line));
  return index < 0 ? lines.length : index;
}

function settingIndexes(lines, start, end, pattern) {
  const indexes = [];
  for (let index = start; index < end; index += 1) {
    if (pattern.test(lines[index]))
      indexes.push(index);
  }
  return indexes;
}

function oneSettingIndex(lines, start, end, pattern, description, required) {
  const indexes = settingIndexes(lines, start, end, pattern);
  if (indexes.length > 1)
    throw new Error(`config.toml contains multiple ${description} settings`);
  if (required && indexes.length !== 1)
    throw new Error(`Temporary ${description} setting is missing from config.toml`);
  return indexes.length === 1 ? indexes[0] : -1;
}

function temporaryCatalogPath(current, marker) {
  if (marker.catalogPath)
    return marker.catalogPath;
  const document = splitConfig(current);
  const index = oneSettingIndex(
    document.lines,
    0,
    topLevelEnd(document.lines),
    /^\s*model_catalog_json\s*=/,
    'top-level model_catalog_json',
    true,
  );
  const match = document.lines[index].match(/^\s*model_catalog_json\s*=\s*("(?:\\.|[^"\\])*")\s*$/);
  if (!match)
    throw new Error('Could not recover the temporary model_catalog_json path safely');
  return JSON.parse(match[1]);
}

function restoreOwnedSettings(original, current, marker) {
  const catalogPath = temporaryCatalogPath(current.toString('utf8'), marker);
  const expected = Buffer.from(rewriteConfig(original.toString('utf8'), catalogPath), 'utf8');
  if (sha256(expected) !== marker.modifiedHash)
    throw new Error('Config transaction marker does not match the generated temporary config');
  if (current.equals(expected))
    return { contents: original, merged: false };

  const originalDocument = splitConfig(original.toString('utf8'));
  const currentDocument = splitConfig(current.toString('utf8'));
  const catalogSetting = `model_catalog_json = ${JSON.stringify(path.resolve(catalogPath))}`;
  const currentCatalogIndex = oneSettingIndex(
    currentDocument.lines,
    0,
    topLevelEnd(currentDocument.lines),
    /^\s*model_catalog_json\s*=/,
    'top-level model_catalog_json',
    true,
  );
  if (currentDocument.lines[currentCatalogIndex] !== catalogSetting)
    throw new Error('Temporary model_catalog_json setting changed while Codex was starting');
  const originalCatalogIndex = oneSettingIndex(
    originalDocument.lines,
    0,
    topLevelEnd(originalDocument.lines),
    /^\s*model_catalog_json\s*=/,
    'top-level model_catalog_json',
    false,
  );
  if (originalCatalogIndex >= 0)
    currentDocument.lines[currentCatalogIndex] = originalDocument.lines[originalCatalogIndex];
  else
    currentDocument.lines.splice(currentCatalogIndex, 1);

  const originalFeatures = tableHeaderIndex(originalDocument.lines, 'features');
  if (originalFeatures >= 0) {
    for (const [key, value] of [['multi_agent', 'true'], ['multi_agent_v2', 'false']]) {
      const currentStart = tableHeaderIndex(currentDocument.lines, 'features');
      if (currentStart < 0)
        throw new Error('Temporary [features] table is missing from config.toml');
      const currentIndex = oneSettingIndex(
        currentDocument.lines,
        currentStart + 1,
        tableEnd(currentDocument.lines, currentStart),
        new RegExp(`^\\s*${key}\\s*=`),
        `features.${key}`,
        true,
      );
      if (currentDocument.lines[currentIndex] !== `${key} = ${value}`)
        throw new Error(`Temporary features.${key} setting changed while Codex was starting`);
      const originalIndex = oneSettingIndex(
        originalDocument.lines,
        originalFeatures + 1,
        tableEnd(originalDocument.lines, originalFeatures),
        new RegExp(`^\\s*${key}\\s*=`),
        `features.${key}`,
        false,
      );
      if (originalIndex >= 0)
        currentDocument.lines[currentIndex] = originalDocument.lines[originalIndex];
      else
        currentDocument.lines.splice(currentIndex, 1);
    }
  } else {
    const originalTopEnd = topLevelEnd(originalDocument.lines);
    const originalDotted = ['multi_agent', 'multi_agent_v2'].some(key =>
      settingIndexes(originalDocument.lines, 0, originalTopEnd, new RegExp(`^\\s*features\\.${key}\\s*=`)).length > 0,
    );
    if (originalDotted) {
      for (const [key, value] of [['multi_agent', 'true'], ['multi_agent_v2', 'false']]) {
        const currentIndex = oneSettingIndex(
          currentDocument.lines,
          0,
          topLevelEnd(currentDocument.lines),
          new RegExp(`^\\s*features\\.${key}\\s*=`),
          `features.${key}`,
          true,
        );
        if (currentDocument.lines[currentIndex] !== `features.${key} = ${value}`)
          throw new Error(`Temporary features.${key} setting changed while Codex was starting`);
        const originalIndex = oneSettingIndex(
          originalDocument.lines,
          0,
          originalTopEnd,
          new RegExp(`^\\s*features\\.${key}\\s*=`),
          `features.${key}`,
          false,
        );
        if (originalIndex >= 0)
          currentDocument.lines[currentIndex] = originalDocument.lines[originalIndex];
        else
          currentDocument.lines.splice(currentIndex, 1);
      }
    } else {
      const currentFeatures = tableHeaderIndex(currentDocument.lines, 'features');
      if (currentFeatures < 0)
        throw new Error('Temporary [features] table is missing from config.toml');
      for (const [key, value] of [['multi_agent_v2', 'false'], ['multi_agent', 'true']]) {
        const currentIndex = oneSettingIndex(
          currentDocument.lines,
          currentFeatures + 1,
          tableEnd(currentDocument.lines, currentFeatures),
          new RegExp(`^\\s*${key}\\s*=`),
          `features.${key}`,
          true,
        );
        if (currentDocument.lines[currentIndex] !== `${key} = ${value}`)
          throw new Error(`Temporary features.${key} setting changed while Codex was starting`);
        currentDocument.lines.splice(currentIndex, 1);
      }
      const refreshedFeatures = tableHeaderIndex(currentDocument.lines, 'features');
      const refreshedEnd = tableEnd(currentDocument.lines, refreshedFeatures);
      const remainingBody = currentDocument.lines.slice(refreshedFeatures + 1, refreshedEnd);
      if (remainingBody.every(line => line.trim() === '')) {
        currentDocument.lines.splice(refreshedFeatures, refreshedEnd - refreshedFeatures);
        if (refreshedFeatures > 0 && currentDocument.lines[refreshedFeatures - 1] === '')
          currentDocument.lines.splice(refreshedFeatures - 1, 1);
      }
    }
  }

  const merged = Buffer.from(joinConfig(currentDocument), 'utf8');
  return { contents: merged, merged: true };
}

function readMarker(markerPath) {
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (!marker || marker.version !== 1)
    throw new Error(`Invalid config transaction marker: ${markerPath}`);
  return marker;
}

function cleanupTransactionFiles(paths) {
  fs.rmSync(paths.backupPath, { force: true });
  fs.rmSync(paths.markerPath, { force: true });
  fs.rmSync(paths.lockPath, { force: true });
}

function recoverConfigTransaction(configPath, log = () => {}) {
  const paths = transactionPaths(configPath);
  if (!fs.existsSync(paths.markerPath)) {
    if (fs.existsSync(paths.backupPath)) {
      const current = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
      const backup = fs.readFileSync(paths.backupPath);
      if ((current && sha256(current) === sha256(backup)) || (!current && backup.length === 0))
        fs.rmSync(paths.backupPath, { force: true });
      else
        throw new Error(`Found an orphaned config backup that requires inspection: ${paths.backupPath}`);
    }
    fs.rmSync(paths.lockPath, { force: true });
    return false;
  }

  const marker = readMarker(paths.markerPath);
  const current = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
  const currentStat = current !== null ? fs.statSync(configPath) : null;
  const currentHash = current ? sha256(current) : null;
  if (currentHash === marker.originalHash) {
    cleanupTransactionFiles(paths);
    return false;
  }
  if (marker.originalExisted) {
    if (current === null)
      throw new Error(`Codex config disappeared during restoration. Preserved backup: ${paths.backupPath}`);
    const backup = fs.readFileSync(paths.backupPath);
    if (sha256(backup) !== marker.originalHash)
      throw new Error(`Config transaction backup checksum mismatch: ${paths.backupPath}`);
    const restored = currentHash === marker.modifiedHash
      ? { contents: backup, merged: false }
      : restoreOwnedSettings(backup, current, marker);
    const latest = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
    if (!latest || sha256(latest) !== currentHash)
      throw new Error(`Codex config changed again during restoration. Preserved backup: ${paths.backupPath}`);
    atomicWrite(configPath, restored.contents, marker.originalMode);
    const atimeMs = restored.merged ? currentStat.atimeMs : marker.originalAtimeMs;
    const mtimeMs = restored.merged ? currentStat.mtimeMs : marker.originalMtimeMs;
    if (Number.isFinite(mtimeMs)) {
      const atime = new Date(Number.isFinite(atimeMs) ? atimeMs : mtimeMs);
      fs.utimesSync(configPath, atime, new Date(mtimeMs));
    }
    if (restored.merged)
      log(`Preserved non-overlapping Codex config changes while removing the launch override: ${configPath}`);
  } else {
    const restored = currentHash === marker.modifiedHash
      ? { contents: Buffer.alloc(0), merged: false }
      : restoreOwnedSettings(Buffer.alloc(0), current, marker);
    const latest = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
    if (!latest || sha256(latest) !== currentHash)
      throw new Error(`Codex config changed again during restoration. Preserved temporary file: ${configPath}`);
    if (restored.contents.length === 0)
      fs.rmSync(configPath, { force: true });
    else
      atomicWrite(configPath, restored.contents, marker.originalMode);
    if (restored.merged)
      log(`Preserved config.toml created by Codex while removing the launch override: ${configPath}`);
  }
  cleanupTransactionFiles(paths);
  log(`Recovered interrupted Codex config transaction: ${configPath}`);
  return true;
}

function beginConfigTransaction(configPath, catalogPath, log = () => {}) {
  recoverConfigTransaction(configPath, log);
  const paths = transactionPaths(configPath);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let lockDescriptor;
  try {
    lockDescriptor = fs.openSync(paths.lockPath, 'wx', 0o600);
    fs.writeFileSync(lockDescriptor, `${process.pid}\n`);
    fs.closeSync(lockDescriptor);
    lockDescriptor = undefined;
  } catch (error) {
    if (lockDescriptor !== undefined)
      fs.closeSync(lockDescriptor);
    throw new Error(`Could not lock Codex config transaction: ${error.message}`);
  }

  let originalExisted;
  let original;
  let stat;
  let configWritten = false;
  try {
    originalExisted = fs.existsSync(configPath);
    original = originalExisted ? fs.readFileSync(configPath) : Buffer.alloc(0);
    stat = originalExisted ? fs.statSync(configPath) : null;
    const modified = Buffer.from(rewriteConfig(original.toString('utf8'), catalogPath), 'utf8');
    const marker = {
      version: 1,
      catalogPath: path.resolve(catalogPath),
      originalExisted,
      originalHash: originalExisted ? sha256(original) : null,
      modifiedHash: sha256(modified),
      originalMode: stat ? stat.mode : 0o600,
      originalAtimeMs: stat ? stat.atimeMs : null,
      originalMtimeMs: stat ? stat.mtimeMs : null,
      startedAt: new Date().toISOString(),
    };

    atomicWrite(paths.backupPath, original);
    atomicWrite(paths.markerPath, `${JSON.stringify(marker)}\n`);
    const current = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
    const currentHash = current ? sha256(current) : null;
    if (currentHash !== marker.originalHash)
      throw new Error('Codex config changed while the launch transaction was being prepared');
    atomicWrite(configPath, modified, stat ? stat.mode : 0o600);
    configWritten = true;
  } catch (error) {
    if (configWritten) {
      if (originalExisted)
        atomicWrite(configPath, original, stat.mode);
      else
        fs.rmSync(configPath, { force: true });
    }
    cleanupTransactionFiles(paths);
    throw error;
  }

  let restored = false;
  return {
    configPath,
    paths,
    restore() {
      if (restored)
        return;
      recoverConfigTransaction(configPath);
      restored = true;
      log(`Restored original Codex config: ${configPath}`);
    },
  };
}

function createRuntimeDirectory(environment = process.env) {
  if (!environment.LOCALAPPDATA)
    throw new Error('LOCALAPPDATA is not set; cannot create the launch runtime directory');
  const runtimeRoot = path.join(environment.LOCALAPPDATA, APP_DIRECTORY_NAME, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const runtimeDirectory = fs.mkdtempSync(path.join(runtimeRoot, 'launch-'));
  fs.chmodSync(runtimeDirectory, 0o700);
  return runtimeDirectory;
}

function forceV1Catalog(catalog) {
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0)
    throw new Error('Codex returned an empty or invalid bundled model catalog');
  let changed = 0;
  for (const model of catalog.models) {
    if (model.multi_agent_version === 'v2') {
      model.multi_agent_version = 'v1';
      changed += 1;
    }
  }
  return { catalog, changed };
}

function readCatalog(realCliPath, arguments_, log) {
  const result = spawnSync(realCliPath, arguments_, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error)
    throw result.error;
  if (result.status !== 0)
    throw new Error((result.stderr || '').trim() || `exit code ${result.status}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    log(`Codex returned invalid catalog JSON: ${error.message}`);
    throw error;
  }
}

function prepareCatalogOverride(realCliPath, log = () => {}) {
  if (!fs.existsSync(realCliPath))
    throw new Error(`Codex CLI not found: ${realCliPath}`);
  const configPath = resolveConfigPath();
  recoverConfigTransaction(configPath, log);

  let parsed;
  try {
    parsed = readCatalog(realCliPath, ['debug', 'models'], log);
    log('Loaded the current effective Codex model catalog');
  } catch (onlineError) {
    log(`Current catalog unavailable; using the catalog bundled with Codex (${onlineError.message})`);
    try {
      parsed = readCatalog(realCliPath, ['debug', 'models', '--bundled'], log);
    } catch (bundledError) {
      throw new Error(`Could not read a Codex model catalog: ${bundledError.message}`);
    }
  }

  const { catalog, changed } = forceV1Catalog(parsed);
  const runtimeDirectory = createRuntimeDirectory();
  const catalogPath = path.join(runtimeDirectory, 'models-v1.json');
  let configTransaction;
  try {
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`, { encoding: 'utf8', mode: 0o600 });
    const verified = readCatalog(realCliPath, [
      '-c', `model_catalog_json=${JSON.stringify(path.resolve(catalogPath))}`,
      '-c', 'features.multi_agent=true',
      '-c', 'features.multi_agent_v2=false',
      'debug', 'models',
    ], log);
    const remainingV2 = verified.models.filter(model => model.multi_agent_version === 'v2').length;
    if (remainingV2 !== 0)
      throw new Error(`Generated Codex catalog verification found ${remainingV2} V2 entries`);
    configTransaction = beginConfigTransaction(configPath, catalogPath, log);
  } catch (error) {
    try {
      configTransaction?.restore();
    } finally {
      fs.rmSync(runtimeDirectory, { recursive: true, force: true });
    }
    throw error;
  }

  log(`Generated and verified launch-only model catalog; changed ${changed} V2 model${changed === 1 ? '' : 's'} to V1`);
  return {
    catalogPath,
    runtimeDirectory,
    environment: process.env,
    restoreConfig: () => configTransaction.restore(),
    cleanup() {
      configTransaction.restore();
      fs.rmSync(runtimeDirectory, { recursive: true, force: true });
    },
  };
}

module.exports = {
  APP_DIRECTORY_NAME,
  beginConfigTransaction,
  createRuntimeDirectory,
  forceV1Catalog,
  prepareCatalogOverride,
  recoverConfigTransaction,
  resolveConfigPath,
  rewriteConfig,
};

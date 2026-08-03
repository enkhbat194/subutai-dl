import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import electronUpdater, { type AppUpdater } from 'electron-updater';
import {
  readUpdateJournal,
  updaterRootPath,
} from './update-transaction';

declare const __SUBUTAI_REAL_UPDATE_ACCEPTANCE_BUILD__: boolean;

const { autoUpdater } = electronUpdater;
const CONFIG_SCHEMA_VERSION = 1 as const;
const RESULT_SCHEMA_VERSION = 1 as const;
const CONFIG_FILENAME = 'real-two-installer-acceptance.json';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const TOKEN_PATTERN = /^[0-9a-f-]{36}$/u;

type AcceptanceMode = 'healthy' | 'rollback';
type AcceptancePhase =
  | 'ready'
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'completed'
  | 'failed';

interface RealUpdateAcceptanceConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  token: string;
  mode: AcceptanceMode;
  baselineVersion: string;
  targetVersion: string;
  feedUrl: string;
  resultPath: string;
  phase: AcceptancePhase;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

interface RealUpdateAcceptanceResult {
  schemaVersion: typeof RESULT_SCHEMA_VERSION;
  token: string;
  mode: AcceptanceMode;
  outcome: 'healthy-update' | 'rolled-back' | 'failed';
  baselineVersion: string;
  targetVersion: string;
  currentVersion: string;
  recordedAt: string;
  transactionState?: string;
  rollbackState?: string;
  error?: string;
}

function acceptanceEnabled(): boolean {
  return __SUBUTAI_REAL_UPDATE_ACCEPTANCE_BUILD__ === true;
}

export function isRealUpdateAcceptanceActive(): boolean {
  return acceptanceEnabled() && loadRealUpdateAcceptanceConfig() !== null;
}

function configPath(): string {
  return join(updaterRootPath(), CONFIG_FILENAME);
}

function acceptanceUpdaterCachePath(): string | null {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) return null;
  return join(localAppData, '@subutaidesktop-updater');
}

function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const backupPath = `${filePath}.bak`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  rmSync(backupPath, { force: true });
  let movedCurrent = false;
  try {
    if (existsSync(filePath)) {
      renameSync(filePath, backupPath);
      movedCurrent = true;
    }
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    if (movedCurrent && !existsSync(filePath) && existsSync(backupPath)) {
      renameSync(backupPath, filePath);
    }
    throw error;
  }
}

function assertVersion(value: string, label: string): void {
  if (!VERSION_PATTERN.test(value)) throw new Error(`${label} is not a valid semantic version.`);
}

function assertLoopbackFeedUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Real updater acceptance feed URL is invalid.');
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('Real updater acceptance feed must use a loopback HTTP address.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Real updater acceptance feed must not contain credentials.');
  }
  return parsed.toString();
}

function validateConfig(value: unknown): RealUpdateAcceptanceConfig {
  if (!value || typeof value !== 'object') throw new Error('Real updater acceptance config is invalid.');
  const config = value as RealUpdateAcceptanceConfig;
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) throw new Error('Unsupported real updater acceptance config schema.');
  if (!TOKEN_PATTERN.test(config.token)) throw new Error('Real updater acceptance token is invalid.');
  if (!['healthy', 'rollback'].includes(config.mode)) throw new Error('Real updater acceptance mode is invalid.');
  assertVersion(config.baselineVersion, 'Acceptance baseline version');
  assertVersion(config.targetVersion, 'Acceptance target version');
  if (config.baselineVersion === config.targetVersion) throw new Error('Acceptance target version must differ from baseline.');
  config.feedUrl = assertLoopbackFeedUrl(config.feedUrl);
  if (!isAbsolute(config.resultPath)) throw new Error('Real updater acceptance result path must be absolute.');
  config.resultPath = resolve(config.resultPath);
  if (!['ready', 'checking', 'downloading', 'installing', 'completed', 'failed'].includes(config.phase)) {
    throw new Error('Real updater acceptance phase is invalid.');
  }
  if (Number.isNaN(Date.parse(config.createdAt)) || Number.isNaN(Date.parse(config.updatedAt))) {
    throw new Error('Real updater acceptance timestamps are invalid.');
  }
  return config;
}

export function loadRealUpdateAcceptanceConfig(): RealUpdateAcceptanceConfig | null {
  if (!acceptanceEnabled()) return null;
  const path = configPath();
  if (!existsSync(path)) return null;
  return validateConfig(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function saveConfig(config: RealUpdateAcceptanceConfig): RealUpdateAcceptanceConfig {
  const next = validateConfig({ ...config, updatedAt: new Date().toISOString() });
  atomicWriteJson(configPath(), next);
  return next;
}

function configFromEnvironment(): RealUpdateAcceptanceConfig | null {
  if (!acceptanceEnabled() || process.env.SUBUTAI_REAL_UPDATE_ACCEPTANCE !== '1') return null;
  const token = process.env.SUBUTAI_REAL_UPDATE_TOKEN?.trim() ?? '';
  const mode = process.env.SUBUTAI_REAL_UPDATE_MODE?.trim() ?? '';
  const baselineVersion = process.env.SUBUTAI_REAL_UPDATE_BASELINE_VERSION?.trim() ?? '';
  const targetVersion = process.env.SUBUTAI_REAL_UPDATE_TARGET_VERSION?.trim() ?? '';
  const feedUrl = process.env.SUBUTAI_REAL_UPDATE_FEED_URL?.trim() ?? '';
  const resultPath = process.env.SUBUTAI_REAL_UPDATE_RESULT_PATH?.trim() ?? '';
  const now = new Date().toISOString();
  return validateConfig({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    token,
    mode,
    baselineVersion,
    targetVersion,
    feedUrl,
    resultPath,
    phase: 'ready',
    createdAt: now,
    updatedAt: now,
  });
}

export function initializeRealUpdateAcceptance(): RealUpdateAcceptanceConfig | null {
  if (!acceptanceEnabled()) return null;
  const incoming = configFromEnvironment();
  const existing = loadRealUpdateAcceptanceConfig();
  if (!incoming) return existing;
  if (existing?.token === incoming.token) return existing;
  if (app.getVersion() === incoming.baselineVersion) {
    const updaterCache = acceptanceUpdaterCachePath();
    if (updaterCache) rmSync(updaterCache, { recursive: true, force: true });
  }
  atomicWriteJson(configPath(), incoming);
  return incoming;
}

export function configureRealUpdateAcceptanceUpdater(updater: AppUpdater): RealUpdateAcceptanceConfig | null {
  const config = loadRealUpdateAcceptanceConfig();
  if (!config || app.getVersion() !== config.baselineVersion || config.phase === 'completed' || config.phase === 'failed') {
    return config;
  }
  updater.setFeedURL({ provider: 'generic', url: config.feedUrl });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  return config;
}

function writeResult(config: RealUpdateAcceptanceConfig, result: RealUpdateAcceptanceResult): void {
  atomicWriteJson(config.resultPath, result);
}

function failAcceptance(config: RealUpdateAcceptanceConfig, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const failed = saveConfig({ ...config, phase: 'failed', lastError: message.slice(0, 2_000) });
  writeResult(failed, {
    schemaVersion: RESULT_SCHEMA_VERSION,
    token: failed.token,
    mode: failed.mode,
    outcome: 'failed',
    baselineVersion: failed.baselineVersion,
    targetVersion: failed.targetVersion,
    currentVersion: app.getVersion(),
    recordedAt: new Date().toISOString(),
    error: message.slice(0, 2_000),
  });
}

export async function driveRealUpdateAcceptance(updater: AppUpdater): Promise<void> {
  let config = loadRealUpdateAcceptanceConfig();
  if (!config || app.getVersion() !== config.baselineVersion || config.phase !== 'ready') return;

  const onUpdaterError = (error: Error): void => {
    const latest = loadRealUpdateAcceptanceConfig();
    if (latest && latest.token === config?.token && latest.phase !== 'completed') failAcceptance(latest, error);
  };
  updater.once('error', onUpdaterError);
  try {
    config = saveConfig({ ...config, phase: 'checking' });
    const check = await updater.checkForUpdates();
    const availableVersion = check?.updateInfo.version ?? '';
    if (availableVersion !== config.targetVersion) {
      throw new Error(`Expected updater target ${config.targetVersion}, received ${availableVersion || 'none'}.`);
    }

    config = saveConfig({ ...config, phase: 'downloading' });
    await updater.downloadUpdate();
    config = saveConfig({ ...config, phase: 'installing' });
    updater.quitAndInstall(false, true);
  } catch (error) {
    updater.removeListener('error', onUpdaterError);
    failAcceptance(config, error);
  }
}

export function startRealUpdateAcceptanceDriver(): void {
  const config = configureRealUpdateAcceptanceUpdater(autoUpdater);
  if (!config || app.getVersion() !== config.baselineVersion || config.phase !== 'ready') return;
  setTimeout(() => { void driveRealUpdateAcceptance(autoUpdater); }, 1_000).unref();
}

export function realUpdateAcceptanceTransactionOptions(): {
  healthTimeoutMs?: number;
  maxStartupAttempts?: number;
} {
  const config = loadRealUpdateAcceptanceConfig();
  if (!config) return {};
  if (config.mode === 'rollback') return { healthTimeoutMs: 15_000, maxStartupAttempts: 1 };
  return { healthTimeoutMs: 120_000, maxStartupAttempts: 3 };
}

export function shouldFailRealUpdateAcceptanceHealth(): boolean {
  const config = loadRealUpdateAcceptanceConfig();
  return Boolean(
    config
    && config.mode === 'rollback'
    && config.phase === 'installing'
    && app.getVersion() === config.targetVersion,
  );
}

export async function recordHealthyRealUpdateAcceptance(): Promise<boolean> {
  const config = loadRealUpdateAcceptanceConfig();
  if (!config || config.mode !== 'healthy' || app.getVersion() !== config.targetVersion) return false;
  const journal = await readUpdateJournal();
  if (!journal || journal.updateState !== 'committed' || journal.targetVersion !== config.targetVersion) {
    failAcceptance(config, new Error('Healthy target started without a committed update transaction.'));
    return false;
  }
  const completed = saveConfig({ ...config, phase: 'completed' });
  writeResult(completed, {
    schemaVersion: RESULT_SCHEMA_VERSION,
    token: completed.token,
    mode: completed.mode,
    outcome: 'healthy-update',
    baselineVersion: completed.baselineVersion,
    targetVersion: completed.targetVersion,
    currentVersion: app.getVersion(),
    recordedAt: new Date().toISOString(),
    transactionState: journal.updateState,
    rollbackState: journal.rollbackState,
  });
  return true;
}

export async function recordRolledBackRealUpdateAcceptance(): Promise<boolean> {
  const config = loadRealUpdateAcceptanceConfig();
  if (!config || config.mode !== 'rollback' || app.getVersion() !== config.baselineVersion) return false;
  const journal = await readUpdateJournal();
  if (!journal || journal.updateState !== 'rolled-back' || journal.rollbackState !== 'succeeded') return false;
  const completed = saveConfig({ ...config, phase: 'completed' });
  writeResult(completed, {
    schemaVersion: RESULT_SCHEMA_VERSION,
    token: completed.token,
    mode: completed.mode,
    outcome: 'rolled-back',
    baselineVersion: completed.baselineVersion,
    targetVersion: completed.targetVersion,
    currentVersion: app.getVersion(),
    recordedAt: new Date().toISOString(),
    transactionState: journal.updateState,
    rollbackState: journal.rollbackState,
  });
  return true;
}

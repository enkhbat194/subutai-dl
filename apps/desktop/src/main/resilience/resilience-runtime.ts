import { app, BrowserWindow, ipcMain, net, powerMonitor } from 'electron';
import { join } from 'node:path';
import type { DownloadJob, NetworkResilienceState } from '@subutai/shared';
import { JobStore } from '../storage/job-store';
import { canAutoRetry } from './failure-policy';

interface RuntimeSessionMarker {
  sessionId: string;
  startedAt: string;
  cleanShutdown: boolean;
  closedAt?: string;
}

type MainInvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

const SESSION_KEY = 'runtime-session-marker';
const RETRY_COUNTS_KEY = 'network-retry-counts';
let store: JobStore | null = null;
let timer: NodeJS.Timeout | null = null;
let sessionId = '';
let retryCounts: Record<string, number> = {};
let state: NetworkResilienceState = {
  online: true,
  recoveredFromCrash: false,
  sessionStartedAt: new Date().toISOString(),
  recoveredJobs: 0,
  pendingNetworkFailures: 0,
};

function invokeHandlers(): Map<string, MainInvokeHandler> {
  const internal = ipcMain as unknown as { _invokeHandlers?: Map<string, MainInvokeHandler> };
  if (!internal._invokeHandlers) throw new Error('Electron IPC invoke handler registry is unavailable.');
  return internal._invokeHandlers;
}

function invokeMain<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = invokeHandlers().get(channel);
  if (!handler) throw new Error(`Main IPC handler бүртгэгдээгүй: ${channel}`);
  return Promise.resolve(handler({}, ...args) as T);
}

function listDownloads(): DownloadJob[] {
  const handler = invokeHandlers().get('downloads:list');
  if (!handler) return [];
  const result = handler({});
  return Array.isArray(result) ? result as DownloadJob[] : [];
}

function retryAwareJob(job: DownloadJob): DownloadJob {
  return {
    ...job,
    retryCount: Math.max(job.retryCount ?? 0, retryCounts[job.id] ?? 0),
  };
}

function pendingFailures(): number {
  return listDownloads().filter((job) => canAutoRetry(retryAwareJob(job))).length;
}

function currentState(): NetworkResilienceState {
  return {
    ...state,
    pendingNetworkFailures: pendingFailures(),
  };
}

function broadcast(): void {
  const snapshot = currentState();
  state.pendingNetworkFailures = snapshot.pendingNetworkFailures;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('network-resilience:changed', snapshot);
  }
}

function persistRetryCounts(): void {
  store?.saveState(RETRY_COUNTS_KEY, retryCounts);
}

async function recover(reason: 'online' | 'resume' | 'manual' | 'startup'): Promise<NetworkResilienceState> {
  let recovered = 0;
  for (const rawJob of listDownloads()) {
    const job = retryAwareJob(rawJob);
    if (!canAutoRetry(job)) continue;
    try {
      await invokeMain<DownloadJob>('downloads:cancel', job.id);
      await invokeMain<DownloadJob>('downloads:resume', job.id);
      retryCounts[job.id] = (job.retryCount ?? 0) + 1;
      recovered += 1;
    } catch {
      // Keep the failed job visible for a later manual or online retry.
    }
  }
  if (recovered > 0) persistRetryCounts();

  const now = new Date().toISOString();
  state = {
    ...state,
    online: net.isOnline(),
    lastRecoveryAt: now,
    recoveredJobs: state.recoveredJobs + recovered,
  };
  if (reason === 'online' || state.online) state.lastOnlineAt = now;
  broadcast();
  return currentState();
}

async function pollNetwork(): Promise<void> {
  const online = net.isOnline();
  if (online === state.online) {
    const pending = pendingFailures();
    if (pending !== state.pendingNetworkFailures) broadcast();
    return;
  }

  const now = new Date().toISOString();
  state.online = online;
  if (online) {
    state.lastOnlineAt = now;
    await recover('online');
  } else {
    state.lastOfflineAt = now;
    broadcast();
  }
}

function markCleanShutdown(): void {
  if (!store || !sessionId) return;
  const marker: RuntimeSessionMarker = {
    sessionId,
    startedAt: state.sessionStartedAt,
    cleanShutdown: true,
    closedAt: new Date().toISOString(),
  };
  store.saveState(SESSION_KEY, marker);
}

async function initialize(): Promise<void> {
  store = new JobStore(join(app.getPath('userData'), 'data', 'subutai.db'));
  const previous = store.loadState<RuntimeSessionMarker>(SESSION_KEY);
  retryCounts = store.loadState<Record<string, number>>(RETRY_COUNTS_KEY) ?? {};
  const now = new Date().toISOString();
  sessionId = crypto.randomUUID();
  state = {
    online: net.isOnline(),
    recoveredFromCrash: Boolean(previous && previous.cleanShutdown === false),
    sessionStartedAt: now,
    recoveredJobs: 0,
    pendingNetworkFailures: pendingFailures(),
  };
  if (state.online) state.lastOnlineAt = now;
  const marker: RuntimeSessionMarker = {
    sessionId,
    startedAt: now,
    cleanShutdown: false,
  };
  store.saveState(SESSION_KEY, marker);

  if (state.recoveredFromCrash || state.pendingNetworkFailures > 0) {
    await recover('startup');
  }
  timer = setInterval(() => void pollNetwork(), 3_000);
  powerMonitor.on('resume', () => void recover('resume'));
  broadcast();
}

ipcMain.handle('network-resilience:get', (): NetworkResilienceState => currentState());
ipcMain.handle('network-resilience:retry', () => recover('manual'));

void app.whenReady().then(initialize);
app.on('before-quit', () => {
  if (timer) clearInterval(timer);
  timer = null;
  markCleanShutdown();
  persistRetryCounts();
  store?.close();
  store = null;
});

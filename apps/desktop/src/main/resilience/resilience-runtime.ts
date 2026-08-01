import { app, BrowserWindow, ipcMain, net, powerMonitor } from 'electron';
import { join } from 'node:path';
import type { NetworkResilienceState } from '@subutai/shared';
import { JobStore } from '../storage/job-store';
import {
  getDownloadSnapshot,
  recoverNetworkInterruptedDownloads,
} from '../subutai-runtime';
import { canAutoRetry } from './failure-policy';

interface RuntimeSessionMarker {
  sessionId: string;
  startedAt: string;
  cleanShutdown: boolean;
  closedAt?: string;
}

const SESSION_KEY = 'runtime-session-marker';
let store: JobStore | null = null;
let timer: NodeJS.Timeout | null = null;
let sessionId = '';
let state: NetworkResilienceState = {
  online: true,
  recoveredFromCrash: false,
  sessionStartedAt: new Date().toISOString(),
  recoveredJobs: 0,
  pendingNetworkFailures: 0,
};

function pendingFailures(): number {
  return getDownloadSnapshot().filter((job) => canAutoRetry(job)).length;
}

function currentState(): NetworkResilienceState {
  return {
    ...state,
    pendingNetworkFailures: pendingFailures(),
  };
}

function broadcast(): void {
  const snapshot = currentState();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('network-resilience:changed', snapshot);
  }
}

async function recover(reason: 'online' | 'resume' | 'manual' | 'startup'): Promise<NetworkResilienceState> {
  const recovered = await recoverNetworkInterruptedDownloads();
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
    if (pendingFailures() !== state.pendingNetworkFailures) broadcast();
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
  store?.close();
  store = null;
});

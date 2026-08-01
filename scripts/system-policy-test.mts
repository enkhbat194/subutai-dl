import assert from 'node:assert/strict';
import {
  DEFAULT_SYSTEM_SETTINGS,
  downloadCountSummary,
  downloadNotificationTransitions,
  normalizeSystemSettings,
} from '../apps/desktop/src/main/system/system-policy.ts';
import type { DownloadJob } from '../packages/shared/src/index.ts';

function job(id: string, status: DownloadJob['status']): DownloadJob {
  return {
    id,
    url: `https://example.test/${id}`,
    filename: `${id}.bin`,
    destination: '/tmp',
    engine: 'subutai',
    status,
    downloadedBytes: status === 'completed' ? 100 : 20,
    totalBytes: 100,
    speedBytesPerSecond: 0,
    etaSeconds: null,
    connections: 8,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:01.000Z',
  };
}

const normalized = normalizeSystemSettings(DEFAULT_SYSTEM_SETTINGS, {
  trayEnabled: false,
  launchAtLogin: true,
  automaticUpdateDownloads: true,
});
assert.equal(normalized.trayEnabled, false);
assert.equal(normalized.launchAtLogin, true);
assert.equal(normalized.automaticUpdateDownloads, true);
assert.equal(normalized.notifyOnComplete, true);

const previous = new Map<string, DownloadJob>([
  ['done', job('done', 'downloading')],
  ['failed', job('failed', 'downloading')],
  ['same', job('same', 'completed')],
]);
const failed = job('failed', 'failed');
failed.error = 'Connection reset';
const events = downloadNotificationTransitions(previous, [
  job('done', 'completed'),
  failed,
  job('same', 'completed'),
], DEFAULT_SYSTEM_SETTINGS);
assert.deepEqual(events.map((event) => event.kind), ['completed', 'failed']);

const disabled = downloadNotificationTransitions(previous, [job('done', 'completed')], {
  ...DEFAULT_SYSTEM_SETTINGS,
  notificationsEnabled: false,
});
assert.equal(disabled.length, 0);

assert.deepEqual(downloadCountSummary([
  job('a', 'downloading'),
  job('b', 'resolving'),
  job('c', 'queued'),
  job('d', 'failed'),
  job('e', 'completed'),
]), { active: 2, queued: 1, failed: 1, completed: 1 });

console.log('Subutai system policy tests passed.');

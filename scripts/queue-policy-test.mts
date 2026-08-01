import assert from 'node:assert/strict';
import { isScheduleActive, queueAllowance, sortQueuedJobs } from '../apps/desktop/src/main/queue/queue-policy.ts';

const overnight = {
  id: 'night',
  name: 'Night queue',
  enabled: true,
  days: [1, 2, 3, 4, 5],
  startTime: '22:00',
  endTime: '06:00',
  maxConcurrentDownloads: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const monday2300 = new Date(2026, 7, 3, 23, 0, 0);
const tuesday0100 = new Date(2026, 7, 4, 1, 0, 0);
const monday1200 = new Date(2026, 7, 3, 12, 0, 0);
const saturday0100 = new Date(2026, 7, 8, 1, 0, 0);

assert.equal(isScheduleActive(overnight, monday2300), true, 'Monday night should be active.');
assert.equal(isScheduleActive(overnight, tuesday0100), true, 'Tuesday early morning belongs to Monday window.');
assert.equal(isScheduleActive(overnight, monday1200), false, 'Monday noon should be inactive.');
assert.equal(isScheduleActive(overnight, saturday0100), true, 'Saturday early morning belongs to Friday window.');

const settings = {
  maxConcurrentDownloads: 4,
  schedulingEnabled: true,
  pauseOutsideSchedule: true,
};

assert.deepEqual(queueAllowance(settings, [overnight], monday2300), {
  allowed: true,
  maxConcurrent: 2,
  activeScheduleIds: ['night'],
});
assert.deepEqual(queueAllowance(settings, [overnight], monday1200), {
  allowed: false,
  maxConcurrent: 4,
  activeScheduleIds: [],
});

const baseJob = {
  url: 'https://example.test/file',
  filename: 'file',
  destination: '/tmp',
  engine: 'subutai',
  status: 'queued',
  downloadedBytes: 0,
  totalBytes: null,
  speedBytesPerSecond: 0,
  etaSeconds: null,
  connections: 4,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const sorted = sortQueuedJobs([
  { ...baseJob, id: 'low', priority: 'low', queueOrder: 1 },
  { ...baseJob, id: 'normal', priority: 'normal', queueOrder: 1 },
  { ...baseJob, id: 'high-later', priority: 'high', queueOrder: 8 },
  { ...baseJob, id: 'high-first', priority: 'high', queueOrder: 2 },
]);
assert.deepEqual(sorted.map((job) => job.id), ['high-first', 'high-later', 'normal', 'low']);

console.log('Subutai queue policy tests passed.');

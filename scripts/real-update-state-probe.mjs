import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const [command, userDataArgument, downloadsArgument, outputArgument] = process.argv.slice(2);
if (!['seed', 'snapshot'].includes(command) || !userDataArgument || !downloadsArgument || !outputArgument) {
  throw new Error('Usage: node scripts/real-update-state-probe.mjs <seed|snapshot> <user-data> <downloads> <output>');
}

const userData = resolve(userDataArgument);
const downloads = resolve(downloadsArgument);
const output = resolve(outputArgument);
const databasePath = join(userData, 'data', 'subutai.db');
const settingsPath = join(userData, 'acceptance-settings.json');
const partialPath = join(downloads, 'acceptance.bin.subutai.part');
const journalPath = join(downloads, 'acceptance.bin.subutai.job');
const sentinelJobId = 'real-update-acceptance-job';
const sentinelStateKey = 'real-update-acceptance-state';
const now = '2026-08-03T00:00:00.000Z';

function hashBuffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(path) {
  return hashBuffer(await readFile(path));
}

function openDatabase() {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return database;
}

async function seed() {
  await mkdir(dirname(databasePath), { recursive: true });
  await mkdir(downloads, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify({
    schemaVersion: 1,
    marker: 'subutai-real-update-settings',
    theme: 'dark',
    defaultConnections: 16,
  }, null, 2)}\n`, 'utf8');
  await writeFile(partialPath, Buffer.from('SUBUTAI_REAL_UPDATE_PARTIAL_SENTINEL_v1\n', 'utf8'));
  await writeFile(journalPath, Buffer.from('SUBUTAI_REAL_UPDATE_JOURNAL_SENTINEL_v1\n', 'utf8'));

  const database = openDatabase();
  try {
    const job = {
      id: sentinelJobId,
      url: 'https://example.invalid/acceptance.bin',
      filename: 'acceptance.bin',
      destination: downloads,
      engine: 'subutai',
      status: 'paused',
      downloadedBytes: 40,
      totalBytes: 4096,
      speedBytesPerSecond: 0,
      etaSeconds: null,
      connections: 16,
      createdAt: now,
      updatedAt: now,
      priority: 'high',
      queueOrder: 1,
      retryCount: 0,
      fileConflictPolicy: 'verified-resume',
      remoteChangePolicy: 'fail',
      destinationPolicyApplied: true,
      remoteRestartCount: 0,
      mirrorIndex: 0,
      activeSourceUrl: 'https://example.invalid/acceptance.bin',
      mirrorFallbackCount: 0,
    };
    database.prepare(`
      INSERT INTO downloads (id, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(sentinelJobId, JSON.stringify(job), now);
    database.prepare(`
      INSERT INTO app_state (key, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run('queue-settings', JSON.stringify({
      maxConcurrentDownloads: 3,
      schedulingEnabled: false,
      pauseOutsideSchedule: true,
    }), now);
    database.prepare(`
      INSERT INTO app_state (key, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(sentinelStateKey, JSON.stringify({
      marker: 'subutai-real-update-database',
      value: 194,
    }), now);
  } finally {
    database.close();
  }
}

async function snapshot() {
  const database = openDatabase();
  let jobPayload;
  let queuePayload;
  let sentinelPayload;
  try {
    jobPayload = database.prepare('SELECT payload FROM downloads WHERE id = ?').get(sentinelJobId)?.payload;
    queuePayload = database.prepare('SELECT payload FROM app_state WHERE key = ?').get('queue-settings')?.payload;
    sentinelPayload = database.prepare('SELECT payload FROM app_state WHERE key = ?').get(sentinelStateKey)?.payload;
  } finally {
    database.close();
  }
  if (!jobPayload || !queuePayload || !sentinelPayload) {
    throw new Error('Real update acceptance database sentinel is missing.');
  }
  const evidence = {
    schemaVersion: 1,
    userData,
    downloads,
    settingsSha256: await hashFile(settingsPath),
    partialSha256: await hashFile(partialPath),
    journalSha256: await hashFile(journalPath),
    job: JSON.parse(jobPayload),
    queueSettings: JSON.parse(queuePayload),
    databaseSentinel: JSON.parse(sentinelPayload),
  };
  const canonical = JSON.stringify(evidence);
  const result = {
    ...evidence,
    logicalStateSha256: hashBuffer(Buffer.from(canonical, 'utf8')),
    recordedAt: new Date().toISOString(),
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(result.logicalStateSha256);
}

if (command === 'seed') await seed();
await snapshot();

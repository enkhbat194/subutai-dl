import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { DownloadJob, DownloadSchedule, QueueSettings } from '@subutai/shared';

const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
  maxConcurrentDownloads: 3,
  schedulingEnabled: false,
  pauseOutsideSchedule: true,
};

export class JobStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
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
  }

  loadAll(): DownloadJob[] {
    const rows = this.database
      .prepare('SELECT payload FROM downloads ORDER BY updated_at DESC')
      .all() as Array<{ payload: string }>;

    const jobs: DownloadJob[] = [];
    for (const row of rows) {
      try {
        jobs.push(JSON.parse(row.payload) as DownloadJob);
      } catch {
        // Ignore a damaged row instead of preventing the app from starting.
      }
    }
    return jobs;
  }

  save(job: DownloadJob): void {
    this.database.prepare(`
      INSERT INTO downloads (id, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).run(job.id, JSON.stringify(job), job.updatedAt);
  }

  saveMany(jobs: Iterable<DownloadJob>): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const job of jobs) this.save(job);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  remove(id: string): void {
    this.database.prepare('DELETE FROM downloads WHERE id = ?').run(id);
  }

  loadQueueSettings(): QueueSettings {
    const row = this.database.prepare('SELECT payload FROM app_state WHERE key = ?').get('queue-settings') as { payload: string } | undefined;
    if (!row) return { ...DEFAULT_QUEUE_SETTINGS };
    try {
      const parsed = JSON.parse(row.payload) as Partial<QueueSettings>;
      return {
        maxConcurrentDownloads: Math.max(1, Math.min(32, Math.trunc(parsed.maxConcurrentDownloads ?? DEFAULT_QUEUE_SETTINGS.maxConcurrentDownloads))),
        schedulingEnabled: parsed.schedulingEnabled ?? DEFAULT_QUEUE_SETTINGS.schedulingEnabled,
        pauseOutsideSchedule: parsed.pauseOutsideSchedule ?? DEFAULT_QUEUE_SETTINGS.pauseOutsideSchedule,
      };
    } catch {
      return { ...DEFAULT_QUEUE_SETTINGS };
    }
  }

  saveQueueSettings(settings: QueueSettings): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO app_state (key, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run('queue-settings', JSON.stringify(settings), now);
  }

  loadSchedules(): DownloadSchedule[] {
    const rows = this.database.prepare('SELECT payload FROM schedules ORDER BY updated_at DESC').all() as Array<{ payload: string }>;
    const schedules: DownloadSchedule[] = [];
    for (const row of rows) {
      try {
        schedules.push(JSON.parse(row.payload) as DownloadSchedule);
      } catch {
        // Ignore damaged schedule rows.
      }
    }
    return schedules;
  }

  saveSchedule(schedule: DownloadSchedule): void {
    this.database.prepare(`
      INSERT INTO schedules (id, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(schedule.id, JSON.stringify(schedule), schedule.updatedAt);
  }

  deleteSchedule(id: string): void {
    this.database.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }

  close(): void {
    this.database.close();
  }
}

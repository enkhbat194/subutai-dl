import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { DownloadJob } from '@subutai/shared';

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

  close(): void {
    this.database.close();
  }
}

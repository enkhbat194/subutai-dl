import { app, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function validateStoredJson(database: DatabaseSync, table: string): void {
  const rows = database.prepare(`SELECT payload FROM ${table} LIMIT 100`).all() as Array<{ payload: string }>;
  for (const row of rows) JSON.parse(row.payload);
}

function verifyUserDatabase(databasePath: string): void {
  if (!existsSync(databasePath)) throw new Error('Subutai user database is missing after update.');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const result = database.prepare('PRAGMA quick_check(1)').get() as Record<string, unknown> | undefined;
    if (!result || !Object.values(result).some((value) => value === 'ok')) {
      throw new Error('Subutai user database integrity check failed after update.');
    }
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('downloads', 'app_state', 'schedules')
    `).all() as Array<{ name: string }>;
    if (new Set(tables.map((entry) => entry.name)).size !== 3) {
      throw new Error('Subutai user database schema is incomplete after update.');
    }
    validateStoredJson(database, 'downloads');
    validateStoredJson(database, 'app_state');
    validateStoredJson(database, 'schedules');
  } finally {
    database.close();
  }
}

async function waitForRendererHealth(timeoutMs = 30_000): Promise<BrowserWindow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      !candidate.isDestroyed()
      && !candidate.webContents.isDestroyed()
      && !candidate.webContents.isLoadingMainFrame()
      && candidate.webContents.getURL().length > 0,
    );
    if (window) return window;
    await delay(250);
  }
  throw new Error('Subutai renderer and preload did not become healthy before the startup deadline.');
}

async function waitForUserDatabase(databasePath: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error('Subutai user database initialization did not begin.');
  while (Date.now() < deadline) {
    try {
      verifyUserDatabase(databasePath);
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError;
}

export async function verifyUpdatedDesktopHealth(nativeMessagingRegistered: boolean): Promise<void> {
  if (!nativeMessagingRegistered) throw new Error('Browser native-messaging registration failed after update.');
  await waitForRendererHealth();

  const preloadPath = join(__dirname, '../preload/index.cjs');
  if (!existsSync(preloadPath)) throw new Error('Subutai preload API is missing after update.');

  if (app.isPackaged) {
    const nativeHostPath = join(process.resourcesPath, 'engines', 'subutai-engine-host.exe');
    if (!existsSync(nativeHostPath)) throw new Error('Subutai native download host is missing after update.');
  }

  await waitForUserDatabase(join(app.getPath('userData'), 'data', 'subutai.db'));
}

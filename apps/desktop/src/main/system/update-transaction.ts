import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_HEALTH_TIMEOUT_MS,
  type ReadJournalOptions,
  type UpdateTransactionJournal,
  readUpdateJournal,
  readUpdateJournalSync,
  redactUpdateError,
  sha256File,
  updateJournalPath,
  updaterRootPath,
  writeUpdateJournal,
  writeUpdateJournalSync,
} from './update-journal.ts';

export * from './update-journal.ts';
export * from './update-staging.ts';

async function replaceJournal(
  rootPath: string,
  allowedInstallRoots: string[] | undefined,
  updater: (journal: UpdateTransactionJournal) => UpdateTransactionJournal | null,
): Promise<UpdateTransactionJournal | null> {
  const journalOptions: ReadJournalOptions = allowedInstallRoots
    ? { rootPath, allowedInstallRoots }
    : { rootPath };
  const journal = await readUpdateJournal(journalOptions);
  if (!journal) return null;
  const next = updater({ ...journal });
  if (!next) return null;
  next.updatedAt = new Date().toISOString();
  await writeUpdateJournal(next, journalOptions);
  return next;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function armUpdateTransaction(
  rootPath?: string,
  allowedInstallRoots?: string[],
): Promise<UpdateTransactionJournal> {
  const root = updaterRootPath(rootPath);
  const result = await replaceJournal(root, allowedInstallRoots, (journal) => {
    if (journal.updateState !== 'staged') throw new Error('Update transaction is not staged.');
    journal.updateState = 'awaiting-health';
    journal.rollbackState = 'ready';
    return journal;
  });
  if (!result) throw new Error('Staged update transaction is missing.');
  return result;
}

export async function beginStartupHealthAttempt(
  currentVersion: string,
  options: ReadJournalOptions & { healthTimeoutMs?: number } = {},
): Promise<UpdateTransactionJournal | null> {
  const root = updaterRootPath(options.rootPath);
  const timeout = Math.max(15_000, Math.min(600_000, options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS));
  return replaceJournal(root, options.allowedInstallRoots, (journal) => {
    if (journal.updateState !== 'awaiting-health' || journal.targetVersion !== currentVersion) return null;
    const now = new Date();
    journal.startupAttemptCount += 1;
    journal.lastLaunchAt = now.toISOString();
    journal.healthDeadline = new Date(now.getTime() + timeout).toISOString();
    delete journal.intentionalExitAt;
    return journal;
  });
}

export async function confirmUpdateHealth(
  currentVersion: string,
  options: ReadJournalOptions = {},
): Promise<UpdateTransactionJournal | null> {
  return replaceJournal(updaterRootPath(options.rootPath), options.allowedInstallRoots, (journal) => {
    if (journal.updateState !== 'awaiting-health' || journal.targetVersion !== currentVersion) return null;
    journal.updateState = 'committed';
    journal.rollbackState = 'not-required';
    journal.healthConfirmedAt = new Date().toISOString();
    delete journal.intentionalExitAt;
    delete journal.lastError;
    return journal;
  });
}

export async function recordStartupHealthFailure(
  currentVersion: string,
  error: unknown,
  options: ReadJournalOptions = {},
): Promise<UpdateTransactionJournal | null> {
  return replaceJournal(updaterRootPath(options.rootPath), options.allowedInstallRoots, (journal) => {
    if (journal.updateState !== 'awaiting-health' || journal.targetVersion !== currentVersion) return null;
    journal.lastError = redactUpdateError(error);
    return journal;
  });
}

export function recordIntentionalExitSync(
  currentVersion: string,
  options: ReadJournalOptions = {},
): void {
  const journal = readUpdateJournalSync(options);
  if (!journal || journal.updateState !== 'awaiting-health' || journal.targetVersion !== currentVersion) return;
  journal.intentionalExitAt = new Date().toISOString();
  journal.updatedAt = journal.intentionalExitAt;
  writeUpdateJournalSync(journal, options);
}

export async function launchUpdateWatchdog(
  journal: UpdateTransactionJournal,
  parentProcessId = process.pid,
): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Transactional updater watchdog requires Windows.');
  if (await sha256File(journal.watchdogPath) !== journal.watchdogSha256) {
    throw new Error('Updater watchdog checksum mismatch.');
  }
  if (!Number.isSafeInteger(parentProcessId) || parentProcessId < 0) {
    throw new Error('Updater watchdog parent process identifier is invalid.');
  }

  const rootPath = dirname(dirname(journal.watchdogPath));
  const watchdogPathLiteral = quotePowerShellLiteral(journal.watchdogPath);
  const transactionPathLiteral = quotePowerShellLiteral(updateJournalPath(rootPath));
  const launcherLogPath = join(rootPath, 'watchdog-launcher.log');
  const mutexScope = 'Local\\SubutaiUpdaterWatchdog';
  const mutexNameLiteral = quotePowerShellLiteral(`${mutexScope}-${journal.transactionId}`);
  const singleInstanceCommand = String.raw`
$createdNew = $false
$mutex = $null
try {
  Write-Output ('launcher-started ' + [DateTime]::UtcNow.ToString('o'))
  $mutex = [System.Threading.Mutex]::new($true, ${mutexNameLiteral}, [ref]$createdNew)
  if (-not $createdNew) { Write-Output 'launcher-duplicate'; exit 0 }
  & ${watchdogPathLiteral} -TransactionPath ${transactionPathLiteral} -ParentProcessId ${parentProcessId}
  exit $LASTEXITCODE
} catch {
  Write-Error ($_ | Out-String)
  exit 2
} finally {
  if ($null -ne $mutex) {
    if ($createdNew) { try { $mutex.ReleaseMutex() } catch {} }
    $mutex.Dispose()
  }
}
`;
  const encodedCommand = Buffer.from(singleInstanceCommand, 'utf16le').toString('base64');
  appendFileSync(
    launcherLogPath,
    `${new Date().toISOString()} launcher-requested transaction=${journal.transactionId}\n`,
    'utf8',
  );

  const launcherLogFile = openSync(launcherLogPath, 'a');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodedCommand,
      ], {
        windowsHide: true,
        detached: true,
        stdio: ['ignore', launcherLogFile, launcherLogFile],
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  } catch (error) {
    try {
      appendFileSync(
        launcherLogPath,
        `${new Date().toISOString()} launcher-spawn-failed ${redactUpdateError(error)}\n`,
        'utf8',
      );
    } catch {
      // Preserve the original spawn error.
    }
    throw error;
  } finally {
    closeSync(launcherLogFile);
  }
}

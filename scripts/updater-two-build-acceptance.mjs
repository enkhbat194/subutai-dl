import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('Subutai local two-build updater acceptance is Windows-only; skipped on this platform.');
  process.exit(0);
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watchdogSource = join(repositoryRoot, 'apps', 'desktop', 'resources', 'updater', 'update-watchdog.ps1');
const registrationSource = join(repositoryRoot, 'apps', 'desktop', 'resources', 'native-messaging', 'register-native-host.ps1');
const HOST_NAME = 'com.subutai.download_manager';

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    windowsHide: true,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      const exitCode = code ?? -1;
      const allowed = options.allowedExitCodes ?? [0];
      if (!allowed.includes(exitCode)) {
        reject(new Error(`${command} exited ${exitCode}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      resolvePromise({ exitCode, stdout, stderr });
    });
  });
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rm(`${path}.bak`, { force: true });
  try { await rename(path, `${path}.bak`); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rename(temporary, path);
}

async function buildFixtureExecutables(workspace) {
  const sourceDirectory = join(workspace, 'fixture-source');
  const outputDirectory = join(workspace, 'fixture-builds');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });

  const oldSource = join(sourceDirectory, 'fixture-old-installer.rs');
  const newSource = join(sourceDirectory, 'fixture-new-app.rs');
  const oldInstaller = join(outputDirectory, 'Subutai-Fixture-Setup-1.0.0.exe');
  const newApplication = join(outputDirectory, 'Subutai-Fixture-App-1.1.0.exe');

  await writeFile(oldSource, String.raw`use std::{env, fs, path::PathBuf};

fn main() {
    let install_root = PathBuf::from(env::var("SUBUTAI_FIXTURE_INSTALL_ROOT").expect("fixture install root"));
    let registration_source = PathBuf::from(env::var("SUBUTAI_FIXTURE_REGISTER_SCRIPT").expect("fixture registration source"));
    let resources = install_root.join("resources").join("native-messaging");
    fs::create_dir_all(&resources).expect("create fixture resources");
    let current = env::current_exe().expect("current fixture executable");
    let installed = install_root.join("Subutai Download Manager.exe");
    if current != installed {
        fs::copy(&current, &installed).expect("restore previous fixture executable");
    }
    fs::copy(registration_source, resources.join("register-native-host.ps1"))
        .expect("restore fixture browser registration script");
    fs::write(install_root.join("installed-version.txt"), b"1.0.0")
        .expect("write previous fixture version");
}
`);
  await writeFile(newSource, String.raw`use std::{env, fs, path::PathBuf, process};

fn main() {
    let install_root = PathBuf::from(env::var("SUBUTAI_FIXTURE_INSTALL_ROOT").expect("fixture install root"));
    fs::create_dir_all(&install_root).expect("create fixture install root");
    fs::write(install_root.join("installed-version.txt"), b"1.1.0")
        .expect("write target fixture version");
    if env::var("SUBUTAI_FIXTURE_FAIL_STARTUP").ok().as_deref() == Some("1") {
        process::exit(70);
    }
    fs::write(install_root.join("startup-health-confirmed.txt"), b"healthy")
        .expect("write fixture health evidence");
}
`);

  await run('rustc', [oldSource, '--edition=2021', '-C', 'opt-level=1', '-C', 'metadata=subutai-fixture-v1', '-o', oldInstaller]);
  await run('rustc', [newSource, '--edition=2021', '-C', 'opt-level=1', '-C', 'metadata=subutai-fixture-v2', '-o', newApplication]);
  assert.notEqual(await sha256File(oldInstaller), await sha256File(newApplication));
  return { oldInstaller, newApplication };
}

async function createTransactionFixture(base, name, builds, deadlineOffsetMs) {
  const fixture = join(base, name);
  const localAppData = join(fixture, 'LocalAppData');
  const updaterRoot = join(localAppData, 'Subutai', 'Updater');
  const installDirectory = join(localAppData, 'Programs', 'Subutai Download Manager');
  const installedExecutablePath = join(installDirectory, 'Subutai Download Manager.exe');
  const transactionId = randomUUID();
  const previousInstallerPath = join(updaterRoot, 'packages', '1.0.0', 'Subutai-Setup-1.0.0-rollback.exe');
  const targetInstallerPath = join(updaterRoot, 'staged', transactionId, 'target-installer.exe');
  const watchdogPath = join(updaterRoot, 'watchdog', 'update-watchdog.ps1');
  const transactionPath = join(updaterRoot, 'update-transaction.json');
  const userDataDirectory = join(localAppData, 'Subutai Download Manager', 'data');

  for (const path of [previousInstallerPath, targetInstallerPath, watchdogPath, installedExecutablePath]) {
    await mkdir(dirname(path), { recursive: true });
  }
  await mkdir(userDataDirectory, { recursive: true });
  await copyFile(builds.oldInstaller, previousInstallerPath);
  await copyFile(builds.newApplication, targetInstallerPath);
  await copyFile(builds.newApplication, installedExecutablePath);
  await copyFile(watchdogSource, watchdogPath);

  const preservedFiles = new Map([
    [join(userDataDirectory, 'settings.json'), '{"trayEnabled":true}'],
    [join(userDataDirectory, 'subutai.db'), 'sqlite-user-database-fixture'],
    [join(userDataDirectory, 'queued-job.subutai.part'), 'partial-download-fixture'],
    [join(userDataDirectory, 'queued-job.subutai.journal'), 'durable-job-journal-fixture'],
  ]);
  for (const [path, content] of preservedFiles) await writeFile(path, content);

  const now = Date.now();
  const journal = {
    schemaVersion: 1,
    transactionId,
    currentVersion: '1.0.0',
    targetVersion: '1.1.0',
    previousWorkingVersion: '1.0.0',
    updateState: 'awaiting-health',
    rollbackState: 'ready',
    createdAt: new Date(now - 5_000).toISOString(),
    updatedAt: new Date(now - 1_000).toISOString(),
    previousInstallerPath,
    previousInstallerSha256: await sha256File(previousInstallerPath),
    targetInstallerPath,
    targetInstallerSha256: await sha256File(targetInstallerPath),
    watchdogPath,
    watchdogSha256: await sha256File(watchdogPath),
    installedExecutablePath,
    startupAttemptCount: 1,
    maxStartupAttempts: 3,
    rollbackAttemptCount: 0,
    healthDeadline: new Date(now + deadlineOffsetMs).toISOString(),
  };
  await atomicJson(transactionPath, journal);

  const environment = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    ProgramFiles: join(fixture, 'ProgramFiles'),
    'ProgramFiles(x86)': join(fixture, 'ProgramFilesX86'),
    SUBUTAI_FIXTURE_INSTALL_ROOT: installDirectory,
    SUBUTAI_FIXTURE_REGISTER_SCRIPT: registrationSource,
  };
  return {
    fixture,
    localAppData,
    updaterRoot,
    installDirectory,
    installedExecutablePath,
    transactionPath,
    watchdogPath,
    preservedFiles,
    environment,
  };
}

async function runProductionWatchdog(fixture) {
  await run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fixture.watchdogPath,
    '-TransactionPath', fixture.transactionPath,
    '-ParentProcessId', '0',
    '-PollMilliseconds', '100',
  ], { env: fixture.environment });

  const deadline = Date.now() + 15_000;
  let lastMissingJournalError = null;
  while (Date.now() < deadline) {
    try {
      const journal = JSON.parse(await readFile(fixture.transactionPath, 'utf8'));
      if (['committed', 'rolled-back', 'failed-safe'].includes(journal.updateState)) return;
      lastMissingJournalError = null;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      // The watchdog atomically replaces the journal, so its destination can be
      // briefly absent between the old-file removal and final rename on Windows.
      lastMissingJournalError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(
    `Script-owned watchdog worker did not reach a terminal transaction state within 15 seconds.${
      lastMissingJournalError ? ` Last journal read failed: ${lastMissingJournalError.message}` : ''
    }`,
  );
}

async function writeRegistryHelpers(workspace) {
  const snapshotScript = join(workspace, 'snapshot-native-host-registry.ps1');
  const restoreScript = join(workspace, 'restore-native-host-registry.ps1');
  await writeFile(snapshotScript, String.raw`param([Parameter(Mandatory = $true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$hostName = '${HOST_NAME}'
$keys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
)
$result = @($keys | ForEach-Object {
  if (Test-Path -LiteralPath $_) {
    [pscustomobject]@{ key = $_; exists = $true; value = [string](Get-Item -LiteralPath $_).GetValue('') }
  } else {
    [pscustomobject]@{ key = $_; exists = $false; value = '' }
  }
})
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
`);
  await writeFile(restoreScript, String.raw`param([Parameter(Mandatory = $true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
$entries = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
foreach ($entry in $entries) {
  $providerPath = [string]$entry.key
  if ($providerPath -notmatch '^HKCU:\\') { throw "Unexpected registry path in snapshot: $providerPath" }
  $subKey = $providerPath -replace '^HKCU:\\', ''
  try {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($subKey, $false)
  } catch [System.ArgumentException] {
    # The key was already absent.
  }
  if ([bool]$entry.exists) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subKey)
    if ($null -eq $key) { throw "Failed to recreate registry key: $providerPath" }
    try {
      $key.SetValue('', [string]$entry.value, [Microsoft.Win32.RegistryValueKind]::String)
    } finally {
      $key.Dispose()
    }
  }
}
`);
  return { snapshotScript, restoreScript };
}

async function assertPreserved(files) {
  for (const [path, expected] of files) assert.equal(await readFile(path, 'utf8'), expected);
}

const workspace = await mkdtemp(join(tmpdir(), 'subutai-updater-two-build-'));
let registrySnapshot = '';
let registryHelpers = null;
try {
  const builds = await buildFixtureExecutables(workspace);

  const healthy = await createTransactionFixture(workspace, 'healthy-two-build', builds, 15_000);
  const healthyWatchdog = runProductionWatchdog(healthy);
  const healthyApp = await run(healthy.installedExecutablePath, [], {
    env: { ...healthy.environment, SUBUTAI_FIXTURE_FAIL_STARTUP: '0' },
  });
  assert.equal(healthyApp.exitCode, 0);
  assert.equal(await readFile(join(healthy.installDirectory, 'startup-health-confirmed.txt'), 'utf8'), 'healthy');
  const healthyJournal = JSON.parse(await readFile(healthy.transactionPath, 'utf8'));
  healthyJournal.updateState = 'committed';
  healthyJournal.rollbackState = 'not-required';
  healthyJournal.healthConfirmedAt = new Date().toISOString();
  await atomicJson(healthy.transactionPath, healthyJournal);
  await healthyWatchdog;
  assert.equal(await readFile(join(healthy.installDirectory, 'installed-version.txt'), 'utf8'), '1.1.0');
  await assertPreserved(healthy.preservedFiles);
  console.log('Local two-build healthy update acceptance passed.');

  registryHelpers = await writeRegistryHelpers(workspace);
  registrySnapshot = join(workspace, 'native-host-registry-before.json');
  await run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', registryHelpers.snapshotScript,
    '-OutputPath', registrySnapshot,
  ]);

  const failed = await createTransactionFixture(workspace, 'failed-two-build', builds, -1_000);
  const failedApp = await run(failed.installedExecutablePath, [], {
    env: { ...failed.environment, SUBUTAI_FIXTURE_FAIL_STARTUP: '1' },
    allowedExitCodes: [70],
  });
  assert.equal(failedApp.exitCode, 70);
  await runProductionWatchdog(failed);

  const rolledBack = JSON.parse(await readFile(failed.transactionPath, 'utf8'));
  assert.equal(rolledBack.updateState, 'rolled-back');
  assert.equal(rolledBack.rollbackState, 'succeeded');
  assert.equal(rolledBack.rollbackAttemptCount, 1);
  assert.equal(await readFile(join(failed.installDirectory, 'installed-version.txt'), 'utf8'), '1.0.0');
  assert.equal(await sha256File(failed.installedExecutablePath), await sha256File(builds.oldInstaller));
  await assertPreserved(failed.preservedFiles);

  const chromiumManifest = JSON.parse(await readFile(
    join(failed.localAppData, 'Subutai Download Manager', 'NativeMessaging', `${HOST_NAME}.chromium.json`),
    'utf8',
  ));
  const firefoxManifest = JSON.parse(await readFile(
    join(failed.localAppData, 'Subutai Download Manager', 'NativeMessaging', `${HOST_NAME}.firefox.json`),
    'utf8',
  ));
  assert.equal(resolve(chromiumManifest.path), resolve(failed.installedExecutablePath));
  assert.equal(resolve(firefoxManifest.path), resolve(failed.installedExecutablePath));
  console.log('Local two-build failed-startup rollback, browser bridge and user-data preservation acceptance passed.');
} finally {
  try {
    if (registrySnapshot && registryHelpers && await exists(registrySnapshot)) {
      await run('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', registryHelpers.restoreScript,
        '-InputPath', registrySnapshot,
      ]);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

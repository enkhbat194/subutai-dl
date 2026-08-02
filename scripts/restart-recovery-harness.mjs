import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32') {
  throw new Error('Subutai restart recovery harness requires Windows.');
}

const command = process.argv[2] || 'status';
const requireBootChange = process.argv.includes('--require-boot-change')
  || /^true$/iu.test(process.env.SUBUTAI_RESTART_REQUIRE_BOOT_CHANGE || '');
const fileMiB = integerEnv('SUBUTAI_RESTART_FILE_MIB', 64, 16, 4096);
const fileSize = fileMiB * 1024 * 1024;
const minimumProgressBytes = integerEnv(
  'SUBUTAI_RESTART_MINIMUM_PROGRESS_MIB',
  4,
  1,
  Math.max(1, fileMiB - 1),
) * 1024 * 1024;
const port = integerEnv('SUBUTAI_RESTART_PORT', 38473, 1024, 65535);
const segments = integerEnv('SUBUTAI_RESTART_SEGMENTS', 8, 1, 32);
const chunkDelayMs = integerEnv('SUBUTAI_RESTART_CHUNK_DELAY_MS', 10, 1, 1000);
const workspace = resolve(
  process.env.SUBUTAI_RESTART_WORKSPACE
    || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Subutai', 'N5RestartRecovery'),
);
const contractPath = join(workspace, 'restart-recovery-contract.json');
const reportPath = join(workspace, 'restart-recovery-report.json');
const sourcePath = join(workspace, 'source.bin');
const destinationPath = join(workspace, 'restart-recovery.bin');
const nativeEngine = resolve(
  process.env.SUBUTAI_NATIVE_ENGINE_PATH
    || join('engines', 'native', 'target', 'release', 'subutai-engine.exe'),
);
const remote = {
  path: '/restart-source.bin',
  etag: '"subutai-n5-restart-recovery-v1"',
  lastModified: 'Sun, 02 Aug 2026 18:00:00 GMT',
};

const execution = (async () => {
  switch (command) {
    case 'prepare':
      await prepare();
      break;
    case 'verify':
      await verify();
      break;
    case 'status':
      await status();
      break;
    case 'cleanup':
      await cleanup();
      break;
    case 'self-test':
      await selfTest();
      break;
    default:
      throw new Error('usage: restart-recovery-harness.mjs <prepare|verify|status|cleanup|self-test> [--require-boot-change]');
  }
})();

async function prepare() {
  requireNativeEngine();
  if (existsSync(contractPath)) {
    const existing = await readContract();
    throw new Error(
      `Restart recovery state already exists with status ${existing.status}. Run status or cleanup before prepare.`,
    );
  }
  await mkdir(workspace, { recursive: true });
  await createDeterministicFile(sourcePath, fileSize);
  const expectedSha256 = await sha256(sourcePath);
  const preparedBootTime = await windowsBootTime();
  const engineVersion = await nativeVersion();
  const server = new RangeServer(sourcePath, fileSize);
  await server.start(port);
  const url = `http://127.0.0.1:${port}${remote.path}`;
  let run;
  let persistedBytes = 0;
  try {
    run = runNative(url, destinationPath);
    persistedBytes = await waitForProgress(run, minimumProgressBytes);
    await terminateProcessTree(run.child.pid);
    await run.completion.catch(() => undefined);
  } finally {
    await server.stop();
  }

  if (existsSync(destinationPath)) {
    throw new Error('Restart prepare unexpectedly completed the final destination.');
  }
  const state = await inspectRecoveryState(destinationPath);
  if (!state.partialExists || state.journalSlots.length === 0) {
    throw new Error('Restart prepare did not preserve both partial data and a durable journal slot.');
  }

  const contract = {
    schemaVersion: 1,
    product: 'Subutai',
    status: 'prepared',
    phaseToken: randomBytes(16).toString('hex'),
    preparedAt: new Date().toISOString(),
    preparedBootTime,
    engineVersion,
    workspace,
    sourcePath,
    destinationPath,
    url,
    port,
    fileSize,
    expectedSha256,
    persistedBytes,
    segments,
    minimumSegmentBytes: 1024 * 1024,
    remote,
    recoveryState: state,
  };
  await writeJson(contractPath, contract);
  await publishSummary('prepared', contract);
  console.log(
    `Subutai restart recovery prepare passed: ${formatBytes(persistedBytes)} persisted, `
      + `${state.journalSlots.length} journal slot(s), boot=${preparedBootTime}.`,
  );
  console.log(`contract=${contractPath}`);
}

async function verify() {
  requireNativeEngine();
  const contract = await readContract();
  if (contract.status !== 'prepared') {
    throw new Error(`Restart recovery verify requires prepared state, received ${contract.status}.`);
  }
  verifyContractPaths(contract);
  const currentBootTime = await windowsBootTime();
  const bootChanged = currentBootTime !== contract.preparedBootTime;
  if (requireBootChange && !bootChanged) {
    throw new Error(
      `Windows boot time did not change: ${currentBootTime}. Restart Windows before verify or omit --require-boot-change for CI self-test.`,
    );
  }
  if (!existsSync(contract.sourcePath)) throw new Error(`Restart source file is missing: ${contract.sourcePath}`);
  const sourceInfo = await stat(contract.sourcePath);
  if (sourceInfo.size !== contract.fileSize) throw new Error('Restart source size changed after prepare.');
  const sourceSha256 = await sha256(contract.sourcePath);
  if (sourceSha256 !== contract.expectedSha256) throw new Error('Restart source SHA-256 changed after prepare.');
  const before = await inspectRecoveryState(contract.destinationPath);
  if (!before.partialExists || before.journalSlots.length === 0) {
    throw new Error('Prepared restart recovery state is incomplete before verify.');
  }

  const server = new RangeServer(contract.sourcePath, contract.fileSize);
  await server.start(contract.port);
  let result;
  const startedAt = performance.now();
  try {
    const run = runNative(contract.url, contract.destinationPath, contract.segments);
    result = await run.completion;
  } finally {
    await server.stop();
  }
  const elapsedMilliseconds = Math.max(1, Math.round(performance.now() - startedAt));
  const destinationInfo = await stat(contract.destinationPath);
  if (destinationInfo.size !== contract.fileSize) {
    throw new Error(`Restart recovery destination size mismatch: ${destinationInfo.size} != ${contract.fileSize}`);
  }
  const finalSha256 = await sha256(contract.destinationPath);
  if (finalSha256 !== contract.expectedSha256) throw new Error('Restart recovery final SHA-256 mismatch.');
  const nativeOutput = parseKeyValueOutput(result.stdout);
  if (nativeOutput.sha256 !== contract.expectedSha256) {
    throw new Error('Restart recovery native result SHA-256 mismatch.');
  }
  const after = await inspectRecoveryState(contract.destinationPath);
  if (after.partialExists || after.journalSlots.length > 0 || after.legacyJournalExists) {
    throw new Error('Restart recovery state remained after successful completion.');
  }

  const completed = {
    ...contract,
    status: 'completed',
    verifiedAt: new Date().toISOString(),
    verifiedBootTime: currentBootTime,
    bootChanged,
    requireBootChange,
    elapsedMilliseconds,
    finalSha256,
    recoveryStateBeforeVerify: before,
    recoveryStateAfterVerify: after,
  };
  await writeJson(contractPath, completed);
  await writeJson(reportPath, completed);
  await publishSummary('completed', completed);
  console.log(
    `Subutai restart recovery verify passed: bootChanged=${bootChanged}, `
      + `${formatBytes(contract.fileSize)} verified in ${elapsedMilliseconds} ms.`,
  );
  console.log(`report=${reportPath}`);
}

async function status() {
  if (!existsSync(contractPath)) {
    console.log(`Subutai restart recovery state is empty: ${workspace}`);
    return;
  }
  const contract = await readContract();
  console.log(JSON.stringify(contract, null, 2));
  await publishSummary('status', contract);
}

async function cleanup() {
  await rm(workspace, { recursive: true, force: true });
  console.log(`Subutai restart recovery workspace removed: ${workspace}`);
}

async function selfTest() {
  if (existsSync(contractPath)) {
    throw new Error('Self-test refuses to overwrite existing restart recovery state. Use a dedicated SUBUTAI_RESTART_WORKSPACE.');
  }
  try {
    await prepare();
    await verify();
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    if (report.status !== 'completed' || report.bootChanged) {
      throw new Error('Same-boot restart harness self-test report is invalid.');
    }
    console.log('Subutai two-phase restart recovery harness self-test passed.');
  } finally {
    await cleanup();
  }
}

class RangeServer {
  constructor(path, length) {
    this.path = path;
    this.length = length;
    this.server = null;
    this.sockets = new Set();
  }

  async start(bindPort) {
    this.server = createServer((request, response) => void this.handle(request, response));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    await new Promise((resolvePromise, reject) => {
      this.server.once('error', reject);
      this.server.listen(bindPort, '127.0.0.1', resolvePromise);
    });
  }

  async stop() {
    if (!this.server) return;
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }

  async handle(request, response) {
    if (request.url !== remote.path) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('accept-ranges', 'bytes');
    response.setHeader('etag', remote.etag);
    response.setHeader('last-modified', remote.lastModified);
    response.setHeader('content-type', 'application/octet-stream');
    if (request.method === 'HEAD') {
      response.statusCode = 200;
      response.setHeader('content-length', String(this.length));
      response.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/u.exec(String(request.headers.range || ''));
    if (request.method !== 'GET' || !match) {
      response.statusCode = 416;
      response.end();
      return;
    }
    const start = Number(match[1]);
    const end = match[2] ? Math.min(this.length - 1, Number(match[2])) : this.length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= this.length) {
      response.statusCode = 416;
      response.end();
      return;
    }
    response.statusCode = 206;
    response.setHeader('content-range', `bytes ${start}-${end}/${this.length}`);
    response.setHeader('content-length', String(end - start + 1));
    const file = await open(this.path, 'r');
    try {
      let position = start;
      while (position <= end && !response.destroyed) {
        const size = Math.min(64 * 1024, end - position + 1);
        const buffer = Buffer.allocUnsafe(size);
        const { bytesRead } = await file.read(buffer, 0, size, position);
        if (bytesRead <= 0) break;
        if (!response.write(buffer.subarray(0, bytesRead))) {
          await new Promise((resolvePromise) => response.once('drain', resolvePromise));
        }
        position += bytesRead;
        await delay(chunkDelayMs);
      }
      if (!response.destroyed) response.end();
    } catch (error) {
      if (!response.destroyed) response.destroy(error);
    } finally {
      await file.close();
    }
  }
}

function runNative(url, destination, requestedSegments = segments) {
  const child = spawn(
    nativeEngine,
    ['download-segmented', url, destination, String(requestedSegments), String(1024 * 1024)],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let stdout = '';
  let stderr = '';
  let downloadedBytes = 0;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
    for (const match of chunk.matchAll(/downloaded=(\d+)/gu)) {
      downloadedBytes = Math.max(downloadedBytes, Number(match[1]));
    }
  });
  const completion = new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0 && stdout.includes('result=PASS')) resolvePromise({ stdout, stderr });
      else reject(new Error(`Subutai native engine exited with ${String(code)}\n${stderr}\n${stdout}`));
    });
  });
  return { child, completion, downloadedBytes: () => downloadedBytes };
}

async function waitForProgress(run, minimumBytes) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (run.downloadedBytes() >= minimumBytes) return run.downloadedBytes();
    if (run.child.exitCode !== null) throw new Error('Native engine exited before restart prepare reached required progress.');
    await delay(50);
  }
  throw new Error(`Restart prepare did not reach ${formatBytes(minimumBytes)} within 60 seconds.`);
}

async function terminateProcessTree(pid) {
  const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const chunks = [];
  child.stderr?.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', resolvePromise);
  });
  if (exitCode !== 0) {
    throw new Error(`Failed to terminate native process tree ${pid}: ${Buffer.concat(chunks).toString('utf8')}`);
  }
}

async function inspectRecoveryState(destination) {
  const partial = `${destination}.subutai.part`;
  const legacyJournal = `${destination}.subutai.job`;
  const slots = [`${legacyJournal}.a`, `${legacyJournal}.b`].filter((path) => existsSync(path));
  return {
    partialPath: partial,
    partialExists: existsSync(partial),
    journalSlots: slots,
    legacyJournalPath: legacyJournal,
    legacyJournalExists: existsSync(legacyJournal),
  };
}

async function createDeterministicFile(path, length) {
  await mkdir(dirname(path), { recursive: true });
  const stream = createWriteStream(path);
  let offset = 0;
  while (offset < length) {
    const size = Math.min(1024 * 1024, length - offset);
    const buffer = Buffer.allocUnsafe(size);
    for (let index = 0; index < size; index += 1) {
      buffer[index] = (offset + index * 47 + 23) & 0xff;
    }
    if (!stream.write(buffer)) await new Promise((resolvePromise) => stream.once('drain', resolvePromise));
    offset += size;
  }
  await new Promise((resolvePromise, reject) => {
    stream.once('error', reject);
    stream.end(resolvePromise);
  });
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function windowsBootTime() {
  const script = "[Console]::Out.Write((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'))";
  const output = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const value = output.trim();
  if (!value) throw new Error('Windows boot time query returned no value.');
  return value;
}

async function nativeVersion() {
  return (await runCommand(nativeEngine, ['--version'])).trim();
}

async function runCommand(file, args) {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const stdout = [];
  const stderr = [];
  child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', resolvePromise);
  });
  if (exitCode !== 0) {
    throw new Error(`${file} exited with ${String(exitCode)}: ${Buffer.concat(stderr).toString('utf8')}`);
  }
  return Buffer.concat(stdout).toString('utf8');
}

async function readContract() {
  return JSON.parse(await readFile(contractPath, 'utf8'));
}

function verifyContractPaths(contract) {
  if (resolve(contract.workspace) !== workspace
      || resolve(contract.sourcePath) !== sourcePath
      || resolve(contract.destinationPath) !== destinationPath
      || contract.port !== port
      || contract.url !== `http://127.0.0.1:${port}${remote.path}`) {
    throw new Error('Restart recovery environment no longer matches the prepared contract.');
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function publishSummary(phase, value) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [
    '## Subutai Windows restart recovery',
    '',
    `- Phase: **${phase}**`,
    `- Workspace: \`${workspace}\``,
    `- Status: **${value.status || phase}**`,
    `- Prepared boot time: \`${value.preparedBootTime || 'not prepared'}\``,
    `- Current/verified boot time: \`${value.verifiedBootTime || await windowsBootTime()}\``,
    `- Boot changed: **${String(value.bootChanged ?? false)}**`,
    `- Payload: **${formatBytes(value.fileSize || fileSize)}**`,
    `- Persisted before interruption: **${formatBytes(value.persistedBytes || 0)}**`,
    '',
  ];
  if (phase === 'prepared') {
    lines.push(
      '> Restart Windows manually. The workflow never invokes a restart command.',
      '> After boot, relaunch the self-hosted runner if it is not installed as a Windows service, then dispatch the verify phase.',
      '',
    );
  }
  await writeFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, { flag: 'a' });
}

function parseKeyValueOutput(value) {
  const output = {};
  for (const line of value.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    output[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return output;
}

function requireNativeEngine() {
  if (!existsSync(nativeEngine)) throw new Error(`Subutai release native engine was not found: ${nativeEngine}`);
}

function integerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function formatBytes(value) {
  return `${(Number(value) / (1024 * 1024)).toFixed(1)} MiB`;
}

await execution;

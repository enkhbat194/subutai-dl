import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32') {
  throw new Error('Subutai native soak benchmark currently requires Windows process telemetry.');
}

const iterations = integerEnv('SUBUTAI_SOAK_ITERATIONS', 8, 1, 500);
const payloadMiB = integerEnv('SUBUTAI_SOAK_MIB', 8, 1, 4096);
const segments = integerEnv('SUBUTAI_SOAK_SEGMENTS', 8, 1, 32);
const minimumSegmentBytes = integerEnv('SUBUTAI_SOAK_MINIMUM_SEGMENT_BYTES', 1024 * 1024, 64 * 1024, 1024 * 1024 * 1024);
const sampleIntervalMs = integerEnv('SUBUTAI_SOAK_SAMPLE_MS', 250, 100, 5000);
const maximumWorkingSetBytes = integerEnv('SUBUTAI_SOAK_MAX_WORKING_SET_MIB', 512, 32, 8192) * 1024 * 1024;
const maximumPrivateBytes = integerEnv('SUBUTAI_SOAK_MAX_PRIVATE_MIB', 512, 32, 8192) * 1024 * 1024;
const maximumHandles = integerEnv('SUBUTAI_SOAK_MAX_HANDLES', 512, 32, 10000);
const maximumPeakHandleSpread = integerEnv('SUBUTAI_SOAK_MAX_HANDLE_SPREAD', 64, 0, 10000);
const reportPath = resolve(process.env.SUBUTAI_SOAK_REPORT || join('artifacts', 'n5', 'native-soak-report.json'));
const nativeEngine = resolve(
  process.env.SUBUTAI_NATIVE_ENGINE_PATH
    || join('engines', 'native', 'target', 'release', 'subutai-engine.exe'),
);

if (!existsSync(nativeEngine)) {
  throw new Error(`Subutai release CLI was not found: ${nativeEngine}`);
}

const root = await mkdtemp(join(tmpdir(), 'subutai-native-soak-'));
const sourcePath = join(root, 'source.bin');
const outputDirectory = join(root, 'downloads');
await mkdir(outputDirectory, { recursive: true });
const payloadBytes = payloadMiB * 1024 * 1024;
await createDeterministicFile(sourcePath, payloadBytes);
const expectedSha256 = await sha256(sourcePath);
const server = await startRangeServer(sourcePath, payloadBytes);

const startedAt = new Date();
const reports = [];
try {
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const destination = join(outputDirectory, `iteration-${String(iteration).padStart(4, '0')}.bin`);
    const report = await runIteration({
      iteration,
      url: server.url,
      destination,
      expectedSha256,
    });
    reports.push(report);
    await assertNoRecoveryFiles(destination);
    await rm(destination, { force: true });
    console.log(
      `Soak iteration ${iteration}/${iterations} passed: ${formatRate(report.throughputBytesPerSecond)}, `
      + `workingSet=${formatBytes(report.peakWorkingSetBytes)}, handles=${report.peakHandleCount}.`,
    );
  }

  const peakHandles = reports.map((report) => report.peakHandleCount);
  const aggregate = {
    schemaVersion: 1,
    product: 'Subutai',
    enginePath: nativeEngine,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    configuration: {
      iterations,
      payloadBytes,
      segments,
      minimumSegmentBytes,
      sampleIntervalMs,
      thresholds: {
        maximumWorkingSetBytes,
        maximumPrivateBytes,
        maximumHandles,
        maximumPeakHandleSpread,
      },
    },
    expectedSha256,
    summary: {
      totalBytes: reports.reduce((sum, report) => sum + report.downloadedBytes, 0),
      totalElapsedMilliseconds: reports.reduce((sum, report) => sum + report.elapsedMilliseconds, 0),
      averageThroughputBytesPerSecond: average(reports.map((report) => report.throughputBytesPerSecond)),
      minimumThroughputBytesPerSecond: Math.min(...reports.map((report) => report.throughputBytesPerSecond)),
      maximumThroughputBytesPerSecond: Math.max(...reports.map((report) => report.throughputBytesPerSecond)),
      peakWorkingSetBytes: Math.max(...reports.map((report) => report.peakWorkingSetBytes)),
      peakPrivateBytes: Math.max(...reports.map((report) => report.peakPrivateBytes)),
      peakHandleCount: Math.max(...peakHandles),
      peakHandleSpread: Math.max(...peakHandles) - Math.min(...peakHandles),
      maximumNativeReportedSpeedBytesPerSecond: Math.max(...reports.map((report) => report.maximumNativeReportedSpeedBytesPerSecond)),
    },
    iterations: reports,
  };

  assertThreshold(
    aggregate.summary.peakWorkingSetBytes <= maximumWorkingSetBytes,
    `peak working set ${formatBytes(aggregate.summary.peakWorkingSetBytes)} exceeded ${formatBytes(maximumWorkingSetBytes)}`,
  );
  assertThreshold(
    aggregate.summary.peakPrivateBytes <= maximumPrivateBytes,
    `peak private memory ${formatBytes(aggregate.summary.peakPrivateBytes)} exceeded ${formatBytes(maximumPrivateBytes)}`,
  );
  assertThreshold(
    aggregate.summary.peakHandleCount <= maximumHandles,
    `peak handle count ${aggregate.summary.peakHandleCount} exceeded ${maximumHandles}`,
  );
  assertThreshold(
    aggregate.summary.peakHandleSpread <= maximumPeakHandleSpread,
    `peak handle spread ${aggregate.summary.peakHandleSpread} exceeded ${maximumPeakHandleSpread}`,
  );

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
  console.log(
    `Subutai native soak passed: ${iterations} iterations, ${formatBytes(aggregate.summary.totalBytes)}, `
    + `average ${formatRate(aggregate.summary.averageThroughputBytesPerSecond)}, `
    + `peak working set ${formatBytes(aggregate.summary.peakWorkingSetBytes)}, `
    + `peak handles ${aggregate.summary.peakHandleCount}.`,
  );
  console.log(`report=${reportPath}`);
} finally {
  await server.stop();
  await rm(root, { recursive: true, force: true });
}

async function runIteration({ iteration, url, destination, expectedSha256 }) {
  const child = spawn(
    nativeEngine,
    ['download-segmented', url, destination, String(segments), String(minimumSegmentBytes)],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const stdoutChunks = [];
  const stderrChunks = [];
  let maximumNativeReportedSpeedBytesPerSecond = 0;
  child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrChunks.push(Buffer.from(chunk));
    for (const match of text.matchAll(/speed_bytes_per_second=(\d+)/gu)) {
      maximumNativeReportedSpeedBytesPerSecond = Math.max(
        maximumNativeReportedSpeedBytesPerSecond,
        Number(match[1]),
      );
    }
  });

  const samples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling && child.exitCode === null) {
      const sample = await sampleWindowsProcess(child.pid).catch(() => null);
      if (sample) samples.push(sample);
      await delay(sampleIntervalMs);
    }
  })();

  const started = performance.now();
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', resolvePromise);
  });
  const elapsedMilliseconds = Math.max(1, performance.now() - started);
  sampling = false;
  await sampler;

  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (exitCode !== 0 || !stdout.includes('result=PASS')) {
    throw new Error(`Soak iteration ${iteration} failed with exit ${String(exitCode)}.\n${stderr}\n${stdout}`);
  }

  const info = await stat(destination);
  if (info.size !== payloadBytes) {
    throw new Error(`Soak iteration ${iteration} size mismatch: ${info.size} != ${payloadBytes}`);
  }
  const actualSha256 = await sha256(destination);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Soak iteration ${iteration} SHA-256 mismatch.`);
  }

  const finalResult = parseKeyValueOutput(stdout);
  if (finalResult.sha256 !== expectedSha256) {
    throw new Error(`Soak iteration ${iteration} native SHA-256 output mismatch.`);
  }

  return {
    iteration,
    downloadedBytes: info.size,
    elapsedMilliseconds: Math.round(elapsedMilliseconds),
    throughputBytesPerSecond: Math.round((info.size * 1000) / elapsedMilliseconds),
    maximumNativeReportedSpeedBytesPerSecond,
    peakWorkingSetBytes: Math.max(0, ...samples.map((sample) => sample.workingSetBytes)),
    peakPrivateBytes: Math.max(0, ...samples.map((sample) => sample.privateBytes)),
    peakHandleCount: Math.max(0, ...samples.map((sample) => sample.handleCount)),
    processSamples: samples.length,
    sha256: actualSha256,
  };
}

async function sampleWindowsProcess(pid) {
  if (!pid) return null;
  const script = [
    `$p = Get-Process -Id ${pid} -ErrorAction Stop`,
    `[Console]::Out.Write((@{workingSetBytes=[int64]$p.WorkingSet64;privateBytes=[int64]$p.PrivateMemorySize64;handleCount=[int]$p.HandleCount;cpuSeconds=[double]$p.CPU} | ConvertTo-Json -Compress))`,
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const chunks = [];
  child.stdout?.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const exitCode = await new Promise((resolvePromise) => child.once('exit', resolvePromise));
  if (exitCode !== 0) return null;
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return {
    sampledAtMilliseconds: Math.round(performance.now()),
    workingSetBytes: Number(value.workingSetBytes ?? 0),
    privateBytes: Number(value.privateBytes ?? 0),
    handleCount: Number(value.handleCount ?? 0),
    cpuSeconds: Number(value.cpuSeconds ?? 0),
  };
}

async function createDeterministicFile(path, length) {
  const stream = createWriteStream(path);
  let offset = 0;
  while (offset < length) {
    const size = Math.min(1024 * 1024, length - offset);
    const buffer = Buffer.allocUnsafe(size);
    for (let index = 0; index < size; index += 1) {
      buffer[index] = (offset + index * 43 + 29) & 0xff;
    }
    if (!stream.write(buffer)) {
      await new Promise((resolvePromise) => stream.once('drain', resolvePromise));
    }
    offset += size;
  }
  await new Promise((resolvePromise, reject) => {
    stream.once('error', reject);
    stream.end(resolvePromise);
  });
}

async function sha256(path) {
  const hash = createHash('sha256');
  const data = await readFile(path);
  hash.update(data);
  return hash.digest('hex');
}

async function assertNoRecoveryFiles(destination) {
  for (const path of [
    `${destination}.subutai.part`,
    `${destination}.subutai.job`,
    `${destination}.subutai.job.a`,
    `${destination}.subutai.job.b`,
  ]) {
    if (existsSync(path)) throw new Error(`Soak recovery file remained after completion: ${path}`);
  }
}

async function startRangeServer(sourcePath, sourceLength) {
  const source = await readFile(sourcePath);
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.url !== '/source.bin') {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('accept-ranges', 'bytes');
    response.setHeader('etag', '"subutai-native-soak"');
    response.setHeader('last-modified', 'Sun, 02 Aug 2026 17:00:00 GMT');
    const range = request.headers.range;
    if (request.method === 'HEAD') {
      response.statusCode = 200;
      response.setHeader('content-length', String(sourceLength));
      response.end();
      return;
    }
    if (request.method !== 'GET' || typeof range !== 'string') {
      response.statusCode = 400;
      response.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
    if (!match) {
      response.statusCode = 416;
      response.end();
      return;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= sourceLength) {
      response.statusCode = 416;
      response.end();
      return;
    }
    const body = source.subarray(start, end + 1);
    response.statusCode = 206;
    response.setHeader('content-range', `bytes ${start}-${end}/${sourceLength}`);
    response.setHeader('content-length', String(body.length));
    response.end(body);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Soak server did not bind.');
  return {
    url: `http://127.0.0.1:${address.port}/source.bin`,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
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

function integerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function average(values) {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length));
}

function formatBytes(value) {
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatRate(value) {
  return `${(value / (1024 * 1024)).toFixed(1)} MiB/s`;
}

function assertThreshold(condition, message) {
  if (!condition) throw new Error(`Subutai soak threshold failed: ${message}`);
}

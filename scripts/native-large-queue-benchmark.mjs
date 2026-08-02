import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32') {
  throw new Error('Subutai native large/queue benchmark requires Windows process telemetry.');
}

const largeMiB = integerEnv('SUBUTAI_BENCHMARK_LARGE_MIB', 128, 8, 4096);
const queueJobs = integerEnv('SUBUTAI_BENCHMARK_QUEUE_JOBS', 12, 1, 500);
const queueMiB = integerEnv('SUBUTAI_BENCHMARK_QUEUE_MIB', 4, 1, 1024);
const concurrency = integerEnv('SUBUTAI_BENCHMARK_CONCURRENCY', 3, 1, 32);
const segments = integerEnv('SUBUTAI_BENCHMARK_SEGMENTS', 8, 1, 32);
const minimumSegmentBytes = integerEnv(
  'SUBUTAI_BENCHMARK_MINIMUM_SEGMENT_BYTES',
  1024 * 1024,
  64 * 1024,
  1024 * 1024 * 1024,
);
const sampleIntervalMs = integerEnv('SUBUTAI_BENCHMARK_SAMPLE_MS', 250, 100, 5000);
const maximumLargeWorkingSetBytes = integerEnv('SUBUTAI_BENCHMARK_MAX_LARGE_WORKING_SET_MIB', 512, 32, 8192) * 1024 * 1024;
const maximumQueueWorkingSetBytes = integerEnv('SUBUTAI_BENCHMARK_MAX_QUEUE_WORKING_SET_MIB', 1024, 32, 16384) * 1024 * 1024;
const maximumQueuePrivateBytes = integerEnv('SUBUTAI_BENCHMARK_MAX_QUEUE_PRIVATE_MIB', 1024, 32, 16384) * 1024 * 1024;
const maximumQueueHandles = integerEnv('SUBUTAI_BENCHMARK_MAX_QUEUE_HANDLES', 4096, 32, 100000);
const reportPath = resolve(
  process.env.SUBUTAI_BENCHMARK_REPORT || join('artifacts', 'n5', 'native-large-queue-report.json'),
);
const nativeEngine = resolve(
  process.env.SUBUTAI_NATIVE_ENGINE_PATH
    || join('engines', 'native', 'target', 'release', 'subutai-engine.exe'),
);

if (!existsSync(nativeEngine)) throw new Error(`Subutai release CLI was not found: ${nativeEngine}`);
if (concurrency > queueJobs) throw new Error('SUBUTAI_BENCHMARK_CONCURRENCY cannot exceed queue job count.');

const root = await mkdtemp(join(tmpdir(), 'subutai-native-large-queue-'));
const sourceDirectory = join(root, 'sources');
const outputDirectory = join(root, 'downloads');
await mkdir(sourceDirectory, { recursive: true });
await mkdir(outputDirectory, { recursive: true });

const largeSource = join(sourceDirectory, 'large.bin');
const queueSource = join(sourceDirectory, 'queue.bin');
const largeBytes = largeMiB * 1024 * 1024;
const queueBytes = queueMiB * 1024 * 1024;
await createDeterministicFile(largeSource, largeBytes, 43);
await createDeterministicFile(queueSource, queueBytes, 61);
const [largeSha256, queueSha256] = await Promise.all([sha256(largeSource), sha256(queueSource)]);
const server = await startRangeServer(new Map([
  ['/large.bin', { path: largeSource, length: largeBytes, tag: 'large' }],
  ['/queue.bin', { path: queueSource, length: queueBytes, tag: 'queue' }],
]));

const benchmarkStartedAt = new Date();
try {
  const largeDestination = join(outputDirectory, 'large-result.bin');
  const largeReport = await runSingleDownload({
    label: 'large-file',
    url: `${server.origin}/large.bin`,
    destination: largeDestination,
    expectedBytes: largeBytes,
    expectedSha256: largeSha256,
  });
  assertThreshold(
    largeReport.peakWorkingSetBytes <= maximumLargeWorkingSetBytes,
    `large-file working set ${formatBytes(largeReport.peakWorkingSetBytes)} exceeded ${formatBytes(maximumLargeWorkingSetBytes)}`,
  );
  await assertNoRecoveryFiles(largeDestination);
  await rm(largeDestination, { force: true });
  console.log(
    `Large-file benchmark passed: ${formatBytes(largeBytes)}, ${formatRate(largeReport.throughputBytesPerSecond)}, `
    + `workingSet=${formatBytes(largeReport.peakWorkingSetBytes)}, handles=${largeReport.peakHandleCount}.`,
  );

  const queueReport = await runQueueBenchmark({
    origin: server.origin,
    outputDirectory,
    expectedBytes: queueBytes,
    expectedSha256: queueSha256,
  });
  assertThreshold(
    queueReport.peakAggregateWorkingSetBytes <= maximumQueueWorkingSetBytes,
    `queue working set ${formatBytes(queueReport.peakAggregateWorkingSetBytes)} exceeded ${formatBytes(maximumQueueWorkingSetBytes)}`,
  );
  assertThreshold(
    queueReport.peakAggregatePrivateBytes <= maximumQueuePrivateBytes,
    `queue private memory ${formatBytes(queueReport.peakAggregatePrivateBytes)} exceeded ${formatBytes(maximumQueuePrivateBytes)}`,
  );
  assertThreshold(
    queueReport.peakAggregateHandleCount <= maximumQueueHandles,
    `queue handles ${queueReport.peakAggregateHandleCount} exceeded ${maximumQueueHandles}`,
  );
  assertThreshold(
    queueReport.peakActiveProcesses <= concurrency,
    `queue active processes ${queueReport.peakActiveProcesses} exceeded concurrency ${concurrency}`,
  );

  const report = {
    schemaVersion: 1,
    product: 'Subutai',
    benchmark: 'native-large-file-and-queue',
    enginePath: nativeEngine,
    startedAt: benchmarkStartedAt.toISOString(),
    completedAt: new Date().toISOString(),
    configuration: {
      largeBytes,
      queueJobs,
      queueBytesPerJob: queueBytes,
      concurrency,
      segments,
      minimumSegmentBytes,
      sampleIntervalMs,
      thresholds: {
        maximumLargeWorkingSetBytes,
        maximumQueueWorkingSetBytes,
        maximumQueuePrivateBytes,
        maximumQueueHandles,
      },
    },
    expected: { largeSha256, queueSha256 },
    largeFile: largeReport,
    queue: queueReport,
  };

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    `Subutai native large/queue benchmark passed: large=${formatBytes(largeBytes)}, `
    + `queue=${queueJobs}×${formatBytes(queueBytes)}, concurrency=${concurrency}, `
    + `queueThroughput=${formatRate(queueReport.aggregateThroughputBytesPerSecond)}, `
    + `peakQueueWorkingSet=${formatBytes(queueReport.peakAggregateWorkingSetBytes)}.`,
  );
  console.log(`report=${reportPath}`);
} finally {
  await server.stop();
  await rm(root, { recursive: true, force: true });
}

async function runQueueBenchmark({ origin, outputDirectory, expectedBytes, expectedSha256 }) {
  const active = new Map();
  const aggregateSamples = [];
  let sampling = true;
  let peakActiveProcesses = 0;
  const queueStarted = performance.now();

  const sampler = (async () => {
    while (sampling) {
      const pids = Array.from(active.values()).map((child) => child.pid).filter(Boolean);
      peakActiveProcesses = Math.max(peakActiveProcesses, pids.length);
      if (pids.length > 0) {
        const sample = await sampleWindowsProcesses(pids).catch(() => null);
        if (sample) aggregateSamples.push(sample);
      }
      await delay(sampleIntervalMs);
    }
  })();

  let nextJob = 0;
  const reports = new Array(queueJobs);
  async function worker(workerIndex) {
    while (true) {
      const jobIndex = nextJob;
      nextJob += 1;
      if (jobIndex >= queueJobs) return;
      const jobNumber = jobIndex + 1;
      const destination = join(outputDirectory, `queue-${String(jobNumber).padStart(4, '0')}.bin`);
      const childKey = `${workerIndex}:${jobNumber}`;
      reports[jobIndex] = await runSingleDownload({
        label: `queue-${jobNumber}`,
        url: `${origin}/queue.bin`,
        destination,
        expectedBytes,
        expectedSha256,
        onSpawn: (child) => active.set(childKey, child),
        onExit: () => active.delete(childKey),
      });
      await assertNoRecoveryFiles(destination);
      await rm(destination, { force: true });
      console.log(`Queue job ${jobNumber}/${queueJobs} passed.`);
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index + 1)));
  } finally {
    sampling = false;
    await sampler;
  }

  const elapsedMilliseconds = Math.max(1, performance.now() - queueStarted);
  const totalBytes = expectedBytes * queueJobs;
  return {
    jobs: queueJobs,
    completedJobs: reports.filter(Boolean).length,
    concurrency,
    peakActiveProcesses,
    totalBytes,
    elapsedMilliseconds: Math.round(elapsedMilliseconds),
    aggregateThroughputBytesPerSecond: Math.round((totalBytes * 1000) / elapsedMilliseconds),
    minimumJobThroughputBytesPerSecond: Math.min(...reports.map((report) => report.throughputBytesPerSecond)),
    maximumJobThroughputBytesPerSecond: Math.max(...reports.map((report) => report.throughputBytesPerSecond)),
    peakAggregateWorkingSetBytes: Math.max(0, ...aggregateSamples.map((sample) => sample.workingSetBytes)),
    peakAggregatePrivateBytes: Math.max(0, ...aggregateSamples.map((sample) => sample.privateBytes)),
    peakAggregateHandleCount: Math.max(0, ...aggregateSamples.map((sample) => sample.handleCount)),
    aggregateProcessSamples: aggregateSamples.length,
    sha256: expectedSha256,
    jobReports: reports,
  };
}

async function runSingleDownload({
  label,
  url,
  destination,
  expectedBytes,
  expectedSha256,
  onSpawn = () => {},
  onExit = () => {},
}) {
  const child = spawn(
    nativeEngine,
    ['download-segmented', url, destination, String(segments), String(minimumSegmentBytes)],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  onSpawn(child);
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
      const sample = await sampleWindowsProcesses([child.pid]).catch(() => null);
      if (sample) samples.push(sample);
      await delay(sampleIntervalMs);
    }
  })();

  const started = performance.now();
  let exitCode;
  try {
    exitCode = await new Promise((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('exit', resolvePromise);
    });
  } finally {
    sampling = false;
    onExit();
    await sampler;
  }
  const elapsedMilliseconds = Math.max(1, performance.now() - started);
  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (exitCode !== 0 || !stdout.includes('result=PASS')) {
    throw new Error(`${label} failed with exit ${String(exitCode)}.\n${stderr}\n${stdout}`);
  }

  const info = await stat(destination);
  if (info.size !== expectedBytes) throw new Error(`${label} size mismatch: ${info.size} != ${expectedBytes}`);
  const actualSha256 = await sha256(destination);
  if (actualSha256 !== expectedSha256) throw new Error(`${label} SHA-256 mismatch.`);
  const finalResult = parseKeyValueOutput(stdout);
  if (finalResult.sha256 !== expectedSha256) throw new Error(`${label} native SHA-256 output mismatch.`);

  return {
    label,
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

async function sampleWindowsProcesses(pids) {
  const valid = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (valid.length === 0) return null;
  const ids = valid.join(',');
  const script = [
    `$p = @(Get-Process -Id @(${ids}) -ErrorAction SilentlyContinue)`,
    `if ($p.Count -eq 0) { exit 3 }`,
    `$working = [int64](($p | Measure-Object -Property WorkingSet64 -Sum).Sum)`,
    `$private = [int64](($p | Measure-Object -Property PrivateMemorySize64 -Sum).Sum)`,
    `$handles = [int](($p | Measure-Object -Property HandleCount -Sum).Sum)`,
    `$cpu = [double](($p | Measure-Object -Property CPU -Sum).Sum)`,
    `[Console]::Out.Write((@{processCount=$p.Count;workingSetBytes=$working;privateBytes=$private;handleCount=$handles;cpuSeconds=$cpu} | ConvertTo-Json -Compress))`,
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
    processCount: Number(value.processCount ?? 0),
    workingSetBytes: Number(value.workingSetBytes ?? 0),
    privateBytes: Number(value.privateBytes ?? 0),
    handleCount: Number(value.handleCount ?? 0),
    cpuSeconds: Number(value.cpuSeconds ?? 0),
  };
}

async function createDeterministicFile(path, length, multiplier) {
  const stream = createWriteStream(path);
  let offset = 0;
  while (offset < length) {
    const size = Math.min(1024 * 1024, length - offset);
    const buffer = Buffer.allocUnsafe(size);
    for (let index = 0; index < size; index += 1) {
      buffer[index] = (offset + index * multiplier + 29) & 0xff;
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

async function assertNoRecoveryFiles(destination) {
  for (const path of [
    `${destination}.subutai.part`,
    `${destination}.subutai.job`,
    `${destination}.subutai.job.a`,
    `${destination}.subutai.job.b`,
  ]) {
    if (existsSync(path)) throw new Error(`Benchmark recovery file remained after completion: ${path}`);
  }
}

async function startRangeServer(files) {
  const sockets = new Set();
  const server = createServer((request, response) => {
    const entry = files.get(request.url ?? '');
    if (!entry) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('accept-ranges', 'bytes');
    response.setHeader('etag', `"subutai-${entry.tag}-benchmark"`);
    response.setHeader('last-modified', 'Sun, 02 Aug 2026 17:30:00 GMT');
    if (request.method === 'HEAD') {
      response.statusCode = 200;
      response.setHeader('content-length', String(entry.length));
      response.end();
      return;
    }
    const range = request.headers.range;
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
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= entry.length) {
      response.statusCode = 416;
      response.end();
      return;
    }
    response.statusCode = 206;
    response.setHeader('content-range', `bytes ${start}-${end}/${entry.length}`);
    response.setHeader('content-length', String(end - start + 1));
    const stream = createReadStream(entry.path, { start, end });
    stream.once('error', () => response.destroy());
    stream.pipe(response);
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
  if (!address || typeof address === 'string') throw new Error('Benchmark server did not bind.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
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

function formatBytes(value) {
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatRate(value) {
  return `${(value / (1024 * 1024)).toFixed(1)} MiB/s`;
}

function assertThreshold(condition, message) {
  if (!condition) throw new Error(`Subutai large/queue benchmark threshold failed: ${message}`);
}

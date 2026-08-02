import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const reportPath = resolve(
  process.env.SUBUTAI_BENCHMARK_REPORT || 'artifacts/n5/native-large-queue-report.json',
);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const configuration = report.configuration;
const large = report.largeFile;
const queue = report.queue;

for (const [condition, message] of [
  [large.processSamples >= 2, 'large-file benchmark did not collect at least two process samples'],
  [large.peakWorkingSetBytes > 0, 'large-file working-set telemetry is empty'],
  [large.peakHandleCount > 0, 'large-file handle telemetry is empty'],
  [queue.aggregateProcessSamples >= 2, 'queue benchmark did not collect at least two aggregate process samples'],
  [queue.peakAggregateWorkingSetBytes > 0, 'queue aggregate working-set telemetry is empty'],
  [queue.peakAggregatePrivateBytes > 0, 'queue aggregate private-memory telemetry is empty'],
  [queue.peakAggregateHandleCount > 0, 'queue aggregate handle telemetry is empty'],
  [queue.peakActiveProcesses === configuration.concurrency, 'queue never reached the configured concurrency'],
  [queue.completedJobs === configuration.queueJobs, 'queue did not complete every configured job'],
]) {
  if (!condition) throw new Error(`Subutai large/queue telemetry validation failed: ${message}.`);
}

const markdown = [
  '## Subutai native large-file and queue benchmark',
  '',
  '| Metric | Result |',
  '|---|---:|',
  `| Large file | ${formatBytes(configuration.largeBytes)} |`,
  `| Large-file throughput | ${formatRate(large.throughputBytesPerSecond)} |`,
  `| Large-file process samples | ${large.processSamples} |`,
  `| Large-file peak working set | ${formatBytes(large.peakWorkingSetBytes)} |`,
  `| Large-file peak handles | ${large.peakHandleCount} |`,
  `| Queue jobs | ${configuration.queueJobs} |`,
  `| Queue bytes per job | ${formatBytes(configuration.queueBytesPerJob)} |`,
  `| Queue concurrency | ${configuration.concurrency} |`,
  `| Queue aggregate samples | ${queue.aggregateProcessSamples} |`,
  `| Queue aggregate throughput | ${formatRate(queue.aggregateThroughputBytesPerSecond)} |`,
  `| Queue peak active processes | ${queue.peakActiveProcesses} |`,
  `| Queue peak aggregate working set | ${formatBytes(queue.peakAggregateWorkingSetBytes)} |`,
  `| Queue peak aggregate private memory | ${formatBytes(queue.peakAggregatePrivateBytes)} |`,
  `| Queue peak aggregate handles | ${queue.peakAggregateHandleCount} |`,
  `| Large-file SHA-256 | \`${report.expected.largeSha256}\` |`,
  `| Queue SHA-256 | \`${report.expected.queueSha256}\` |`,
  '',
  '<details><summary>Machine-readable JSON report</summary>',
  '',
  '```json',
  JSON.stringify(report, null, 2),
  '```',
  '',
  '</details>',
  '',
].join('\n');

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, 'utf8');
}

console.log('SUBUTAI_NATIVE_LARGE_QUEUE_REPORT_BEGIN');
console.log(JSON.stringify(report));
console.log('SUBUTAI_NATIVE_LARGE_QUEUE_REPORT_END');
console.log(
  `Subutai large/queue summary published: large ${formatBytes(configuration.largeBytes)} at `
  + `${formatRate(large.throughputBytesPerSecond)}, queue ${configuration.queueJobs}×`
  + `${formatBytes(configuration.queueBytesPerJob)} at ${formatRate(queue.aggregateThroughputBytesPerSecond)}, `
  + `peak queue working set ${formatBytes(queue.peakAggregateWorkingSetBytes)}.`,
);

function formatBytes(value) {
  return `${(Number(value) / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatRate(value) {
  return `${(Number(value) / (1024 * 1024)).toFixed(1)} MiB/s`;
}

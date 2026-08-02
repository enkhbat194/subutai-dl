import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const reportPath = resolve(process.env.SUBUTAI_SOAK_REPORT || 'artifacts/n5/native-soak-report.json');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const summary = report.summary;
const configuration = report.configuration;

const markdown = [
  '## Subutai native soak telemetry',
  '',
  '| Metric | Result |',
  '|---|---:|',
  `| Iterations | ${configuration.iterations} |`,
  `| Payload per iteration | ${formatBytes(configuration.payloadBytes)} |`,
  `| Total verified bytes | ${formatBytes(summary.totalBytes)} |`,
  `| Average throughput | ${formatRate(summary.averageThroughputBytesPerSecond)} |`,
  `| Minimum throughput | ${formatRate(summary.minimumThroughputBytesPerSecond)} |`,
  `| Maximum throughput | ${formatRate(summary.maximumThroughputBytesPerSecond)} |`,
  `| Peak working set | ${formatBytes(summary.peakWorkingSetBytes)} |`,
  `| Peak private memory | ${formatBytes(summary.peakPrivateBytes)} |`,
  `| Peak handles | ${summary.peakHandleCount} |`,
  `| Peak-handle spread | ${summary.peakHandleSpread} |`,
  `| Expected SHA-256 | \`${report.expectedSha256}\` |`,
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

console.log('SUBUTAI_NATIVE_SOAK_REPORT_BEGIN');
console.log(JSON.stringify(report));
console.log('SUBUTAI_NATIVE_SOAK_REPORT_END');
console.log(
  `Subutai soak summary published: ${configuration.iterations} iterations, `
  + `${formatBytes(summary.totalBytes)}, ${formatRate(summary.averageThroughputBytesPerSecond)}, `
  + `peak working set ${formatBytes(summary.peakWorkingSetBytes)}, peak handles ${summary.peakHandleCount}.`,
);

function formatBytes(value) {
  return `${(Number(value) / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatRate(value) {
  return `${(Number(value) / (1024 * 1024)).toFixed(1)} MiB/s`;
}

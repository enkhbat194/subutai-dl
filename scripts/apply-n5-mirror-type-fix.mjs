import { readFileSync, writeFileSync } from 'node:fs';

const path = 'apps/desktop/src/main/subutai-runtime.ts';
const original = readFileSync(path, 'utf8');
const newline = original.includes('\r\n') ? '\r\n' : '\n';
let source = original.replace(/\r\n/gu, '\n');

function replaceOnce(before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${path}: expected source block was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${path}: expected source block is not unique`);
  }
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
  `async function verifyJobIntegrity(job: DownloadJob): Promise<void> {
  if (job.engine === 'media' || !job.expectedSha256 || job.actualSha256) return;`,
  `async function verifyJobIntegrity(job: DownloadJob): Promise<boolean> {
  if (job.engine === 'media' || !job.expectedSha256 || job.actualSha256) return true;`,
);

replaceOnce(
  `    job.updatedAt = new Date().toISOString();
  }
}

async function synchronizeJobs(): Promise<void> {`,
  `    job.updatedAt = new Date().toISOString();
    return false;
  }
  return true;
}

async function synchronizeJobs(): Promise<void> {`,
);

replaceOnce(
  `        } else if (job.status === 'completed') {
          await verifyJobIntegrity(job);
          if (job.status === 'failed' && job.failureKind === 'integrity') {
            await failoverToNextMirror(job, 'integrity');
          }
        }`,
  `        } else if (job.status === 'completed') {
          const integrityMatched = await verifyJobIntegrity(job);
          if (!integrityMatched) await failoverToNextMirror(job, 'integrity');
        }`,
);

writeFileSync(path, source.replace(/\n/gu, newline));
console.log('N5 mirror integrity result type migration applied.');

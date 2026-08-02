import { readFileSync, writeFileSync } from 'node:fs';

const path = 'apps/desktop/src/main/subutai-runtime.ts';
let source = readFileSync(path, 'utf8');

function replaceOnce(before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${path}: expected source block was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${path}: expected source block is not unique`);
  }
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
  `import { toPublicError } from './engines/public-error';
import {
  DEFAULT_TRANSFER_SETTINGS,`,
  `import { toPublicError } from './engines/public-error';
import {
  isRemoteChangeFailure,
  normalizeSha256,
  prepareDownloadDestination,
  verifyCompletedDownload,
} from './integrity/download-policy';
import {
  DEFAULT_TRANSFER_SETTINGS,`,
);

replaceOnce(
  `  if (!['http:', 'https:', 'ftp:', 'sftp:'].includes(parsed.protocol)) {
    throw new Error(\`Одоогоор дэмжихгүй протокол: \${parsed.protocol}\`);
  }
}`,
  `  if (!['http:', 'https:', 'ftp:', 'sftp:'].includes(parsed.protocol)) {
    throw new Error(\`Одоогоор дэмжихгүй протокол: \${parsed.protocol}\`);
  }
  normalizeSha256(request.expectedSha256);
}`,
);

replaceOnce(
  `async function assignTask(job: DownloadJob): Promise<void> {
  job.status = 'resolving';
  job.updatedAt = new Date().toISOString();
  saveJob(job);
  broadcastAll();`,
  `async function assignTask(job: DownloadJob): Promise<boolean> {
  if (job.engine !== 'media' && !job.destinationPolicyApplied) {
    const decision = await prepareDownloadDestination({
      directory: job.destination,
      filename: job.filename,
      policy: job.fileConflictPolicy ?? 'rename',
      expectedSha256: job.expectedSha256,
    });
    job.filename = decision.filename;
    job.destinationPolicyApplied = true;
    if (decision.outcome === 'skip') {
      job.status = 'completed';
      job.totalBytes = decision.totalBytes ?? null;
      job.downloadedBytes = decision.totalBytes ?? 0;
      job.speedBytesPerSecond = 0;
      job.etaSeconds = 0;
      if (decision.actualSha256) job.actualSha256 = decision.actualSha256;
      delete job.error;
      delete job.failureKind;
      job.updatedAt = new Date().toISOString();
      saveJob(job);
      broadcastAll();
      return false;
    }
  }

  job.status = 'resolving';
  job.updatedAt = new Date().toISOString();
  saveJob(job);
  broadcastAll();`,
);

replaceOnce(
  `  job.updatedAt = new Date().toISOString();
  saveJob(job);
}

async function startQueuedJob(job: DownloadJob): Promise<void> {`,
  `  job.updatedAt = new Date().toISOString();
  saveJob(job);
  return true;
}

async function startQueuedJob(job: DownloadJob): Promise<boolean> {`,
);

replaceOnce(
  `    saveJob(job);
    await engine.resume(job.engineTaskId);
  } else {
    await assignTask(job);
  }
}`,
  `    saveJob(job);
    await engine.resume(job.engineTaskId);
    return true;
  }
  return assignTask(job);
}`,
);

replaceOnce(
  `      try {
        await startQueuedJob(job);
        slots -= 1;
      } catch (error) {`,
  `      try {
        const started = await startQueuedJob(job);
        if (started) slots -= 1;
      } catch (error) {`,
);

replaceOnce(
  `  if (media) job.media = media;
  if (request.scheduleId) job.scheduleId = request.scheduleId;`,
  `  if (media) job.media = media;
  else {
    job.fileConflictPolicy = request.fileConflictPolicy ?? 'rename';
    job.remoteChangePolicy = request.remoteChangePolicy ?? 'fail';
    job.destinationPolicyApplied = false;
    job.remoteRestartCount = 0;
    const expectedSha256 = normalizeSha256(request.expectedSha256);
    if (expectedSha256) job.expectedSha256 = expectedSha256;
  }
  if (request.scheduleId) job.scheduleId = request.scheduleId;`,
);

replaceOnce(
  `      ].map((path) => rm(path, { force: true })));
    }
  }
  broadcastAll();`,
  `      ].map((path) => rm(path, { force: true })));
    }
    if (job.quarantinePath) await rm(job.quarantinePath, { force: true });
  }
  broadcastAll();`,
);

replaceOnce(
  `  if (status.errorMessage) {
    job.error = status.errorMessage;
    job.failureKind = classifyDownloadFailure(status.errorMessage);`,
  `  if (status.errorMessage) {
    job.error = toPublicError(status.errorMessage);
    job.failureKind = classifyDownloadFailure(job.error);`,
);

replaceOnce(
  `async function synchronizeJobs(): Promise<void> {`,
  `async function restartChangedRemote(job: DownloadJob, status: SubutaiTaskStatus): Promise<boolean> {
  if (job.remoteChangePolicy !== 'restart'
    || (job.remoteRestartCount ?? 0) >= 1
    || !isRemoteChangeFailure(status.errorCode, status.errorMessage)) return false;

  if (job.engineTaskId) {
    try { await engine.cancel(job.engineTaskId); } catch { /* failed task may already be gone */ }
  }
  delete job.engineTaskId;
  delete job.error;
  delete job.failureKind;
  delete job.actualSha256;
  delete job.quarantinePath;
  job.status = 'queued';
  job.downloadedBytes = 0;
  job.totalBytes = null;
  job.speedBytesPerSecond = 0;
  job.etaSeconds = null;
  job.remoteRestartCount = (job.remoteRestartCount ?? 0) + 1;
  job.updatedAt = new Date().toISOString();
  return true;
}

async function verifyJobIntegrity(job: DownloadJob): Promise<void> {
  if (job.engine === 'media' || !job.expectedSha256 || job.actualSha256) return;
  const filePath = join(job.destination, job.filename);
  const verification = await verifyCompletedDownload(filePath, job.expectedSha256);
  job.actualSha256 = verification.actualSha256;
  if (!verification.matched) {
    if (job.engineTaskId) {
      try { await engine.cancel(job.engineTaskId); } catch { /* completed native task may already be gone */ }
    }
    delete job.engineTaskId;
    job.status = 'failed';
    job.failureKind = 'integrity';
    job.error = 'SHA-256 шалгалт зөрсөн. Файлыг аюулгүй тусгаарласан.';
    if (verification.quarantinePath) job.quarantinePath = verification.quarantinePath;
    job.speedBytesPerSecond = 0;
    job.etaSeconds = null;
    job.updatedAt = new Date().toISOString();
  }
}

async function synchronizeJobs(): Promise<void> {`,
);

replaceOnce(
  `        const status = await engine.getStatus(job.engineTaskId);
        updateJobFromStatus(job, status);
        saveJob(job);
        changed = true;`,
  `        const status = await engine.getStatus(job.engineTaskId);
        updateJobFromStatus(job, status);
        if (job.status === 'failed') {
          await restartChangedRemote(job, status);
        } else if (job.status === 'completed') {
          await verifyJobIntegrity(job);
        }
        saveJob(job);
        changed = true;`,
);

replaceOnce(
  `    restored.priority ??= 'normal';
    restored.queueOrder ??= order;
    restored.retryCount ??= 0;`,
  `    restored.priority ??= 'normal';
    restored.queueOrder ??= order;
    restored.retryCount ??= 0;
    restored.fileConflictPolicy ??= 'rename';
    restored.remoteChangePolicy ??= 'fail';
    restored.remoteRestartCount ??= 0;
    restored.destinationPolicyApplied ??= true;`,
);

writeFileSync(path, source);
console.log('N5 integrity runtime migration applied.');

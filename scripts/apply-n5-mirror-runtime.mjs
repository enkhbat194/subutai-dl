import { readFileSync, writeFileSync } from 'node:fs';

function update(path, transform) {
  const original = readFileSync(path, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  let source = original.replace(/\r\n/gu, '\n');
  source = transform(source);
  writeFileSync(path, source.replace(/\n/gu, newline));
}

function replaceOnce(source, path, before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${path}: expected source block was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${path}: expected source block is not unique`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

update('packages/shared/src/index.ts', (initial) => {
  const path = 'packages/shared/src/index.ts';
  let source = initial;
  source = replaceOnce(
    source,
    path,
    `  remoteChangePolicy?: RemoteChangePolicy;
  expectedSha256?: string;
}`,
    `  remoteChangePolicy?: RemoteChangePolicy;
  expectedSha256?: string;
  mirrorUrls?: string[];
}`,
  );
  source = replaceOnce(
    source,
    path,
    `  remoteChangePolicy?: RemoteChangePolicy;
  expectedSha256?: string;
  actualSha256?: string;`,
    `  remoteChangePolicy?: RemoteChangePolicy;
  expectedSha256?: string;
  mirrorUrls?: string[];
  mirrorIndex?: number;
  activeSourceUrl?: string;
  mirrorFallbackCount?: number;
  actualSha256?: string;`,
  );
  return source;
});

update('apps/desktop/src/main/subutai-runtime.ts', (initial) => {
  const path = 'apps/desktop/src/main/subutai-runtime.ts';
  let source = initial;
  source = replaceOnce(
    source,
    path,
    `  normalizeSha256,
  prepareDownloadDestination,
  verifyCompletedDownload,`,
    `  normalizeSha256,
  prepareDownloadDestination,
  removeDownloadFiles,
  verifyCompletedDownload,`,
  );
  source = replaceOnce(
    source,
    path,
    `import { canAutoRetry, classifyDownloadFailure } from './resilience/failure-policy';
import { JobStore } from './storage/job-store';`,
    `import { canAutoRetry, classifyDownloadFailure } from './resilience/failure-policy';
import {
  activeDownloadUrl,
  applyMirrorTransition,
  mirrorReasonFromFailure,
  nextMirrorSource,
  normalizeMirrorUrls,
  validateMirrorIntegrity,
  type MirrorFailoverReason,
} from './resilience/mirror-policy';
import { JobStore } from './storage/job-store';`,
  );
  source = replaceOnce(
    source,
    path,
    `  normalizeSha256(request.expectedSha256);
}`,
    `  const expectedSha256 = normalizeSha256(request.expectedSha256);
  const mirrorUrls = normalizeMirrorUrls(url, request.mirrorUrls);
  validateMirrorIntegrity(mirrorUrls, expectedSha256);
}`,
  );
  source = replaceOnce(
    source,
    path,
    `    url: job.url,
    destination: job.destination,`,
    `    url: activeDownloadUrl(job),
    destination: job.destination,`,
  );
  source = replaceOnce(
    source,
    path,
    `  const media = resolveMediaOptions(request);
  const filename = requestedFilename || (media ? 'Media таталт' : inferFilename(request.url));`,
    `  const media = resolveMediaOptions(request);
  const mirrorUrls = normalizeMirrorUrls(request.url.trim(), request.mirrorUrls);
  if (media && mirrorUrls.length > 0) {
    throw new Error('Mirror fallback нь зөвхөн direct HTTP/HTTPS таталтад хамаарна.');
  }
  const filename = requestedFilename || (media ? 'Media таталт' : inferFilename(request.url));`,
  );
  source = replaceOnce(
    source,
    path,
    `    const expectedSha256 = normalizeSha256(request.expectedSha256);
    if (expectedSha256) job.expectedSha256 = expectedSha256;
  }`,
    `    const expectedSha256 = normalizeSha256(request.expectedSha256);
    if (expectedSha256) job.expectedSha256 = expectedSha256;
    if (mirrorUrls.length > 0) job.mirrorUrls = mirrorUrls;
    job.mirrorIndex = 0;
    job.activeSourceUrl = job.url;
    job.mirrorFallbackCount = 0;
  }`,
  );
  source = replaceOnce(
    source,
    path,
    `async function restartChangedRemote(job: DownloadJob, status: SubutaiTaskStatus): Promise<boolean> {`,
    `async function failoverToNextMirror(
  job: DownloadJob,
  reason: MirrorFailoverReason,
): Promise<boolean> {
  const transition = nextMirrorSource(job, reason);
  if (!transition) return false;

  if (job.engineTaskId) {
    try { await engine.cancel(job.engineTaskId); } catch { /* failed or completed task may already be gone */ }
  }
  const destinationPath = join(job.destination, job.filename);
  await removeDownloadFiles(destinationPath, false);
  applyMirrorTransition(job, transition);
  return true;
}

async function restartChangedRemote(job: DownloadJob, status: SubutaiTaskStatus): Promise<boolean> {`,
  );
  source = replaceOnce(
    source,
    path,
    `        if (job.status === 'failed') {
          await restartChangedRemote(job, status);
        } else if (job.status === 'completed') {
          await verifyJobIntegrity(job);
        }`,
    `        if (job.status === 'failed') {
          let mirrorSwitched = false;
          if (isRemoteChangeFailure(status.errorCode, status.errorMessage)) {
            mirrorSwitched = await failoverToNextMirror(job, 'remote-change');
          } else {
            const mirrorReason = mirrorReasonFromFailure(job.failureKind);
            if (mirrorReason) mirrorSwitched = await failoverToNextMirror(job, mirrorReason);
          }
          if (!mirrorSwitched) await restartChangedRemote(job, status);
        } else if (job.status === 'completed') {
          await verifyJobIntegrity(job);
          if (job.status === 'failed' && job.failureKind === 'integrity') {
            await failoverToNextMirror(job, 'integrity');
          }
        }`,
  );
  source = replaceOnce(
    source,
    path,
    `    restored.remoteRestartCount ??= 0;
    restored.destinationPolicyApplied ??= true;
    order += 1;`,
    `    restored.remoteRestartCount ??= 0;
    restored.destinationPolicyApplied ??= true;
    restored.mirrorUrls = normalizeMirrorUrls(restored.url, restored.mirrorUrls);
    restored.mirrorIndex = Math.max(0, Math.min(restored.mirrorUrls.length, restored.mirrorIndex ?? 0));
    restored.activeSourceUrl = [restored.url, ...restored.mirrorUrls][restored.mirrorIndex] ?? restored.url;
    restored.mirrorFallbackCount ??= restored.mirrorIndex;
    order += 1;`,
  );
  return source;
});

update('package.json', (initial) => {
  const path = 'package.json';
  return replaceOnce(
    initial,
    path,
    `    "test:integrity": "node --experimental-strip-types scripts/integrity-policy-test.mts",
    "test:production-acceptance":`,
    `    "test:integrity": "node --experimental-strip-types scripts/integrity-policy-test.mts",
    "test:mirror": "node --experimental-strip-types scripts/mirror-policy-test.mts",
    "test:production-acceptance":`,
  );
});

console.log('N5 mirror runtime migration applied.');

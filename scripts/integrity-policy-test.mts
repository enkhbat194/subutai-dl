import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isRemoteChangeFailure,
  prepareDownloadDestination,
  resumableStatePaths,
  verifyCompletedDownload,
} from '../apps/desktop/src/main/integrity/download-policy.ts';
import { redactDiagnosticMessage } from '../apps/desktop/src/main/engines/public-error.ts';

const runtimeSource = await readFile(
  join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'subutai-runtime.ts'),
  'utf8',
);
for (const requiredRuntimeContract of [
  'prepareDownloadDestination({',
  "job.fileConflictPolicy = request.fileConflictPolicy ?? 'rename'",
  "job.remoteChangePolicy = request.remoteChangePolicy ?? 'fail'",
  'async function restartChangedRemote(',
  'await verifyJobIntegrity(job)',
  "job.failureKind = 'integrity'",
]) {
  assert.ok(
    runtimeSource.includes(requiredRuntimeContract),
    `desktop runtime is missing integrity contract: ${requiredRuntimeContract}`,
  );
}

const root = await mkdtemp(join(tmpdir(), 'subutai-integrity-'));
try {
  const source = Buffer.from('Subutai integrity acceptance data');
  const expectedSha256 = createHash('sha256').update(source).digest('hex');
  const filePath = join(root, 'sample.bin');
  await writeFile(filePath, source);

  const renameDecision = await prepareDownloadDestination({
    directory: root,
    filename: 'sample.bin',
    policy: 'rename',
  });
  assert.equal(renameDecision.filename, 'sample (1).bin');
  assert.equal(renameDecision.outcome, 'download');

  const skipDecision = await prepareDownloadDestination({
    directory: root,
    filename: 'sample.bin',
    policy: 'skip',
    expectedSha256,
  });
  assert.equal(skipDecision.outcome, 'skip');
  assert.equal(skipDecision.actualSha256, expectedSha256);

  const partialPath = join(root, 'resume.bin');
  await writeFile(`${partialPath}.subutai.part`, source);
  const resumeDecision = await prepareDownloadDestination({
    directory: root,
    filename: 'resume.bin',
    policy: 'resume',
  });
  assert.equal(resumeDecision.outcome, 'download');
  assert.equal(resumeDecision.filename, 'resume.bin');

  const overwritePath = join(root, 'overwrite.bin');
  await writeFile(overwritePath, source);
  for (const statePath of resumableStatePaths(overwritePath)) await writeFile(statePath, source);
  const overwriteDecision = await prepareDownloadDestination({
    directory: root,
    filename: 'overwrite.bin',
    policy: 'overwrite',
  });
  assert.equal(overwriteDecision.outcome, 'download');
  await assert.rejects(readFile(overwritePath));
  for (const statePath of resumableStatePaths(overwritePath)) await assert.rejects(readFile(statePath));

  const verifiedPath = join(root, 'verified.bin');
  await writeFile(verifiedPath, source);
  const verified = await verifyCompletedDownload(verifiedPath, expectedSha256);
  assert.equal(verified.matched, true);
  assert.equal(verified.actualSha256, expectedSha256);
  assert.deepEqual(await readFile(verifiedPath), source);

  const corruptPath = join(root, 'corrupt.bin');
  await writeFile(corruptPath, source);
  const mismatch = await verifyCompletedDownload(corruptPath, '0'.repeat(64));
  assert.equal(mismatch.matched, false);
  assert.ok(mismatch.quarantinePath?.endsWith('.subutai.corrupt'));
  await assert.rejects(readFile(corruptPath));
  assert.deepEqual(await readFile(mismatch.quarantinePath!), source);

  assert.equal(isRemoteChangeFailure('REMOTE_CHANGED', ''), true);
  assert.equal(isRemoteChangeFailure(undefined, 'remote content changed: ETag changed'), true);
  assert.equal(isRemoteChangeFailure(undefined, 'connection timed out'), false);

  const diagnostic = redactDiagnosticMessage(
    'Authorization: Bearer private-value URL=https://user:pass@example.test/file?token=abc&safe=1 Cookie=session-value',
  );
  assert.ok(!diagnostic.includes('private-value'));
  assert.ok(!diagnostic.includes('user:pass'));
  assert.ok(!diagnostic.includes('token=abc'));
  assert.ok(!diagnostic.includes('session-value'));
  assert.ok(diagnostic.includes('[redacted]'));

  console.log('Subutai integrity policies passed: runtime wiring, conflict handling, verified skip/resume, quarantine, remote restart detection and diagnostic redaction.');
} finally {
  await rm(root, { recursive: true, force: true });
}

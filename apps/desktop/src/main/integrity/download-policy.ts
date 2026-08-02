import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { FileConflictPolicy } from '@subutai/shared';

export interface DestinationDecision {
  filename: string;
  outcome: 'download' | 'skip';
  totalBytes?: number;
  actualSha256?: string;
}

export interface VerificationResult {
  matched: boolean;
  actualSha256: string;
  quarantinePath?: string;
}

export function normalizeSha256(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error('SHA-256 утга 64 ширхэг hexadecimal тэмдэгт байх ёстой.');
  }
  return normalized;
}

export async function prepareDownloadDestination(input: {
  directory: string;
  filename: string;
  policy: FileConflictPolicy;
  expectedSha256?: string | undefined;
}): Promise<DestinationDecision> {
  const expectedSha256 = normalizeSha256(input.expectedSha256);
  const initialPath = join(input.directory, input.filename);
  const finalExists = existsSync(initialPath);
  const stateExists = resumableStatePaths(initialPath).some((path) => existsSync(path));

  if (!finalExists && !stateExists) {
    return { filename: input.filename, outcome: 'download' };
  }

  switch (input.policy) {
    case 'rename': {
      const filename = uniqueDownloadName(input.directory, input.filename);
      return { filename, outcome: 'download' };
    }
    case 'overwrite': {
      await removeDownloadFiles(initialPath, true);
      return { filename: input.filename, outcome: 'download' };
    }
    case 'skip': {
      if (!finalExists) {
        throw new Error('Бэлэн файл байхгүй, зөвхөн дутуу таталт байгаа тул skip хийх боломжгүй.');
      }
      const metadata = await stat(initialPath);
      const decision: DestinationDecision = {
        filename: input.filename,
        outcome: 'skip',
        totalBytes: metadata.size,
      };
      if (expectedSha256) {
        const actualSha256 = await hashFileSha256(initialPath);
        if (actualSha256 !== expectedSha256) {
          throw new Error('Одоо байгаа файлын SHA-256 хүлээгдсэн утгатай тохирохгүй байна.');
        }
        decision.actualSha256 = actualSha256;
      }
      return decision;
    }
    case 'resume': {
      if (!finalExists) {
        return { filename: input.filename, outcome: 'download' };
      }
      if (!expectedSha256) {
        throw new Error('Бэлэн файлыг verified resume хийхэд SHA-256 шаардлагатай.');
      }
      const actualSha256 = await hashFileSha256(initialPath);
      if (actualSha256 !== expectedSha256) {
        throw new Error('Бэлэн файлын SHA-256 зөрсөн тул verified resume-ийг зөвшөөрөхгүй.');
      }
      const metadata = await stat(initialPath);
      return {
        filename: input.filename,
        outcome: 'skip',
        totalBytes: metadata.size,
        actualSha256,
      };
    }
  }
}

export async function verifyCompletedDownload(
  filePath: string,
  expectedSha256: string,
): Promise<VerificationResult> {
  const expected = normalizeSha256(expectedSha256);
  if (!expected) throw new Error('SHA-256 verification requires an expected hash.');
  const actualSha256 = await hashFileSha256(filePath);
  if (actualSha256 === expected) return { matched: true, actualSha256 };

  const quarantinePath = uniqueQuarantinePath(filePath);
  await rename(filePath, quarantinePath);
  return { matched: false, actualSha256, quarantinePath };
}

export async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolvePromise);
  });
  return hash.digest('hex');
}

export function isRemoteChangeFailure(errorCode: string | undefined, message: string | undefined): boolean {
  if (errorCode === 'REMOTE_CHANGED') return true;
  const value = message?.toLowerCase() ?? '';
  return value.includes('remote content changed')
    || value.includes('etag changed')
    || value.includes('last-modified changed')
    || value.includes('server rejected the saved range validator');
}

export async function removeDownloadFiles(filePath: string, includeFinal: boolean): Promise<void> {
  const paths = includeFinal ? [filePath, ...resumableStatePaths(filePath)] : resumableStatePaths(filePath);
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}

export function resumableStatePaths(filePath: string): string[] {
  return [
    `${filePath}.subutai.part`,
    `${filePath}.subutai.job`,
    `${filePath}.subutai.job.a`,
    `${filePath}.subutai.job.b`,
  ];
}

function uniqueDownloadName(directory: string, filename: string): string {
  const extension = extname(filename);
  const stem = basename(filename, extension) || 'download';
  for (let index = 1; index <= 10_000; index += 1) {
    const candidate = `${stem} (${index})${extension}`;
    const candidatePath = join(directory, candidate);
    if (!existsSync(candidatePath) && !resumableStatePaths(candidatePath).some((path) => existsSync(path))) {
      return candidate;
    }
  }
  throw new Error('Файлын давхардлыг шийдэх сул нэр олдсонгүй.');
}

function uniqueQuarantinePath(filePath: string): string {
  const initial = `${filePath}.subutai.corrupt`;
  if (!existsSync(initial)) return initial;
  for (let index = 1; index <= 10_000; index += 1) {
    const candidate = `${initial}.${index}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error('Гэмтсэн файлыг тусгаарлах сул нэр олдсонгүй.');
}

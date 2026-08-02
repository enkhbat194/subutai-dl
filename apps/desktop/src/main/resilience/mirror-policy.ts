import type { DownloadFailureKind, DownloadJob } from '@subutai/shared';

const MAX_MIRROR_URLS = 16;
const MIRROR_FAILURES = new Set<MirrorFailoverReason>([
  'network',
  'server',
  'remote-change',
  'integrity',
]);

export type MirrorFailoverReason = 'network' | 'server' | 'remote-change' | 'integrity';

export interface MirrorTransition {
  index: number;
  url: string;
  reason: MirrorFailoverReason;
}

export function normalizeMirrorUrls(primaryUrl: string, values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  if (values.length > MAX_MIRROR_URLS) {
    throw new Error(`Mirror URL-ийн тоо ${MAX_MIRROR_URLS}-аас их байж болохгүй.`);
  }

  const primaryKey = validatedHttpUrl(primaryUrl, 'Үндсэн URL').key;
  const seen = new Set<string>([primaryKey]);
  const mirrors: string[] = [];
  for (const value of values) {
    const validated = validatedHttpUrl(value, 'Mirror URL');
    if (seen.has(validated.key)) continue;
    seen.add(validated.key);
    mirrors.push(validated.value);
  }
  return mirrors;
}

export function validateMirrorIntegrity(mirrorUrls: readonly string[], expectedSha256: string | undefined): void {
  if (mirrorUrls.length === 0) return;
  if (!expectedSha256 || !/^[a-f0-9]{64}$/u.test(expectedSha256.trim().toLowerCase())) {
    throw new Error('Mirror fallback ашиглахад expected SHA-256 заавал шаардлагатай.');
  }
}

export function activeDownloadUrl(job: Pick<DownloadJob, 'url' | 'mirrorUrls' | 'mirrorIndex' | 'activeSourceUrl'>): string {
  if (job.activeSourceUrl?.trim()) return job.activeSourceUrl;
  const sources = [job.url, ...(job.mirrorUrls ?? [])];
  return sources[Math.max(0, Math.min(sources.length - 1, job.mirrorIndex ?? 0))] ?? job.url;
}

export function mirrorReasonFromFailure(kind: DownloadFailureKind | undefined): MirrorFailoverReason | null {
  return kind === 'network' || kind === 'server' ? kind : null;
}

export function nextMirrorSource(
  job: Pick<DownloadJob, 'engine' | 'url' | 'mirrorUrls' | 'mirrorIndex' | 'expectedSha256'>,
  reason: MirrorFailoverReason,
): MirrorTransition | null {
  if (job.engine === 'media' || !MIRROR_FAILURES.has(reason)) return null;
  if (!job.expectedSha256 || !/^[a-f0-9]{64}$/u.test(job.expectedSha256)) return null;
  const sources = [job.url, ...(job.mirrorUrls ?? [])];
  const nextIndex = (job.mirrorIndex ?? 0) + 1;
  const url = sources[nextIndex];
  if (!url) return null;
  return { index: nextIndex, url, reason };
}

export function applyMirrorTransition(job: DownloadJob, transition: MirrorTransition, now = new Date().toISOString()): void {
  job.mirrorIndex = transition.index;
  job.activeSourceUrl = transition.url;
  job.mirrorFallbackCount = (job.mirrorFallbackCount ?? 0) + 1;
  job.status = 'queued';
  job.downloadedBytes = 0;
  job.totalBytes = null;
  job.speedBytesPerSecond = 0;
  job.etaSeconds = null;
  job.updatedAt = now;
  delete job.engineTaskId;
  delete job.error;
  delete job.failureKind;
  delete job.actualSha256;
}

function validatedHttpUrl(input: string, label: string): { value: string; key: string } {
  const value = input.trim();
  if (!value) throw new Error(`${label} хоосон байж болохгүй.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} буруу байна.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} зөвхөн HTTP/HTTPS байх ёстой: ${parsed.protocol}`);
  }
  parsed.hash = '';
  return { value, key: parsed.href };
}

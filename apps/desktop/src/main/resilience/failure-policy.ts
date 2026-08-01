import type { DownloadFailureKind, DownloadJob } from '@subutai/shared';

const SERVER_STATUS = /\b(?:408|425|429|500|502|503|504)\b/u;
const AUTH_STATUS = /\b(?:401|403)\b/u;

export function classifyDownloadFailure(message: string): DownloadFailureKind {
  const normalized = message.toLowerCase();
  if (/cancel|removed|aborted by user|force.?remove/u.test(normalized)) return 'cancelled';
  if (/enospc|no space|disk full|read.?only|permission denied|access denied|eacces|eperm/u.test(normalized)) return 'disk';
  if (AUTH_STATUS.test(normalized) || /unauthori[sz]ed|forbidden|authentication failed|login failed/u.test(normalized)) return 'authentication';
  if (SERVER_STATUS.test(normalized) || /too many requests|service unavailable|bad gateway|gateway timeout/u.test(normalized)) return 'server';
  if (/timeout|timed out|connection reset|connection refused|connection closed|network unreachable|host unreachable|name resolution|dns|offline|socket|temporary failure|econnreset|econnrefused|enetunreach|ehostunreach|etimedout|fetch failed/u.test(normalized)) return 'network';
  return 'unknown';
}

export function isAutoRecoverableFailure(kind: DownloadFailureKind): boolean {
  return kind === 'network' || kind === 'server';
}

export function canAutoRetry(job: DownloadJob, maxRetries = 5): boolean {
  const kind = job.failureKind ?? classifyDownloadFailure(job.error ?? '');
  return job.status === 'failed'
    && isAutoRecoverableFailure(kind)
    && (job.retryCount ?? 0) < Math.max(1, maxRetries);
}

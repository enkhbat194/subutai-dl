const IMPLEMENTATION_NAMES: Array<[RegExp, string]> = [
  [/aria2c?/giu, 'Subutai direct engine'],
  [/yt-dlp(?:\.exe)?/giu, 'Subutai media engine'],
  [/ffmpeg(?:\.exe)?/giu, 'Subutai media engine'],
  [/ffprobe(?:\.exe)?/giu, 'Subutai media engine'],
];

const SENSITIVE_QUERY_NAMES = [
  'access_token', 'auth', 'authorization', 'code', 'credential', 'key', 'password',
  'secret', 'sig', 'signature', 'token', 'x-amz-credential', 'x-amz-security-token',
  'x-amz-signature',
].join('|');

export function redactDiagnosticMessage(input: string): string {
  return input
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n|]+/giu, '$1: [redacted]')
    .replace(/\b(bearer|basic)\s+[a-z0-9+/_=.-]+/giu, '$1 [redacted]')
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[redacted]@')
    .replace(new RegExp(`([?&](?:${SENSITIVE_QUERY_NAMES})=)[^&#\\s]+`, 'giu'), '$1[redacted]');
}

export function toPublicError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [pattern, replacement] of IMPLEMENTATION_NAMES) {
    message = message.replaceAll(pattern, replacement);
  }
  message = redactDiagnosticMessage(message);
  return message.trim() || 'Subutai-д тодорхойгүй алдаа гарлаа.';
}

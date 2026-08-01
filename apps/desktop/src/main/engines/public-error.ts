const IMPLEMENTATION_NAMES: Array<[RegExp, string]> = [
  [/aria2c?/giu, 'Subutai direct engine'],
  [/yt-dlp(?:\.exe)?/giu, 'Subutai media engine'],
  [/ffmpeg(?:\.exe)?/giu, 'Subutai media engine'],
  [/ffprobe(?:\.exe)?/giu, 'Subutai media engine'],
];

export function toPublicError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [pattern, replacement] of IMPLEMENTATION_NAMES) {
    message = message.replaceAll(pattern, replacement);
  }
  return message.trim() || 'Subutai-д тодорхойгүй алдаа гарлаа.';
}

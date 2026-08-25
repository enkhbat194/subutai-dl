import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const YOUTUBE_AUTH_CHALLENGE = /sign in to confirm|not a bot|authentication[^\n]*cookies|cookies[^\n]*authentication|youtube cookies|cookies-from-browser|http(?: response)? error:? 403|\b403 forbidden\b/i;

export function isYouTubeUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'youtu.be'
      || host === 'youtube.com'
      || host.endsWith('.youtube.com')
      || host === 'youtube-nocookie.com'
      || host.endsWith('.youtube-nocookie.com');
  } catch {
    return false;
  }
}

export function looksLikeYouTubeAuthChallenge(value: string): boolean {
  return YOUTUBE_AUTH_CHALLENGE.test(value);
}

export function hasPackagedWpcProvider(ytDlpPath: string): boolean {
  if (!ytDlpPath || ytDlpPath === basename(ytDlpPath)) return false;
  const engineDir = dirname(ytDlpPath);
  return existsSync(join(
    engineDir,
    'yt-dlp-plugins',
    'subutai-wpc',
    'yt_dlp_plugins',
    'extractor',
    'getpot_wpc.py',
  ));
}

export function appendYouTubeWpcRoute(args: string[], url: string): void {
  if (!isYouTubeUrl(url)) return;
  args.push('--extractor-args', 'youtube:player_client=mweb');
}

export function shouldAttemptYouTubeWpcFallback(input: {
  url: string;
  diagnostic: string;
  ytDlpPath: string;
  attempted: boolean;
  browserCookieSourceIndex: number;
  browserCookieSourceCount: number;
}): boolean {
  if (input.attempted) return false;
  if (!isYouTubeUrl(input.url)) return false;
  if (!looksLikeYouTubeAuthChallenge(input.diagnostic)) return false;
  if (!hasPackagedWpcProvider(input.ytDlpPath)) return false;

  // The browser-cookie chain must be exhausted first. With no discovered sources,
  // browserCookieSourceCount is zero and the initial -1 index is already terminal.
  return input.browserCookieSourceIndex >= input.browserCookieSourceCount - 1;
}

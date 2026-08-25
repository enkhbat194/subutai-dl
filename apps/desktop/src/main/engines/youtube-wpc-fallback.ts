import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';

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

function addCandidate(target: string[], value: string | undefined): void {
  const candidate = value?.trim().replace(/^"|"$/g, '');
  if (!candidate || target.includes(candidate)) return;
  target.push(candidate);
}

export function resolveYouTubeWpcBrowserPath(): string | null {
  const candidates: string[] = [];
  addCandidate(candidates, process.env.SUBUTAI_WPC_BROWSER_PATH);

  const programFiles = process.env.PROGRAMFILES?.trim();
  const programFilesX86 = process.env['PROGRAMFILES(X86)']?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();

  for (const root of [programFiles, programFilesX86, localAppData]) {
    if (!root) continue;
    addCandidate(candidates, join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    addCandidate(candidates, join(root, 'Chromium', 'Application', 'chrome.exe'));
    addCandidate(candidates, join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    addCandidate(candidates, join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    addCandidate(candidates, join(root, 'Vivaldi', 'Application', 'vivaldi.exe'));
    addCandidate(candidates, join(root, 'Programs', 'Opera', 'opera.exe'));
    addCandidate(candidates, join(root, 'Programs', 'Opera GX', 'opera.exe'));
  }

  const pathEntries = (process.env.PATH ?? '').split(delimiter).map((entry) => entry.trim()).filter(Boolean);
  for (const entry of pathEntries) {
    addCandidate(candidates, join(entry, 'chrome.exe'));
    addCandidate(candidates, join(entry, 'chromium.exe'));
    addCandidate(candidates, join(entry, 'msedge.exe'));
    addCandidate(candidates, join(entry, 'brave.exe'));
    addCandidate(candidates, join(entry, 'vivaldi.exe'));
    addCandidate(candidates, join(entry, 'opera.exe'));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function appendYouTubeWpcRoute(args: string[], url: string): void {
  if (!isYouTubeUrl(url)) return;
  args.push('--extractor-args', 'youtube:player_client=mweb');
  const browserPath = resolveYouTubeWpcBrowserPath();
  if (browserPath) {
    args.push('--extractor-args', `youtubepot-wpc:browser_path=${browserPath}`);
  }
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

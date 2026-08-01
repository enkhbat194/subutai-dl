import type { SiteResourceKind } from '@subutai/shared';

const ATTRIBUTE_URL = /\b(?:href|src|data-src|poster)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/giu;
const CSS_URL = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/giu;

const KIND_EXTENSIONS: Record<SiteResourceKind, Set<string>> = {
  document: new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf', '.csv', '.epub']),
  archive: new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso']),
  image: new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tif', '.tiff', '.ico', '.avif']),
  audio: new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma']),
  video: new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.wmv', '.m4v', '.ts', '.m3u8', '.mpd']),
  software: new Set(['.exe', '.msi', '.apk', '.dmg', '.pkg', '.deb', '.rpm', '.appx', '.msix']),
  font: new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot']),
  other: new Set(['.json', '.xml', '.css', '.js', '.wasm', '.bin', '.dat']),
};

export const DEFAULT_SITE_EXTENSIONS = Array.from(
  new Set(Object.values(KIND_EXTENSIONS).flatMap((extensions) => Array.from(extensions))),
).sort();

function normalizeExtension(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

export function extensionOf(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const filename = pathname.split('/').at(-1) ?? '';
    const index = filename.lastIndexOf('.');
    if (index <= 0 || index === filename.length - 1) return '';
    return filename.slice(index);
  } catch {
    return '';
  }
}

export function filenameOf(url: string): string {
  try {
    const parsed = new URL(url);
    const filename = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? 'download');
    return filename || 'download';
  } catch {
    return 'download';
  }
}

export function kindOfExtension(extension: string): SiteResourceKind {
  const normalized = normalizeExtension(extension);
  for (const [kind, extensions] of Object.entries(KIND_EXTENSIONS) as Array<[SiteResourceKind, Set<string>]>) {
    if (extensions.has(normalized)) return kind;
  }
  return 'other';
}

function resolveCandidate(candidate: string, pageUrl: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(?:javascript|data|mailto|tel|blob):/iu.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, pageUrl);
    if (!['http:', 'https:', 'ftp:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function extractPageLinks(html: string, pageUrl: string): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const collect = (candidate: string | undefined): void => {
    if (!candidate) return;
    const resolved = resolveCandidate(candidate, pageUrl);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    output.push(resolved);
  };

  for (const match of html.matchAll(ATTRIBUTE_URL)) collect(match[1] ?? match[2] ?? match[3]);
  for (const match of html.matchAll(CSS_URL)) collect(match[1] ?? match[2] ?? match[3]);
  return output;
}

export function isHtmlContentType(contentType: string | null): boolean {
  return Boolean(contentType && /(?:text\/html|application\/xhtml\+xml)/iu.test(contentType));
}

export function normalizeSiteExtensions(values: string[] | undefined): string[] {
  const input = values && values.length > 0 ? values : DEFAULT_SITE_EXTENSIONS;
  return Array.from(new Set(input.map(normalizeExtension).filter(Boolean))).sort();
}

export function hostAllowed(rootUrl: URL, candidate: URL, sameHostOnly: boolean, includeSubdomains: boolean): boolean {
  if (!sameHostOnly) return true;
  if (candidate.hostname === rootUrl.hostname) return true;
  return includeSubdomains && candidate.hostname.endsWith(`.${rootUrl.hostname}`);
}

export function matchesExcludedPattern(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed) return false;
    try {
      return new RegExp(trimmed, 'iu').test(url);
    } catch {
      return url.toLowerCase().includes(trimmed.toLowerCase());
    }
  });
}

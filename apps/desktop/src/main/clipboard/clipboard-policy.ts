import type { ClipboardSettings } from '@subutai/shared';

export const DEFAULT_CLIPBOARD_SETTINGS: ClipboardSettings = {
  enabled: false,
  autoEnqueue: false,
  captureMultipleUrls: true,
  cooldownMs: 10_000,
  maxHistory: 50,
  ignoredHosts: [],
  ignoredExtensions: [],
};

const URL_PATTERN = /(?:https?|ftp|sftp):\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = /[),.;!?\]}]+$/u;

function normalizeExtension(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

export function normalizeClipboardSettings(current: ClipboardSettings, update: Partial<ClipboardSettings>): ClipboardSettings {
  return {
    enabled: update.enabled ?? current.enabled,
    autoEnqueue: update.autoEnqueue ?? current.autoEnqueue,
    captureMultipleUrls: update.captureMultipleUrls ?? current.captureMultipleUrls,
    cooldownMs: Math.max(1_000, Math.min(300_000, Math.trunc(update.cooldownMs ?? current.cooldownMs))),
    maxHistory: Math.max(1, Math.min(500, Math.trunc(update.maxHistory ?? current.maxHistory))),
    ignoredHosts: Array.from(new Set((update.ignoredHosts ?? current.ignoredHosts).map((host) => host.trim().toLowerCase()).filter(Boolean))),
    ignoredExtensions: Array.from(new Set((update.ignoredExtensions ?? current.ignoredExtensions).map(normalizeExtension).filter(Boolean))),
  };
}

export function extractClipboardUrls(text: string, settings: ClipboardSettings): string[] {
  const matches = text.match(URL_PATTERN) ?? [];
  const output: string[] = [];
  const seen = new Set<string>();

  for (const raw of matches) {
    const candidate = raw.replace(TRAILING_PUNCTUATION, '');
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    const host = parsed.hostname.toLowerCase();
    if (settings.ignoredHosts.some((ignored) => host === ignored || host.endsWith(`.${ignored}`))) continue;
    const path = parsed.pathname.toLowerCase();
    if (settings.ignoredExtensions.some((extension) => path.endsWith(extension))) continue;
    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (!settings.captureMultipleUrls) break;
  }
  return output;
}

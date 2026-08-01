import type { TransferSettings, TransferSettingsUpdate } from '@subutai/shared';

export const DEFAULT_TRANSFER_SETTINGS: TransferSettings = {
  globalSpeedLimitBytesPerSecond: 0,
  defaultDownloadSpeedLimitBytesPerSecond: 0,
  proxyMode: 'off',
  proxyUrl: '',
  proxyUsername: '',
  proxyPasswordSet: false,
  retryMaxAttempts: 10,
  retryBaseDelaySeconds: 2,
  connectTimeoutSeconds: 20,
  transferTimeoutSeconds: 60,
};

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function normalizeTransferSettings(
  current: TransferSettings,
  update: TransferSettingsUpdate,
  proxyPasswordSet: boolean,
): TransferSettings {
  return {
    globalSpeedLimitBytesPerSecond: boundedInteger(
      update.globalSpeedLimitBytesPerSecond,
      current.globalSpeedLimitBytesPerSecond,
      0,
      10_000_000_000,
    ),
    defaultDownloadSpeedLimitBytesPerSecond: boundedInteger(
      update.defaultDownloadSpeedLimitBytesPerSecond,
      current.defaultDownloadSpeedLimitBytesPerSecond,
      0,
      10_000_000_000,
    ),
    proxyMode: update.proxyMode ?? current.proxyMode,
    proxyUrl: (update.proxyUrl ?? current.proxyUrl).trim(),
    proxyUsername: (update.proxyUsername ?? current.proxyUsername).trim(),
    proxyPasswordSet,
    retryMaxAttempts: boundedInteger(update.retryMaxAttempts, current.retryMaxAttempts, 1, 100),
    retryBaseDelaySeconds: boundedInteger(update.retryBaseDelaySeconds, current.retryBaseDelaySeconds, 0, 300),
    connectTimeoutSeconds: boundedInteger(update.connectTimeoutSeconds, current.connectTimeoutSeconds, 1, 600),
    transferTimeoutSeconds: boundedInteger(update.transferTimeoutSeconds, current.transferTimeoutSeconds, 1, 3_600),
  };
}

export function resolveProxyUrl(settings: TransferSettings, password: string): string | null {
  if (settings.proxyMode !== 'manual' || !settings.proxyUrl.trim()) return null;
  let input = settings.proxyUrl.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) input = `http://${input}`;
  try {
    const url = new URL(input);
    if (settings.proxyUsername) url.username = settings.proxyUsername;
    if (password) url.password = password;
    return url.toString();
  } catch {
    throw new Error('Proxy URL буруу байна.');
  }
}

export function ariaSpeed(value: number): string {
  return value > 0 ? String(Math.trunc(value)) : '0';
}

export function ytDlpSpeed(value: number): string | null {
  return value > 0 ? String(Math.trunc(value)) : null;
}

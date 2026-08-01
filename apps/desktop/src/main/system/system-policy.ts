import type { DownloadJob, SystemSettings } from '@subutai/shared';

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  trayEnabled: true,
  minimizeToTray: true,
  closeToTray: true,
  notificationsEnabled: true,
  notifyOnComplete: true,
  notifyOnFailure: true,
  launchAtLogin: false,
  automaticUpdateChecks: true,
  automaticUpdateDownloads: false,
};

export function normalizeSystemSettings(
  current: SystemSettings,
  update: Partial<SystemSettings>,
): SystemSettings {
  return {
    trayEnabled: update.trayEnabled ?? current.trayEnabled,
    minimizeToTray: update.minimizeToTray ?? current.minimizeToTray,
    closeToTray: update.closeToTray ?? current.closeToTray,
    notificationsEnabled: update.notificationsEnabled ?? current.notificationsEnabled,
    notifyOnComplete: update.notifyOnComplete ?? current.notifyOnComplete,
    notifyOnFailure: update.notifyOnFailure ?? current.notifyOnFailure,
    launchAtLogin: update.launchAtLogin ?? current.launchAtLogin,
    automaticUpdateChecks: update.automaticUpdateChecks ?? current.automaticUpdateChecks,
    automaticUpdateDownloads: update.automaticUpdateDownloads ?? current.automaticUpdateDownloads,
  };
}

export type DownloadNotificationKind = 'completed' | 'failed';

export interface DownloadNotificationEvent {
  kind: DownloadNotificationKind;
  job: DownloadJob;
}

export function downloadNotificationTransitions(
  previous: ReadonlyMap<string, DownloadJob>,
  current: Iterable<DownloadJob>,
  settings: SystemSettings,
): DownloadNotificationEvent[] {
  if (!settings.notificationsEnabled) return [];
  const events: DownloadNotificationEvent[] = [];

  for (const job of current) {
    const before = previous.get(job.id);
    if (!before || before.status === job.status) continue;
    if (job.status === 'completed' && settings.notifyOnComplete) {
      events.push({ kind: 'completed', job });
    } else if (job.status === 'failed' && settings.notifyOnFailure) {
      events.push({ kind: 'failed', job });
    }
  }
  return events;
}

export function downloadCountSummary(jobs: Iterable<DownloadJob>): {
  active: number;
  queued: number;
  failed: number;
  completed: number;
} {
  let active = 0;
  let queued = 0;
  let failed = 0;
  let completed = 0;
  for (const job of jobs) {
    if (['resolving', 'downloading', 'merging'].includes(job.status)) active += 1;
    else if (job.status === 'queued') queued += 1;
    else if (job.status === 'failed') failed += 1;
    else if (job.status === 'completed') completed += 1;
  }
  return { active, queued, failed, completed };
}

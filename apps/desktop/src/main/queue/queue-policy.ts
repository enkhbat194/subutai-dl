import type { DownloadJob, DownloadSchedule, QueuePriority, QueueSettings } from '@subutai/shared';

const PRIORITY_WEIGHT: Record<QueuePriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

function parseTime(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return 0;
  const hour = Math.max(0, Math.min(23, Number(match[1])));
  const minute = Math.max(0, Math.min(59, Number(match[2])));
  return hour * 60 + minute;
}

function localMinute(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function isScheduleActive(schedule: DownloadSchedule, date: Date): boolean {
  if (!schedule.enabled || schedule.days.length === 0) return false;
  const currentMinute = localMinute(date);
  const start = parseTime(schedule.startTime);
  const end = parseTime(schedule.endTime);
  const currentDay = date.getDay();

  if (start === end) return schedule.days.includes(currentDay);
  if (start < end) {
    return schedule.days.includes(currentDay) && currentMinute >= start && currentMinute < end;
  }

  if (currentMinute >= start) return schedule.days.includes(currentDay);
  const previousDay = (currentDay + 6) % 7;
  return currentMinute < end && schedule.days.includes(previousDay);
}

export function activeSchedules(schedules: DownloadSchedule[], date: Date): DownloadSchedule[] {
  return schedules.filter((schedule) => isScheduleActive(schedule, date));
}

export function queueAllowance(settings: QueueSettings, schedules: DownloadSchedule[], date: Date): {
  allowed: boolean;
  maxConcurrent: number;
  activeScheduleIds: string[];
} {
  const baseLimit = Math.max(1, Math.min(32, Math.trunc(settings.maxConcurrentDownloads)));
  if (!settings.schedulingEnabled) {
    return { allowed: true, maxConcurrent: baseLimit, activeScheduleIds: [] };
  }

  const enabled = schedules.filter((schedule) => schedule.enabled);
  if (enabled.length === 0) {
    return { allowed: true, maxConcurrent: baseLimit, activeScheduleIds: [] };
  }

  const active = activeSchedules(enabled, date);
  if (active.length === 0) {
    return {
      allowed: !settings.pauseOutsideSchedule,
      maxConcurrent: baseLimit,
      activeScheduleIds: [],
    };
  }

  const scheduleLimits = active
    .map((schedule) => schedule.maxConcurrentDownloads)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  const scheduledLimit = scheduleLimits.length > 0 ? Math.min(...scheduleLimits) : baseLimit;
  return {
    allowed: true,
    maxConcurrent: Math.max(1, Math.min(baseLimit, Math.trunc(scheduledLimit))),
    activeScheduleIds: active.map((schedule) => schedule.id),
  };
}

export function sortQueuedJobs(jobs: Iterable<DownloadJob>): DownloadJob[] {
  return Array.from(jobs)
    .filter((job) => job.status === 'queued')
    .sort((a, b) => {
      const priorityA = PRIORITY_WEIGHT[a.priority ?? 'normal'];
      const priorityB = PRIORITY_WEIGHT[b.priority ?? 'normal'];
      if (priorityA !== priorityB) return priorityA - priorityB;
      const orderA = a.queueOrder ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.queueOrder ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.createdAt.localeCompare(b.createdAt);
    });
}

export function isRunningStatus(status: DownloadJob['status']): boolean {
  return status === 'resolving' || status === 'downloading' || status === 'merging';
}

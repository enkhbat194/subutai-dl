import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type {
  DownloadJob,
  DownloadScheduleInput,
  QueuePriority,
  QueueSnapshot,
} from '@subutai/shared';

const DAY_LABELS = ['Ня', 'Да', 'Мя', 'Лх', 'Пү', 'Ба', 'Бя'];

function priorityLabel(priority: QueuePriority | undefined): string {
  if (priority === 'high') return 'Өндөр';
  if (priority === 'low') return 'Бага';
  return 'Энгийн';
}

function QueueSchedulerDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [downloads, setDownloads] = useState<DownloadJob[]>([]);
  const [name, setName] = useState('Шөнийн таталт');
  const [startTime, setStartTime] = useState('22:00');
  const [endTime, setEndTime] = useState('06:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6, 0]);
  const [scheduleLimit, setScheduleLimit] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void window.subutai.getQueueSnapshot().then((value) => { if (active) setSnapshot(value); });
    void window.subutai.listDownloads().then((value) => { if (active) setDownloads(value); });
    const offQueue = window.subutai.onQueueChanged((value) => { if (active) setSnapshot(value); });
    const offDownloads = window.subutai.onDownloadsChanged((value) => { if (active) setDownloads(value); });
    return () => {
      active = false;
      offQueue();
      offDownloads();
    };
  }, []);

  const queued = useMemo(() => downloads
    .filter((job) => job.status === 'queued' || job.status === 'paused')
    .sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0)), [downloads]);

  const run = async (work: () => Promise<QueueSnapshot>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setSnapshot(await work());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const toggleDay = (day: number): void => {
    setDays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort());
  };

  const addSchedule = async (): Promise<void> => {
    const input: DownloadScheduleInput = {
      name,
      enabled: true,
      days,
      startTime,
      endTime,
      maxConcurrentDownloads: scheduleLimit,
    };
    await run(() => window.subutai.saveSchedule(input));
  };

  const changePriority = async (job: DownloadJob, priority: QueuePriority): Promise<void> => {
    setError('');
    try {
      await window.subutai.setDownloadPriority(job.id, priority);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const move = async (job: DownloadJob, direction: 'up' | 'down' | 'top' | 'bottom'): Promise<void> => {
    setError('');
    try {
      setDownloads(await window.subutai.moveDownload(job.id, direction));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div className="queue-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="queue-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="queue-modal-header">
          <div><span>SUBUTAI QUEUE</span><h2>Дараалал ба төлөвлөлт</h2></div>
          <button onClick={onClose}>×</button>
        </header>

        {snapshot ? (
          <>
            <div className="queue-status-grid">
              <article><span>Ажиллаж буй</span><strong>{snapshot.runningCount}</strong></article>
              <article><span>Хүлээгдэж буй</span><strong>{snapshot.queuedCount}</strong></article>
              <article><span>Түр зогссон</span><strong>{snapshot.pausedCount}</strong></article>
              <article className={snapshot.allowedNow ? 'queue-allowed' : 'queue-blocked'}><span>Хуваарь</span><strong>{snapshot.allowedNow ? 'Нээлттэй' : 'Хаалттай'}</strong></article>
            </div>

            <section className="queue-settings-card">
              <h3>Queue тохиргоо</h3>
              <label>Зэрэг ажиллах таталт<select value={snapshot.settings.maxConcurrentDownloads} onChange={(event) => void run(() => window.subutai.updateQueueSettings({ maxConcurrentDownloads: Number(event.target.value) }))}>{[1, 2, 3, 4, 5, 8].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              <label className="queue-check"><input type="checkbox" checked={snapshot.settings.schedulingEnabled} onChange={(event) => void run(() => window.subutai.updateQueueSettings({ schedulingEnabled: event.target.checked }))} />Хуваарийн горим ашиглах</label>
              <label className="queue-check"><input type="checkbox" checked={snapshot.settings.pauseOutsideSchedule} onChange={(event) => void run(() => window.subutai.updateQueueSettings({ pauseOutsideSchedule: event.target.checked }))} />Хуваариас гадуур идэвхтэй таталтыг түр зогсоох</label>
              <button className="queue-run-now" disabled={busy} onClick={() => void run(() => window.subutai.runQueueNow())}>Одоо queue ажиллуулах</button>
            </section>

            <section className="queue-list-card">
              <div className="queue-card-heading"><h3>Таталтын дараалал</h3><span>{queued.length} даалгавар</span></div>
              <div className="queue-job-list">
                {queued.length === 0 ? <div className="queue-empty">Хүлээгдэж буй таталт алга.</div> : queued.map((job, index) => (
                  <article key={job.id} className="queue-job-row">
                    <span className="queue-position">{index + 1}</span>
                    <div className="queue-job-name"><strong>{job.filename}</strong><small>{job.status === 'paused' ? 'Түр зогссон' : 'Хүлээж байна'} · {priorityLabel(job.priority)}</small></div>
                    <select value={job.priority ?? 'normal'} onChange={(event) => void changePriority(job, event.target.value as QueuePriority)}><option value="high">Өндөр</option><option value="normal">Энгийн</option><option value="low">Бага</option></select>
                    <div className="queue-move-buttons"><button title="Дээш" onClick={() => void move(job, 'up')}>↑</button><button title="Доош" onClick={() => void move(job, 'down')}>↓</button><button title="Эхэнд" onClick={() => void move(job, 'top')}>⇈</button><button title="Төгсгөлд" onClick={() => void move(job, 'bottom')}>⇊</button></div>
                  </article>
                ))}
              </div>
            </section>

            <section className="schedule-card">
              <div className="queue-card-heading"><h3>Хуваарь</h3><span>{snapshot.schedules.length}</span></div>
              <div className="schedule-form-grid">
                <label>Нэр<input value={name} onChange={(event) => setName(event.target.value)} /></label>
                <label>Эхлэх<input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></label>
                <label>Дуусах<input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></label>
                <label>Зэрэг таталт<select value={scheduleLimit} onChange={(event) => setScheduleLimit(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              </div>
              <div className="schedule-days">{DAY_LABELS.map((label, day) => <button key={label} className={days.includes(day) ? 'active' : ''} onClick={() => toggleDay(day)}>{label}</button>)}</div>
              <button className="schedule-add" disabled={busy || days.length === 0 || !name.trim()} onClick={() => void addSchedule()}>＋ Хуваарь нэмэх</button>

              <div className="schedule-list-real">
                {snapshot.schedules.map((schedule) => (
                  <article key={schedule.id} className={snapshot.activeScheduleIds.includes(schedule.id) ? 'active' : ''}>
                    <div><strong>{schedule.name}</strong><span>{schedule.startTime}–{schedule.endTime} · {schedule.days.map((day) => DAY_LABELS[day]).join(', ')}</span></div>
                    <label className="schedule-toggle"><input type="checkbox" checked={schedule.enabled} onChange={(event) => void run(() => window.subutai.saveSchedule({ ...schedule, enabled: event.target.checked }))} />{schedule.enabled ? 'Идэвхтэй' : 'Унтраалттай'}</label>
                    <button className="schedule-delete" onClick={() => void run(() => window.subutai.deleteSchedule(schedule.id))}>Устгах</button>
                  </article>
                ))}
              </div>
            </section>
          </>
        ) : <div className="queue-loading">Queue төлөв ачаалж байна…</div>}

        {error ? <div className="queue-error">{error}</div> : null}
      </section>
    </div>
  );
}

export function QueueSchedulerLauncher(): ReactElement {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    void window.subutai.getQueueSnapshot().then((value) => { if (active) setSnapshot(value); });
    const off = window.subutai.onQueueChanged((value) => { if (active) setSnapshot(value); });
    return () => { active = false; off(); };
  }, []);

  return (
    <>
      <button className="queue-launch-button" onClick={() => setOpen(true)}><span>◷</span><b>Queue</b><em>{snapshot?.queuedCount ?? 0}</em></button>
      {open ? <QueueSchedulerDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

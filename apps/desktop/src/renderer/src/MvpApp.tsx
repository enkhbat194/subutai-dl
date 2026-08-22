import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type {
  DownloadCreateRequest,
  DownloadJob,
  DownloadStatus,
  EngineHealth,
  MediaAudioFormat,
  MediaQuality,
} from '@subutai/shared';

const MEDIA_HOSTS = [
  'youtube.com',
  'youtu.be',
  'facebook.com',
  'fb.watch',
  'instagram.com',
  'tiktok.com',
  'vimeo.com',
  'dailymotion.com',
  'twitch.tv',
  'soundcloud.com',
  'twitter.com',
  'x.com',
  'reddit.com',
];

type Filter = 'all' | 'active' | 'completed' | 'failed';

function isMediaUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase();
    if (MEDIA_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) return true;
    const path = parsed.pathname.toLowerCase();
    return path.endsWith('.m3u8') || path.endsWith('.mpd');
  } catch {
    return false;
  }
}

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function progressOf(job: DownloadJob): number {
  if (job.status === 'completed') return 100;
  if (!job.totalBytes || job.totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((job.downloadedBytes / job.totalBytes) * 100)));
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatSpeed(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '—';
}

function formatEta(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '—';
  if (seconds < 60) return `${seconds} сек`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  return `${Math.floor(minutes / 60)} ц ${minutes % 60} мин`;
}

function statusLabel(status: DownloadStatus): string {
  const labels: Record<DownloadStatus, string> = {
    queued: 'Хүлээж байна',
    resolving: 'Мэдээлэл авч байна',
    downloading: 'Татаж байна',
    paused: 'Түр зогссон',
    merging: 'Нэгтгэж байна',
    completed: 'Дууссан',
    failed: 'Алдаа',
    cancelled: 'Цуцлагдсан',
  };
  return labels[status];
}

function canPause(job: DownloadJob): boolean {
  return job.status === 'downloading' || job.status === 'resolving' || job.status === 'merging';
}

function canResume(job: DownloadJob): boolean {
  return job.status === 'paused' || job.status === 'failed' || job.status === 'queued';
}

export function MvpApp(): ReactElement {
  const [downloads, setDownloads] = useState<DownloadJob[]>([]);
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [url, setUrl] = useState('');
  const [destination, setDestination] = useState('');
  const [filename, setFilename] = useState('');
  const [mediaMode, setMediaMode] = useState<'video' | 'audio'>('video');
  const [quality, setQuality] = useState<MediaQuality>('1080p');
  const [audioFormat, setAudioFormat] = useState<MediaAudioFormat>('mp3');
  const [connections, setConnections] = useState(16);
  const [filter, setFilter] = useState<Filter>('all');
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const accept = (jobs: DownloadJob[]): void => {
      if (active) setDownloads(jobs);
    };
    void window.subutai.listDownloads().then(accept).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    });
    const unsubscribe = window.subutai.onDownloadsChanged(accept);
    const refreshHealth = (): void => {
      void window.subutai.getEngineHealth().then((next) => {
        if (active) setHealth(next);
      }).catch(() => undefined);
    };
    refreshHealth();
    const timer = window.setInterval(refreshHealth, 3000);
    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, []);

  const mediaDetected = isMediaUrl(url);
  const validUrl = isValidUrl(url);
  const activeCount = downloads.filter((job) => ['queued', 'resolving', 'downloading', 'merging'].includes(job.status)).length;
  const completedCount = downloads.filter((job) => job.status === 'completed').length;
  const failedCount = downloads.filter((job) => job.status === 'failed').length;
  const totalSpeed = downloads.reduce((sum, job) => sum + job.speedBytesPerSecond, 0);

  const visibleDownloads = useMemo(() => {
    if (filter === 'active') return downloads.filter((job) => ['queued', 'resolving', 'downloading', 'paused', 'merging'].includes(job.status));
    if (filter === 'completed') return downloads.filter((job) => job.status === 'completed');
    if (filter === 'failed') return downloads.filter((job) => job.status === 'failed');
    return downloads;
  }, [downloads, filter]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!validUrl || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const request: DownloadCreateRequest = {
        url: url.trim(),
        destination: destination.trim(),
        engine: 'auto',
        source: 'desktop',
        connections: mediaDetected ? 1 : connections,
      };
      if (filename.trim()) request.filename = filename.trim();
      if (mediaDetected) {
        request.media = {
          mode: mediaMode,
          playlist: false,
          subtitles: false,
          embedMetadata: true,
          embedThumbnail: mediaMode === 'audio',
        };
        if (mediaMode === 'video') request.media.quality = quality;
        else request.media.audioFormat = audioFormat;
      }
      await window.subutai.createDownload(request);
      setUrl('');
      setFilename('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const runAction = async (job: DownloadJob, action: 'pause' | 'resume' | 'cancel' | 'folder' | 'remove'): Promise<void> => {
    if (busyId) return;
    setBusyId(job.id);
    setError('');
    try {
      if (action === 'pause') await window.subutai.pauseDownload(job.id);
      if (action === 'resume') await window.subutai.resumeDownload(job.id);
      if (action === 'cancel') await window.subutai.cancelDownload(job.id);
      if (action === 'folder') await window.subutai.openDownloadFolder(job.id);
      if (action === 'remove') await window.subutai.removeDownload(job.id, false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId('');
    }
  };

  const clearFailed = async (): Promise<void> => {
    if (busyId) return;
    setBusyId('clear-failed');
    setError('');
    try {
      for (const job of downloads.filter((item) => item.status === 'failed' || item.status === 'cancelled')) {
        await window.subutai.removeDownload(job.id, false);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId('');
    }
  };

  const engineAvailable = Boolean(health?.subutai.available);
  const mediaAvailable = Boolean(health?.subutai.mediaAvailable);

  return (
    <div className="mvp-shell">
      <header className="mvp-titlebar">
        <div className="mvp-brand">
          <div className="mvp-mark">♞</div>
          <div><strong>SUBUTAI</strong><span>Download Manager · 0.2.0-rc.2</span></div>
        </div>
        <div className={`mvp-health ${engineAvailable ? 'ready' : 'waiting'}`}>
          <span />{engineAvailable ? 'Таталтын хөдөлгүүр бэлэн' : 'Хөдөлгүүр шалгаж байна'}
        </div>
        <div className="mvp-window-controls">
          <button type="button" onClick={() => void window.subutai.minimizeWindow()} aria-label="Жижигрүүлэх">—</button>
          <button type="button" onClick={() => void window.subutai.toggleMaximizeWindow()} aria-label="Томруулах">□</button>
          <button type="button" className="close" onClick={() => void window.subutai.closeWindow()} aria-label="Хаах">×</button>
        </div>
      </header>

      <main className="mvp-main">
        <section className="mvp-hero">
          <div className="mvp-hero-copy">
            <span className="mvp-eyebrow">НЭГ LINK · НЭГ ҮЙЛДЭЛ</span>
            <h1>Татах холбоосоо оруул</h1>
            <p>YouTube болон бусад media холбоосыг автоматаар танина. Шууд файлыг олон хэсгээр татна.</p>
          </div>

          <form className="mvp-download-form" onSubmit={(event) => void submit(event)}>
            <div className={`mvp-url-box ${url && !validUrl ? 'invalid' : ''}`}>
              <span className="mvp-link-icon">↗</span>
              <input
                value={url}
                onChange={(event) => { setUrl(event.target.value); setError(''); }}
                placeholder="YouTube link эсвэл https://example.com/file.zip"
                autoFocus
              />
              {url ? <button type="button" className="mvp-clear-url" onClick={() => setUrl('')} aria-label="URL арилгах">×</button> : null}
            </div>

            <div className="mvp-detection-row">
              <div className={`mvp-detected-kind ${mediaDetected ? 'media' : 'direct'}`}>
                <span>{mediaDetected ? '▶' : '⇩'}</span>
                <div><b>{mediaDetected ? 'Видео / аудио гэж танилаа' : 'Шууд файл таталт'}</b><small>{mediaDetected ? 'Subutai Media автоматаар ашиглана' : 'Subutai олон хэсэгт хөдөлгүүр ашиглана'}</small></div>
              </div>
              {mediaDetected && !mediaAvailable ? <div className="mvp-inline-warning">Media хөдөлгүүр одоогоор бэлэн биш байна.</div> : null}
            </div>

            <div className="mvp-options">
              {mediaDetected ? (
                <>
                  <div className="mvp-segmented-control" role="group" aria-label="Media төрөл">
                    <button type="button" className={mediaMode === 'video' ? 'active' : ''} onClick={() => setMediaMode('video')}>Видео</button>
                    <button type="button" className={mediaMode === 'audio' ? 'active' : ''} onClick={() => setMediaMode('audio')}>Зөвхөн аудио</button>
                  </div>
                  {mediaMode === 'video' ? (
                    <label>Чанар<select value={quality} onChange={(event) => setQuality(event.target.value as MediaQuality)}><option value="best">Хамгийн сайн</option><option value="2160p">4K · 2160p</option><option value="1440p">2K · 1440p</option><option value="1080p">Full HD · 1080p</option><option value="720p">HD · 720p</option><option value="480p">480p</option></select></label>
                  ) : (
                    <label>Формат<select value={audioFormat} onChange={(event) => setAudioFormat(event.target.value as MediaAudioFormat)}><option value="mp3">MP3</option><option value="m4a">M4A</option><option value="opus">Opus</option><option value="flac">FLAC</option><option value="wav">WAV</option></select></label>
                  )}
                </>
              ) : (
                <label>Хэсгийн тоо<select value={connections} onChange={(event) => setConnections(Number(event.target.value))}><option value={4}>4</option><option value={8}>8</option><option value={16}>16</option><option value={32}>32</option></select></label>
              )}
              <label className="mvp-grow">Хадгалах хавтас<input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Хоосон бол Downloads" /></label>
              <label className="mvp-grow">Файлын нэр <small>(заавал биш)</small><input value={filename} onChange={(event) => setFilename(event.target.value)} placeholder="Автоматаар нэрлэнэ" /></label>
            </div>

            {url && !validUrl ? <div className="mvp-form-hint error">Зөв `http://` эсвэл `https://` холбоос оруулна уу.</div> : null}
            {error ? <div className="mvp-global-error">{error}</div> : null}

            <button className="mvp-primary-action" type="submit" disabled={!validUrl || submitting || (mediaDetected && !mediaAvailable)}>
              <span>{submitting ? '…' : '⇩'}</span>
              {submitting ? 'Таталтыг бэлтгэж байна' : mediaDetected ? `${mediaMode === 'video' ? 'Видео' : 'Аудио'} татаж эхлэх` : 'Файл татаж эхлэх'}
            </button>
          </form>
        </section>

        <section className="mvp-downloads-section">
          <div className="mvp-section-header">
            <div><span className="mvp-eyebrow">ТАТАЛТУУД</span><h2>Явц</h2></div>
            <div className="mvp-summary"><span><b>{activeCount}</b> идэвхтэй</span><span><b>{completedCount}</b> дууссан</span><span><b>{formatSpeed(totalSpeed)}</b></span></div>
          </div>

          <div className="mvp-filterbar">
            <div className="mvp-filters">
              <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Бүгд <span>{downloads.length}</span></button>
              <button type="button" className={filter === 'active' ? 'active' : ''} onClick={() => setFilter('active')}>Идэвхтэй <span>{activeCount}</span></button>
              <button type="button" className={filter === 'completed' ? 'active' : ''} onClick={() => setFilter('completed')}>Дууссан <span>{completedCount}</span></button>
              <button type="button" className={filter === 'failed' ? 'active' : ''} onClick={() => setFilter('failed')}>Алдаа <span>{failedCount}</span></button>
            </div>
            {failedCount > 0 ? <button type="button" className="mvp-text-action" disabled={Boolean(busyId)} onClick={() => void clearFailed()}>Алдаатайг цэвэрлэх</button> : null}
          </div>

          <div className="mvp-download-list">
            {visibleDownloads.length === 0 ? (
              <div className="mvp-empty-state"><div>⇩</div><b>{downloads.length === 0 ? 'Одоогоор таталт алга' : 'Энэ ангилалд таталт алга'}</b><span>Дээр холбоосоо оруулаад “Татаж эхлэх” дарна.</span></div>
            ) : visibleDownloads.map((job) => {
              const progress = progressOf(job);
              const busy = busyId === job.id;
              return (
                <article className={`mvp-download-card status-${job.status}`} key={job.id}>
                  <div className="mvp-file-icon">{job.engine === 'media' ? '▶' : '⇩'}</div>
                  <div className="mvp-download-body">
                    <div className="mvp-download-title-row"><div><h3>{job.filename}</h3><span>{job.engine === 'media' ? 'Видео / аудио' : 'Шууд файл'} · {statusLabel(job.status)}</span></div><strong>{progress}%</strong></div>
                    <div className="mvp-progress"><span style={{ width: `${progress}%` }} /></div>
                    <div className="mvp-download-meta"><span>{formatBytes(job.downloadedBytes)} / {formatBytes(job.totalBytes)}</span><span>Хурд: {formatSpeed(job.speedBytesPerSecond)}</span><span>Үлдсэн: {formatEta(job.etaSeconds)}</span></div>
                    {job.error ? <div className="mvp-job-error"><b>Таталт амжилтгүй:</b> {job.error}</div> : null}
                  </div>
                  <div className="mvp-card-actions">
                    {canPause(job) ? <button type="button" disabled={busy} onClick={() => void runAction(job, 'pause')} title="Түр зогсоох">Ⅱ</button> : null}
                    {canResume(job) ? <button type="button" disabled={busy} onClick={() => void runAction(job, 'resume')} title={job.status === 'failed' ? 'Дахин оролдох' : 'Үргэлжлүүлэх'}>↻</button> : null}
                    {!['completed', 'cancelled', 'failed'].includes(job.status) ? <button type="button" disabled={busy} onClick={() => void runAction(job, 'cancel')} title="Цуцлах">■</button> : null}
                    <button type="button" disabled={busy} onClick={() => void runAction(job, 'folder')} title="Хавтас нээх">▱</button>
                    <button type="button" disabled={busy} onClick={() => void runAction(job, 'remove')} title="Жагсаалтаас устгах">×</button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}

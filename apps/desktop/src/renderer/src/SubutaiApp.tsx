import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import type { DownloadCreateRequest, DownloadJob, DownloadStatus, EngineHealth } from '@subutai/shared';

type DownloadKind = 'iso' | 'video' | 'document' | 'archive' | 'audio' | 'app';

interface PanelProps {
  title?: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}

const navItems = [
  ['⇩', 'Таталтууд'],
  ['◌', 'Түр зогсоосон'],
  ['✓', 'Дууссан'],
  ['◷', 'Төлөвлөлт'],
  ['□', 'Категори'],
  ['◎', 'Түгээмэл сайт'],
  ['⚙', 'Тохиргоо'],
] as const;

const sites = [
  ['YT', 'YouTube', 'site-red'],
  ['f', 'Facebook', 'site-blue'],
  ['v', 'Vimeo', 'site-cyan'],
  ['◎', 'Instagram', 'site-pink'],
  ['♪', 'TikTok', 'site-dark'],
  ['▥', 'SoundCloud', 'site-orange'],
  ['▣', 'Twitch', 'site-purple'],
] as const;

function Panel({ title, children, className, action }: PanelProps): ReactElement {
  return (
    <section className={`panel${className ? ` ${className}` : ''}`}>
      {title ? <div className="panel-heading"><h2>{title}</h2>{action}</div> : null}
      {children}
    </section>
  );
}

function kindFromFilename(filename: string): DownloadKind {
  const extension = filename.split('.').at(-1)?.toLowerCase();
  if (extension === 'iso') return 'iso';
  if (['mp4', 'mkv', 'webm', 'mov', 'avi'].includes(extension ?? '')) return 'video';
  if (['pdf', 'doc', 'docx', 'txt', 'xls', 'xlsx', 'ppt', 'pptx'].includes(extension ?? '')) return 'document';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension ?? '')) return 'archive';
  if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'].includes(extension ?? '')) return 'audio';
  return 'app';
}

function FileGlyph({ filename }: { filename: string }): ReactElement {
  const kind = kindFromFilename(filename);
  const glyphs: Record<DownloadKind, string> = {
    iso: '△',
    video: '▶',
    document: '▤',
    archive: '▥',
    audio: '♫',
    app: '◆',
  };
  return <span className={`file-glyph file-${kind}`}>{glyphs[kind]}</span>;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return 'Тодорхойгүй';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[unit]}`;
}

function formatSpeed(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '—';
}

function formatEta(seconds: number | null, status: DownloadStatus): string {
  if (status === 'completed') return 'Дууссан';
  if (status === 'paused') return 'Түр зогссон';
  if (status === 'failed') return 'Алдаа';
  if (status === 'cancelled') return 'Цуцлагдсан';
  if (seconds === null || seconds < 0) return status === 'resolving' ? 'Шалгаж байна…' : 'Тооцож байна…';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function progressOf(job: DownloadJob): number {
  if (!job.totalBytes || job.totalBytes <= 0) return job.status === 'completed' ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((job.downloadedBytes / job.totalBytes) * 100)));
}

function statusLabel(status: DownloadStatus): string {
  const labels: Record<DownloadStatus, string> = {
    queued: 'Хүлээгдэж байна',
    resolving: 'Шалгаж байна',
    downloading: 'Татагдаж байна',
    paused: 'Түр зогссон',
    merging: 'Нэгтгэж байна',
    completed: 'Дууссан',
    failed: 'Алдаа',
    cancelled: 'Цуцлагдсан',
  };
  return labels[status];
}

function ProgressBar({ job }: { job: DownloadJob }): ReactElement {
  const progress = progressOf(job);
  return <div className="progress-track" aria-label={`${progress}%`}><span className={job.status === 'completed' ? 'progress-value progress-complete' : 'progress-value'} style={{ width: `${progress}%` }} /></div>;
}

function NewDownloadDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (job: DownloadJob) => void }): ReactElement {
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [destination, setDestination] = useState('');
  const [connections, setConnections] = useState(16);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const request: DownloadCreateRequest = {
        url: url.trim(),
        destination: destination.trim(),
        engine: 'subutai',
        connections,
      };
      if (filename.trim()) request.filename = filename.trim();
      const created = await window.subutai.createDownload(request);
      onCreated(created);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="new-download-modal" onSubmit={(event) => void submit(event)} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title-row"><div><span className="eyebrow">SUBUTAI ТАТАЛТ</span><h2>Шинэ таталт нэмэх</h2></div><button type="button" className="icon-button" onClick={onClose}>×</button></div>
        <label>URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/file.zip" autoFocus /></label>
        <div className="modal-grid">
          <label>Файлын нэр<input value={filename} onChange={(event) => setFilename(event.target.value)} placeholder="Автоматаар тодорхойлно" /></label>
          <label>Холболтын тоо<select value={connections} onChange={(event) => setConnections(Number(event.target.value))}><option value={1}>1</option><option value={4}>4</option><option value={8}>8</option><option value={16}>16</option></select></label>
        </div>
        <label>Хадгалах зам<input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Хоосон бол системийн Downloads хавтас" /></label>
        {error ? <div className="action-error">{error}</div> : null}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Цуцлах</button><button type="submit" className="button primary" disabled={submitting || !url.trim()}>{submitting ? 'Бэлтгэж байна…' : 'Татаж эхлэх'}</button></div>
      </form>
    </div>
  );
}

export function SubutaiApp(): ReactElement {
  const [downloads, setDownloads] = useState<DownloadJob[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [activeNav, setActiveNav] = useState('Таталтууд');
  const [search, setSearch] = useState('');
  const [showNewDownload, setShowNewDownload] = useState(false);
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const acceptJobs = (jobs: DownloadJob[]): void => {
      if (!active) return;
      setDownloads(jobs);
      setSelectedId((current) => current && jobs.some((job) => job.id === current) ? current : (jobs[0]?.id ?? ''));
    };
    void window.subutai.listDownloads().then(acceptJobs).catch((error: unknown) => {
      if (active) setActionError(error instanceof Error ? error.message : String(error));
    });
    const unsubscribe = window.subutai.onDownloadsChanged(acceptJobs);
    const refreshHealth = (): void => {
      void window.subutai.getEngineHealth().then((next) => { if (active) setHealth(next); }).catch(() => undefined);
    };
    refreshHealth();
    const healthTimer = window.setInterval(refreshHealth, 2000);
    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(healthTimer);
    };
  }, []);

  const selected = downloads.find((job) => job.id === selectedId) ?? null;
  const visibleDownloads = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? downloads.filter((job) => job.filename.toLowerCase().includes(query) || job.url.toLowerCase().includes(query)) : downloads;
  }, [downloads, search]);

  const activeCount = downloads.filter((job) => job.status === 'downloading').length;
  const completedCount = downloads.filter((job) => job.status === 'completed').length;
  const pausedCount = downloads.filter((job) => job.status === 'paused').length;
  const failedCount = downloads.filter((job) => job.status === 'failed').length;
  const totalSpeed = downloads.reduce((sum, job) => sum + job.speedBytesPerSecond, 0);

  const runAction = async (action: 'pause' | 'resume' | 'cancel' | 'folder' | 'remove'): Promise<void> => {
    if (!selected || busy) return;
    setBusy(true);
    setActionError('');
    try {
      if (action === 'pause') await window.subutai.pauseDownload(selected.id);
      if (action === 'resume') await window.subutai.resumeDownload(selected.id);
      if (action === 'cancel') await window.subutai.cancelDownload(selected.id);
      if (action === 'folder') await window.subutai.openDownloadFolder(selected.id);
      if (action === 'remove') await window.subutai.removeDownload(selected.id, false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const selectedProgress = selected ? progressOf(selected) : 0;
  const engineClass = health?.subutai.running ? 'good' : health?.subutai.error ? 'bad' : 'idle';
  const engineText = health?.subutai.running ? 'Subutai бэлэн' : health?.subutai.error ? 'Subutai эхэлсэнгүй' : 'Subutai бэлтгэж байна';
  const categories = [
    ['☷', 'Бүх таталтууд', downloads.length],
    ['◌', 'Түр зогссон', pausedCount],
    ['✓', 'Дууссан', completedCount],
    ['▶', 'Татагдаж буй', activeCount],
    ['!', 'Алдаатай', failedCount],
  ] as const;

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand-lockup"><div className="brand-mark"><span>♞</span></div><div><strong>SUBUTAI</strong><span>DOWNLOAD MANAGER</span></div></div>
        <div className="titlebar-description">Subutai — хурдан, найдвартай, олон хэсэгт таталтын нэгдсэн систем<br />Pause, Resume, Recovery, Speed, ETA бүгд нэг апп дотор ажиллана.</div>
        <div className="window-controls"><button className="window-control minimize" onClick={() => void window.subutai.minimizeWindow()}>—</button><button className="window-control maximize" onClick={() => void window.subutai.toggleMaximizeWindow()}>□</button><button className="window-control close" onClick={() => void window.subutai.closeWindow()}>×</button></div>
      </header>

      <main className="dashboard">
        <section className="primary-grid">
          <aside className="left-sidebar panel">
            <div className="sidebar-brand"><span className="mini-brand">♞</span> Subutai</div>
            <nav>{navItems.map(([icon, label]) => <button key={label} className={activeNav === label ? 'nav-item active' : 'nav-item'} onClick={() => setActiveNav(label)}><span>{icon}</span>{label}</button>)}</nav>
            <div className={`engine-health ${engineClass}`}><span className="health-dot" /><div><b>{engineText}</b><small>Нэгдсэн таталтын хөдөлгүүр</small></div></div>
          </aside>

          <Panel className="downloads-panel">
            <div className="download-header-row">
              <h1>Таталтууд</h1>
              <div className="toolbar">
                <button className="button primary compact" onClick={() => setShowNewDownload(true)}>＋ Шинэ таталт</button>
                <button className="tool-button" title="Үргэлжлүүлэх" disabled={!selected || busy || !['paused', 'queued'].includes(selected.status)} onClick={() => void runAction('resume')}>▶</button>
                <button className="tool-button" title="Түр зогсоох" disabled={!selected || busy || selected.status !== 'downloading'} onClick={() => void runAction('pause')}>Ⅱ</button>
                <button className="tool-button" title="Цуцлах" disabled={!selected || busy || ['completed', 'cancelled'].includes(selected.status)} onClick={() => void runAction('cancel')}>■</button>
                <button className="tool-button" title="Хавтас" disabled={!selected || busy} onClick={() => void runAction('folder')}>▱</button>
                <button className="tool-button" title="Жагсаалтаас устгах" disabled={!selected || busy} onClick={() => void runAction('remove')}>⌫</button>
              </div>
              <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Хайх…" /></label>
            </div>
            {actionError ? <div className="action-error app-error">{actionError}</div> : null}
            <div className="download-table">
              <div className="download-table-head"><span>Нэр</span><span>Хэмжээ</span><span>Төлөв</span><span>Хурд</span><span>Дуусах хугацаа</span></div>
              <div className="download-table-body">
                {visibleDownloads.length === 0 ? <div className="empty-downloads"><b>Одоогоор таталт алга.</b><span>“Шинэ таталт” дарж URL оруулна уу.</span></div> : visibleDownloads.map((job) => <button key={job.id} className={selected?.id === job.id ? 'download-row selected' : 'download-row'} onClick={() => setSelectedId(job.id)}><span className="download-name"><FileGlyph filename={job.filename} /><b>{job.filename}</b></span><span>{formatBytes(job.totalBytes)}</span><span className="row-progress"><b>{progressOf(job)}%</b><ProgressBar job={job} /></span><span>{formatSpeed(job.speedBytesPerSecond)}</span><span className={`status-text status-${job.status}`}>{formatEta(job.etaSeconds, job.status)}</span></button>)}
              </div>
            </div>
            <div className="download-summary"><span>Нийт: <b>{downloads.length}</b></span><span>Татагдаж буй: <b>{activeCount}</b></span><span>Хурд: <b>{formatSpeed(totalSpeed)}</b></span><span>Хязгаарлалт: <b>∞</b></span></div>
          </Panel>

          <Panel title="ТАТАЛТЫН ДЭЛГЭРЭНГҮЙ" className="detail-panel">
            {selected ? <><div className="selected-file-title"><FileGlyph filename={selected.filename} /><span>{selected.filename}</span></div><div className="detail-overview"><div className="progress-ring" style={{ background: `conic-gradient(#2f8cff ${selectedProgress * 3.6}deg, #14243a 0deg)` }}><div><strong>{selectedProgress}%</strong><span>{formatBytes(selected.downloadedBytes)} / {formatBytes(selected.totalBytes)}</span></div></div><dl><div><dt>Төлөв:</dt><dd>{statusLabel(selected.status)}</dd></div><div><dt>Хурд:</dt><dd>{formatSpeed(selected.speedBytesPerSecond)}</dd></div><div><dt>Үлдсэн хугацаа:</dt><dd>{formatEta(selected.etaSeconds, selected.status)}</dd></div><div><dt>Холболт:</dt><dd>{selected.connections}</dd></div><div><dt>Даалгавар:</dt><dd>{selected.engineTaskId ?? 'Хүлээгдэж байна'}</dd></div><div><dt>Хадгалах зам:</dt><dd>{selected.destination}</dd></div><div><dt>URL:</dt><dd className="truncate">{selected.url}</dd></div></dl></div><ProgressBar job={selected} />{selected.error ? <div className="action-error detail-error">{selected.error}</div> : null}<div className="segments-table"><div className="segment-head"><span>#</span><span>Холболт</span><span>Төлөв</span><span>Явц</span><span>Нийт хурд</span></div>{Array.from({ length: Math.max(1, Math.min(selected.connections, 8)) }, (_, index) => <div className="segment-row" key={index}><span>{index + 1}</span><span>Subutai connection {index + 1}</span><span>{statusLabel(selected.status)}</span><span>{selectedProgress}%</span><span>{formatSpeed(selected.speedBytesPerSecond)}</span></div>)}</div></> : <div className="empty-detail"><b>Таталт сонгоогүй байна</b><span>Шинэ URL нэмэхэд дэлгэрэнгүй мэдээлэл энд гарна.</span><button className="button primary compact" onClick={() => setShowNewDownload(true)}>＋ Шинэ таталт</button></div>}
          </Panel>

          <aside className="right-sidebar">
            <Panel title="АНГИЛАЛ (КАТЕГОРИ)" className="category-panel"><div className="category-list">{categories.map(([icon, label, count], index) => <button key={label} className={index === 0 ? 'active' : ''}><span>{icon}</span><b>{label}</b><em>{count}</em></button>)}</div></Panel>
            <Panel title="ТҮГЭЭМЭЛ САЙТУУД" className="sites-panel"><div className="sites-grid">{sites.map(([logo, label, color]) => <button key={label}><span className={color}>{logo}</span><b>{label}</b></button>)}</div></Panel>
          </aside>
        </section>

        <section className="secondary-grid">
          <Panel title="ТӨЛӨВЛӨЛТ" className="schedule-panel"><div className="schedule-layout"><div className="schedule-list"><div className="schedule-head"><span>Нэр</span><span>Хугацаа</span><span>Төлөв</span></div><div className="schedule-row"><b>Шөнийн таталт</b><span>22:00 - 06:00</span><span>Идэвхгүй</span></div><div className="schedule-row"><b>Ажлын өдрийн таталт</b><span>09:00 - 18:00</span><span>Идэвхгүй</span></div></div><div className="schedule-form"><h3>Төлөвлөлтийн дэлгэрэнгүй</h3><label>Эхлэх:<input value="22:00" readOnly /></label><label>Дуусах:<input value="06:00" readOnly /></label><label>Хурдны хязгаарлалт:<select defaultValue="Хязгаарлалтгүй"><option>Хязгаарлалтгүй</option></select></label></div></div></Panel>
          <Panel title="ФАЙЛЫН МЭДЭЭЛЭЛ" className="file-info-panel">{selected ? <><div className="file-info-title"><FileGlyph filename={selected.filename} /><b>{selected.filename}</b></div><dl className="file-info-list"><div><dt>Хэмжээ:</dt><dd>{formatBytes(selected.totalBytes)}</dd></div><div><dt>Татсан:</dt><dd>{formatBytes(selected.downloadedBytes)} ({selectedProgress}%)</dd></div><div><dt>Хэсэг:</dt><dd>{selected.connections}</dd></div><div><dt>Систем:</dt><dd>Subutai Engine</dd></div><div><dt>URL:</dt><dd className="link-text">{selected.url}</dd></div><div><dt>Хадгалах зам:</dt><dd>{selected.destination}</dd></div><div><dt>Үүссэн:</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd></div></dl><div className="panel-actions center"><button onClick={() => void runAction('folder')}>Нээх хавтас</button><button onClick={() => void navigator.clipboard.writeText(selected.url)}>URL хуулах</button></div></> : <div className="empty-mini">Файл сонгоно уу.</div>}</Panel>
          <Panel title="СТАТИСТИК" className="stats-panel"><div className="stat-main"><span>Нийт татсан</span><strong>{formatBytes(downloads.reduce((sum, job) => sum + job.downloadedBytes, 0))}</strong></div><dl className="stats-list"><div><dt>Нийт:</dt><dd>{downloads.length}</dd></div><div><dt>Амжилттай:</dt><dd>{completedCount}</dd></div><div><dt>Амжилтгүй:</dt><dd>{failedCount}</dd></div><div><dt>Татагдаж буй:</dt><dd>{activeCount}</dd></div><div><dt>Одоогийн хурд:</dt><dd>{formatSpeed(totalSpeed)}</dd></div></dl></Panel>
          <Panel title="ТОХИРГОО" className="settings-panel"><div className="settings-layout"><nav className="settings-nav"><button className="active">⚙ Ерөнхий</button><button>♧ Холболт</button><button>≋ Хурд</button><button>▥ Прокси</button><button>▱ Интерфейс</button></nav><div className="settings-content"><label className="check-row"><input type="checkbox" defaultChecked />Таталт дуусахад мэдэгдэх</label><label className="check-row"><input type="checkbox" defaultChecked />Subutai-г автоматаар бэлдэх</label><label>Үндсэн холболт:<select defaultValue="16"><option>4</option><option>8</option><option>16</option></select></label><label>Таталтын систем:<input value="Апп дотор бүрэн багцлагдсан" readOnly /></label></div></div></Panel>
        </section>

        <section className="features-strip panel"><h2>ОНЦЛОГ, ДАВУУ ТАЛ</h2><div className="feature-grid">{[['ϟ', 'ХУРДАН ТАТАЛТ', 'Олон хэсэгт хуваан өндөр хурдтай татна.'], ['✣', 'ОЛОН ПРОТОКОЛ', 'HTTP, HTTPS, FTP, SFTP дэмжинэ.'], ['♢', 'НАЙДВАРТАЙ', 'Pause, Resume болон restart recovery.'], ['◷', 'ШУУД ХЯНАЛТ', 'Progress, speed, ETA тасралтгүй шинэчлэгдэнэ.'], ['◇', '16 ХОЛБОЛТ', 'Нэг файлд олон зэрэгцээ холболт.'], ['▱', 'НЭГ БҮХЭЛ АПП', 'Шаардлагатай хөдөлгүүрүүд дотроо багтана.']].map(([icon, title, text]) => <article key={title}><span>{icon}</span><div><h3>{title}</h3><p>{text}</p></div></article>)}</div></section>
      </main>

      {showNewDownload ? <NewDownloadDialog onClose={() => setShowNewDownload(false)} onCreated={(job) => { setDownloads((current) => [job, ...current.filter((item) => item.id !== job.id)]); setSelectedId(job.id); }} /> : null}
    </div>
  );
}

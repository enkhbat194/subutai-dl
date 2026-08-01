import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { DownloadCreateRequest, DownloadJob } from '@subutai/shared';

type DownloadKind = 'iso' | 'video' | 'document' | 'archive' | 'audio' | 'app';
type UiStatus = 'downloading' | 'completed' | 'queued' | 'paused';

interface DisplayDownload {
  id: string;
  name: string;
  size: string;
  status: UiStatus;
  progress: number;
  speed: string;
  eta: string;
  kind: DownloadKind;
  downloaded: string;
  connections: number;
  destination: string;
  url: string;
}

interface PanelProps {
  title?: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}

const initialDownloads: DisplayDownload[] = [
  {
    id: 'ubuntu',
    name: 'ubuntu-24.04-desktop.iso',
    size: '4.62 GB',
    status: 'downloading',
    progress: 53,
    speed: '12.4 MB/s',
    eta: '2m 45s',
    kind: 'iso',
    downloaded: '2.45 GB',
    connections: 16,
    destination: 'D:\\Downloads',
    url: 'https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso',
  },
  {
    id: 'archlinux',
    name: 'archlinux-2024.06.01.iso',
    size: '2.00 GB',
    status: 'downloading',
    progress: 38,
    speed: '9.7 MB/s',
    eta: '1m 10s',
    kind: 'iso',
    downloaded: '760 MB',
    connections: 12,
    destination: 'D:\\Downloads',
    url: 'https://example.com/archlinux.iso',
  },
  {
    id: 'movie',
    name: 'big_video_1080p.mkv',
    size: '1.36 GB',
    status: 'downloading',
    progress: 61,
    speed: '11.1 MB/s',
    eta: '20s',
    kind: 'video',
    downloaded: '850 MB',
    connections: 8,
    destination: 'D:\\Downloads\\Video',
    url: 'https://example.com/big_video_1080p.mkv',
  },
  {
    id: 'document',
    name: 'document.pdf',
    size: '42.7 MB',
    status: 'completed',
    progress: 100,
    speed: '—',
    eta: 'Дууссан',
    kind: 'document',
    downloaded: '42.7 MB',
    connections: 4,
    destination: 'D:\\Downloads\\Documents',
    url: 'https://example.com/document.pdf',
  },
  {
    id: 'archive',
    name: 'project_archive.zip',
    size: '2.01 GB',
    status: 'completed',
    progress: 100,
    speed: '—',
    eta: 'Дууссан',
    kind: 'archive',
    downloaded: '2.01 GB',
    connections: 32,
    destination: 'D:\\Downloads\\Archive',
    url: 'https://example.com/project_archive.zip',
  },
  {
    id: 'music',
    name: 'music_album.mp3',
    size: '320 MB',
    status: 'completed',
    progress: 100,
    speed: '—',
    eta: 'Дууссан',
    kind: 'audio',
    downloaded: '320 MB',
    connections: 8,
    destination: 'D:\\Downloads\\Music',
    url: 'https://example.com/music_album.mp3',
  },
  {
    id: 'tutorial',
    name: 'video_tutorial.mp4',
    size: '890 MB',
    status: 'downloading',
    progress: 78,
    speed: '6.1 MB/s',
    eta: '15s',
    kind: 'video',
    downloaded: '694 MB',
    connections: 8,
    destination: 'D:\\Downloads\\Video',
    url: 'https://example.com/video_tutorial.mp4',
  },
  {
    id: 'setup',
    name: 'software_setup.exe',
    size: '95.4 MB',
    status: 'queued',
    progress: 0,
    speed: '—',
    eta: 'Хүлээгдэж байна',
    kind: 'app',
    downloaded: '0 B',
    connections: 8,
    destination: 'D:\\Downloads\\Programs',
    url: 'https://example.com/software_setup.exe',
  },
];

const navItems = [
  ['⇩', 'Таталтууд'],
  ['◌', 'Түр зогсоосон'],
  ['✓', 'Дууссан'],
  ['◷', 'Төлөвлөлт'],
  ['□', 'Категори'],
  ['◎', 'Түгээмэл сайт'],
  ['⚙', 'Тохиргоо'],
] as const;

const categories = [
  ['☷', 'Бүх таталтууд', 8],
  ['▤', 'Баримт бичиг', 2],
  ['▶', 'Видео', 2],
  ['♫', 'Аудио', 1],
  ['▣', 'Програм', 2],
  ['▥', 'Архив', 1],
  ['▧', 'Зураг', 0],
  ['◎', 'Бусад', 0],
] as const;

const sites = [
  ['YT', 'YouTube', 'site-red'],
  ['f', 'Facebook', 'site-blue'],
  ['v', 'Vimeo', 'site-cyan'],
  ['d', 'Dailymotion', 'site-blue'],
  ['◎', 'Instagram', 'site-pink'],
  ['t', 'Twitter', 'site-cyan'],
  ['♪', 'TikTok', 'site-dark'],
  ['▥', 'SoundCloud', 'site-orange'],
  ['▣', 'Twitch', 'site-purple'],
] as const;

function Panel({ title, children, className, action }: PanelProps): JSX.Element {
  return (
    <section className={`panel${className ? ` ${className}` : ''}`}>
      {title ? (
        <div className="panel-heading">
          <h2>{title}</h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function FileGlyph({ kind }: { kind: DownloadKind }): JSX.Element {
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

function ProgressBar({ progress, completed }: { progress: number; completed: boolean }): JSX.Element {
  return (
    <div className="progress-track" aria-label={`${progress}%`}>
      <span
        className={completed ? 'progress-value progress-complete' : 'progress-value'}
        style={{ width: `${Math.max(0, Math.min(progress, 100))}%` }}
      />
    </div>
  );
}

function Toggle({ active }: { active: boolean }): JSX.Element {
  return <span className={active ? 'toggle active' : 'toggle'}><span /></span>;
}

function mapJob(job: DownloadJob): DisplayDownload {
  const total = job.totalBytes ?? 0;
  const progress = total > 0 ? Math.round((job.downloadedBytes / total) * 100) : 0;
  const status: UiStatus = job.status === 'completed'
    ? 'completed'
    : job.status === 'paused'
      ? 'paused'
      : job.status === 'downloading'
        ? 'downloading'
        : 'queued';

  return {
    id: job.id,
    name: job.filename,
    size: total > 0 ? `${(total / 1024 / 1024).toFixed(1)} MB` : 'Тодорхойгүй',
    status,
    progress,
    speed: job.speedBytesPerSecond > 0
      ? `${(job.speedBytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
      : '—',
    eta: status === 'completed' ? 'Дууссан' : 'Хүлээгдэж байна',
    kind: 'app',
    downloaded: `${(job.downloadedBytes / 1024 / 1024).toFixed(1)} MB`,
    connections: 8,
    destination: job.destination,
    url: job.url,
  };
}

function NewDownloadDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (download: DisplayDownload) => void;
}): JSX.Element {
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [destination, setDestination] = useState('D:\\Downloads');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);

    try {
      const request: DownloadCreateRequest = {
        url: url.trim(),
        destination: destination.trim() || 'D:\\Downloads',
        engine: 'auto',
      };
      if (filename.trim()) request.filename = filename.trim();
      const created = await window.subutai.createDownload(request);
      onCreated(mapJob(created));
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="new-download-modal" onSubmit={(event) => void submit(event)} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title-row">
          <div>
            <span className="eyebrow">ШИНЭ ДААЛГАВАР</span>
            <h2>Шинэ таталт нэмэх</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>×</button>
        </div>
        <label>
          URL
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/file.zip" autoFocus />
        </label>
        <div className="modal-grid">
          <label>
            Файлын нэр
            <input value={filename} onChange={(event) => setFilename(event.target.value)} placeholder="Автоматаар тодорхойлно" />
          </label>
          <label>
            Холболтын тоо
            <select defaultValue="16">
              <option>8</option>
              <option>16</option>
              <option>32</option>
            </select>
          </label>
        </div>
        <label>
          Хадгалах зам
          <input value={destination} onChange={(event) => setDestination(event.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>Цуцлах</button>
          <button type="submit" className="button primary" disabled={submitting || !url.trim()}>
            {submitting ? 'Нэмж байна…' : 'Татаж эхлэх'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function App(): JSX.Element {
  const [downloads, setDownloads] = useState<DisplayDownload[]>(initialDownloads);
  const [selectedId, setSelectedId] = useState('ubuntu');
  const [activeNav, setActiveNav] = useState('Таталтууд');
  const [search, setSearch] = useState('');
  const [showNewDownload, setShowNewDownload] = useState(false);
  const [detailTab, setDetailTab] = useState('Ерөнхий');

  useEffect(() => {
    void window.subutai.listDownloads().then((jobs) => {
      if (jobs.length > 0) setDownloads((current) => [...jobs.map(mapJob), ...current]);
    }).catch(() => undefined);
  }, []);

  const visibleDownloads = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? downloads.filter((download) => download.name.toLowerCase().includes(query)) : downloads;
  }, [downloads, search]);

  const selected = downloads.find((download) => download.id === selectedId) ?? downloads[0];
  const activeCount = downloads.filter((download) => download.status === 'downloading').length;

  if (!selected) return <div className="empty-state">Таталт алга байна.</div>;

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand-lockup">
          <div className="brand-mark"><span>♞</span></div>
          <div>
            <strong>SUBUTAI IDM</strong>
            <span>DESKTOP APPLICATION</span>
          </div>
        </div>
        <div className="titlebar-description">
          Subutai IDM нь олон төрлийн файл, протоколуудыг дэмжсэн<br />хурдан, найдвартай таталтын менежер юм.
        </div>
        <div className="window-controls">
          <button className="window-control minimize" aria-label="Minimize" onClick={() => void window.subutai.minimizeWindow()}>—</button>
          <button className="window-control maximize" aria-label="Maximize" onClick={() => void window.subutai.toggleMaximizeWindow()}>□</button>
          <button className="window-control close" aria-label="Close" onClick={() => void window.subutai.closeWindow()}>×</button>
        </div>
      </header>

      <main className="dashboard">
        <section className="primary-grid">
          <aside className="left-sidebar panel">
            <div className="sidebar-brand"><span className="mini-brand">♞</span> Subutai IDM</div>
            <nav>
              {navItems.map(([icon, label]) => (
                <button key={label} className={activeNav === label ? 'nav-item active' : 'nav-item'} onClick={() => setActiveNav(label)}>
                  <span>{icon}</span>{label}
                </button>
              ))}
            </nav>
            <div className="premium-card">
              <div className="premium-title"><span>♢</span><b>SUBUTAI IDM<br />PREMIUM</b></div>
              <button>Идэвхжүүлэх</button>
            </div>
          </aside>

          <Panel className="downloads-panel">
            <div className="download-header-row">
              <h1>Таталтууд</h1>
              <div className="toolbar">
                <button className="button primary compact" onClick={() => setShowNewDownload(true)}>＋ Шинэ таталт</button>
                <button className="tool-button" title="Эхлүүлэх">▶</button>
                <button className="tool-button" title="Түр зогсоох">Ⅱ</button>
                <button className="tool-button" title="Зогсоох">■</button>
                <button className="tool-button" title="Хавтас">▱</button>
                <button className="tool-button" title="Харагдац">⠿</button>
              </div>
              <label className="search-box">
                <span>⌕</span>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Хайх…" />
              </label>
            </div>

            <div className="download-table">
              <div className="download-table-head">
                <span>Нэр</span><span>Хэмжээ</span><span>Төлөв</span><span>Хурд</span><span>Дуусах хугацаа</span>
              </div>
              <div className="download-table-body">
                {visibleDownloads.map((download) => (
                  <button
                    key={download.id}
                    className={selected.id === download.id ? 'download-row selected' : 'download-row'}
                    onClick={() => setSelectedId(download.id)}
                  >
                    <span className="download-name"><FileGlyph kind={download.kind} /><b>{download.name}</b></span>
                    <span>{download.size}</span>
                    <span className="row-progress"><b>{download.progress}%</b><ProgressBar progress={download.progress} completed={download.status === 'completed'} /></span>
                    <span>{download.speed}</span>
                    <span className={`status-text status-${download.status}`}>{download.eta}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="download-summary">
              <span>Нийт: <b>{downloads.length}</b></span>
              <span>Татагдаж буй: <b>{activeCount}</b></span>
              <span>Хурд: <b>32.3 MB/s</b></span>
              <span>Хязгаарлалт: <b>∞</b></span>
            </div>
          </Panel>

          <Panel title="ТАТАЛТЫН ДЭЛГЭРЭНГҮЙ" className="detail-panel">
            <div className="selected-file-title"><FileGlyph kind={selected.kind} /><span>{selected.name}</span></div>
            <div className="tabs">
              {['Ерөнхий', 'Хэсгүүд', 'Холболтууд', 'Лог'].map((tab) => (
                <button key={tab} className={detailTab === tab ? 'active' : ''} onClick={() => setDetailTab(tab)}>{tab}</button>
              ))}
            </div>
            <div className="detail-overview">
              <div className="progress-ring" style={{ background: `conic-gradient(#2f8cff ${selected.progress * 3.6}deg, #14243a 0deg)` }}>
                <div><strong>{selected.progress}%</strong><span>{selected.downloaded} / {selected.size}</span></div>
              </div>
              <dl>
                <div><dt>Төлөв:</dt><dd>{selected.status === 'completed' ? 'Дууссан' : 'Татагдаж байна'}</dd></div>
                <div><dt>Хурд:</dt><dd>{selected.speed}</dd></div>
                <div><dt>Үлдсэн хугацаа:</dt><dd>{selected.eta}</dd></div>
                <div><dt>Холболт:</dt><dd>{selected.connections} / {selected.connections}</dd></div>
                <div><dt>Файл:</dt><dd>{selected.name}</dd></div>
                <div><dt>Хадгалах зам:</dt><dd>{selected.destination}</dd></div>
                <div><dt>URL:</dt><dd className="truncate">{selected.url}</dd></div>
              </dl>
            </div>
            <ProgressBar progress={selected.progress} completed={selected.status === 'completed'} />
            <div className="segments-table">
              <div className="segment-head"><span>#</span><span>Хэсгийн хүрээ</span><span>Төлөв</span><span>Хэмжээ</span><span>Хурд</span></div>
              {Array.from({ length: 8 }, (_, index) => (
                <div className="segment-row" key={index}>
                  <span>{index + 1}</span>
                  <span>{index * 576} MB - {(index + 1) * 576} MB</span>
                  <span>{index === 7 && selected.progress < 100 ? 'Хүлээгдэж байна' : 'Татагдаж байна'}</span>
                  <span>{index === 7 ? '0 B' : '576 MB'}</span>
                  <span>{index === 7 ? '0 B/s' : `${(1.2 + (index % 5) * 0.1).toFixed(1)} MB/s`}</span>
                </div>
              ))}
            </div>
          </Panel>

          <aside className="right-sidebar">
            <Panel title="АНГИЛАЛ (КАТЕГОРИ)" className="category-panel">
              <div className="category-list">
                {categories.map(([icon, label, count], index) => (
                  <button key={label} className={index === 0 ? 'active' : ''}><span>{icon}</span><b>{label}</b><em>{count}</em></button>
                ))}
              </div>
            </Panel>
            <Panel title="ТҮГЭЭМЭЛ САЙТУУД" className="sites-panel">
              <div className="sites-grid">
                {sites.map(([logo, label, color]) => (
                  <button key={label}><span className={color}>{logo}</span><b>{label}</b></button>
                ))}
              </div>
            </Panel>
          </aside>
        </section>

        <section className="secondary-grid">
          <Panel title="ТӨЛӨВЛӨЛТ" className="schedule-panel">
            <div className="schedule-layout">
              <div className="schedule-list">
                <div className="schedule-head"><span>Нэр</span><span>Хугацаа</span><span>Төлөв</span></div>
                {[
                  ['Шөнийн таталт', '22:00 - 06:00', true],
                  ['Ажлын өдрийн таталт', '09:00 - 18:00', false],
                  ['Тогтмол таталт', 'Даваа, Лхагва, Баасан', false],
                  ['Хязгаарлалтгүй', 'Үргэлж', false],
                ].map(([name, time, enabled]) => (
                  <div className="schedule-row" key={String(name)}><b>{name}</b><span>{time}</span><span><Toggle active={Boolean(enabled)} />{enabled ? 'Идэвхтэй' : 'Идэвхгүй'}</span></div>
                ))}
              </div>
              <div className="schedule-form">
                <h3>Төлөвлөлтийн дэлгэрэнгүй</h3>
                <label>Нэр:<input value="Шөнийн таталт" readOnly /></label>
                <label>Төрөл:<select defaultValue="Хугацааны хүрээ"><option>Хугацааны хүрээ</option></select></label>
                <label>Эхлэх:<input value="22:00" readOnly /></label>
                <label>Дуусах:<input value="06:00" readOnly /></label>
                <label>Давтах:<select defaultValue="Өдөр бүр"><option>Өдөр бүр</option></select></label>
                <label>Хурдны хязгаарлалт:<select defaultValue="Хязгаарлалтгүй"><option>Хязгаарлалтгүй</option></select></label>
              </div>
            </div>
            <div className="panel-actions"><button>＋ Шинэ төлөвлөлт</button><button>✎ Засах</button><button>⌫ Устгах</button></div>
          </Panel>

          <Panel title="ФАЙЛЫН МЭДЭЭЛЭЛ" className="file-info-panel">
            <div className="file-info-title"><FileGlyph kind={selected.kind} /><b>{selected.name}</b></div>
            <dl className="file-info-list">
              <div><dt>Хэмжээ:</dt><dd>{selected.size} (2,157,463,520 bytes)</dd></div>
              <div><dt>Татсан:</dt><dd>{selected.downloaded} ({selected.progress}%)</dd></div>
              <div><dt>Хэсэг:</dt><dd>{selected.connections}</dd></div>
              <div><dt>URL:</dt><dd className="link-text">{selected.url}</dd></div>
              <div><dt>Хадгалах зам:</dt><dd>{selected.destination}\{selected.name}</dd></div>
              <div><dt>Үүссэн:</dt><dd>2024-06-01 14:30:22</dd></div>
              <div><dt>Дууссан:</dt><dd>{selected.status === 'completed' ? '2024-06-01 14:32:11' : '—'}</dd></div>
              <div><dt>MD5:</dt><dd>8f3e2cd64e7b9cd1ca8afa5b6c7d8e9f</dd></div>
              <div><dt>SHA1:</dt><dd>afb2c3d4e5f67890123456789abcdef01234567</dd></div>
            </dl>
            <div className="panel-actions center"><button>Нээх хавтас</button><button>URL хуулах</button></div>
          </Panel>

          <Panel title="СТАТИСТИК" className="stats-panel" action={<select defaultValue="Өнөөдөр"><option>Өнөөдөр</option></select>}>
            <div className="stat-main"><span>Татсан өгөгдөл</span><strong>18.7 GB</strong></div>
            <div className="chart">
              <div className="chart-grid" />
              <svg viewBox="0 0 300 110" preserveAspectRatio="none" aria-label="Download statistics chart">
                <defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2e90ff" stopOpacity=".42"/><stop offset="1" stopColor="#2e90ff" stopOpacity="0"/></linearGradient></defs>
                <path d="M5 92 L38 76 L72 76 L104 61 L138 61 L171 46 L205 46 L238 31 L270 33 L296 12 L296 108 L5 108 Z" fill="url(#area)" />
                <polyline points="5,92 38,76 72,76 104,61 138,61 171,46 205,46 238,31 270,33 296,12" fill="none" stroke="#3b9cff" strokeWidth="3" />
              </svg>
              <div className="chart-labels"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
            </div>
            <dl className="stats-list">
              <div><dt>Татсан файлууд:</dt><dd>12</dd></div>
              <div><dt>Амжилттай:</dt><dd>9</dd></div>
              <div><dt>Амжилтгүй:</dt><dd>0</dd></div>
              <div><dt>Татагдаж буй:</dt><dd>3</dd></div>
              <div><dt>Дундаж хурд:</dt><dd>9.3 MB/s</dd></div>
              <div><dt>Хамгийн их хурд:</dt><dd>24.8 MB/s</dd></div>
            </dl>
          </Panel>

          <Panel title="ТОХИРГОО" className="settings-panel">
            <div className="settings-layout">
              <nav className="settings-nav">
                {['⚙ Ерөнхий', '♧ Холболт', '≋ Хурд', '▥ Прокси', '▱ Интерфейс', '♨ Интеграци', '♫ Түгээмэл', '◉ Дэвшилтэт'].map((item, index) => <button key={item} className={index === 0 ? 'active' : ''}>{item}</button>)}
              </nav>
              <div className="settings-content">
                {[
                  'Windows асахад Subutai IDM-ийг ажиллуулах',
                  'Clipboard-аас таталтыг хянах',
                  'Таталт дуусахад мэдэгдэх',
                  'Таталт дуусахад мэдэгдэл харуулах',
                  'Дараах товлолоор таталтыг эхлүүлэх',
                ].map((label, index) => <label className="check-row" key={label}><input type="checkbox" defaultChecked={index < 4} />{label}</label>)}
                <label>Хэл (Language):<select defaultValue="Монгол (Mongolian)"><option>Монгол (Mongolian)</option></select></label>
                <label>Шинэ таталтыг ангилах:<select defaultValue="Ерөнхий"><option>Ерөнхий</option></select></label>
                <label>Хадгалах зам:<div className="path-input"><input value="D:\\Downloads" readOnly /><button>…</button></div></label>
              </div>
            </div>
            <div className="settings-actions"><button className="button primary compact">OK</button><button>Хэрэглэх</button><button>Цуцлах</button></div>
          </Panel>
        </section>

        <section className="features-strip panel">
          <h2>ОНЦЛОГ, ДАВУУ ТАЛ</h2>
          <div className="feature-grid">
            {[
              ['ϟ', 'ХУРДАН ТАТАЛТ', 'Олон хэсэгт хуваан хамгийн их хурдтай татдаг.'],
              ['✣', 'ОЛОН ПРОТОКОЛ', 'HTTP, HTTPS, FTP, FTPS, SFTP, BitTorrent дэмжинэ.'],
              ['♢', 'НАЙДВАРТАЙ', 'Таталт тасарсан ч үргэлжлүүлэн татах боломжтой.'],
              ['◷', 'ТӨЛӨВЛӨЛТ', 'Таталтыг цагийн хуваарь, давтамжаар төлөвлөнө.'],
              ['◇', 'АНГИЛАЛ', 'Файлуудыг төрөл, ангиллаар зохион байгуулна.'],
              ['▱', 'БҮХ ТӨХӨӨРӨМЖ', 'Windows 10/11 (64-bit) бүрэн дэмжинэ.'],
            ].map(([icon, title, text]) => (
              <article key={title}><span>{icon}</span><div><h3>{title}</h3><p>{text}</p></div></article>
            ))}
          </div>
        </section>
      </main>

      {showNewDownload ? (
        <NewDownloadDialog
          onClose={() => setShowNewDownload(false)}
          onCreated={(download) => {
            setDownloads((current) => [download, ...current]);
            setSelectedId(download.id);
          }}
        />
      ) : null}
    </div>
  );
}

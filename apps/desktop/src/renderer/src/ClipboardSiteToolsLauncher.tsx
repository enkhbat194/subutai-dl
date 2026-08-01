import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type {
  ClipboardCapture,
  ClipboardSnapshot,
  QueuePriority,
  SiteGrabberJob,
  SiteGrabberStartRequest,
} from '@subutai/shared';

type ToolsTab = 'clipboard' | 'site';

function statusLabel(status: SiteGrabberJob['status']): string {
  if (status === 'running') return 'Шалгаж байна';
  if (status === 'completed') return 'Дууссан';
  if (status === 'cancelled') return 'Цуцлагдсан';
  if (status === 'failed') return 'Алдаа';
  return 'Хүлээж байна';
}

function ClipboardPanel(): ReactElement {
  const [snapshot, setSnapshot] = useState<ClipboardSnapshot | null>(null);
  const [ignoredHosts, setIgnoredHosts] = useState('');
  const [ignoredExtensions, setIgnoredExtensions] = useState('');
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void window.subutai.getClipboardSnapshot().then((value) => {
      if (!active) return;
      setSnapshot(value);
      setIgnoredHosts(value.settings.ignoredHosts.join(', '));
      setIgnoredExtensions(value.settings.ignoredExtensions.join(', '));
    });
    const off = window.subutai.onClipboardChanged((value) => {
      if (!active) return;
      setSnapshot(value);
      setIgnoredHosts(value.settings.ignoredHosts.join(', '));
      setIgnoredExtensions(value.settings.ignoredExtensions.join(', '));
    });
    return () => { active = false; off(); };
  }, []);

  const update = async (settings: Parameters<typeof window.subutai.updateClipboardSettings>[0]): Promise<void> => {
    setError('');
    try {
      setSnapshot(await window.subutai.updateClipboardSettings(settings));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const act = async (capture: ClipboardCapture, action: 'queue' | 'dismiss'): Promise<void> => {
    setBusyId(capture.id);
    setError('');
    try {
      const value = action === 'queue'
        ? await window.subutai.enqueueClipboardCapture(capture.id)
        : await window.subutai.dismissClipboardCapture(capture.id);
      setSnapshot(value);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId('');
    }
  };

  if (!snapshot) return <div className="tools-loading">Clipboard төлөв ачаалж байна…</div>;

  return (
    <div className="clipboard-tools-panel">
      <section className="tools-card clipboard-settings-card">
        <div className="tools-card-title"><div><h3>Clipboard Monitor</h3><p>Clipboard-д орсон URL-ийг зөвхөн идэвхжүүлсэн үед илрүүлнэ.</p></div><label className="tools-switch"><input type="checkbox" checked={snapshot.settings.enabled} onChange={(event) => void update({ enabled: event.target.checked })} /><span /></label></div>
        <div className="clipboard-settings-grid">
          <label className="tools-check"><input type="checkbox" checked={snapshot.settings.autoEnqueue} onChange={(event) => void update({ autoEnqueue: event.target.checked })} />URL-ийг queue-д автоматаар нэмэх</label>
          <label className="tools-check"><input type="checkbox" checked={snapshot.settings.captureMultipleUrls} onChange={(event) => void update({ captureMultipleUrls: event.target.checked })} />Нэг clipboard-оос олон URL авах</label>
          <label>Cooldown · секунд<input type="number" min="1" max="300" value={Math.round(snapshot.settings.cooldownMs / 1000)} onChange={(event) => void update({ cooldownMs: Number(event.target.value) * 1000 })} /></label>
          <label>History лимит<input type="number" min="1" max="500" value={snapshot.settings.maxHistory} onChange={(event) => void update({ maxHistory: Number(event.target.value) })} /></label>
          <label className="tools-wide">Ignore host<input value={ignoredHosts} onChange={(event) => setIgnoredHosts(event.target.value)} onBlur={() => void update({ ignoredHosts: ignoredHosts.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="example.com, ads.example.net" /></label>
          <label className="tools-wide">Ignore extension<input value={ignoredExtensions} onChange={(event) => setIgnoredExtensions(event.target.value)} onBlur={() => void update({ ignoredExtensions: ignoredExtensions.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder=".jpg, .css, .js" /></label>
        </div>
      </section>

      <section className="tools-card">
        <div className="tools-card-title"><div><h3>Илэрсэн URL</h3><p>{snapshot.pendingCount} хүлээгдэж буй · {snapshot.captures.length} history</p></div><button className="tools-secondary" onClick={() => void window.subutai.clearClipboardHistory().then(setSnapshot)}>History цэвэрлэх</button></div>
        <div className="clipboard-capture-list">
          {snapshot.captures.length === 0 ? <div className="tools-empty">Clipboard URL илрээгүй байна.</div> : snapshot.captures.map((capture) => (
            <article key={capture.id} className={capture.handled ? 'handled' : ''}>
              <div className="clipboard-capture-head"><strong>{capture.urls.length} URL</strong><span>{new Date(capture.detectedAt).toLocaleString()}</span><em>{capture.handled ? `Queue-д ${capture.queuedJobIds.length}` : 'Хүлээгдэж байна'}</em></div>
              <div className="clipboard-url-list">{capture.urls.slice(0, 5).map((url) => <code key={url}>{url}</code>)}{capture.urls.length > 5 ? <small>… +{capture.urls.length - 5}</small> : null}</div>
              {capture.error ? <p className="tools-inline-error">{capture.error}</p> : null}
              <div className="clipboard-capture-actions"><button disabled={busyId === capture.id || capture.handled} onClick={() => void act(capture, 'queue')}>Queue-д нэмэх</button><button disabled={busyId === capture.id} onClick={() => void act(capture, 'dismiss')}>Арилгах</button></div>
            </article>
          ))}
        </div>
      </section>
      {error ? <div className="tools-error">{error}</div> : null}
    </div>
  );
}

function SiteGrabberPanel(): ReactElement {
  const [jobs, setJobs] = useState<SiteGrabberJob[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [rootUrl, setRootUrl] = useState('');
  const [destination, setDestination] = useState('');
  const [maxDepth, setMaxDepth] = useState(2);
  const [maxPages, setMaxPages] = useState(250);
  const [maxResources, setMaxResources] = useState(5000);
  const [sameHostOnly, setSameHostOnly] = useState(true);
  const [includeSubdomains, setIncludeSubdomains] = useState(true);
  const [extensions, setExtensions] = useState('.pdf,.zip,.rar,.7z,.jpg,.png,.webp,.mp3,.mp4,.mkv,.exe,.msi,.apk');
  const [excludePatterns, setExcludePatterns] = useState('logout, signout, /admin');
  const [priority, setPriority] = useState<QueuePriority>('normal');
  const [connections, setConnections] = useState(8);
  const [resourceFilter, setResourceFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void window.subutai.listSiteGrabberJobs().then((value) => {
      if (!active) return;
      setJobs(value);
      if (value[0]) setSelectedId(value[0].id);
    });
    const off = window.subutai.onSiteGrabberChanged((changed) => {
      if (!active) return;
      setJobs((current) => [changed, ...current.filter((job) => job.id !== changed.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
      setSelectedId((current) => current || changed.id);
    });
    return () => { active = false; off(); };
  }, []);

  const selected = jobs.find((job) => job.id === selectedId) ?? jobs[0] ?? null;
  const visibleResources = useMemo(() => {
    if (!selected) return [];
    const query = resourceFilter.trim().toLowerCase();
    return selected.resources.filter((resource) => !query || resource.url.toLowerCase().includes(query) || resource.kind.includes(query));
  }, [selected, resourceFilter]);

  const start = async (): Promise<void> => {
    if (!rootUrl.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const request: SiteGrabberStartRequest = {
        rootUrl: rootUrl.trim(),
        destination,
        maxDepth,
        maxPages,
        maxResources,
        sameHostOnly,
        includeSubdomains,
        includeExtensions: extensions.split(',').map((value) => value.trim()).filter(Boolean),
        excludePatterns: excludePatterns.split(',').map((value) => value.trim()).filter(Boolean),
        priority,
        connections,
      };
      const job = await window.subutai.startSiteGrabber(request);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setSelectedId(job.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!selected || busy) return;
    setBusy(true);
    setError('');
    try {
      const job = await window.subutai.cancelSiteGrabber(selected.id);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const queueAll = async (): Promise<void> => {
    if (!selected || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.subutai.enqueueSiteGrabberResources({ grabberJobId: selected.id });
      setJobs((current) => [result.job, ...current.filter((item) => item.id !== result.job.id)]);
      if (result.rejected.length > 0) setError(`${result.rejected.length} resource queue-д орсонгүй.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="site-tools-panel">
      <section className="tools-card">
        <div className="tools-card-title"><div><h3>Site Grabber</h3><p>Сайтын хуудсуудыг хязгаартай crawl хийж татаж болох resource олно.</p></div></div>
        <div className="site-form-grid">
          <label className="tools-wide">Эхлэх URL<input value={rootUrl} onChange={(event) => setRootUrl(event.target.value)} placeholder="https://example.com/downloads/" /></label>
          <label className="tools-wide">Хадгалах зам<input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Хоосон бол Downloads" /></label>
          <label>Depth<input type="number" min="0" max="10" value={maxDepth} onChange={(event) => setMaxDepth(Number(event.target.value))} /></label>
          <label>Хуудасны лимит<input type="number" min="1" max="5000" value={maxPages} onChange={(event) => setMaxPages(Number(event.target.value))} /></label>
          <label>Resource лимит<input type="number" min="1" max="20000" value={maxResources} onChange={(event) => setMaxResources(Number(event.target.value))} /></label>
          <label>Холболт<select value={connections} onChange={(event) => setConnections(Number(event.target.value))}>{[1,4,8,16].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Priority<select value={priority} onChange={(event) => setPriority(event.target.value as QueuePriority)}><option value="high">Өндөр</option><option value="normal">Энгийн</option><option value="low">Бага</option></select></label>
          <label className="tools-wide">Extension<input value={extensions} onChange={(event) => setExtensions(event.target.value)} /></label>
          <label className="tools-wide">Exclude pattern<input value={excludePatterns} onChange={(event) => setExcludePatterns(event.target.value)} /></label>
          <label className="tools-check"><input type="checkbox" checked={sameHostOnly} onChange={(event) => setSameHostOnly(event.target.checked)} />Зөвхөн ижил host</label>
          <label className="tools-check"><input type="checkbox" checked={includeSubdomains} onChange={(event) => setIncludeSubdomains(event.target.checked)} />Subdomain оруулах</label>
        </div>
        <div className="site-form-actions"><button className="tools-primary" disabled={!rootUrl.trim() || busy} onClick={() => void start()}>{busy ? 'Ажиллаж байна…' : 'Crawl эхлүүлэх'}</button></div>
      </section>

      <section className="tools-card site-results-card">
        <div className="tools-card-title"><div><h3>Үр дүн</h3><p>{selected ? `${statusLabel(selected.status)} · ${selected.scannedPages} хуудас · ${selected.resources.length} resource` : 'Crawl сонгоогүй'}</p></div>{selected ? <select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>{jobs.map((job) => <option key={job.id} value={job.id}>{new URL(job.rootUrl).hostname} · {statusLabel(job.status)} · {job.resources.length}</option>)}</select> : null}</div>
        {selected ? (
          <>
            <div className="site-progress-row"><span>{selected.pendingPages} хуудас хүлээгдэж байна</span><span>{selected.resources.filter((resource) => resource.queued).length} queue-д орсон</span><span>{selected.errors.length} алдаа</span></div>
            <div className="site-result-actions"><input value={resourceFilter} onChange={(event) => setResourceFilter(event.target.value)} placeholder="URL эсвэл төрөл хайх…" /><button disabled={busy || selected.status !== 'running'} onClick={() => void cancel()}>Crawl цуцлах</button><button className="tools-primary" disabled={busy || selected.resources.every((resource) => resource.queued)} onClick={() => void queueAll()}>Олдсоныг queue-д нэмэх</button></div>
            <div className="site-resource-list">
              {visibleResources.length === 0 ? <div className="tools-empty">Resource олдоогүй байна.</div> : visibleResources.slice(0, 500).map((resource) => (
                <article key={resource.id} className={resource.queued ? 'queued' : ''}><span className={`resource-kind kind-${resource.kind}`}>{resource.kind}</span><div><strong>{resource.filename}</strong><code>{resource.url}</code></div><em>{resource.queued ? 'Queue-д орсон' : `Depth ${resource.depth}`}</em></article>
              ))}
              {visibleResources.length > 500 ? <p className="site-more">… үлдсэн {visibleResources.length - 500} resource</p> : null}
            </div>
            {selected.error ? <div className="tools-error">{selected.error}</div> : null}
          </>
        ) : <div className="tools-empty">Шинэ crawl эхлүүлнэ үү.</div>}
      </section>
      {error ? <div className="tools-error">{error}</div> : null}
    </div>
  );
}

function ToolsDialog({ onClose, initialTab }: { onClose: () => void; initialTab: ToolsTab }): ReactElement {
  const [tab, setTab] = useState<ToolsTab>(initialTab);
  return (
    <div className="tools-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="tools-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="tools-modal-header"><div><span>SUBUTAI TOOLS</span><h2>Clipboard ба Site Grabber</h2></div><button onClick={onClose}>×</button></header>
        <nav className="tools-tabs"><button className={tab === 'clipboard' ? 'active' : ''} onClick={() => setTab('clipboard')}>Clipboard Monitor</button><button className={tab === 'site' ? 'active' : ''} onClick={() => setTab('site')}>Site Grabber</button></nav>
        {tab === 'clipboard' ? <ClipboardPanel /> : <SiteGrabberPanel />}
      </section>
    </div>
  );
}

export function ClipboardSiteToolsLauncher(): ReactElement {
  const [open, setOpen] = useState(false);
  const [initialTab, setInitialTab] = useState<ToolsTab>('clipboard');
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let active = true;
    void window.subutai.getClipboardSnapshot().then((value) => { if (active) setPending(value.pendingCount); });
    const off = window.subutai.onClipboardChanged((value) => { if (active) setPending(value.pendingCount); });
    return () => { active = false; off(); };
  }, []);

  const launch = (tab: ToolsTab): void => { setInitialTab(tab); setOpen(true); };
  return (
    <>
      <button className="tools-launch-button" onClick={() => launch('clipboard')}><span>⌘</span><b>Tools</b>{pending > 0 ? <em>{pending}</em> : null}</button>
      {open ? <ToolsDialog onClose={() => setOpen(false)} initialTab={initialTab} /> : null}
    </>
  );
}

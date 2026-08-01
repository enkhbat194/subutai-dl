import { useState } from 'react';
import type { ReactElement } from 'react';
import type { BatchPreviewResult, QueuePriority } from '@subutai/shared';

function BatchDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [input, setInput] = useState('https://example.com/files/file_[001-010].zip');
  const [destination, setDestination] = useState('');
  const [priority, setPriority] = useState<QueuePriority>('normal');
  const [connections, setConnections] = useState(16);
  const [speedMbps, setSpeedMbps] = useState('0');
  const [preview, setPreview] = useState<BatchPreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<number | null>(null);

  const previewInput = async (): Promise<void> => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setError('');
    setCreated(null);
    try {
      setPreview(await window.subutai.previewBatch({ input, maxItems: 10_000 }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const createBatch = async (): Promise<void> => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setError('');
    setCreated(null);
    try {
      const speed = Number(speedMbps);
      const result = await window.subutai.createBatchDownloads({
        input,
        destination,
        priority,
        connections,
        maxItems: 10_000,
        speedLimitBytesPerSecond: Number.isFinite(speed) && speed > 0 ? Math.trunc(speed * 1_000_000 / 8) : 0,
      });
      setCreated(result.jobs.length);
      if (result.rejected.length > 0) setError(`${result.rejected.length} URL queue-д орсонгүй.`);
      setPreview(await window.subutai.previewBatch({ input, maxItems: 10_000 }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="batch-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="batch-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="batch-modal-header">
          <div><span>SUBUTAI BATCH</span><h2>Олон файл нэг дор татах</h2></div>
          <button onClick={onClose}>×</button>
        </header>

        <label className="batch-input-label">URL жагсаалт эсвэл numbered pattern
          <textarea value={input} onChange={(event) => { setInput(event.target.value); setPreview(null); setCreated(null); }} spellCheck={false} />
          <small>{'Жишээ: file_[001-100].zip · image_{01..50}.jpg · {10..1..2}'}</small>
        </label>

        <div className="batch-options-grid">
          <label>Хадгалах зам<input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Хоосон бол Downloads" /></label>
          <label>Priority<select value={priority} onChange={(event) => setPriority(event.target.value as QueuePriority)}><option value="high">Өндөр</option><option value="normal">Энгийн</option><option value="low">Бага</option></select></label>
          <label>Холболт<select value={connections} onChange={(event) => setConnections(Number(event.target.value))}>{[1, 4, 8, 16].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Таталт бүр · Mbps<input type="number" min="0" step="0.5" value={speedMbps} onChange={(event) => setSpeedMbps(event.target.value)} /><small>0 = үндсэн тохиргоо</small></label>
        </div>

        <div className="batch-actions-top">
          <button disabled={busy || !input.trim()} onClick={() => void previewInput()}>{busy ? 'Шалгаж байна…' : 'Preview гаргах'}</button>
          <button className="primary" disabled={busy || !input.trim()} onClick={() => void createBatch()}>{busy ? 'Queue-д нэмж байна…' : 'Бүгдийг queue-д нэмэх'}</button>
        </div>

        {preview ? (
          <section className="batch-preview-card">
            <div className="batch-summary">
              <article><span>Зөв URL</span><strong>{preview.total}</strong></article>
              <article><span>Duplicate</span><strong>{preview.duplicateCount}</strong></article>
              <article><span>Буруу мөр</span><strong>{preview.invalidLines.length}</strong></article>
              <article><span>Лимит</span><strong>{preview.truncated ? 'Хасагдсан' : 'OK'}</strong></article>
            </div>
            <div className="batch-preview-list">
              {preview.urls.slice(0, 100).map((url, index) => <div key={`${index}-${url}`}><span>{index + 1}</span><code>{url}</code></div>)}
              {preview.urls.length > 100 ? <p>… үлдсэн {preview.urls.length - 100} URL</p> : null}
            </div>
            {preview.invalidLines.length > 0 ? <details><summary>Буруу мөрүүд</summary>{preview.invalidLines.slice(0, 30).map((line) => <code key={line}>{line}</code>)}</details> : null}
          </section>
        ) : null}

        {created !== null ? <div className="batch-success">{created} таталт queue-д нэмэгдлээ.</div> : null}
        {error ? <div className="batch-error">{error}</div> : null}
      </section>
    </div>
  );
}

export function BatchDownloadLauncher(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="batch-launch-button" onClick={() => setOpen(true)}><span>≣</span><b>Batch</b></button>
      {open ? <BatchDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

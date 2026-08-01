import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { NetworkResilienceState } from '@subutai/shared';

function formatDate(value: string | undefined): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function ResilienceDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [state, setState] = useState<NetworkResilienceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void window.subutai.getNetworkResilienceState().then((value) => { if (active) setState(value); });
    const off = window.subutai.onNetworkResilienceChanged((value) => { if (active) setState(value); });
    return () => { active = false; off(); };
  }, []);

  const retry = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setState(await window.subutai.retryNetworkDownloads());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="resilience-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="resilience-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="resilience-modal-header">
          <div><span>SUBUTAI RESILIENCE</span><h2>Recovery ба network төлөв</h2></div>
          <button onClick={onClose}>×</button>
        </header>
        {state ? (
          <>
            <div className="resilience-status-grid">
              <article className={state.online ? 'online' : 'offline'}><span>Сүлжээ</span><strong>{state.online ? 'Online' : 'Offline'}</strong></article>
              <article><span>Crash recovery</span><strong>{state.recoveredFromCrash ? 'Сэргээсэн' : 'Хэвийн'}</strong></article>
              <article><span>Сэргээсэн таталт</span><strong>{state.recoveredJobs}</strong></article>
              <article className={state.pendingNetworkFailures > 0 ? 'warning' : ''}><span>Retry хүлээж буй</span><strong>{state.pendingNetworkFailures}</strong></article>
            </div>
            <section className="resilience-card">
              <dl>
                <div><dt>Session эхэлсэн:</dt><dd>{formatDate(state.sessionStartedAt)}</dd></div>
                <div><dt>Сүүлд online:</dt><dd>{formatDate(state.lastOnlineAt)}</dd></div>
                <div><dt>Сүүлд offline:</dt><dd>{formatDate(state.lastOfflineAt)}</dd></div>
                <div><dt>Сүүлд recovery:</dt><dd>{formatDate(state.lastRecoveryAt)}</dd></div>
              </dl>
              <p>Network тасарч transient алдаа болсон таталтууд online болоход автоматаар queue-д буцна. Authentication, disk болон хэрэглэгчийн cancel алдааг автоматаар давтахгүй.</p>
            </section>
            {error ? <div className="resilience-error">{error}</div> : null}
            <footer className="resilience-actions"><button onClick={onClose}>Хаах</button><button className="primary" disabled={busy || !state.online || state.pendingNetworkFailures === 0} onClick={() => void retry()}>{busy ? 'Сэргээж байна…' : 'Network таталтуудыг дахин оролдох'}</button></footer>
          </>
        ) : <div className="resilience-loading">Recovery төлөв ачаалж байна…</div>}
      </section>
    </div>
  );
}

export function ResilienceLauncher(): ReactElement {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<NetworkResilienceState | null>(null);

  useEffect(() => {
    let active = true;
    void window.subutai.getNetworkResilienceState().then((value) => { if (active) setState(value); });
    const off = window.subutai.onNetworkResilienceChanged((value) => { if (active) setState(value); });
    return () => { active = false; off(); };
  }, []);

  return (
    <>
      <button className={`resilience-launch-button ${state?.online === false ? 'offline' : ''}`} onClick={() => setOpen(true)}><span>⟳</span><b>Recovery</b>{state && state.pendingNetworkFailures > 0 ? <em>{state.pendingNetworkFailures}</em> : null}</button>
      {open ? <ResilienceDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

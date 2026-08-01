import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { ProxyMode, TransferSettings, TransferSettingsUpdate } from '@subutai/shared';

function bytesToMbps(bytes: number): string {
  if (bytes <= 0) return '0';
  return (bytes * 8 / 1_000_000).toFixed(1).replace(/\.0$/, '');
}

function mbpsToBytes(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed * 1_000_000 / 8) : 0;
}

function TransferSettingsDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [settings, setSettings] = useState<TransferSettings | null>(null);
  const [globalMbps, setGlobalMbps] = useState('0');
  const [downloadMbps, setDownloadMbps] = useState('0');
  const [proxyPassword, setProxyPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void window.subutai.getTransferSettings().then((value) => {
      if (!active) return;
      setSettings(value);
      setGlobalMbps(bytesToMbps(value.globalSpeedLimitBytesPerSecond));
      setDownloadMbps(bytesToMbps(value.defaultDownloadSpeedLimitBytesPerSecond));
    });
    const off = window.subutai.onTransferSettingsChanged((value) => {
      if (!active) return;
      setSettings(value);
      setGlobalMbps(bytesToMbps(value.globalSpeedLimitBytesPerSecond));
      setDownloadMbps(bytesToMbps(value.defaultDownloadSpeedLimitBytesPerSecond));
    });
    return () => { active = false; off(); };
  }, []);

  const patch = (update: Partial<TransferSettings>): void => {
    setSettings((current) => current ? { ...current, ...update } : current);
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    if (!settings || busy) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const update: TransferSettingsUpdate = {
        globalSpeedLimitBytesPerSecond: mbpsToBytes(globalMbps),
        defaultDownloadSpeedLimitBytesPerSecond: mbpsToBytes(downloadMbps),
        proxyMode: settings.proxyMode,
        proxyUrl: settings.proxyUrl,
        proxyUsername: settings.proxyUsername,
        retryMaxAttempts: settings.retryMaxAttempts,
        retryBaseDelaySeconds: settings.retryBaseDelaySeconds,
        connectTimeoutSeconds: settings.connectTimeoutSeconds,
        transferTimeoutSeconds: settings.transferTimeoutSeconds,
      };
      if (proxyPassword) update.proxyPassword = proxyPassword;
      setSettings(await window.subutai.updateTransferSettings(update));
      setProxyPassword('');
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const clearPassword = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      setSettings(await window.subutai.updateTransferSettings({ clearProxyPassword: true }));
      setProxyPassword('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="transfer-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="transfer-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="transfer-modal-header">
          <div><span>SUBUTAI NETWORK</span><h2>Хурд, proxy, retry</h2></div>
          <button onClick={onClose}>×</button>
        </header>

        {settings ? (
          <>
            <section className="transfer-card">
              <h3>Хурдны хязгаарлалт</h3>
              <div className="transfer-grid two">
                <label>Нийт хурд · Mbps<input type="number" min="0" step="0.5" value={globalMbps} onChange={(event) => { setGlobalMbps(event.target.value); setSaved(false); }} /><small>0 = хязгаарлалтгүй</small></label>
                <label>Таталт бүр · Mbps<input type="number" min="0" step="0.5" value={downloadMbps} onChange={(event) => { setDownloadMbps(event.target.value); setSaved(false); }} /><small>Тусгай лимитгүй даалгаварт</small></label>
              </div>
            </section>

            <section className="transfer-card">
              <h3>Proxy</h3>
              <div className="proxy-mode-switch">
                {([['off', 'Унтраалттай'], ['system', 'Системийн'], ['manual', 'Гараар']] as Array<[ProxyMode, string]>).map(([mode, label]) => <button key={mode} className={settings.proxyMode === mode ? 'active' : ''} onClick={() => patch({ proxyMode: mode })}>{label}</button>)}
              </div>
              {settings.proxyMode === 'manual' ? (
                <div className="transfer-grid two">
                  <label className="transfer-wide">Proxy URL<input value={settings.proxyUrl} onChange={(event) => patch({ proxyUrl: event.target.value })} placeholder="http://127.0.0.1:8080 эсвэл socks5://host:port" /></label>
                  <label>Хэрэглэгчийн нэр<input value={settings.proxyUsername} onChange={(event) => patch({ proxyUsername: event.target.value })} /></label>
                  <label>Нууц үг<input type="password" value={proxyPassword} onChange={(event) => { setProxyPassword(event.target.value); setSaved(false); }} placeholder={settings.proxyPasswordSet ? 'Хадгалсан · солих бол бичнэ' : 'Нууц үг'} /></label>
                  {settings.proxyPasswordSet ? <button className="clear-proxy-password" disabled={busy} onClick={() => void clearPassword()}>Хадгалсан нууц үгийг арилгах</button> : null}
                </div>
              ) : null}
            </section>

            <section className="transfer-card">
              <h3>Retry ба timeout</h3>
              <div className="transfer-grid four">
                <label>Оролдлого<input type="number" min="1" max="100" value={settings.retryMaxAttempts} onChange={(event) => patch({ retryMaxAttempts: Number(event.target.value) })} /></label>
                <label>Retry хүлээлт · сек<input type="number" min="0" max="300" value={settings.retryBaseDelaySeconds} onChange={(event) => patch({ retryBaseDelaySeconds: Number(event.target.value) })} /></label>
                <label>Холболт · сек<input type="number" min="1" max="600" value={settings.connectTimeoutSeconds} onChange={(event) => patch({ connectTimeoutSeconds: Number(event.target.value) })} /></label>
                <label>Дамжуулалт · сек<input type="number" min="1" max="3600" value={settings.transferTimeoutSeconds} onChange={(event) => patch({ transferTimeoutSeconds: Number(event.target.value) })} /></label>
              </div>
            </section>

            {error ? <div className="transfer-error">{error}</div> : null}
            {saved ? <div className="transfer-saved">Тохиргоо хадгалагдаж, ажиллаж буй таталтуудад хэрэгжлээ.</div> : null}
            <footer className="transfer-actions"><button onClick={onClose}>Хаах</button><button className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Хадгалж байна…' : 'Хадгалах'}</button></footer>
          </>
        ) : <div className="transfer-loading">Тохиргоо ачаалж байна…</div>}
      </section>
    </div>
  );
}

export function TransferSettingsLauncher(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="transfer-launch-button" onClick={() => setOpen(true)}><span>⇅</span><b>Network</b></button>
      {open ? <TransferSettingsDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

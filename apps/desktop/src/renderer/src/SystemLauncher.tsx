import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { SystemSettings, SystemState } from '@subutai/shared';

function updateStatusText(state: SystemState): string {
  switch (state.update.status) {
    case 'checking': return 'Шинэчлэлт шалгаж байна…';
    case 'available': return `${state.update.availableVersion ?? 'Шинэ'} хувилбар бэлэн`;
    case 'not-available': return 'Хамгийн шинэ хувилбар ашиглаж байна';
    case 'downloading': return `Татаж байна ${Math.round(state.update.progressPercent ?? 0)}%`;
    case 'downloaded': return `${state.update.availableVersion ?? 'Шинэ'} хувилбар суулгахад бэлэн`;
    case 'disabled': return 'Development горимд шинэчлэлт идэвхгүй';
    case 'error': return state.update.error ?? 'Шинэчлэлтийн алдаа';
    default: return `Одоогийн хувилбар ${state.update.currentVersion}`;
  }
}

function Toggle({ checked, label, description, onChange }: {
  checked: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <label className="system-toggle-row">
      <span><b>{label}</b><small>{description}</small></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function SystemDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [state, setState] = useState<SystemState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void window.subutai.getSystemState().then((value) => { if (active) setState(value); });
    const off = window.subutai.onSystemStateChanged((value) => { if (active) setState(value); });
    return () => { active = false; off(); };
  }, []);

  const patch = async (value: Partial<SystemSettings>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setState(await window.subutai.updateSystemSettings(value));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const run = async (action: 'check' | 'download'): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = action === 'check'
        ? await window.subutai.checkForUpdates()
        : await window.subutai.downloadUpdate();
      setState(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="system-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="system-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="system-modal-header">
          <div><span>SUBUTAI SYSTEM</span><h2>Tray, мэдэгдэл, шинэчлэлт</h2></div>
          <button onClick={onClose}>×</button>
        </header>

        {state ? (
          <>
            <section className="system-card">
              <h3>System tray</h3>
              <Toggle checked={state.settings.trayEnabled} label="Tray icon" description="Subutai taskbar-ийн notification area-д ажиллана" onChange={(value) => void patch({ trayEnabled: value })} />
              <Toggle checked={state.settings.minimizeToTray} label="Minimize хийхэд нуух" description="Таталт цаанаа үргэлжилнэ" onChange={(value) => void patch({ minimizeToTray: value })} />
              <Toggle checked={state.settings.closeToTray} label="Close хийхэд tray-д үлдээх" description="Tray цэсний Гарах үйлдлээр бүрэн хаана" onChange={(value) => void patch({ closeToTray: value })} />
              <Toggle checked={state.settings.launchAtLogin} label="Windows асахад эхлүүлэх" description="Хэрэглэгч нэвтрэхэд Subutai автоматаар асна" onChange={(value) => void patch({ launchAtLogin: value })} />
            </section>

            <section className="system-card">
              <h3>Мэдэгдэл</h3>
              <Toggle checked={state.settings.notificationsEnabled} label="Desktop мэдэгдэл" description={state.notificationsSupported ? 'Windows notification center ашиглана' : 'Энэ систем дээр дэмжигдэхгүй байна'} onChange={(value) => void patch({ notificationsEnabled: value })} />
              <Toggle checked={state.settings.notifyOnComplete} label="Таталт дуусахад" description="Файлын нэртэй completion notification" onChange={(value) => void patch({ notifyOnComplete: value })} />
              <Toggle checked={state.settings.notifyOnFailure} label="Таталт алдаатай дуусахад" description="Алдааны шалтгааныг мэдэгдэнэ" onChange={(value) => void patch({ notifyOnFailure: value })} />
            </section>

            <section className="system-card update-card">
              <h3>Шинэчлэлт</h3>
              <div className={`update-status ${state.update.status}`}>
                <b>{updateStatusText(state)}</b>
                <small>Одоогийн хувилбар: {state.update.currentVersion}</small>
                {state.update.status === 'downloading' ? <progress max="100" value={state.update.progressPercent ?? 0} /> : null}
              </div>
              <Toggle checked={state.settings.automaticUpdateChecks} label="Автоматаар шалгах" description="App ассан үед шинэ хувилбар шалгана" onChange={(value) => void patch({ automaticUpdateChecks: value })} />
              <Toggle checked={state.settings.automaticUpdateDownloads} label="Автоматаар татах" description="Шинэ хувилбар олдвол background-д татна" onChange={(value) => void patch({ automaticUpdateDownloads: value })} />
              <div className="system-update-actions">
                <button disabled={busy} onClick={() => void run('check')}>Шалгах</button>
                {state.update.status === 'available' ? <button className="primary" disabled={busy} onClick={() => void run('download')}>Татах</button> : null}
                {state.update.status === 'downloaded' ? <button className="primary" onClick={() => void window.subutai.installUpdate()}>Restart & install</button> : null}
              </div>
            </section>

            {error ? <div className="system-error">{error}</div> : null}
            <footer className="system-actions"><button onClick={onClose}>Хаах</button><button onClick={() => void window.subutai.showMainWindow()}>Цонхыг нээх</button></footer>
          </>
        ) : <div className="system-loading">System тохиргоо ачаалж байна…</div>}
      </section>
    </div>
  );
}

export function SystemLauncher(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="system-launch-button" onClick={() => setOpen(true)}><span>◉</span><b>System</b></button>
      {open ? <SystemDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

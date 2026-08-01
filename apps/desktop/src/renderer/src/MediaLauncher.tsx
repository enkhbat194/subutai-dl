import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type {
  DownloadCreateRequest,
  MediaAudioFormat,
  MediaProbeResult,
  MediaQuality,
} from '@subutai/shared';

function MediaDownloadDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [url, setUrl] = useState('');
  const [destination, setDestination] = useState('');
  const [filename, setFilename] = useState('');
  const [mode, setMode] = useState<'video' | 'audio'>('video');
  const [quality, setQuality] = useState<MediaQuality>('1080p');
  const [audioFormat, setAudioFormat] = useState<MediaAudioFormat>('mp3');
  const [playlist, setPlaylist] = useState(false);
  const [subtitles, setSubtitles] = useState(false);
  const [subtitleLanguages, setSubtitleLanguages] = useState('mn,en');
  const [probe, setProbe] = useState<MediaProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const inspectUrl = async (): Promise<void> => {
    if (!url.trim() || probing) return;
    setProbing(true);
    setError('');
    try {
      const result = await window.subutai.probeMedia({ url: url.trim() });
      setProbe(result);
      if (result.isPlaylist) setPlaylist(true);
    } catch (caught) {
      setProbe(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setProbing(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!url.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const request: DownloadCreateRequest = {
        url: url.trim(),
        destination: destination.trim(),
        engine: 'media',
        source: 'desktop',
        media: {
          mode,
          quality,
          audioFormat,
          playlist,
          subtitles,
          subtitleLanguages: subtitleLanguages.split(',').map((value) => value.trim()).filter(Boolean),
          embedMetadata: true,
          embedThumbnail: mode === 'audio',
        },
      };
      if (filename.trim()) request.filename = filename.trim();
      await window.subutai.createDownload(request);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="media-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="media-modal" onSubmit={(event) => void submit(event)} onMouseDown={(event) => event.stopPropagation()}>
        <header className="media-modal-header">
          <div><span>SUBUTAI MEDIA</span><h2>Видео болон аудио татах</h2></div>
          <button type="button" onClick={onClose}>×</button>
        </header>

        <div className="media-url-row">
          <label>URL<input value={url} onChange={(event) => { setUrl(event.target.value); setProbe(null); }} placeholder="YouTube, Facebook, TikTok, Vimeo, HLS, DASH…" autoFocus /></label>
          <button type="button" disabled={!url.trim() || probing} onClick={() => void inspectUrl()}>{probing ? 'Шалгаж байна…' : 'Шинжлэх'}</button>
        </div>

        {probe ? (
          <section className="media-probe-card">
            {probe.thumbnail ? <img src={probe.thumbnail} alt="" /> : <div className="media-probe-placeholder">▶</div>}
            <div><strong>{probe.title}</strong><span>{probe.uploader ?? 'Media source'}</span><small>{probe.isPlaylist ? `Playlist · ${probe.entryCount ?? '?'} бичлэг` : 'Нэг бичлэг'}</small></div>
          </section>
        ) : null}

        <div className="media-type-switch">
          <button type="button" className={mode === 'video' ? 'active' : ''} onClick={() => setMode('video')}>Видео</button>
          <button type="button" className={mode === 'audio' ? 'active' : ''} onClick={() => setMode('audio')}>Аудио</button>
        </div>

        <div className="media-options-grid">
          {mode === 'video' ? (
            <label>Чанар<select value={quality} onChange={(event) => setQuality(event.target.value as MediaQuality)}><option value="best">Хамгийн сайн</option><option value="2160p">4K · 2160p</option><option value="1440p">2K · 1440p</option><option value="1080p">Full HD · 1080p</option><option value="720p">HD · 720p</option><option value="480p">480p</option></select></label>
          ) : (
            <label>Аудио формат<select value={audioFormat} onChange={(event) => setAudioFormat(event.target.value as MediaAudioFormat)}><option value="mp3">MP3</option><option value="m4a">M4A</option><option value="opus">Opus</option><option value="flac">FLAC</option><option value="wav">WAV</option></select></label>
          )}
          <label>Файлын нэр<input value={filename} onChange={(event) => setFilename(event.target.value)} placeholder="Хоосон бол гарчгаас авна" /></label>
          <label className="media-wide">Хадгалах зам<input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Хоосон бол Downloads хавтас" /></label>
        </div>

        <div className="media-checks">
          <label><input type="checkbox" checked={playlist} onChange={(event) => setPlaylist(event.target.checked)} />Playlist-ийг бүхэлд нь татах</label>
          <label><input type="checkbox" checked={subtitles} onChange={(event) => setSubtitles(event.target.checked)} />Subtitle татаж, видеонд суулгах</label>
        </div>
        {subtitles ? <label className="subtitle-languages">Subtitle хэл<input value={subtitleLanguages} onChange={(event) => setSubtitleLanguages(event.target.value)} placeholder="mn,en эсвэл all" /></label> : null}

        {error ? <div className="media-error">{error}</div> : null}
        <footer className="media-modal-actions">
          <button type="button" onClick={onClose}>Цуцлах</button>
          <button type="submit" className="primary" disabled={!url.trim() || submitting}>{submitting ? 'Нэмж байна…' : mode === 'video' ? 'Видео татах' : 'Аудио татах'}</button>
        </footer>
      </form>
    </div>
  );
}

export function MediaLauncher(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="media-launch-button" onClick={() => setOpen(true)}><span>▶</span><b>Видео / Аудио</b></button>
      {open ? <MediaDownloadDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

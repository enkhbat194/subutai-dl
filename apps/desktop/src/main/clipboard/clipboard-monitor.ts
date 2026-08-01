import { clipboard } from 'electron';
import type { ClipboardSettings } from '@subutai/shared';
import { extractClipboardUrls } from './clipboard-policy';

export interface ClipboardDetection {
  text: string;
  urls: string[];
  detectedAt: string;
}

export class ClipboardMonitor {
  private timer: NodeJS.Timeout | null = null;
  private settings: ClipboardSettings;
  private lastText = '';
  private readonly recent = new Map<string, number>();
  private readonly onDetection: (detection: ClipboardDetection) => void | Promise<void>;

  constructor(settings: ClipboardSettings, onDetection: (detection: ClipboardDetection) => void | Promise<void>) {
    this.settings = { ...settings };
    this.onDetection = onDetection;
  }

  updateSettings(settings: ClipboardSettings): void {
    const wasEnabled = this.settings.enabled;
    this.settings = { ...settings };
    if (!wasEnabled && settings.enabled) this.start();
    if (wasEnabled && !settings.enabled) this.stop();
  }

  start(): void {
    if (this.timer || !this.settings.enabled) return;
    this.lastText = clipboard.readText('clipboard');
    this.timer = setInterval(() => void this.tick(), 1_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
    this.recent.clear();
  }

  private async tick(): Promise<void> {
    if (!this.settings.enabled) return;
    const text = clipboard.readText('clipboard').trim();
    if (!text || text === this.lastText) return;
    this.lastText = text;
    const urls = extractClipboardUrls(text, this.settings).filter((url) => this.isOutsideCooldown(url));
    if (urls.length === 0) return;
    const now = Date.now();
    for (const url of urls) this.recent.set(url, now);
    this.pruneRecent(now);
    await this.onDetection({ text, urls, detectedAt: new Date(now).toISOString() });
  }

  private isOutsideCooldown(url: string): boolean {
    const lastSeen = this.recent.get(url);
    return lastSeen === undefined || Date.now() - lastSeen >= this.settings.cooldownMs;
  }

  private pruneRecent(now: number): void {
    const keepFor = Math.max(this.settings.cooldownMs * 3, 60_000);
    for (const [url, seenAt] of this.recent) {
      if (now - seenAt > keepFor) this.recent.delete(url);
    }
  }
}

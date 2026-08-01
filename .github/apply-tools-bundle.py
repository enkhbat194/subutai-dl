from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding="utf-8")


def insert_before(text: str, anchor: str, block: str, label: str) -> str:
    if block.strip() in text:
        return text
    if anchor not in text:
        raise RuntimeError(f"Missing anchor for {label}: {anchor}")
    return text.replace(anchor, block + anchor, 1)


def insert_after(text: str, anchor: str, block: str, label: str) -> str:
    if block.strip() in text:
        return text
    if anchor not in text:
        raise RuntimeError(f"Missing anchor for {label}: {anchor}")
    return text.replace(anchor, anchor + block, 1)


TOOLS_CONTRACTS = """export interface ClipboardSettings {
  enabled: boolean;
  autoEnqueue: boolean;
  captureMultipleUrls: boolean;
  cooldownMs: number;
  maxHistory: number;
  ignoredHosts: string[];
  ignoredExtensions: string[];
}

export interface ClipboardSettingsUpdate extends Partial<ClipboardSettings> {}

export interface ClipboardCapture {
  id: string;
  text: string;
  urls: string[];
  detectedAt: string;
  handled: boolean;
  queuedJobIds: string[];
  error?: string;
}

export interface ClipboardSnapshot {
  settings: ClipboardSettings;
  captures: ClipboardCapture[];
  pendingCount: number;
}

export type SiteGrabberStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
export type SiteResourceKind = 'document' | 'archive' | 'image' | 'audio' | 'video' | 'software' | 'font' | 'other';

export interface SiteGrabberStartRequest {
  rootUrl: string;
  destination: string;
  maxDepth?: number;
  maxPages?: number;
  maxResources?: number;
  sameHostOnly?: boolean;
  includeSubdomains?: boolean;
  includeExtensions?: string[];
  excludePatterns?: string[];
  headers?: DownloadRequestHeaders;
  priority?: QueuePriority;
  connections?: number;
}

export interface SiteGrabberResource {
  id: string;
  url: string;
  sourcePageUrl: string;
  filename: string;
  extension: string;
  kind: SiteResourceKind;
  depth: number;
  queued: boolean;
  jobId?: string;
}

export interface SiteGrabberJob {
  id: string;
  rootUrl: string;
  destination: string;
  status: SiteGrabberStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  maxDepth: number;
  maxPages: number;
  maxResources: number;
  sameHostOnly: boolean;
  includeSubdomains: boolean;
  includeExtensions: string[];
  excludePatterns: string[];
  headers?: DownloadRequestHeaders;
  priority: QueuePriority;
  connections: number;
  scannedPages: number;
  pendingPages: number;
  resources: SiteGrabberResource[];
  errors: Array<{ url: string; error: string }>;
  error?: string;
}

export interface SiteGrabberEnqueueRequest {
  grabberJobId: string;
  resourceIds?: string[];
}

export interface SiteGrabberEnqueueResult {
  queued: number;
  rejected: Array<{ url: string; error: string }>;
  job: SiteGrabberJob;
}

"""

TOOLS_API = """  getClipboardSnapshot(): Promise<ClipboardSnapshot>;
  updateClipboardSettings(settings: ClipboardSettingsUpdate): Promise<ClipboardSnapshot>;
  enqueueClipboardCapture(id: string): Promise<ClipboardSnapshot>;
  dismissClipboardCapture(id: string): Promise<ClipboardSnapshot>;
  clearClipboardHistory(): Promise<ClipboardSnapshot>;
  startSiteGrabber(request: SiteGrabberStartRequest): Promise<SiteGrabberJob>;
  listSiteGrabberJobs(): Promise<SiteGrabberJob[]>;
  getSiteGrabberJob(id: string): Promise<SiteGrabberJob>;
  cancelSiteGrabber(id: string): Promise<SiteGrabberJob>;
  enqueueSiteGrabberResources(request: SiteGrabberEnqueueRequest): Promise<SiteGrabberEnqueueResult>;
"""

TOOLS_EVENTS = """  onClipboardChanged(listener: (snapshot: ClipboardSnapshot) => void): () => void;
  onSiteGrabberChanged(listener: (job: SiteGrabberJob) => void): () => void;
"""

# Shared contracts: preserve resilience contracts and add tools contracts/API.
path = "packages/shared/src/index.ts"
text = read(path)
text = insert_before(text, "export interface BrowserEnqueueMessage {", TOOLS_CONTRACTS, "tools contracts")
text = insert_before(text, "  pauseDownload(id: string): Promise<DownloadJob>;", TOOLS_API, "tools API")
text = insert_before(text, "  minimizeWindow(): Promise<void>;", TOOLS_EVENTS, "tools events")
write(path, text)

# Main entry loads the tools runtime alongside batch and resilience.
path = "apps/desktop/src/main/index.ts"
text = read(path)
if "void import('./tools/utility-runtime');" not in text:
    text = insert_after(
        text,
        "      void import('./resilience/resilience-runtime');",
        "\n      void import('./tools/utility-runtime');",
        "tools runtime import",
    )
write(path, text)

# Preload imports and IPC surface.
path = "apps/desktop/src/preload/index.ts"
text = read(path)
text = insert_after(
    text,
    "  BatchPreviewResult,",
    "\n  ClipboardSettingsUpdate,\n  ClipboardSnapshot,",
    "clipboard preload imports",
)
text = insert_after(
    text,
    "  QueueSnapshot,",
    "\n  SiteGrabberEnqueueRequest,\n  SiteGrabberEnqueueResult,\n  SiteGrabberJob,\n  SiteGrabberStartRequest,",
    "site grabber preload imports",
)
PRELOAD_METHODS = """  getClipboardSnapshot: (): Promise<ClipboardSnapshot> => ipcRenderer.invoke('clipboard:get'),
  updateClipboardSettings: (settings: ClipboardSettingsUpdate): Promise<ClipboardSnapshot> => ipcRenderer.invoke('clipboard:update-settings', settings),
  enqueueClipboardCapture: (id: string): Promise<ClipboardSnapshot> => ipcRenderer.invoke('clipboard:enqueue', id),
  dismissClipboardCapture: (id: string): Promise<ClipboardSnapshot> => ipcRenderer.invoke('clipboard:dismiss', id),
  clearClipboardHistory: (): Promise<ClipboardSnapshot> => ipcRenderer.invoke('clipboard:clear'),
  startSiteGrabber: (request: SiteGrabberStartRequest): Promise<SiteGrabberJob> => ipcRenderer.invoke('site-grabber:start', request),
  listSiteGrabberJobs: (): Promise<SiteGrabberJob[]> => ipcRenderer.invoke('site-grabber:list'),
  getSiteGrabberJob: (id: string): Promise<SiteGrabberJob> => ipcRenderer.invoke('site-grabber:get', id),
  cancelSiteGrabber: (id: string): Promise<SiteGrabberJob> => ipcRenderer.invoke('site-grabber:cancel', id),
  enqueueSiteGrabberResources: (request: SiteGrabberEnqueueRequest): Promise<SiteGrabberEnqueueResult> => ipcRenderer.invoke('site-grabber:enqueue', request),
"""
text = insert_before(text, "  pauseDownload: (id: string): Promise<DownloadJob>", PRELOAD_METHODS, "tools preload methods")
PRELOAD_EVENTS = """  onClipboardChanged: (listener: (snapshot: ClipboardSnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: ClipboardSnapshot): void => listener(snapshot);
    ipcRenderer.on('clipboard:changed', handler);
    return () => ipcRenderer.removeListener('clipboard:changed', handler);
  },
  onSiteGrabberChanged: (listener: (job: SiteGrabberJob) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, job: SiteGrabberJob): void => listener(job);
    ipcRenderer.on('site-grabber:changed', handler);
    return () => ipcRenderer.removeListener('site-grabber:changed', handler);
  },
"""
text = insert_before(text, "  minimizeWindow: (): Promise<void>", PRELOAD_EVENTS, "tools preload events")
write(path, text)

# Renderer composition.
path = "apps/desktop/src/renderer/src/RootApp.tsx"
text = read(path)
if "ClipboardSiteToolsLauncher" not in text:
    text = insert_after(
        text,
        "import { BatchDownloadLauncher } from './BatchDownloadLauncher';",
        "\nimport { ClipboardSiteToolsLauncher } from './ClipboardSiteToolsLauncher';",
        "tools launcher import",
    )
    text = insert_after(
        text,
        "      <ResilienceLauncher />",
        "\n      <ClipboardSiteToolsLauncher />",
        "tools launcher mount",
    )
write(path, text)

path = "apps/desktop/src/renderer/src/main.tsx"
text = read(path)
if "import './tools.css';" not in text:
    text = insert_after(text, "import './resilience.css';", "\nimport './tools.css';", "tools stylesheet")
write(path, text)

# Root scripts.
path = "package.json"
data = json.loads(read(path))
scripts = data.setdefault("scripts", {})
scripts["test:clipboard"] = "node --experimental-strip-types scripts/clipboard-policy-test.mts"
scripts["test:site-grabber"] = "node --experimental-strip-types scripts/site-grabber-test.mts"
write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")

# CI tests.
path = ".github/workflows/ci.yml"
text = read(path)
if "Clipboard monitoring policy tests" not in text:
    marker = "      - name: Failure and recovery policy tests\n        run: pnpm test:failure-policy"
    steps = """      - name: Clipboard monitoring policy tests
        run: pnpm test:clipboard

      - name: Site Grabber local crawl tests
        run: pnpm test:site-grabber

"""
    text = insert_before(text, marker, steps, "tools CI tests")
write(path, text)

print("Clipboard and Site Grabber bundle integrated with resilience mainline.")

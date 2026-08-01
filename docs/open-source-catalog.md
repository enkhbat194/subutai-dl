# SubutaiDL open-source component catalog

This catalog is the starting point for building IDM-level functional coverage without reimplementing mature download, media, browser, storage, and packaging subsystems from zero.

## Selection rules

1. Prefer actively maintained upstream projects with repeatable builds and releases.
2. Integrate through small SubutaiDL adapters instead of scattering third-party APIs across the app.
3. Pin versions and verify checksums for downloaded engine binaries.
4. Keep engine processes isolated from the Electron renderer.
5. Record every license and attribution before redistribution.
6. Do not copy code from repositories with missing, unclear, or incompatible licenses.
7. Use reference projects for architecture and test cases even when their code is not imported.

## Tier A — primary integration candidates

| Repository | Planned role | Integration approach | Current decision |
|---|---|---|---|
| https://github.com/aria2/aria2 | Generic HTTP(S), FTP/SFTP, Metalink, BitTorrent, multi-source download engine | Local sidecar process through JSON-RPC | Primary generic engine candidate; compare against aria2-next before pinning |
| https://github.com/AnInsomniacy/aria2-next | Maintained aria2-compatible engine with modern builds and additional fixes | Local sidecar process through aria2-compatible JSON-RPC | Strong candidate; requires GPL and release audit before distribution |
| https://github.com/yt-dlp/yt-dlp | Media-site extraction, format discovery, playlists, subtitles, metadata | Managed subprocess with structured JSON output and progress events | Primary media extractor |
| https://github.com/FFmpeg/FFmpeg | Audio/video merge, remux, conversion, probing | Managed sidecar executable | Primary media processor; build configuration and license must be pinned |
| https://github.com/nilaoda/N_m3u8DL-RE | Robust HLS/DASH/MSS downloading and live-stream handling | Optional fallback sidecar behind a stream-engine adapter | Candidate fallback for manifests and fragmented streams |
| https://github.com/wxt-dev/wxt | Chrome, Edge, Firefox extension build system | TypeScript browser-extension workspace | Primary extension framework candidate |
| https://github.com/WiseLibs/better-sqlite3 | Persistent queue, history, settings, recovery metadata | Electron main-process database adapter | Primary local database candidate |
| https://github.com/alex8088/electron-vite | Electron main/preload/renderer development and build tooling | Desktop workspace build layer | Primary Electron build candidate |
| https://github.com/electron-userland/electron-builder | Windows installer, portable package, update metadata | Release pipeline | Primary packaging candidate |
| https://github.com/microsoft/playwright | End-to-end desktop/web-extension workflow testing | Automated test suite | Primary UI/E2E test candidate |
| https://github.com/vitest-dev/vitest | Unit and integration testing for TypeScript packages | Workspace test runner | Primary TypeScript test candidate |

## Tier B — architecture and UX reference projects

| Repository | What to study | Import policy |
|---|---|---|
| https://github.com/AnInsomniacy/motrix-next | Modern download-manager architecture, sidecar lifecycle, preferences, task UI, updater and release workflow | Reference first; selectively adapt only license-compatible code with attribution |
| https://github.com/agalwood/Motrix | Electron + aria2 lifecycle, task list, settings, tray integration, installer configuration | Reference and selective MIT-compatible adaptation; avoid legacy stack coupling |
| https://github.com/GopeedLab/gopeed | Download-core boundaries, plugin model, remote API, protocol dispatch and cross-platform service design | GPLv3 reference; do not copy into the proprietary core without an explicit license decision |
| https://github.com/GopeedLab/browser-extension | Download interception, right-click actions, resource sniffing and remote-server routing | Reference only until its license is explicitly confirmed |
| https://github.com/persepolisdm/persepolis | Queue, scheduler, multi-segment controls, video finder, browser integration and recovery UX | GPLv3 reference; behavior and tests may inspire our implementation |
| https://github.com/filecxx/FileCentipede | IDM-like feature inventory, browser integration, protocol breadth, upload/download tools and media handling | Reference only; license/activation model must be treated as incompatible until proven otherwise |
| https://github.com/simov/native-messaging | Native Messaging framing and host registration basics | Protocol reference only; rewrite for Manifest V3, persistent buffering, validation and installer support |
| https://github.com/mdn/webextensions-examples | Standards-based Firefox/WebExtension examples | Reference and test patterns |
| https://github.com/GoogleChrome/chrome-extensions-samples | Manifest V3, service worker, downloads API and native messaging examples | Reference and test patterns |
| https://github.com/JunkFood02/Seal | yt-dlp job creation, format selection and progress UX | Mobile UX/reference only |

## Adapter boundaries

SubutaiDL must expose one internal contract regardless of the selected engine:

```ts
export interface DownloadEngineAdapter {
  probe(input: ProbeRequest): Promise<ProbeResult>;
  create(job: DownloadJob): Promise<EngineTaskHandle>;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  remove(taskId: string, deleteFiles: boolean): Promise<void>;
  events(): AsyncIterable<DownloadEngineEvent>;
}
```

Planned adapters:

- `Aria2Adapter` — direct files, torrents, magnets and multi-source downloads.
- `YtDlpAdapter` — supported media pages, format analysis and metadata.
- `FfmpegAdapter` — probe, merge, remux and conversion jobs.
- `StreamAdapter` — HLS/DASH/MSS fallback through native tools.
- `BrowserBridgeAdapter` — browser interception and Native Messaging requests.

## First comparison targets

Before locking engine versions, test the same workload against candidates:

1. A large HTTP file with byte ranges and 8/16/32 connections.
2. Pause, application restart and resume without corruption.
3. Redirects, cookies, authentication headers and expiring URLs.
4. Unknown content length and chunked transfer.
5. HLS VOD, DASH VOD and separate audio/video tracks.
6. Failed segments, network loss, disk-full condition and retry recovery.
7. Browser interception in Chrome, Edge and Firefox.
8. Windows installer registration, native-host registration and clean uninstall.

## Immediate decision

The initial implementation path is:

```text
Electron + React + TypeScript
        |
        +-- Unified queue and SQLite persistence
        +-- aria2 / aria2-next adapter
        +-- yt-dlp adapter
        +-- FFmpeg adapter
        +-- WXT browser extension
        +-- Native Messaging host
```

No third-party repository will be copied wholesale. SubutaiDL will combine mature engines behind stable adapters and retain its own IDM-style workflow, UI, queue, scheduler, recovery model and product identity.

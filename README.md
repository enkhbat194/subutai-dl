# Subutai

Subutai is a private Windows download manager for fast transfers, recovery, browser integration, media downloads, queues and scheduling.

## Product identity

- Product: **Subutai**
- Formal name: **Subutai Download Manager**
- Windows artifacts: `Subutai-Setup-*` and `Subutai-Portable-*`
- Repository: `subutai-dl`

Subutai is delivered as one application. Bundled dependencies are internal implementation details, not separate user-facing products.

## Current capability groups

- Chrome, Edge and Firefox integration
- Browser interception and right-click actions
- Request context forwarding
- First-party Rust direct-download engine
- Media downloads through temporary `yt-dlp` and `FFmpeg` tooling
- Playlist, subtitles, audio-only, 4K, HLS and DASH options
- Persistent queue and scheduler
- Proxy, speed limits, retry and timeout controls
- Batch and numbered URL expansion
- Clipboard monitoring
- Site Grabber
- System tray, notifications and transactional update handling
- Crash, process-kill, network-interruption and rollback recovery
- Windows Setup and Portable packaging

All original capability groups are implemented and automated checks exist. Setup/Portable, native-engine and transactional updater acceptance pass on the current Windows runner.

This does **not** yet mean the product is a signed Direct 1.0 stable release. Physical installed-browser testing, clean Windows 10/11 acceptance, a real end-user update channel, real published-version rollback and code signing remain pending.

See:

- [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) for the authoritative implementation and remaining-work matrix.
- [`docs/DIRECT_1_0_RELEASE_GATE.md`](docs/DIRECT_1_0_RELEASE_GATE.md) for the ordered physical, clean-machine, updater and signing acceptance gate.
- [`docs/UPDATER_ROLLBACK.md`](docs/UPDATER_ROLLBACK.md) for the transactional updater contract and current acceptance boundary.

## Brand rule

Public UI, notifications, browser extension, installer, artifacts and public errors use only **Subutai** or **Subutai Download Manager**. Dependency names remain only where technically or legally required.

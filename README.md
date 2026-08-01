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
- Direct and media downloads
- Playlist, subtitles, audio-only, 4K, HLS and DASH options
- Persistent queue and scheduler
- Proxy, speed limits, retry and timeout controls
- Batch and numbered URL expansion
- Clipboard monitoring
- Site Grabber
- System tray, notifications and update handling
- Crash and network-interruption recovery
- Windows Setup and Portable packaging

All requested capability groups are implemented and automated checks exist. Physical Windows/browser acceptance and additional production hardening remain.

See [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) for the authoritative implementation and remaining-work matrix.

## Brand rule

Public UI, notifications, browser extension, installer, artifacts and public errors use only **Subutai** or **Subutai Download Manager**. Dependency names remain only where technically or legally required.

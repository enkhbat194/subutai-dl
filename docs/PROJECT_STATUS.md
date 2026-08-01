# Subutai — Authoritative Project Status

Last audited: 2026-08-02
Source of truth: `main` plus merged PRs #3–#12.

## Status definitions

- **Implemented** — production source is present on `main`.
- **Automated verified** — TypeScript/build/policy/smoke checks exist and have passed on the feature PR.
- **Runner verified** — exercised on GitHub Linux/Windows runners.
- **Physical-device verified** — manually accepted on a real Windows PC and real installed browsers.
- **Release-ready** — signed, tagged, install/update/rollback accepted and supported.

## Requested feature inventory

| # | Capability | Implemented | Automated verified | Physical-device verified | Notes |
|---|---|---:|---:|---:|---|
| 1 | Chrome, Edge, Firefox integration | Yes | Yes | Pending | Extension packages, native host registration and installer resources exist. |
| 2 | Browser interception and right-click actions | Yes | Yes | Pending | Link, media, page and selected-URL actions are implemented. |
| 3 | Cookie, header, login and referer forwarding | Yes | Yes | Pending | Cookie, referer, user-agent, authorization and request headers are forwarded through the local native channel. |
| 4 | Subutai video/media system | Yes | Yes | Pending | Media resolution, download and merge pipeline is integrated inside Subutai. |
| 5 | Playlist, subtitles, audio formats, 4K, HLS/DASH | Yes | Yes | Pending | Offline HLS smoke test exists; real-site compatibility matrix is still required. |
| 6 | Persistent queue and scheduler | Yes | Yes | Pending | Priority, concurrency, recurring windows, pause/resume and SQLite persistence are present. |
| 7 | Proxy, speed limit and retry policy | Yes | Yes | Pending | Direct/media shared settings, encrypted proxy secret, timeout and retry controls are present. |
| 8 | Batch and numbered URL downloads | Yes | Yes | Pending | Nested ranges, padding, preview, deduplication and safety limits are present. |
| 9 | Clipboard monitoring | Yes | Yes | Pending | Persistent capture history, filters, cooldown and optional auto-queue are present. |
| 10 | Site Grabber | Yes | Yes | Pending | Bounded crawl, filters, progress, cancellation and queue integration are present. |
| 11 | Tray, notifications and automatic update | Yes | Yes | Pending | Tray lifecycle, launch-at-login, completion/failure notices and update state are present. |
| 12 | Large-file, crash and network-switch resilience | Yes | Yes | Runner verified | Local large-file, process-kill and server-drop/rebind tests pass; physical Wi-Fi/VPN/sleep testing is pending. |

## Current conclusion

All 12 requested capability groups are implemented on `main` and have automated coverage. This does **not** yet mean Subutai is production-complete or fully equal to a mature commercial download manager. The remaining work is acceptance, hardening, UX consolidation and several advanced policies that are not represented in the original 12-item list.

## Product-quality gaps before production release

### P0 — Identity and repository cleanup

1. User-visible branding must be only **Subutai** or **Subutai Download Manager**.
2. Remove stale `SubutaiDL`, `SUBUTAI IDM`, bootstrap and demo wording.
3. Keep third-party names only where technically or legally required: dependency resolution, binary lookup, licenses and third-party notices.
4. Add an automated brand-string gate for renderer, extension, installer and public error messages.
5. Replace stale README/status text with this audited status model.

### P0 — Real acceptance gate

1. Install Setup and Portable builds on clean Windows 10 and Windows 11 systems.
2. Verify Chrome, Edge and Firefox native messaging, interception, context menus, cookies and authenticated downloads.
3. Run direct downloads from multiple real servers: range-supported, no-range, redirects, expiring URLs and interrupted sessions.
4. Run media tests on a maintained site matrix for video, playlist, subtitles, audio-only, HLS and DASH. DRM-protected streams are explicitly out of scope.
5. Test sleep/wake, Wi-Fi disconnect/reconnect, VPN change, proxy change, app kill and Windows restart.
6. Verify update check, update download, restart-to-install and rollback/recovery behavior.

### P1 — IDM-level direct-download parity still missing or incomplete

1. File-conflict policy: rename, overwrite, skip, resume and ask-each-time.
2. Disk-space preflight and destination writability checks.
3. Checksum entry/verification and corrupted-file quarantine.
4. HTTP authentication prompt and credential vault instead of relying only on forwarded headers.
5. Per-site rules for folders, categories, connection count, headers, proxy and interception exclusions.
6. Resume validators using ETag/Last-Modified and safe restart when remote content changes.
7. Dynamic segment sizing and adaptive connection count based on server behavior.
8. Mirror/fallback URL support and integrity-aware failover.
9. Detailed per-connection view, diagnostics and exportable logs.
10. Completion actions: open, run, scan, sleep, hibernate and shutdown with explicit safety controls.
11. Browser extension installation/update lifecycle suitable for normal users, not developer side-loading.
12. Signed Windows installer and executable to reduce SmartScreen/antivirus warnings.

### P1 — Media parity still missing or incomplete

1. In-page video detection/download panel comparable to mature download managers.
2. Real-site regression suite and extractor-update compatibility checks.
3. Format/codec/container detail view before download.
4. Playlist item selection and per-item failure/retry controls.
5. Subtitle language preview and explicit embed/separate-file policy.
6. Media post-processing diagnostics and recoverable merge failures.

### P1 — Architecture and maintainability

1. Consolidate floating feature launchers into one navigation/settings architecture.
2. Add versioned SQLite migrations and downgrade/backup strategy.
3. Add structured logs with secret/header/cookie redaction.
4. Add crash diagnostics without exposing private URLs or credentials.
5. Add browser end-to-end tests, packaged Electron UI tests and installer/uninstaller tests.
6. Add long-running soak tests for large queues, thousands of history rows and repeated pause/resume cycles.
7. Add dependency/SBOM/license/security scanning and third-party notices.
8. Add accessibility, keyboard navigation, DPI scaling and localization review.

## Ordered next execution packages

1. **Product cleanup gate** — branding, README, public errors, navigation consolidation baseline and automated forbidden-string scan.
2. **Windows acceptance harness** — reproducible test server, clean-install checklist, browser E2E and packaged-app diagnostics.
3. **Direct-download correctness** — conflict policy, disk checks, checksum, validators, authentication and per-site rules.
4. **Browser production delivery** — extension install/update lifecycle, exclusions and real-browser regression tests.
5. **Media production hardening** — real-site matrix, format selection, playlist item control and recoverable post-processing.
6. **Release trust** — code signing, tagged stable release, updater acceptance and rollback.
7. **Performance/soak** — large files, large queues, memory/CPU, sleep/network/VPN and repeated recovery cycles.

## Naming policy

- Product name: **Subutai**.
- Formal name where needed: **Subutai Download Manager**.
- Executable/artifact prefix: **Subutai**.
- Public UI, notifications, extension title, installer and public errors must not expose implementation-engine brands.
- Technical source code may reference a dependency only when required to call its executable/API or satisfy its license. Such names are implementation details, never product identity.

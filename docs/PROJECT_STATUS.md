# Subutai — Authoritative Project Status

Last audited: 2026-08-02
Source of truth: `main` plus merged PRs #3–#13 and N0 PR #15.

## Status definitions

- **Implemented** — production source is present on `main`.
- **Automated verified** — build, policy and smoke checks exist and have passed.
- **Runner verified** — exercised on an automated runner.
- **Physical-device verified** — accepted on a real Windows PC and installed browsers.
- **Release-ready** — signed, tagged, install/update/rollback accepted and supported.

## Requested feature inventory

| # | Capability | Implemented | Automated verified | Physical-device verified | Notes |
|---|---|---:|---:|---:|---|
| 1 | Chrome, Edge, Firefox integration | Yes | Yes | Pending | Extension packages, native host registration and installer resources exist. |
| 2 | Browser interception and right-click actions | Yes | Yes | Pending | Link, media, page and selected-URL actions are implemented. |
| 3 | Cookie, header, login and referer forwarding | Yes | Yes | Pending | Cookie, referer, user-agent, authorization and request headers are forwarded through the local native channel. |
| 4 | Subutai video/media system | Yes | Yes | Pending | Media resolution, download and merge pipeline is integrated inside Subutai. |
| 5 | Playlist, subtitles, audio formats, 4K, HLS/DASH | Yes | Yes | Pending | Offline HLS smoke test exists; real-site compatibility testing is still required. |
| 6 | Persistent queue and scheduler | Yes | Yes | Pending | Priority, concurrency, recurring windows, pause/resume and SQLite persistence are present. |
| 7 | Proxy, speed limit and retry policy | Yes | Yes | Pending | Direct/media shared settings, encrypted proxy secret, timeout and retry controls are present. |
| 8 | Batch and numbered URL downloads | Yes | Yes | Pending | Nested ranges, padding, preview, deduplication and safety limits are present. |
| 9 | Clipboard monitoring | Yes | Yes | Pending | Persistent capture history, filters, cooldown and optional auto-queue are present. |
| 10 | Site Grabber | Yes | Yes | Pending | Bounded crawl, filters, progress, cancellation and queue integration are present. |
| 11 | Tray, notifications and automatic update | Yes | Yes | Pending | Tray lifecycle, launch-at-login, completion/failure notices and update state are present. |
| 12 | Large-file, crash and network-switch resilience | Yes | Yes | Runner verified | Local large-file, process-kill and server-drop/rebind tests passed; physical Wi-Fi/VPN/sleep testing is pending. |

## Native engine replacement program

Subutai is being moved from temporary external download/media engines to first-party Subutai engines. The final target will not require a third-party download or media executable.

| Package | Purpose | Source written | Executable checks | Merged to main |
|---|---|---:|---:|---:|
| N0 | Core state, range planning, durable journal and desktop/engine protocol | Yes | Windows self-hosted PASS | Yes — PR #15 |
| N1 | Real HTTP/HTTPS probing and single-file transfer | No | No | No |
| N2 | Segmented transfer, pause/resume and safe recovery | No | No | No |
| N3 | Adaptive connections and dynamic chunking | No | No | No |
| N4 | Replace the desktop app's temporary direct engine | No | No | No |
| N5 | Production acceptance and removal of old release engines | No | No | No |
| M1 | First-party HLS/DASH media core | No | No | No |
| M2 | Maintained website adapters | No | No | No |

### N0 completed and verified work

- First-party Rust core crate with no third-party crate dependencies.
- Download job and segment states with legal transition checks.
- Deterministic byte-range planning with no gaps or overlaps.
- Overflow-safe planning up to the maximum supported integer file size.
- Versioned binary job journal with corruption detection.
- Two alternating recovery copies; a damaged newest copy falls back to the previous valid copy.
- Both damaged copies are preserved and never silently overwritten.
- Disk-backed save, sync, read-back and cleanup self-test.
- Versioned local desktop/engine message format with request IDs and payload limits.
- Partial-read and multiple-message stream handling.
- Truncation, byte-corruption and deterministic arbitrary-input tests.
- Fixed binary example tests to detect accidental format changes.
- Automated policy gate forbidding third-party crates, foreign product identities and unsafe Rust in the native-engine directory.
- Pinned Rust 1.97.1 toolchain and committed Cargo.lock.
- Free self-hosted Windows runner named `subutai-windows`.

### N0 verification evidence

The final N0 run on the real Windows self-hosted runner passed all of the following:

1. Subutai ownership policy.
2. Rust formatter check.
3. Clippy static checks with every warning treated as an error.
4. Native-engine unit and protocol tests.
5. Durable journal disk recovery self-test.
6. Desktop dependency installation.
7. Public Subutai identity gate.
8. Desktop/browser TypeScript checks.
9. Queue, scheduler, transfer, batch, clipboard, Site Grabber, tray/update and failure-policy tests.
10. Release-version consistency.
11. Full desktop production build.

Linux portability verification remains useful but is not a release blocker for the Windows-first product. It will be run later using a free self-hosted Linux environment. Paid GitHub-hosted CI, large resilience runs and installer packaging are retained as manual workflows rather than running automatically.

## Current conclusion

The original 12 capability groups are implemented and have automated coverage. N0, the first-party native-engine foundation, is now implemented and verified on the actual Windows target platform. This does **not** yet mean Subutai is production-complete or fully equal to a mature commercial download manager. The next core milestone is N1: real HTTP/HTTPS probing and safe single-stream transfer.

## Product-quality gaps before production release

### P0 — Real acceptance gate

1. Install Setup and Portable builds on clean Windows 10 and Windows 11 systems.
2. Verify Chrome, Edge and Firefox native messaging, interception, context menus, cookies and authenticated downloads.
3. Run direct downloads from multiple real servers: range-supported, no-range, redirects, expiring URLs and interrupted sessions.
4. Run media tests for video, playlist, subtitles, audio-only, HLS and DASH. DRM-protected streams remain out of scope.
5. Test sleep/wake, Wi-Fi disconnect/reconnect, VPN change, proxy change, app kill and Windows restart.
6. Verify update check, update download, restart-to-install and rollback/recovery behavior.

### P0 — First-party native engine

1. Build N1 HTTP/HTTPS probe and safe single-stream download.
2. Build N2 segmented transfer and verified resume.
3. Build N3 adaptive chunking and connection control.
4. Integrate the new engine into the desktop and browser flow in N4.
5. Complete N5 acceptance, performance and release migration.
6. Remove temporary third-party engine executables from final release resources only after the native replacement passes every gate.
7. Add a free self-hosted Linux portability runner when available.

### P1 — Commercial-grade direct-download behavior

1. File-conflict policy: rename, overwrite, skip, resume and ask-each-time.
2. Disk-space preflight and destination writability checks.
3. Checksum entry/verification and corrupted-file quarantine.
4. HTTP authentication prompt and credential vault.
5. Per-site rules for folders, categories, connections, headers, proxy and interception exclusions.
6. ETag/Last-Modified resume validation and safe restart when remote content changes.
7. Dynamic segment sizing and adaptive connection count.
8. Mirror/fallback URL support and integrity-aware failover.
9. Detailed connection diagnostics and redacted exportable logs.
10. Completion actions with explicit safety controls.
11. Browser extension installation/update suitable for normal users.
12. Signed Windows installer and executable.

### P1 — First-party media engine

1. Direct media, HLS and DASH parsing and transfer.
2. Audio/video track merge using Windows media facilities.
3. Subtitle and playlist item selection.
4. Browser-authenticated media requests.
5. In-page Subutai media panel.
6. Prioritized maintained site adapters with regression fixtures.

### P1 — Architecture and maintainability

1. Consolidate feature launchers into one navigation/settings architecture.
2. Add versioned SQLite migrations and backup/restore strategy.
3. Add structured logs with secret, header and cookie redaction.
4. Add crash diagnostics without exposing private URLs or credentials.
5. Add browser end-to-end, packaged-app and installer/uninstaller tests.
6. Add long-running tests for large queues and repeated pause/resume cycles.
7. Add dependency, license and security reporting for any components still shipped.
8. Add accessibility, keyboard navigation, DPI scaling and localization review.

## Ordered next execution packages

1. **N1 safe transfer** — HTTP/HTTPS metadata probe, redirects, single-stream transfer, temporary file and atomic completion.
2. **N2 resumable transfer** — segments, persistent progress, validators and interruption recovery.
3. **N3 adaptive engine** — dynamic chunks, adaptive connections, writer queue and mirror failover.
4. **N4 desktop replacement** — connect the first-party engine to Subutai's queue, browser, settings and package.
5. **N5 release gate** — Windows acceptance, performance tests, signing and removal of temporary release engines.
6. **M1/M2 media replacement** — first-party media core followed by prioritized site adapters.

## Naming policy

- Product name: **Subutai**.
- Formal name where needed: **Subutai Download Manager**.
- Executable/artifact prefix: **Subutai**.
- Public UI, notifications, extension title, installer and public errors must not expose implementation-engine brands.
- Technical source may reference a temporary dependency only where required to operate or remove it safely. Such names are never part of the product identity.

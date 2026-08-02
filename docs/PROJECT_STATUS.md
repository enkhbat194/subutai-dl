# Subutai — Authoritative Project Status

Last audited: 2026-08-03  
Source of truth: `main`, merged pull requests, source code, and executable Windows-runner evidence.

## Status definitions

- **Implemented** — source exists and is connected to the intended runtime path.
- **Automated verified** — deterministic tests and builds passed.
- **Runner verified** — checks passed on the `subutai-windows` self-hosted Windows computer.
- **Physical verified** — manually accepted through an installed browser and installed desktop application.
- **Clean-machine verified** — accepted on clean Windows 10/11 without development tooling.
- **Release-ready** — signed, tagged, and accepted through the real update and rollback channel.

## Current conclusion

Subutai is a feature-complete engineering build with strong automated Windows acceptance. It is **not yet a signed Direct 1.0 stable release**.

- Normal HTTP/HTTPS downloads use Subutai's first-party Rust native engine.
- Desktop, browser queue, scheduler, pause/resume, integrity and recovery paths are integrated.
- Setup and Portable packages build, launch, install and uninstall on the current Windows runner.
- Transactional update and automatic rollback are implemented and deterministic local two-build acceptance passes.
- Temporary `yt-dlp`, `FFmpeg` and `ffprobe` binaries remain for media downloads until M1/M2.
- Physical browser acceptance, clean Windows 10/11 acceptance, a real end-user update channel, code signing and real published-version rollback remain pending.

## Repository baseline

| Item | Current value |
|---|---|
| Product | Subutai / Subutai Download Manager |
| Default branch | `main` |
| Audited main commit | `b98229b76464f5c56cbf1d6e6fb582b1c82040cd` |
| Application version | `0.1.0` |
| Desktop | Electron + React + TypeScript |
| Direct engine | First-party Rust `subutai-engine-host.exe` |
| Media path | Temporary `yt-dlp` + `FFmpeg` + `ffprobe` |
| Windows outputs | NSIS Setup + Portable |
| Stable public release | Not published |
| Code signing | Pending |

## Capability matrix

| # | Capability | Implemented | Automated | Runner | Physical |
|---|---|---:|---:|---:|---:|
| 1 | Chrome, Edge and Firefox integration | Yes | Yes | Partial | Pending |
| 2 | Browser interception and right-click actions | Yes | Yes | Partial | Pending |
| 3 | Cookie, header, login and referer forwarding | Yes | Yes | Yes | Pending |
| 4 | Direct HTTP/HTTPS downloads | Yes | Yes | Yes | Pending |
| 5 | Media, playlist, subtitle, audio-only, 4K, HLS and DASH through temporary tools | Yes | Yes | Partial | Pending |
| 6 | Persistent queue and scheduler | Yes | Yes | Yes | Pending |
| 7 | Proxy, speed limit, retry and timeout policy | Yes | Yes | Yes | Pending |
| 8 | Batch and numbered URL downloads | Yes | Yes | Yes | Pending |
| 9 | Clipboard monitoring | Yes | Yes | Yes | Pending |
| 10 | Site Grabber | Yes | Yes | Yes | Pending |
| 11 | Tray, notifications and update UI integration | Yes | Yes | Partial | Pending |
| 12 | Crash, process-kill and network interruption recovery | Yes | Yes | Yes | Pending |
| 13 | Transactional update and automatic rollback | Yes | Yes | Yes | Pending real channel |
| 14 | Setup, Portable, install and uninstall | Yes | Yes | Yes | Pending clean machine |

## First-party native direct engine

| Package | Scope | Main status |
|---|---|---|
| N0 | State, range planning, dual-slot durable journal and versioned IPC | PR #15 merged |
| N1 | WinHTTP probe, safe single-stream transfer and SHA-256 | PR #16 merged |
| N2 | Segmented transfer, pause/resume and validator-safe recovery | PR #17 merged |
| N3 | Adaptive connections, dynamic chunking and slow-range replacement | PR #18 merged |
| N4 | Desktop, browser queue and scheduler replacement integration | PR #19 merged |
| N5.1 | Native-engine release path migration | PR #20 merged |
| N5.2 | Reproducible dependency locking | PR #21 merged |
| N5.3 | Native proxy, speed, timeout and retry settings | PR #22 merged |
| N5.4 | Conflict, checksum, quarantine and remote-change policies | PR #23 merged |
| N5.5 | Setup/Portable and Windows production acceptance | PR #24 merged |
| N5.6a | Safe no-range fallback and exponential retry | PR #25 merged |
| N5.6b | Integrity-safe mirror fallback | PR #26 merged |
| N5.6c | Deterministic disk/write/sync/atomic-move failure injection | PR #27 merged |
| N5.6d | Native soak and resource telemetry | PR #28 merged |
| N5.6e | Desktop telemetry schema v3 | PR #29 merged |
| N5.6f | Large-file and concurrent-queue benchmark | PR #30 merged |
| N5.6g | Two-phase Windows restart recovery harness | PR #31 merged |
| N5.7a | Transactional updater and automatic rollback implementation | PR #32 merged |
| M1 | First-party HLS/DASH media core | Pending |
| M2 | Maintained browser-authenticated website adapters | Pending |

## Current direct-download truth

Implemented and automated/runner verified:

- WinHTTP HTTP/HTTPS transport;
- redirect and metadata probe;
- segmented and safe no-range download routes;
- adaptive worker limits and dynamic chunks;
- exact pause/resume offsets;
- ETag, Last-Modified, remote-size and Content-Range safety;
- `.subutai.part` and dual-slot durable resume journal;
- whole-file SHA-256 and atomic completion;
- proxy, speed limit, timeout and retry settings;
- checksum-enforced mirror fallback;
- process-kill and network-drop recovery;
- deterministic disk-space, write, sync and destination-move failure handling;
- persisted native telemetry;
- Setup and Portable packaging with the first-party native host.

Not implemented or not yet accepted:

- explicit HTTP/2 enablement and protocol-used telemetry;
- HTTP/3 enablement and fallback matrix;
- IOCP/asynchronous WinHTTP rewrite;
- clean Windows 10/11 acceptance;
- physical end-to-end browser interception acceptance.

HTTP/2, HTTP/3 and IOCP are optimization/research packages, not Direct 1.0 blockers unless profiling demonstrates a correctness or performance need.

## Transactional updater and rollback

PR #32 implemented:

- atomic durable update transaction journal;
- verified previous Setup installer cache with bounded retention;
- staged target installer verification;
- renderer, preload, native host, browser bridge and SQLite startup-health confirmation;
- external watchdog;
- bounded failed-startup detection;
- one-attempt verified silent rollback;
- intentional-exit handling;
- settings, database, queue and partial-download preservation;
- Chrome, Edge and Firefox native-messaging restoration;
- checksum mismatch and corrupt-journal fail-safe behavior;
- deterministic local previous/target build acceptance.

The current acceptance does **not** prove:

- update from an independently published previous production installer;
- public end-user update distribution;
- real update and rollback after a Windows reboot;
- signed installer rollback;
- overnight updater/rollback soak.

## Release distribution decision required

The source repository is private while the desktop package currently declares a GitHub release provider. Direct 1.0 must select and accept an end-user distribution design that does not embed a personal access token in the application.

Allowed candidate designs:

1. a public binary-only GitHub release repository while source remains private;
2. a generic HTTPS update server such as object storage/CDN;
3. a private personal channel only for owner-operated machines, with credentials supplied outside the application.

No design is considered accepted until a real `0.1.0 -> 0.1.1` update and a failed-target rollback pass through that channel.

## Remaining Direct 1.0 release gates

See [`DIRECT_1_0_RELEASE_GATE.md`](DIRECT_1_0_RELEASE_GATE.md) for the ordered acceptance matrix.

Highest-priority remaining gates:

1. choose and implement the real update distribution channel;
2. perform installed Chrome, Edge and Firefox end-to-end acceptance;
3. perform real authenticated/cookie/referer/expiring-URL downloads;
4. complete clean Windows 11 acceptance;
5. complete clean Windows 10 acceptance;
6. perform real two-version update, failed startup and rollback;
7. configure code signing and verify signed outputs;
8. fix release-quality warnings and add product icon assets;
9. publish a draft prerelease only after every required gate passes.

## Known release-quality debt

- application and installer icon assets are not configured;
- restart/resilience scripts have emitted FileHandle garbage-collection warnings and should close handles explicitly;
- GitHub Actions dependencies emit Node runtime deprecation warnings;
- packaged Electron currently emits the Node SQLite experimental warning;
- the richer user-facing `ask` destination-conflict flow remains pending;
- diagnostics export and clear updater/rollback evidence should be exposed for support.

These are tracked defects or hardening tasks. A green automated workflow does not erase them.

## Required next package order

1. **S0 — status reset and release-gate documentation**.
2. **U1 — real update distribution architecture and acceptance**.
3. **A1 — physical desktop/browser/media acceptance**.
4. **UX1 — release-quality UI, diagnostics and defect fixes**.
5. **C1 — clean Windows 11 and Windows 10 acceptance**.
6. **R1 — real two-version update and rollback acceptance**.
7. **S1 — code signing and draft prerelease**.
8. **P1 — protocol observability, HTTP/2 first; HTTP/3 only afterward**.
9. **M1/M2 — first-party media core and maintained adapters after Direct 1.0**.
10. **T1 — measured Tauri feasibility spike after Direct 1.0; no migration commitment**.

## Naming policy

- Product: **Subutai**.
- Formal name where required: **Subutai Download Manager**.
- Executable and artifact prefix: **Subutai**.
- Public UI, notifications, extensions, installer and public errors expose only Subutai product identity.
- Temporary component names may appear only in technical provisioning, license and removal-policy code.

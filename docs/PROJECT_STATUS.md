# Subutai — Authoritative Project Status

Last audited: 2026-08-02  
Source of truth: `main`, merged pull requests, the active N5 acceptance pull request, and executable Windows-runner evidence.

## Status definitions

- **Implemented** — source exists and is connected to its intended runtime path.
- **Automated verified** — deterministic tests and build checks passed.
- **Runner verified** — checks passed on the actual `subutai-windows` self-hosted Windows computer.
- **Physical-browser verified** — manually accepted through an installed browser and installed desktop application.
- **Release-ready** — signed, tagged, clean-machine install/update/rollback accepted.

## Product capability inventory

| # | Capability | Implemented | Automated verified | Runner verified | Physical-browser verified |
|---|---|---:|---:|---:|---:|
| 1 | Chrome, Edge and Firefox integration | Yes | Yes | Partial | Pending |
| 2 | Browser interception and right-click actions | Yes | Yes | Partial | Pending |
| 3 | Cookie, header, login and referer forwarding | Yes | Yes | Yes | Pending |
| 4 | Subutai video/media system | Yes | Yes | Partial | Pending |
| 5 | Playlist, subtitles, audio formats, 4K, HLS/DASH through the temporary media path | Yes | Yes | Partial | Pending |
| 6 | Persistent queue and scheduler | Yes | Yes | Yes | Pending |
| 7 | Proxy, speed limit, retry and timeout policy | Yes | Yes | Yes | Pending |
| 8 | Batch and numbered URL downloads | Yes | Yes | Yes | Pending |
| 9 | Clipboard monitoring | Yes | Yes | Yes | Pending |
| 10 | Site Grabber | Yes | Yes | Yes | Pending |
| 11 | Tray, notifications and automatic-update integration | Yes | Yes | Partial | Pending |
| 12 | Large-file, crash and network interruption resilience | Yes | Yes | Partial | Pending |

All original capability groups exist. This does not yet mean the product is a signed Direct 1.0 stable release.

## First-party native direct engine

Direct HTTP/HTTPS downloads now use Subutai’s first-party Rust engine. The Windows release path rejects the replaced direct-download executable and requires `subutai-engine-host.exe`.

Temporary `yt-dlp` and `FFmpeg` binaries remain only for the media path until M1/M2 replace that scope. They do not perform normal direct downloads.

| Package | Scope | Source | Windows checks | Main status |
|---|---|---:|---:|---:|
| N0 | State, range planning, durable journal and versioned IPC | Complete | PASS | PR #15 merged |
| N1 | HTTP/HTTPS probe, safe single-stream transfer and SHA-256 | Complete | PASS | PR #16 merged |
| N2 | Segmented transfer, pause/resume and validator-safe recovery | Complete | PASS | PR #17 merged |
| N3 | Adaptive connections, dynamic chunking and slow-range replacement | Complete | PASS | PR #18 merged |
| N4 | Desktop, browser queue and scheduler replacement integration | Complete | PASS | PR #19 merged |
| N5 | Direct 1.0 production gate | In progress | Current gates PASS | N5.1–N5.5 implemented |
| M1 | First-party HLS/DASH media core | Pending | Pending | Pending |
| M2 | Maintained website adapters | Pending | Pending | Pending |

## N5 completed engineering packages

### N5.1 — release path migration, PR #20

- Removed the replaced direct-download engine from release installation and packaging.
- Required `subutai-engine-host.exe` in Windows package validation.
- Added a negative package assertion preventing the legacy direct executable from entering Setup or Portable builds.
- Kept only temporary media tooling until M1/M2.

### N5.2 — reproducible dependency graph, PR #21

- Committed the pnpm v9 lockfile.
- Pinned pnpm `10.15.0`.
- Enforced `pnpm install --frozen-lockfile` in CI and release workflows.
- Added a dependency-lock policy gate.

### N5.3 — native transfer settings, PR #22

- Versioned desktop IPC now carries proxy mode, endpoint, private credentials, speed limits, retry policy and timeouts.
- Direct downloads support proxy off, Windows system proxy and explicit HTTP proxy.
- WinHTTP applies connect and transfer timeouts.
- Proxy challenge handling covers Windows Negotiate, NTLM, Digest and Basic schemes.
- One shared limiter caps aggregate segmented throughput.
- A real Windows acceptance test verified manual proxy routing, speed limiting and exact final bytes.

### N5.4 — integrity and conflict policies, PR #23

- Added rename, overwrite, skip and verified-resume destination policies.
- Added expected SHA-256 validation before queueing and after native completion.
- Mismatched completed files move to a unique `.subutai.corrupt` quarantine path.
- Changed remote content can trigger one clean product-layer restart.
- Public diagnostics redact authorization, proxy authorization, cookies, URL credentials and sensitive query values.

### N5.5 — Windows production acceptance, PR #24

- Replaced the obsolete direct-engine resilience suite with first-party Subutai process-kill and network-drop recovery tests.
- Added checksum-verified, pinned temporary media-tool provisioning without Chocolatey.
- Built Setup and Portable packages on the actual Windows runner.
- Fixed the packaged Electron preload contract by emitting and loading sandbox-compatible `index.cjs`.
- Verified the unpacked packaged application launches with its renderer API connected.
- Verified Portable launch through the portable wrapper.
- Verified silent Setup installation into an isolated directory.
- Verified packaged native engine and browser-extension resources.
- Verified Chrome, Edge and Firefox native-messaging registry manifests point to the installed Subutai executable.
- Verified the installed application launches successfully.
- Verified silent uninstall removes the executable, registry keys and native-messaging manifests.
- Stable release workflow now requires the same native resilience, package launch and install/uninstall acceptance before publication.

### N5.5 executable evidence

The final check-only runs on `subutai-windows` passed:

1. Native ownership policy, Rust formatting and Clippy with warnings as errors.
2. All native unit and integration tests.
3. Durable journal self-test and release native-host build.
4. Frozen dependency installation and release-engine policy.
5. Integrity, conflict, quarantine and diagnostic-redaction policy tests.
6. Desktop and browser TypeScript contracts.
7. Queue, transfer, batch, clipboard, Site Grabber, system and failure/recovery tests.
8. Clean 16 MiB segmented transfer with exact SHA-256.
9. Forced process termination after persisted progress, followed by exact resume.
10. Network socket drop and same-port recovery, followed by exact completion.
11. Setup and Portable package production build.
12. Packaged application launch with CommonJS preload and renderer API.
13. Portable-wrapper launch acceptance.
14. Silent Setup install and installed-app launch.
15. Chrome, Edge and Firefox native-messaging registration checks.
16. Silent uninstall and browser-bridge cleanup.

No tag, GitHub Release, deployment or signing was performed by the N5.5 acceptance workflow.

## Current direct-download truth

- Normal HTTP/HTTPS direct downloads use the first-party Subutai Rust engine.
- The replaced direct-download executable is forbidden from release resources.
- Pause, resume, cancel, process restart, network interruption, remote-validator safety, checksum verification and atomic completion are automated and Windows-runner verified.
- Proxy, speed limit, retry and timeout settings reach the native transport through private versioned IPC.
- Setup and Portable packaging, launch, install and uninstall are Windows-runner verified on the current runner machine.
- Media-site extraction still uses temporary `yt-dlp` and `FFmpeg` tooling until M1/M2.

## Why N5 is not yet marked release-ready

The locked N5 definition includes gates that cannot honestly be inferred from the current single-machine acceptance run.

### Remaining engineering gates

1. Complete the remaining Direct 1.0 correctness matrix, including explicit mirror/fallback behavior and additional no-range/authentication edge cases.
2. Add deterministic disk-full, destination-loss and write-failure acceptance.
3. Add sleep/wake and actual Windows restart recovery evidence beyond process-kill recovery.
4. Add long-running large-file and large-queue soak tests with memory, handle and file-descriptor monitoring.
5. Add reproducible performance benchmark records: throughput, first-byte time, CPU, memory, disk rate, connection history, retries and final SHA-256.
6. Persist and expose connection/retry/replacement telemetry in product diagnostics.
7. Add a user-facing `ask` conflict flow; current API defaults use safe automatic policies.

### Remaining external release gates

1. Clean Windows 10 x64 acceptance.
2. Clean Windows 11 x64 acceptance independent of the development runner state.
3. Manual installed Chrome, Edge and Firefox end-to-end interception acceptance.
4. Real authenticated downloads using cookies, headers and expiring URLs.
5. A real code-signing certificate and protected signing secrets.
6. Signed installer and executable verification.
7. Tagged stable release, updater download, upgrade and rollback acceptance.

Signing cannot be completed without an externally issued certificate and repository secrets. Clean-machine and physical-browser acceptance require the corresponding machines/browsers; they are not replaced by compile success.

## Current conclusion

N0 through N4 are complete and merged. N5.1 through N5.5 are implemented and Windows-runner verified. The direct-download runtime and release package no longer use the replaced direct engine.

N5 as a whole remains **in progress**, not release-ready, until the remaining correctness, soak, clean-machine, physical-browser, signing and updater/rollback gates pass.

## Ordered next packages

1. **N5.6 — correctness, failure injection, benchmark and soak matrix**.
2. **N5.7 — clean Windows/browser, signing, stable updater and rollback acceptance**.
3. **M1 — first-party HLS/DASH media core**.
4. **M2 — maintained browser-authenticated website adapters**.

## Naming policy

- Product: **Subutai**.
- Formal name where required: **Subutai Download Manager**.
- Executable and artifact prefix: **Subutai**.
- Public UI, notifications, extension, installer and public errors expose only Subutai product identity.
- Temporary component names may appear only in technical provisioning, license and removal policy code; they are never part of the public product identity.

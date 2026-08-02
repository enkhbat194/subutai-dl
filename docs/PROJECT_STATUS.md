# Subutai — Authoritative Project Status

Last audited: 2026-08-02
Source of truth: `main` plus merged PRs and the currently verified native-engine package.

## Status definitions

- **Implemented** — source exists and is connected to its intended package.
- **Automated verified** — deterministic tests and build checks passed.
- **Runner verified** — checks passed on the actual Windows self-hosted runner.
- **Physical-device verified** — manually accepted in the installed desktop/browser product.
- **Release-ready** — signed, tagged, install/update/rollback accepted.

## Original requested capability inventory

| # | Capability | Implemented | Automated verified | Physical-device verified |
|---|---|---:|---:|---:|
| 1 | Chrome, Edge and Firefox integration | Yes | Yes | Pending |
| 2 | Browser interception and right-click actions | Yes | Yes | Pending |
| 3 | Cookie, header, login and referer forwarding | Yes | Yes | Pending |
| 4 | Subutai video/media system | Yes | Yes | Pending |
| 5 | Playlist, subtitles, audio formats, 4K, HLS/DASH | Yes | Yes | Pending |
| 6 | Persistent queue and scheduler | Yes | Yes | Pending |
| 7 | Proxy, speed limit and retry policy | Yes | Yes | Pending |
| 8 | Batch and numbered URL downloads | Yes | Yes | Pending |
| 9 | Clipboard monitoring | Yes | Yes | Pending |
| 10 | Site Grabber | Yes | Yes | Pending |
| 11 | Tray, notifications and automatic update | Yes | Yes | Pending |
| 12 | Large-file, crash and network-switch resilience | Yes | Yes | Partial |

All 12 capability groups exist. They are not yet equivalent to a completed commercial release because clean-install browser acceptance, signing, real-site media testing and first-party engine replacement remain.

## First-party native-engine replacement

Final Subutai releases must not require a third-party download or media executable. Temporary release engines remain only until the first-party replacements pass every migration gate.

| Package | Purpose | Source | Windows checks | Main |
|---|---|---:|---:|---:|
| N0 | State, range planning, durable journal and desktop/engine protocol | Complete | PASS | PR #15 |
| N1 | HTTP/HTTPS probe and safe single-stream transfer | Complete | PASS | PR #16 |
| N2 | Segmented transfer, pause/resume and safe recovery | Pending | Pending | Pending |
| N3 | Adaptive connections and dynamic chunking | Pending | Pending | Pending |
| N4 | Replace the desktop direct-download path | Pending | Pending | Pending |
| N5 | Production acceptance and old-engine removal | Pending | Pending | Pending |
| M1 | First-party HLS/DASH media core | Pending | Pending | Pending |
| M2 | Maintained website adapters | Pending | Pending | Pending |

## N0 — completed and verified

- First-party Rust core with no third-party crate dependencies.
- Download job and segment states with legal transition checks.
- Overflow-safe deterministic byte-range planning.
- Versioned binary job journal with corruption detection.
- Alternating recovery copies and safe fallback to the previous valid copy.
- Refusal to overwrite data when both recovery copies are damaged.
- Disk-backed save, sync, read-back and cleanup self-test.
- Versioned desktop/engine message format with request IDs and payload limits.
- Partial-read, multiple-message, truncation and arbitrary-input tests.
- Policy gate forbidding external product identities, third-party crates and unaudited unsafe Rust.
- Pinned Rust toolchain, Cargo.lock and free Windows self-hosted validation.

## N1 — completed and verified

- First-party Windows HTTP/HTTPS transport using the operating system network and TLS facilities.
- HTTP/HTTPS URL parsing and rejection of embedded URL credentials.
- HEAD metadata probe with one-byte GET fallback when HEAD is unsupported.
- Automatic redirects with secure-to-insecure downgrade blocked and a bounded redirect count.
- Final URL, status, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified and Content-Type extraction.
- Safe Content-Disposition filename extraction and Windows filename sanitization.
- Cookie, referer, authorization and other request headers through validated header objects.
- Header injection rejection for CR, LF and NUL characters.
- Safe single-stream download to `<destination>.subutai.part`.
- Destination conflict and existing-partial-file protection.
- Parent-directory creation and relative destination support.
- Disk-space preflight when the remote size is known.
- Bounded 64 KiB streaming buffer, byte-count progress, elapsed time and transfer-rate reporting.
- First-party SHA-256 implementation with standard known-answer tests.
- Content-length verification before completion.
- File flush and atomic final move; an incomplete file is never presented as completed.
- `subutai-engine probe <url>` command.
- `subutai-engine download <url> <destination>` command.
- Deterministic local Windows test server covering redirect, metadata, actual byte transfer, final hash and partial-to-final behavior.
- Unsafe Rust restricted to one audited Windows API boundary; business logic remains safe Rust.

## Latest N1 verification evidence

The final check-only run on `subutai-windows` passed:

1. Subutai native ownership policy.
2. Rust formatting check.
3. Static checks with every warning treated as an error.
4. N0 unit, journal and protocol tests.
5. N1 SHA-256 vectors.
6. N1 local HTTP redirect and metadata probe.
7. N1 real byte-stream download, size check, hash check and atomic completion.
8. Durable journal self-test.
9. Public Subutai identity gate.
10. Desktop and browser TypeScript checks.
11. Queue, scheduler, transfer, batch, clipboard, Site Grabber, tray/update and failure-policy tests.
12. Release-version consistency.
13. Full desktop production build.

Paid hosted CI, large resilience suites and installer packaging are retained as manual workflows. Normal native-engine and desktop regression checks run free on `subutai-windows`.

## Current conclusion

N0 and N1 are complete. Subutai now has its own verified state/recovery foundation and its own safe Windows HTTP/HTTPS single-stream transfer path. The next milestone is N2: segmented transfer, persistent progress, pause/resume and validator-safe recovery. The existing desktop application does not switch to the new engine until N2 and the N4 integration gate are complete.

## Remaining release-critical work

### First-party direct engine

1. N2 segmented byte-range transfer.
2. Persistent per-segment progress and verified pause/resume.
3. ETag/Last-Modified validator checks before resume.
4. Safe restart when remote content changes.
5. N3 dynamic segment sizing and adaptive connection count.
6. Network interruption, sleep/wake and process-kill recovery on the new engine.
7. Proxy, authentication, speed limits, retries and mirror fallback on the new engine.
8. N4 desktop, browser, queue and scheduler integration.
9. N5 performance, installer and migration acceptance.
10. Remove temporary release engines only after the replacement passes every gate.

### Product acceptance

1. Clean Windows 10 and Windows 11 Setup/Portable tests.
2. Installed Chrome, Edge and Firefox end-to-end tests.
3. Authenticated downloads with real cookies, headers and expiring URLs.
4. File-conflict policies: ask, rename, overwrite, skip and verified resume.
5. Checksum input, corrupted-file quarantine and redacted diagnostics.
6. Signed executable and installer, tagged release, updater and rollback acceptance.
7. Long-running large-file, large-queue and repeated interruption tests.

### First-party media

1. M1 direct media, HLS and DASH parsing and transfer.
2. Audio/video track merge using Windows media facilities.
3. Subtitle and playlist selection.
4. Browser-authenticated media requests and in-page Subutai media panel.
5. M2 prioritized maintained website adapters with regression fixtures.

### Architecture and usability

1. Consolidate feature launchers into one navigation/settings architecture.
2. Versioned database migrations and backup/restore strategy.
3. Structured logs with secret, header and cookie redaction.
4. Packaged-app and installer/uninstaller tests.
5. Accessibility, keyboard navigation, DPI scaling and localization review.

## Ordered next packages

1. **N2 resumable segmented transfer**.
2. **N3 adaptive engine**.
3. **N4 desktop replacement**.
4. **N5 production migration and release gate**.
5. **M1/M2 first-party media replacement**.

## Naming policy

- Product: **Subutai**.
- Formal name where required: **Subutai Download Manager**.
- Executable and artifact prefix: **Subutai**.
- Public UI, notifications, extension, installer and public errors must expose only Subutai product identity.
- Technical source may mention a temporary component only where required to operate or remove it safely; it is never part of the product identity.

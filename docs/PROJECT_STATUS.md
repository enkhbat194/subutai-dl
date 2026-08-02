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

All 12 capability groups exist. They are not yet equivalent to a completed commercial release because clean-install browser acceptance, signing, real-site media testing and first-party engine migration remain.

## First-party native-engine replacement

Final Subutai releases must not require a third-party download or media executable. Temporary release engines remain only until the first-party replacements pass every migration gate.

| Package | Purpose | Source | Windows checks | Main |
|---|---|---:|---:|---:|
| N0 | State, range planning, durable journal and desktop/engine protocol | Complete | PASS | PR #15 |
| N1 | HTTP/HTTPS probe and safe single-stream transfer | Complete | PASS | PR #16 |
| N2 | Segmented transfer, pause/resume and validator-safe recovery | Complete | PASS | PR #17 |
| N3 | Adaptive connections, dynamic chunking and range replacement | Complete | PASS | PR #18 |
| N4 | Replace the desktop direct-download path | Complete | PASS | PR #19 |
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
- Destination conflict, existing-partial-file and disk-space protection.
- Bounded streaming buffer, progress, elapsed time and transfer-rate reporting.
- First-party SHA-256 with standard known-answer tests.
- Content-length verification, file flush and atomic final move.
- `subutai-engine probe <url>` and `subutai-engine download <url> <destination>` commands.
- Deterministic local Windows tests for redirect, metadata, byte transfer, hash and completion.

## N2 — completed and verified

- Concurrent first-party byte-range workers with disjoint writes into one preallocated `.subutai.part` file.
- Segment count and minimum segment size controls built on the N0 overflow-safe range planner.
- Per-segment start, end, completed-byte count and state persisted in the durable dual-slot journal.
- Checkpointed progress while data is actively transferring.
- Thread-safe pause, resume and cancel control shared by every worker.
- Pause leaves the partial file and journal intact; cancel removes resumable state intentionally.
- Resume starts each unfinished segment from its exact persisted byte offset.
- Mandatory HTTP `206 Partial Content` and exact `Content-Range` validation for every segment.
- Remote total-size validation before any persisted transfer is resumed.
- Strong ETag preferred for `If-Range`; Last-Modified used when no strong ETag is available.
- Resume refused when ETag, Last-Modified or remote size changes.
- Validator-less resume refused after any bytes have been persisted.
- Active or failed segment states normalized safely after process interruption.
- Crash-window recovery for journals already in verifying or completed state.
- Full-file SHA-256 after all ranges finish, followed by atomic final move.
- `subutai-engine download-segmented <url> <destination> [segments] [minimum-segment-bytes]` command.
- Re-running the same CLI URL and destination resumes the saved transfer automatically.
- Mid-transfer test pauses after real nonzero progress, persists 524 KiB in the observed runner execution, then resumes remaining ranges and verifies exact final bytes.
- Validator-change test confirms a saved transfer is preserved but never mixed with changed remote content.

## N3 — completed and verified

- Adaptive policy is implemented in safe Rust with no new third-party crate dependency.
- `requested_segments` is the maximum concurrent connection budget for new adaptive transfers.
- File size and target chunk size determine the dynamic journal chunk count.
- Chunk count is bounded by `maximum connections × chunks per connection` and the configured minimum chunk size.
- New downloads can persist substantially more chunks than active connections, allowing workers to consume a durable work queue without changing the N0 journal format.
- An adaptive connection gate starts at the configured minimum and ramps toward the maximum after healthy throughput samples or successful chunks.
- Slow or transiently failing workers reduce the connection limit before replacement, preventing uncontrolled connection growth against overloaded servers.
- Each slow worker checkpoints its exact contiguous byte offset, closes the current response and opens a replacement range request from the saved offset.
- Windows, file I/O, truncated-range and retryable HTTP failures use bounded replacement attempts with increasing backoff.
- Non-retryable validator, range and protocol failures still fail immediately; changed remote content is never mixed with saved bytes.
- Replacement exhaustion returns an explicit segment, attempt count and final reason.
- Progress telemetry now includes active connections, current connection limit, peak connections, queued chunks, slow-range replacements and transient retries.
- Pause, resume, cancel, ETag/Last-Modified validation, whole-file SHA-256 and atomic completion retain the N2 guarantees.
- Deterministic unit tests verify dynamic chunk planning and connection ramp-up/backoff behavior.
- The Windows integration test creates 25 dynamic chunks for a 6 MiB transfer with a four-connection budget.
- Its first real range is deliberately throttled below the configured threshold; Subutai checkpoints and replaces that connection, scales above one concurrent worker and verifies the exact final bytes.

## N4 — completed and verified

- Desktop direct-download tasks now run through the first-party `subutai-engine-host` Rust process.
- The existing desktop, browser bridge, queue, scheduler and renderer contracts remain stable while the internal direct engine adapter is replaced.
- One native host process owns one direct task, keeping pause, resume, cancel and failure isolation explicit.
- Desktop and host communicate through the N0 versioned, length-prefixed and checksummed binary IPC frame format.
- A separate versioned desktop payload carries task ID, URL, destination, connection budget, chunk/checkpoint sizes and validated request headers.
- Cookie, referer, authorization and other forwarded values travel through stdin IPC and are never placed in process command-line arguments.
- The Electron task registry maps native waiting, active, paused, complete, error and removed events back into the existing queue status format.
- Pause sends a native control frame, preserves the partial file and durable journal, and allows the host process to exit cleanly.
- Resume starts a new native process with the same task and destination; N2 restores every unfinished chunk from its saved byte offset.
- Cancel removes the native partial file and both durable journal recovery slots.
- Browser-created direct jobs and scheduled direct jobs enter the same first-party engine path through the existing runtime queue.
- Desktop shutdown pauses active native tasks before the application exits.
- The packaged Windows application builds and embeds `subutai-engine-host.exe` as a release resource.
- The replaced direct-download service source was removed from the desktop runtime.
- Media downloads remain on the temporary media path until the M1 first-party HLS/DASH replacement is complete.

## Latest N4 verification evidence

The Windows self-hosted runner passed:

1. Rust desktop payload round-trip, malformed input and task-state tests.
2. N0 IPC checksum, partial-read, multi-frame and corruption tests.
3. A real `subutai-engine-host.exe` child process started from the integration test.
4. A private request header crossed the binary IPC boundary and reached the local HTTP range server.
5. A real direct download advanced beyond 256 KiB before desktop pause was requested.
6. The first host checkpointed progress, emitted paused state and exited successfully.
7. The partial file and durable journal remained after pause.
8. A second host process resumed the same task from saved state and completed the file.
9. The resumed final file matched the source byte-for-byte, and partial/journal files were removed.
10. A separate real-process cancel test emitted removed state and cleaned every resumable file.
11. Release `subutai-engine-host.exe` build.
12. Public Subutai identity gate.
13. Desktop and browser TypeScript checks.
14. Queue, scheduler, transfer, batch, clipboard, Site Grabber, tray/update and failure-policy tests.
15. Release-version consistency.
16. Full desktop production build.

## Latest N3 verification evidence

The final check-only run on the Windows self-hosted runner passed:

1. Subutai native ownership policy with zero third-party Rust crates and one audited unsafe Windows boundary.
2. Rust formatting check.
3. Clippy with every warning treated as an error.
4. N0 state, journal, corruption and protocol tests.
5. N1 metadata, redirect, transfer and SHA-256 tests.
6. N2 concurrent transfer, nonzero pause/resume and validator-change tests.
7. N3 dynamic chunk planner unit tests.
8. N3 adaptive connection ramp-up and backoff unit tests.
9. N3 real slow-range detection, checkpoint and replacement.
10. N3 real connection scaling with bounded maximum concurrency.
11. Exact final byte equality, whole-file SHA-256 and atomic completion.
12. Durable journal self-test.
13. Public Subutai identity gate.
14. Desktop and browser TypeScript checks.
15. Queue, scheduler, transfer, batch, clipboard, Site Grabber, tray/update and failure-policy tests.
16. Release-version consistency.
17. Full desktop production build.

Normal native-engine and desktop regression checks run free on `subutai-windows`. Paid hosted CI, large resilience suites and installer packaging remain manual workflows.

## Current conclusion

N0 through N4 are complete and runner verified. Desktop direct downloads created from the app, browser bridge, queue and scheduler now run through Subutai’s first-party native engine. The first-party media replacement, physical installed-browser acceptance and N5 production migration gates remain incomplete.

## Remaining release-critical work

### First-party direct engine

1. Persist and display N3 connection, queue, retry and replacement telemetry in the desktop UI.
2. Implement explicit file-conflict and changed-remote restart policies at the product layer.
3. N5 long-running network interruption, sleep/wake, process-kill and large-file acceptance.
4. Add proxy, speed-limit, authentication challenge and mirror-fallback acceptance to the first-party path.
5. Validate Setup, Portable, updater and rollback with the first-party engine bundled.
6. Remove temporary media engines only after the M1/M2 replacement gates pass.

### Product acceptance

1. Clean Windows 10 and Windows 11 Setup/Portable tests.
2. Installed Chrome, Edge and Firefox end-to-end tests.
3. Authenticated downloads with real cookies, headers and expiring URLs.
4. Checksum input, corrupted-file quarantine and redacted diagnostics.
5. Signed executable and installer, tagged release, updater and rollback acceptance.
6. Long-running large-file, large-queue and repeated interruption tests.

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

1. **N5 production migration and release gate**.
2. **M1/M2 first-party media replacement**.

## Naming policy

- Product: **Subutai**.
- Formal name where required: **Subutai Download Manager**.
- Executable and artifact prefix: **Subutai**.
- Public UI, notifications, extension, installer and public errors must expose only Subutai product identity.
- Technical source may mention a temporary component only where required to operate or remove it safely; it is never part of the product identity.

# Subutai Direct 1.0 Release Gate

This checklist separates implemented engineering capability from physical product acceptance and signed release readiness.

A green automated workflow is necessary but is not sufficient to mark Direct 1.0 release-ready.

## Gate states

- **PASS** — evidence exists for the exact build and environment.
- **FAIL** — the expected behavior did not occur.
- **BLOCKED** — an external dependency or environment is unavailable.
- **PENDING** — not yet executed.

Every physical acceptance result must record the exact application SHA/version, Windows version, browser version, expected result, actual result, screenshots or logs, and reproduction steps for failures.

## G0 — Repository and engineering baseline

Current state: **PASS on automated Windows runner**.

Required evidence:

- [x] first-party Rust direct-download engine;
- [x] no replaced direct-download executable in Setup/Portable resources;
- [x] frozen dependency installation;
- [x] Rust format, Clippy and native tests;
- [x] TypeScript typecheck;
- [x] queue, scheduler, batch, clipboard and Site Grabber policy tests;
- [x] pause/resume, validator, no-range, mirror and failure-injection tests;
- [x] restart-recovery same-boot harness;
- [x] native soak and large-file/queue benchmarks;
- [x] Setup and Portable build;
- [x] packaged, portable and installed launch;
- [x] install/uninstall registry cleanup;
- [x] transactional updater and local two-build rollback acceptance.

## G1 — Update distribution architecture

Current state: **PENDING**.

Select one end-user channel:

- [ ] public binary-only GitHub release repository;
- [ ] generic HTTPS object storage/CDN;
- [ ] documented private owner-only channel.

Required constraints:

- [ ] no personal access token embedded in application code or artifacts;
- [ ] stable, beta and development channels are distinct;
- [ ] `latest.yml`, Setup and blockmap are delivered atomically;
- [ ] downloaded installer SHA-256 is verified;
- [ ] unavailable/offline channel fails safely;
- [ ] update logs redact tokens, cookies and signed URL parameters;
- [ ] rollback cache remains compatible with the selected channel.

Exit condition:

- [ ] installed `0.1.0` discovers, downloads and stages real `0.1.1` through the selected channel.

## G2 — Physical desktop acceptance

Current state: **PENDING**.

Direct downloads:

- [ ] small file;
- [ ] multi-gigabyte file;
- [ ] byte-range server;
- [ ] no-range server;
- [ ] redirects;
- [ ] pause and resume;
- [ ] cancel and cleanup;
- [ ] app restart recovery;
- [ ] native-process kill recovery;
- [ ] network disconnect and recovery;
- [ ] destination conflict policies;
- [ ] expected SHA-256 success and mismatch quarantine;
- [ ] insufficient disk space;
- [ ] remote validator change;
- [ ] proxy and speed limit.

Utilities:

- [ ] batch URL expansion;
- [ ] numbered URL range;
- [ ] clipboard capture and confirmation;
- [ ] schedule open/close behavior;
- [ ] Site Grabber crawl, preview, cancel and queue;
- [ ] tray minimize/close behavior;
- [ ] completion and failure notifications.

## G3 — Installed browser acceptance

Current state: **PENDING**.

Execute through installed Subutai, not source/dev mode.

Chrome:

- [ ] automatic interception;
- [ ] right-click link;
- [ ] right-click media;
- [ ] selected URL;
- [ ] app closed at invocation;
- [ ] app already running;
- [ ] uninstall cleanup.

Edge:

- [ ] automatic interception;
- [ ] right-click link;
- [ ] right-click media;
- [ ] selected URL;
- [ ] app closed at invocation;
- [ ] app already running;
- [ ] uninstall cleanup.

Firefox:

- [ ] automatic interception;
- [ ] right-click link;
- [ ] right-click media;
- [ ] selected URL;
- [ ] app closed at invocation;
- [ ] app already running;
- [ ] uninstall cleanup.

Authenticated request matrix:

- [ ] cookie-required direct URL;
- [ ] referer-required URL;
- [ ] authorization/custom header URL;
- [ ] expiring URL;
- [ ] URL with sensitive query values and redacted diagnostics.

## G4 — Physical media acceptance

Current state: **PENDING**.

- [ ] single video;
- [ ] playlist;
- [ ] 1080p;
- [ ] 4K where the source provides it;
- [ ] HLS;
- [ ] DASH;
- [ ] subtitles download;
- [ ] subtitle conversion/embedding;
- [ ] MP3;
- [ ] M4A;
- [ ] Opus/FLAC/WAV where supported;
- [ ] browser-cookie media URL;
- [ ] pause and resume;
- [ ] cancel and cleanup;
- [ ] media-tool missing/corrupt failure message.

Media acceptance verifies the current temporary-tool path. It does not claim first-party M1/M2 media implementation.

## G5 — Clean Windows acceptance

Current state: **PENDING**.

### Windows 11 x64

- [ ] clean snapshot/machine without Node, Rust or pnpm;
- [ ] Setup install;
- [ ] first launch;
- [ ] Portable launch;
- [ ] direct-download matrix smoke;
- [ ] Chrome/Edge/Firefox integration;
- [ ] media smoke;
- [ ] Windows restart and recovery;
- [ ] sleep/wake recovery;
- [ ] uninstall and registry/file cleanup.

### Windows 10 x64

- [ ] clean snapshot/machine without Node, Rust or pnpm;
- [ ] Setup install;
- [ ] first launch;
- [ ] Portable launch;
- [ ] direct-download matrix smoke;
- [ ] Chrome/Edge/Firefox integration;
- [ ] media smoke;
- [ ] Windows restart and recovery;
- [ ] sleep/wake recovery;
- [ ] uninstall and registry/file cleanup.

## G6 — Real update and rollback

Current state: **PENDING**.

Healthy update:

- [ ] install independently built/published `0.1.0`;
- [ ] seed settings, queue, schedules, SQLite data and a resumable partial job;
- [ ] update to independently built/published `0.1.1`;
- [ ] confirm renderer, preload, native host and browser bridge health;
- [ ] verify transaction committed;
- [ ] verify all seeded user data and partial state preserved.

Failed-target rollback:

- [ ] install healthy `0.1.1`;
- [ ] update to deliberately unhealthy target build;
- [ ] withhold startup-health confirmation;
- [ ] watchdog detects bounded failure;
- [ ] previous installer SHA-256 is reverified;
- [ ] silent rollback completes;
- [ ] previous version relaunches;
- [ ] Chrome/Edge/Firefox registration is restored;
- [ ] settings, database and partial state remain intact;
- [ ] repeated invocation does not create a rollback loop.

Reboot path:

- [ ] update awaiting health survives a real Windows restart;
- [ ] rollback decision survives a real Windows restart;
- [ ] intentional user exit does not trigger rollback.

## G7 — Release-quality defects

Current state: **PENDING**.

- [ ] configure product, executable and installer icons;
- [ ] explicitly close FileHandle objects in restart/resilience scripts;
- [ ] resolve or document GitHub Actions Node runtime deprecation;
- [ ] resolve or document packaged SQLite experimental warning;
- [ ] add user-facing destination-conflict `Ask` flow;
- [ ] expose browser integration health;
- [ ] expose updater/rollback state and result;
- [ ] add diagnostics/log export with secret redaction;
- [ ] verify error messages provide a concrete recovery action.

## G8 — Signing and prerelease

Current state: **BLOCKED until certificate and protected secrets exist**.

- [ ] acquire a Windows code-signing certificate;
- [ ] store signing material only in protected release infrastructure;
- [ ] sign native host, desktop executable, Setup and Portable outputs;
- [ ] timestamp signatures;
- [ ] verify signatures on clean Windows 10/11;
- [ ] verify update and rollback reject untrusted/tampered installers;
- [ ] inspect SmartScreen behavior;
- [ ] create a draft prerelease;
- [ ] repeat clean-machine install/update/rollback from prerelease artifacts;
- [ ] publish stable only after every mandatory gate is PASS.

## Post-Direct 1.0 packages

The following are deliberately outside the Direct 1.0 critical path unless profiling or correctness evidence changes that decision:

- explicit HTTP/2 enablement and protocol-used telemetry;
- HTTP/3 capability/fallback work;
- asynchronous WinHTTP/IOCP investigation;
- first-party HLS/DASH media core;
- maintained website adapters;
- measured Electron-versus-Tauri feasibility spike.

No full Tauri migration or IOCP rewrite should begin without a measured and documented benefit.

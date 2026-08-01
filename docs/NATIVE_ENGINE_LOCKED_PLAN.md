# Subutai Native Engine — Locked Delivery Plan

Status: **LOCKED**  
Locked on: 2026-08-02  
Product identity: **Subutai** / **Subutai Download Manager**

## 1. Non-negotiable product boundary

Subutai will own the download behavior, state model, scheduling, recovery, browser bridge, journal format, file-integrity logic, diagnostics and user experience.

The production target will not bundle or require a third-party download or media engine. Development toolchains, the Rust standard library, Windows SDK and operating-system APIs are allowed. Third-party runtime code may be used only in temporary benchmark builds and must not ship in the final native-engine release.

No external product name is part of the Subutai identity. Technical dependency names may appear only in historical migration code, development-only benchmarks, license records and removal tracking.

## 2. Release scope

### Subutai Native Direct 1.0

Supported platform:

- Windows 10 x64
- Windows 11 x64
- ARM64 is a post-1.0 target

Supported protocols:

- HTTP/1.1
- HTTP/2
- HTTP/3 where the Windows transport supports it, with safe fallback
- HTTPS with normal Windows certificate validation

Required capabilities:

1. URL probe, redirects, content length, content disposition and MIME metadata.
2. Range and no-range server handling.
3. Single-stream and segmented downloads.
4. Pause, resume, cancel, restart and crash recovery.
5. Persistent versioned job journal and segment journal.
6. `.subutai.part` temporary files and atomic final rename.
7. Disk-space and destination-writability preflight.
8. ETag and Last-Modified resume validation.
9. Safe restart when remote content changes.
10. Retry classification, exponential backoff and bounded retries.
11. Proxy, authenticated requests, cookies, referer and custom headers.
12. Global and per-job speed limits.
13. SHA-256 verification and corrupted-file quarantine.
14. File conflict policy: ask, rename, overwrite, skip or verified resume.
15. Dynamic segment sizing and adaptive connection count.
16. Slow-segment splitting and work reassignment.
17. Mirror/fallback URL support.
18. Network change, sleep/wake and process-restart recovery.
19. Redacted structured logs and per-connection diagnostics.
20. Versioned IPC contract with the Subutai desktop application.

Explicitly deferred from Direct 1.0:

- BitTorrent, DHT and magnet links
- FTP and SFTP
- macOS and Linux desktop releases
- media-site extraction

### Subutai Native Media 2.0

Required first-party media scope:

1. Direct MP4/WebM/audio files.
2. HLS VOD and live manifests.
3. DASH VOD manifests.
4. Separate audio/video track download and merge.
5. Subtitle download and language selection.
6. Playlist item selection and per-item recovery.
7. Container/codec/quality detail view.
8. Browser-authenticated media requests.
9. In-page Subutai media detection panel.
10. Maintained site adapters delivered incrementally.

DRM circumvention is out of scope.

## 3. Architecture freeze

```text
Subutai Desktop
    |
    +-- versioned local IPC
            |
            +-- Subutai Native Engine
                    +-- Probe and metadata
                    +-- Transfer scheduler
                    +-- Adaptive segment planner
                    +-- Connection workers
                    +-- Ordered disk writer
                    +-- Journal and recovery
                    +-- Integrity verification
                    +-- Network monitor
                    +-- Diagnostics
```

Implementation decisions:

- Engine language: Rust.
- Windows transport and TLS: Windows networking APIs through a small audited FFI boundary.
- HTTP/2 and HTTP/3: enabled through the Windows transport with protocol-use telemetry and fallback.
- File I/O: bounded writer queue; Windows asynchronous file I/O is introduced after correctness tests pass.
- IPC: length-prefixed, versioned messages over inherited pipes first; named pipes after the protocol is stable.
- Journal: compact versioned binary format with atomic replacement and backward migration tests.
- Public API: engine implementation details never appear in the Subutai UI.

## 4. Mandatory quality gates

A milestone is not complete until every relevant gate passes:

- deterministic unit tests
- local integration test server
- checksum equality
- process-kill recovery
- Windows restart recovery
- range/no-range/redirect/auth cases
- remote ETag change safety
- disk-full and destination-loss behavior
- memory and handle leak checks
- large-file and large-queue soak tests
- packaged application tests
- clean Windows 10/11 acceptance
- benchmark reproducibility

No milestone may be marked production-ready from compile success alone.

## 5. Benchmark policy

Performance claims use the same machine, URL, network path, time window and file checksum. Record:

- total wall-clock time
- stable throughput
- time to first byte
- CPU usage
- peak memory
- disk queue and write rate
- connection count over time
- retry count
- final SHA-256

Subutai must never sacrifice file integrity for benchmark speed.

## 6. Migration policy

The current external-engine implementation remains development-only until the native engine passes the replacement gate. It is not the future product architecture.

Replacement gate:

1. Native engine passes every Direct 1.0 correctness test.
2. Native engine meets or exceeds the reference throughput on the benchmark matrix.
3. Native recovery produces identical checksums after interruption.
4. Windows package contains and uses the native engine by default.
5. All old runtime engines and their public naming are removed from release resources.
6. Third-party notices accurately describe only components still shipped.

## 7. Locked execution packages

### Package N0 — foundation

- Rust workspace and zero-third-party-dependency core crate
- job/segment state model
- byte-range planner
- versioned binary journal
- IPC protocol specification
- deterministic tests

### Package N1 — correctness transport

- Windows HTTP/HTTPS probe
- redirects and response metadata
- single-stream download
- temporary file and atomic completion
- progress, speed and cancellation

### Package N2 — resumable segmented transfer

- byte ranges
- segment persistence
- pause/resume/restart
- ETag/Last-Modified validation
- no-range fallback
- retry/backoff

### Package N3 — adaptive engine

- dynamic chunking
- adaptive concurrency
- slow-segment reassignment
- bounded writer queue
- mirror failover
- connection telemetry

### Package N4 — desktop replacement integration

- versioned IPC
- desktop queue integration
- browser request context
- settings and diagnostics
- Windows packaging
- development reference/native A/B mode

### Package N5 — Direct 1.0 production gate

- complete correctness matrix
- clean Windows acceptance
- performance and soak tests
- signing and stable update
- remove old runtime download engine from release

### Package M1 — first-party media core

- HLS/DASH parser
- segment scheduler
- direct media and subtitles
- audio/video track merge using Windows media APIs

### Package M2 — maintained site adapters

- prioritized adapters based on user demand
- browser-authenticated extraction
- regression fixtures and update channel

## 8. Delivery estimate

Assumption: one product owner, AI-assisted engineering, continuous review, and active work sessions rather than unattended background work.

| Milestone | Active engineering estimate | Target window |
|---|---:|---|
| N0 foundation | 5–7 days | 2026-08-02 to 2026-08-09 |
| N1 correctness transport | 10–14 days | 2026-08-10 to 2026-08-23 |
| N2 segmented/recovery alpha | 3–4 weeks | 2026-08-24 to 2026-09-20 |
| N3 adaptive engine | 3–4 weeks | 2026-09-21 to 2026-10-18 |
| N4 integrated Windows beta | 2–3 weeks | 2026-10-19 to 2026-11-08 |
| N5 Direct 1.0 release candidate | 3–5 weeks | 2026-11-09 to 2026-12-13 |
| M1 native HLS/DASH media beta | 8–12 weeks after Direct 1.0 | 2027 Q1 |
| M2 top-priority site adapters | 3–6 additional months | 2027 Q2–Q3 |

Direct-download 1.0 target: **2026-12-13**, with a realistic range of **2026-11-15 to 2027-01-31** depending on Windows edge cases and test failures.

A fully first-party replacement for a constantly changing thousand-site media extractor cannot be honestly promised on a short fixed date. The maintainable target is the native media core plus a prioritized adapter set, followed by continuous adapter maintenance.

## 9. Definition of done

The plan is complete only when:

- the final Windows release uses the Subutai native direct engine by default;
- no third-party download/media executable is required by the completed scope;
- every user-visible name is Subutai;
- clean Windows and browser acceptance is documented;
- checksums prove correctness through interruption and restart;
- source, tests, release artifacts and status documentation agree.

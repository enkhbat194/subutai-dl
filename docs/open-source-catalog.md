# Subutai third-party component catalog

This document records implementation dependencies and reference material used by **Subutai**. These names are technical and legal attribution only; they are not Subutai product branding and must not appear in normal user-facing UI or public error messages.

## Product boundary

Subutai exposes one application, one queue, one settings model, one recovery model and one public identity. External executables and libraries are isolated behind Subutai-owned adapters in the Electron main process.

## Bundled runtime dependencies

| Component | Internal role | Boundary | Release requirement |
|---|---|---|---|
| aria2 | Direct HTTP(S)/FTP segmented transfer process | Local JSON-RPC adapter | Pin version, verify checksum, retain license notice |
| yt-dlp | Media URL resolution, formats, playlists, subtitles and metadata | Managed subprocess | Pin version, verify checksum, retain license notice |
| FFmpeg / ffprobe | Media probing, merge, remux and conversion | Managed subprocess | Record build configuration and applicable license |
| Electron | Windows desktop runtime | Main/preload/renderer boundary | Pin version and monitor security updates |
| React | Renderer UI | Renderer only | Pin version and retain license notice |
| electron-builder | Setup, Portable and update metadata | Release pipeline | Pin version and validate produced artifacts |
| electron-updater | GitHub release update client | Main process only | Validate update metadata and signed release path |
| SQLite through Node runtime | Queue, history, settings and recovery state | Main process storage adapter | Version schema and test migrations |

## Reference-only projects

The following projects may be studied for behavior, architecture or test ideas. Their names and code must not be copied into Subutai without an explicit license review and attribution decision:

- Motrix and motrix-next
- Gopeed and its browser extension
- Persepolis Download Manager
- FileCentipede
- Native Messaging examples from browser vendors and MDN
- Playwright and Vitest documentation for future test infrastructure

Reference-only material does not become a Subutai dependency automatically.

## Adapter rules

1. Renderer code never starts or calls third-party executables directly.
2. Browser extensions communicate only with the Subutai native host contract.
3. Public errors are normalized to Subutai terminology.
4. Cookies, authorization headers and private URLs are not written to normal logs.
5. Runtime versions and checksums are validated by the Windows package/release pipeline.
6. Each redistributed component must have a license entry in the final third-party notices file.
7. Dependency names may exist in source code only where technically required for executable discovery, API calls, build scripts, tests or legal attribution.

## Current internal pipeline

```text
Subutai desktop UI
        |
        +-- Subutai queue, scheduler and recovery
        +-- Subutai direct-transfer adapter
        +-- Subutai media adapter
        +-- Subutai browser bridge
        +-- Subutai persistence layer
        +-- Subutai installer and updater
```

## Required follow-up

- Add generated `THIRD_PARTY_NOTICES.md` to release artifacts.
- Add software bill of materials and dependency vulnerability scanning.
- Record exact bundled binary versions and checksums in release provenance.
- Review licenses before any additional component is bundled.
- Keep public brand-policy tests separate from technical/legal attribution files.

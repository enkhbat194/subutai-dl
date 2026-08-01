# SubutaiDL

**Divide the download. Conquer the wait.**

SubutaiDL is a private high-performance download manager project focused on parallel downloads, resilient recovery, browser integration, and pluggable download engines.

## Planned architecture

- Electron + React + TypeScript desktop shell
- Unified download queue and persistent job state
- aria2 adapter for accelerated generic downloads
- yt-dlp adapter for supported media extraction
- FFmpeg adapter for media merge and conversion
- Browser extension + native messaging bridge
- SQLite-backed history, settings, and recovery

## Status

Repository bootstrap is in progress on `feat/bootstrap`.

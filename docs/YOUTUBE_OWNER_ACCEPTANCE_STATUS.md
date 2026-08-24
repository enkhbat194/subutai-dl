# Subutai YouTube owner acceptance status

Last audited: 2026-08-25 after PR #103 (`d4a4daed8634bab5d1430940b4134584d21149f9`).

## Readiness boundary

Subutai is **not yet owner-ready**. The only remaining owner-use release blocker is a real YouTube media download through the packaged Windows media stack on a non-datacenter owner network. Neutral media, metadata-only probes, hosted CI success, or code completion do not satisfy this gate.

Required terminal evidence remains:

```text
SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS
```

from the packaged `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd` path or equivalent real packaged-app execution.

## Critical paths already proved

The current `0.2.0-rc.2` owner-test package has real Setup and Portable executables. Internal Windows MVP run #95 on PR #103 head `175c4997a5b7ae04add56f3f577f208125a51ba5` passed the full hosted owner-test path:

- owner-acceptance launcher syntax/control-flow validation;
- packaged yt-dlp/FFmpeg/ffprobe/Node staging;
- pinned YouTube PO-token provider staging and package validation;
- packaged media-stack smoke with a public YouTube attempt while preserving strict owner-network PASS semantics;
- TypeScript and browser-extension contracts;
- checksum-verified normal HTTP download through the native engine;
- live interruption and durable restart recovery;
- transfer pause/resume contracts;
- Windows Setup and Portable construction;
- packaged desktop-host normal HTTP, explicit pause/resume and restart recovery;
- packaged Electron launch smoke;
- internal prerelease publication.

These gates must remain green while YouTube compatibility work continues.

## YouTube hardening through PR #103

The packaged YouTube path has been hardened without weakening the real-owner PASS boundary:

- PR #75 packaged the `bgutil-ytdlp-pot-provider` path and Node runtime integration;
- PRs #76-#82 added structured diagnostics, bounded fresh-media-URL retries, packaged owner acceptance, packaged-app-first execution and deterministic launcher control-flow tests;
- PRs #84-#85 moved to safer current client defaults and pinned the merged homepage-challenge provider fix;
- PRs #86-#90 added isolated embedded-client, creator, Safari and Safari-HLS owner routes;
- PR #92 added bounded recently-used Firefox/Chrome/Edge/Brave profile discovery before bare-browser cookie fallback;
- PR #93 added isolated no-cookie `mweb` + PO-provider, `web_embedded` and `tv` routes;
- PR #95 restored the normal packaged application to the safe `default,web_embedded` client pair and prevents isolated owner fallback clients leaking into global configuration;
- PR #96 added a browser-matched User-Agent owner fallback paired with browser cookies;
- PR #98 added an isolated cookie-backed `tv` client fallback while keeping normal packaged defaults unchanged;
- PR #99 forwards a bounded allowlist of same-tab non-credential YouTube player/session context headers (`Origin`, `X-Origin`, `X-Goog-AuthUser`, `X-Goog-Visitor-Id`, `X-YouTube-Client-Name`, `X-YouTube-Client-Version`) from the browser extension to the native handoff. Authorization is deliberately not copied and non-YouTube interception behavior is unchanged;
- PR #101 adds an isolated browser-profile + browser-matched User-Agent `mweb` route that uses the already-packaged PO-token provider;
- PR #103 adds live browser YouTube PO-context capture. When the browser exposes a recent `youtubei/v1/player` request body, the extension extracts only bounded transient `poToken`, `visitorData` and video-id context, attaches it only to Subutai native enqueue payloads for YouTube, and the packaged media engine consumes it as an isolated `mweb` GVS PO-token route. Internal context transport headers are stripped before any remote HTTP request. If capture is unavailable or rejected by the browser, the existing packaged provider/profile fallbacks remain intact.

The latest yt-dlp PO Token guidance audited on 2026-08-25 still favors a PO Token provider/token for `mweb` when ordinary YouTube clients are challenged. Subutai now has three bounded compatibility sources: the packaged PO provider, browser-profile/browser-matched-UA fallbacks, and live browser-session PO context when available. A separate browser-driven provider such as `yt-dlp-getpot-wpc` remains a possible engineering alternative, but it introduces Python/nodriver/Chromium packaging dependencies and must not be added blindly without its own pinned, checksum-verified Windows packaging and acceptance path.

Hosted CI can still be challenged by YouTube datacenter-IP controls and may emit:

```text
SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PENDING_HOSTED_RUNNER_CHALLENGE
```

That is not owner-ready evidence.

## Current engineering interpretation

The direct-download engine, large-file pause/resume, restart recovery, browser interception contracts, Setup/Portable packaging, launch smoke, updater gates, packaged yt-dlp/FFmpeg/Node stack, PO-token provider, owner acceptance launcher, browser session context forwarding, live PO-context capture and bounded fallback harness are not current release blockers. The remaining blocker is obtaining one playable real YouTube result through the packaged application or packaged owner-acceptance path on an owner network and recording the strict PASS marker.

Do not regress working direct-download behavior in pursuit of YouTube compatibility. Any further YouTube fallback must stay bounded, isolated, observable in diagnostics and unable to turn metadata-only, DRM-only or neutral-media results into PASS.

## Next action

Run the packaged application/owner-acceptance path on a real owner Windows network with an installed browser session available. Prefer testing through the browser integration first so PR #103 can reuse live session PO context; then run the packaged owner-acceptance launcher for strict evidence. If either path produces playable media and `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS`, re-run the full critical acceptance boundary before declaring Subutai ready. If it still fails, use the emitted route/profile/PO-context diagnostics to choose the next isolated engineering fallback rather than weakening the PASS boundary.

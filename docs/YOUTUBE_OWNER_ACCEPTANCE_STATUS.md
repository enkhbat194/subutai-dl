# Subutai YouTube owner acceptance status

Last audited: 2026-08-25 after PR #106 (`4b528130ef11abb022a90e03c41e08ae44fcba97`).

## Readiness boundary

Subutai is **not yet owner-ready**. The only remaining owner-use release blocker is a real YouTube media download through the packaged Windows media stack on a non-datacenter owner network. Neutral media, metadata-only probes, hosted CI success, or code completion do not satisfy this gate.

Required terminal evidence remains:

```text
SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS
```

from the packaged `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd` path or equivalent real packaged-app execution.

## Critical paths already proved

The current `0.2.0-rc.2` owner-test package has real Setup and Portable executables. Internal Windows MVP run #97 on PR #106 head `c031fcb98a286f6b0317395a41993fc85c012e8a` passed the full hosted owner-test path:

- owner-acceptance launcher syntax/control-flow validation;
- packaged yt-dlp/FFmpeg/ffprobe/Node staging;
- pinned local YouTube PO-token provider staging and validation;
- pinned browser-minted WPC provider staging and packaged payload validation;
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

## YouTube hardening through PR #106

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
- PR #99 forwards a bounded allowlist of same-tab non-credential YouTube player/session context headers from the browser extension to the native handoff;
- PR #101 adds an isolated browser-profile + browser-matched User-Agent `mweb` route that uses the packaged PO-token provider;
- PR #103 adds live browser YouTube PO-context capture and isolated reuse of transient `poToken` / `visitorData` context;
- PR #105 proved that the browser-minted `yt-dlp-getpot-wpc` provider can be loaded inside the standalone packaged yt-dlp runtime with a pinned Windows dependency set;
- PR #106 packages that WPC path for owner use: `yt-dlp-getpot-wpc` 1.1.2, `nodriver` 0.50.3 and its pinned runtime dependencies are staged into the Windows package, validated in CI, and invoked as the final isolated owner retry after packaged-app, primary, fresh-media-URL and browser-cookie/matched-UA routes. The WPC route only passes when packaged `ffprobe` verifies a real playable YouTube media file.

Hosted CI can still be challenged by YouTube datacenter-IP controls and may emit:

```text
SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PENDING_HOSTED_RUNNER_CHALLENGE
```

That is not owner-ready evidence.

## Current engineering interpretation

The direct-download engine, large-file pause/resume, restart recovery, browser interception contracts, Setup/Portable packaging, launch smoke, updater gates, packaged yt-dlp/FFmpeg/Node stack, local PO-token provider, browser-minted WPC provider, owner acceptance launcher, browser session context forwarding, live PO-context capture and bounded fallback harness are not current release blockers.

The remaining blocker is obtaining one playable real YouTube result through the packaged application or packaged owner-acceptance path on an owner network and recording the strict PASS marker.

One implementation gap remains worth tracking separately from the release gate: the normal desktop `MediaService` automatically retries browser-cookie sources but the newly packaged WPC provider is currently wired into the strict owner-acceptance launcher rather than the ordinary interactive media retry chain. This does not invalidate run #97, but promoting the same bounded WPC fallback into normal packaged media handling would reduce the difference between diagnostic acceptance and day-to-day browser interception. That change must preserve the current direct-download/recovery behavior and must remain isolated to YouTube authentication/challenge failures.

Do not regress working direct-download behavior in pursuit of YouTube compatibility. Any further YouTube fallback must stay bounded, isolated, observable in diagnostics and unable to turn metadata-only, DRM-only or neutral-media results into PASS.

## Next action

1. Keep the run-#97-class hosted Windows gates green.
2. Promote the audited packaged WPC fallback into the normal packaged YouTube retry chain after browser-cookie routes are exhausted, without changing non-YouTube behavior.
3. Run the packaged application/owner-acceptance path on a real owner Windows network with an installed browser session available.
4. Prefer testing through browser integration first so live session context is available, then run the packaged owner-acceptance launcher for strict evidence.
5. If either path produces playable media and `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS`, re-run the full critical acceptance boundary before declaring Subutai ready.
6. If it still fails, use emitted route/profile/PO-context/WPC diagnostics to choose the next isolated engineering fallback rather than weakening the PASS boundary.

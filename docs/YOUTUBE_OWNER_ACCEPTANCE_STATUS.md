# Subutai YouTube owner acceptance status

Last audited: 2026-08-24 after PR #93 (`0879be81ea799cc82ebc39a3df8d0f4622fc52f4`).

## Readiness boundary

Subutai is **not yet owner-ready**. The remaining release-blocking gate is a real YouTube media download through the packaged Windows media stack on a non-datacenter owner network. Do not replace this gate with a neutral media download, metadata-only probe, code completion, or hosted CI success.

Required terminal evidence remains:

```text
SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS
```

from the packaged `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd` path or an equivalent real packaged-app execution.

## Critical paths already proved

The current `0.2.0-rc.2` owner-test package has real Setup and Portable executables. Windows MVP acceptance has proved application launch, normal HTTP download, packaged-host 64 MiB transfer, explicit pause/resume, controller/app restart recovery with exact completion, browser integration contracts, packaged media binaries/runtime, package validation, and the packaged owner-acceptance launcher control flow.

PR #93 re-ran the full Windows MVP acceptance after adding the new no-cookie owner YouTube routes on top of PR #92's browser-profile hardening. Syntax/launcher validation, packaged media-stack smoke, TypeScript checks, native HTTP download, live interruption/restart recovery, pause/resume contracts, Setup/Portable construction, packaged provider validation, packaged desktop-host pause/resume/restart recovery, package launch smoke, and internal prerelease publication all passed in Internal Windows MVP run #88.

These gates must remain green while YouTube work continues.

## Progress through PR #93

The packaged YouTube path has been hardened without weakening the real-owner PASS boundary:

- PR #75 packaged the `bgutil-ytdlp-pot-provider` path and its Node runtime integration;
- PRs #76-#80 preserved structured diagnostics, added bounded fresh-media-URL retries, packaged the retry helper, and added a packaged-app owner acceptance command path;
- PRs #81-#82 made the packaged executable the preferred acceptance route and fixed launcher exit-code handling;
- PR #84 stopped forcing `mweb` globally and preferred current stable clients while preserving the PO-token provider as an explicit fallback;
- PR #85 pinned upstream merged homepage-challenge PO-token fix commit `495a47f7e9d442addc7b7f03c2751001558bb983`;
- PR #86 added isolated `web_embedded` and `tv_embedded` browser-cookie fallbacks before mixed-client fallback;
- PR #87 restricted the normal packaged application to the compatible `default,web_embedded` pair so a token/format selected for one YouTube client cannot accidentally cross over to another client's GoogleVideo URL;
- PR #88 added isolated browser-cookie `web_creator` and `web_safari` fresh-URL routes;
- PR #90 added isolated `web_safari` HLS owner routes, because current yt-dlp guidance notes that its HLS formats can avoid the GVS PO-token requirement in supported sessions;
- PR #92 enumerates a bounded set of recently used Firefox/Chrome/Edge/Brave profiles and tries explicit `browser:profile` cookie sources before bare-browser fallbacks, improving the chance that owner acceptance uses the profile actually signed into YouTube;
- PR #93 superseded stale PR #91 on current main and added isolated no-cookie `web_embedded` and `tv` routes. Current yt-dlp guidance identifies both as not requiring a GVS PO token in supported cases, while strict ffprobe/playable-media validation prevents metadata-only or DRM-only results from becoming PASS.

Hosted CI may still receive YouTube datacenter challenges and therefore may correctly emit:

```text
SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PENDING_HOSTED_RUNNER_CHALLENGE
```

That status is **not** owner-ready evidence.

## Current engineering interpretation

The direct-download engine, pause/resume/recovery path, browser interception contracts, Setup/Portable packaging, launch smoke, updater gates, packaged yt-dlp/FFmpeg/Node stack, PO-token provider, owner acceptance launcher, bounded owner fallback harness, explicit browser-profile discovery, and no-cookie client routes are not the current blocker. The blocker is obtaining one playable real YouTube media result through the packaged application or packaged owner-acceptance path on an owner network and recording the strict PASS marker.

Do not regress working direct-download behavior in pursuit of YouTube compatibility. Any additional YouTube fallback must remain bounded, isolated, observable in diagnostics, and unable to turn a metadata-only, DRM-only, or neutral-media result into PASS.

## Next action

Run the packaged application/owner-acceptance path on a real owner Windows network with an installed browser session available for cookie-backed routes. If the packaged run produces playable media and `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS`, re-run the full critical acceptance boundary before declaring Subutai ready. If it still fails, use the emitted per-route/profile diagnostics to choose the next isolated engineering fallback rather than weakening the PASS boundary.

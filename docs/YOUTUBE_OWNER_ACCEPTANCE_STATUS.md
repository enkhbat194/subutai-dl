# Subutai YouTube owner acceptance status

Last audited: 2026-08-24 after PR #87 (`109ba04b421768ef9a8e522247b0f6eab9808c98`).

## Readiness boundary

Subutai is **not yet owner-ready**. The remaining release-blocking gate is a real YouTube media download through the packaged Windows media stack on a non-datacenter owner network. Do not replace this gate with a neutral media download, metadata-only probe, code completion, or hosted CI success.

Required terminal evidence remains:

```text
SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS
```

from the packaged `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd` path or an equivalent real packaged-app execution.

## Critical paths already proved

The current `0.2.0-rc.2` owner-test package has real Setup and Portable executables. Windows MVP acceptance has proved application launch, normal HTTP download, packaged-host 64 MiB transfer, explicit pause/resume, controller/app restart recovery with exact completion, browser integration contracts, packaged media binaries/runtime, package validation, and the packaged owner-acceptance launcher control flow.

These gates must remain green while YouTube work continues.

## Progress through PR #87

The packaged YouTube path has been hardened without weakening the real-owner PASS boundary:

- PR #75 packaged the `bgutil-ytdlp-pot-provider` path and its Node runtime integration;
- PRs #76-#80 preserved structured diagnostics, added bounded fresh-media-URL retries, packaged the retry helper, and added a packaged-app owner acceptance command path;
- PRs #81-#82 made the packaged executable the preferred acceptance route and fixed launcher exit-code handling;
- PR #84 stopped forcing `mweb` globally and preferred current stable clients while preserving the PO-token provider as an explicit fallback;
- PR #85 pinned upstream merged homepage-challenge PO-token fix commit `495a47f7e9d442addc7b7f03c2751001558bb983`;
- PR #86 added isolated `web_embedded` and `tv_embedded` browser-cookie fallbacks before mixed-client fallback;
- PR #87 restricted the normal packaged application to the compatible `default,web_embedded` pair so a token/format selected for one YouTube client cannot accidentally cross over to another client's GoogleVideo URL.

Hosted CI may still receive YouTube datacenter challenges and therefore may correctly emit:

```text
SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PENDING_HOSTED_RUNNER_CHALLENGE
```

That status is **not** owner-ready evidence.

## Current engineering interpretation

The direct-download engine, pause/resume/recovery path, browser interception contracts, Setup/Portable packaging, launch smoke, updater gates, packaged yt-dlp/FFmpeg/Node stack, PO-token provider, and owner acceptance launcher are not the current blocker. The blocker is obtaining one playable real YouTube media result through the packaged application on an owner network and recording the strict PASS marker.

Do not regress working direct-download behavior in pursuit of YouTube compatibility. Any additional YouTube fallback must remain bounded, isolated, observable in diagnostics, and unable to turn a metadata-only or neutral-media result into PASS.

## Next action

Continue engineering only where it increases the probability or observability of the real packaged owner-network YouTube pass. Prefer packaged application execution first, then the packaged diagnostic helpers. Once the real packaged run produces playable media and `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS`, re-run the full critical acceptance boundary before declaring Subutai ready.

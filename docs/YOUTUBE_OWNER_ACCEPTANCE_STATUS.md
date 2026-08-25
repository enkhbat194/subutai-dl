# Subutai YouTube owner acceptance status

Last audited: 2026-08-26 after PR #129 (`0139086d437e84dc773ca3d6773844d41b705bfe`).

## Readiness boundary

Subutai is **not yet owner-ready**. The only remaining owner-use release blocker is a real playable YouTube media download through the packaged Windows media stack on a non-datacenter owner network. Neutral media, metadata-only probes, GitHub-hosted CI success, provider capability audits, request-impersonation capability checks, or code completion do not satisfy this gate.

Required terminal evidence remains:

```text
SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS
```

from the packaged `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd` path or equivalent real packaged-app execution.

## Critical paths already proved

The current `0.2.0-rc.2` owner-test package has real Setup and Portable executables. Internal Windows MVP run #113 (`32894761374`) on PR #129 head `f2806b786e9e0ecc21ed12eaa4d0949067fea835` passed the complete hosted owner-test boundary:

- owner-acceptance launcher syntax/control-flow validation;
- packaged yt-dlp/FFmpeg/ffprobe/Node staging;
- pinned local YouTube PO-token provider staging and validation;
- browser-minted WPC PO-token provider staging and packaged payload validation;
- packaged media-stack smoke with a public YouTube attempt while preserving strict owner-network PASS semantics;
- TypeScript and browser-extension contracts;
- checksum-verified normal HTTP download through the native engine;
- live interruption and durable restart recovery;
- transfer pause/resume contracts;
- Windows Setup and Portable construction;
- packaged desktop-host normal HTTP, explicit pause/resume and restart recovery;
- packaged Electron launch smoke;
- internal prerelease publication.

The direct-download engine, large-file pause/resume, restart recovery, browser interception contracts, Setup/Portable packaging, launch smoke, updater gates and packaged media tools are therefore not the current release blocker.

## YouTube hardening through PR #129

The packaged YouTube path has been hardened without weakening the real-owner PASS boundary:

- PR #75 packaged the `bgutil-ytdlp-pot-provider` path and Node runtime integration;
- PRs #76-#82 added structured diagnostics, bounded fresh-media-URL retries, packaged owner acceptance, packaged-app-first execution and deterministic launcher control-flow tests;
- PRs #84-#93 added safer current client defaults plus isolated embedded, creator, Safari/HLS, browser-profile and no-cookie fallback routes;
- PRs #95-#103 kept owner-only fallbacks isolated from normal application defaults, added browser-matched User-Agent routes, bounded same-tab player/session context forwarding and transient browser PO-context reuse;
- PRs #105-#120 packaged browser-minted WPC support and broadened bounded browser/client discovery across Chrome, Edge, Brave, Vivaldi, Opera/Opera GX and alternate Chromium-family channels;
- PR #123 proved that the staged standalone yt-dlp runtime exposes usable browser request-impersonation targets without changing normal media behavior;
- PR #124 packaged a bounded request-impersonation owner retry and chained it before WPC while requiring playable-media validation with packaged ffprobe;
- PRs #126-#127 broadened browser-session discovery and prioritize active Chromium profiles for the owner impersonation retry;
- PR #128 made owner-impersonation changes pass through the full Internal Windows MVP acceptance path so HTTP, pause/resume, recovery, packaging and launch cannot silently regress;
- PR #129 broadened the packaged request-impersonation owner retry to reuse Firefox profiles as well as Chromium-family/Opera sessions. Full Internal Windows MVP run #113 passed.

Current official yt-dlp guidance recommends a PO-token provider with the `mweb` client for GVS requests. The official July 2026 PO-token matrix also documents bounded alternatives already represented in Subutai's isolated owner chain: `web_safari` HLS can avoid a GVS PO token, `web_embedded` does not require a token for embeddable videos, and no-cookie `tv`/`android_vr` routes can work under their stated limitations. These routes remain fallbacks, not substitutes for the strict real-owner playable-media acceptance gate.

Hosted CI can still be challenged by YouTube datacenter-IP controls and may emit:

```text
SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PENDING_HOSTED_RUNNER_CHALLENGE
```

That is not owner-ready evidence.

## Current engineering interpretation

The remaining blocker is obtaining one playable real YouTube result through the packaged application or packaged owner-acceptance path on an owner Windows network and recording the strict PASS marker.

The owner acceptance chain now has independent bounded paths for:

1. packaged-app execution;
2. primary yt-dlp/provider execution;
3. fresh media URL retries;
4. browser cookies plus browser-matched User-Agent;
5. packaged request impersonation using discovered Chromium-family, Opera-family and Firefox sessions;
6. browser-minted WPC PO-token retries across discovered compatible browsers and supported clients;
7. isolated client fallbacks whose limitations match current yt-dlp guidance.

These routes are intentionally isolated and observable. Do not regress working direct-download behavior in pursuit of YouTube compatibility. Any future fallback must remain bounded, clean up deterministically, and validate a real playable media file before it can satisfy owner PASS.

## Next action

1. Keep the run-#113-class hosted Windows gates green on current main.
2. Run the current Setup or Portable package on a real owner Windows network, preferably through browser interception first so live browser/session context can be reused.
3. Run `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd` and require a playable output plus `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS`.
4. If that succeeds, re-run the complete critical acceptance boundary before declaring Subutai ready.
5. If it still fails, use emitted route/profile/PO-context/impersonation/WPC diagnostics to choose the next isolated engineering fallback. Do not relax the PASS boundary.

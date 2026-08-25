# Subutai YouTube owner acceptance status

Last audited: 2026-08-25 after PR #124 (`442ee1211c011dbcd27f54dc69c9253a054abac3`).

## Readiness boundary

Subutai is **not yet owner-ready**. The only remaining owner-use release blocker is a real YouTube media download through the packaged Windows media stack on a non-datacenter owner network. Neutral media, metadata-only probes, hosted CI success, provider capability audits, or code completion do not satisfy this gate.

Required terminal evidence remains:

```text
SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS
```

from the packaged `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd` path or equivalent real packaged-app execution.

## Critical paths already proved

The current `0.2.0-rc.2` owner-test package has real Setup and Portable executables. The run-#108-class Internal Windows MVP acceptance path has proved the following and these gates must remain green while YouTube compatibility work continues:

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

The direct-download engine, large-file pause/resume, restart recovery, browser interception contracts, Setup/Portable packaging, launch smoke, updater gates and packaged media tools are therefore not the current release blocker.

## YouTube hardening through PR #124

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
- PR #106 packages that WPC path for owner use and invokes it as the final isolated owner retry after packaged-app, primary, fresh-media-URL and browser-cookie/matched-UA routes;
- PR #110 promotes the bounded WPC retry into the ordinary packaged `MediaService` only after YouTube authentication/challenge failures and after browser-cookie sources are exhausted;
- PRs #111-#120 broaden explicit WPC browser discovery from Chrome/Chromium to Edge, Brave, Vivaldi, Opera/Opera GX and stable/alternate Chromium-family release channels, while keeping `mweb` first and adding bounded `web_safari` routes;
- PR #123 adds an isolated packaged yt-dlp request-impersonation capability audit and proves that the staged standalone runtime exposes usable browser impersonation targets without changing normal media behavior;
- PR #124 packages a bounded Chrome request-impersonation owner retry, combines it with installed Chromium-family browser sessions, validates only playable media with packaged ffprobe, and chains it after the browser-UA retry and before WPC. The fallback is part of Setup/Portable owner-acceptance resources and cannot turn metadata-only output into PASS.

The current official yt-dlp PO-token guidance still recommends a PO-token provider for the `mweb` client. Manual PO-token extraction is not a durable production solution because tokens may be video-bound and need automatic generation. Subutai therefore keeps both featured provider classes available: BgUtils-backed generation and browser-minted WPC, with browser/session context and request impersonation as bounded compatibility fallbacks.

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
5. packaged Chrome request impersonation, with and without Chromium-family browser sessions;
6. browser-minted WPC PO-token retries across discovered Chromium-family browsers and supported clients.

These routes are intentionally isolated and observable. Do not regress working direct-download behavior in pursuit of YouTube compatibility. Any future fallback must remain bounded, must clean up deterministically, and must validate a real playable media file before it can satisfy owner PASS.

The separate Rust BgUtil provider feasibility work in PR #122 showed that a second provider implementation can load and operate, but GitHub-hosted datacenter IPs were still challenged before playable output. PR #123/#124 now provide a lower-risk packaged request-impersonation path on main, so the Rust provider remains research-only unless owner-network evidence shows it solves a failure the merged provider/impersonation/WPC chain cannot.

## Next action

1. Keep the run-#108-class hosted Windows gates green on the current main head.
2. Run the current Setup or Portable package on a real owner Windows network, preferably through browser interception first so live session context can be reused.
3. Run `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd`; it now includes the packaged request-impersonation route before WPC.
4. If either path produces playable media and `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS`, re-run the complete critical acceptance boundary before declaring Subutai ready.
5. If the real owner-network path still fails, use emitted route/profile/PO-context/impersonation/WPC diagnostics to choose the next isolated engineering fallback. Do not relax the PASS boundary.

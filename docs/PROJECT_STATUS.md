# Subutai — Authoritative Project Status

Last audited: 2026-08-24  
Audited `main`: `63fae36a84aa6a9c3a5121d839c90cc948161e67` (through PR #82)

## Current conclusion

Subutai has a working unsigned **`0.2.0-rc.2` owner-test Windows baseline** with real Setup and Portable artifacts. It is **not yet declared owner-ready** because a real owner-network YouTube download through the packaged application/tools has not produced `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS` evidence.

Normal HTTP downloads through the first-party native engine, packaged desktop-host HTTP downloads, explicit large-file pause/resume, controller/app restart recovery, packaging, launch, browser interception/integration and the packaged media runtime are passing. The owner-network launcher now executes the packaged application first and its Windows CMD exit-code/fallback control flow is regression-tested. Production signing/public-release gates remain separate from owner-test readiness.

## Merged owner-test baseline

| PR | Result |
|---|---|
| #45 | Focused one-link UI, automatic media routing, packaged yt-dlp/FFmpeg/Node stack, Setup/Portable owner-test publication |
| #47 | Real live HTTP transfer interruption, durable partial/journal persistence and exact restart-resume verification |
| #51 | Bounded YouTube player-client fallback attempts before neutral hosted-runner fallback |
| #52 | yt-dlp `2026.08.19`, strict real-owner YouTube acceptance harness, Chrome/Edge/Firefox browser-cookie fallback |
| #53 | Packaged `yt-dlp.conf` makes the real application media engine try resilient YouTube player-client defaults automatically |
| #54/#56 | One-click owner-network YouTube acceptance launcher published beside artifacts and bundled inside Setup/Portable |
| #57 | Windows owner build gated by a checksum-verified normal HTTP download through the first-party native engine |
| #58/#60/#62/#63/#65/#67/#68/#71/#72 | Packaged media path and acceptance harness progressively hardened for Firefox/Chromium-family profile discovery, fresh browser cookies, request headers and strict real YouTube PASS semantics |
| #69 | Packaged `subutai-engine-host.exe` acceptance covers normal HTTP, explicit pause/resume and controller shutdown/restart recovery over the real desktop IPC protocol |
| #74 | Explicit YouTube HTTP 403 responses enter the browser-session/player-client retry path instead of ending the media attempt early |
| #75/#76 | Pinned YouTube PO-token provider packaged and validated with stronger diagnostics |
| #77/#78 | Fresh-media-URL owner acceptance retry path added and carried into the packaged application |
| #79 | Windows packaging and readiness gates strengthened around the owner acceptance assets |
| #80/#81 | Packaged application exposes the owner YouTube acceptance command and the launcher now tries the packaged app first before direct diagnostic scripts |
| #82 | Fixed Windows CMD stale `%ERRORLEVEL%` handling in the owner launcher; added deterministic packaged-pass, primary-fallback, retry-fallback and all-fail launcher regression coverage |

Earlier merged release engineering remains preserved, including native direct engine, queue/persistence, browser integration, transactional update/rollback, checksum rejection, Authenticode release policy and signed update-manifest policy.

## Current owner-use acceptance matrix

| Critical path | Status | Evidence |
|---|---:|---|
| Windows app launches | PASS | Packaged Electron launch smoke, Internal Windows MVP run #79 |
| Normal HTTP/direct engine | PASS | Checksum-verified real download through `subutai-engine`, run #79 |
| Packaged desktop host normal HTTP | PASS | Actual packaged `subutai-engine-host.exe`, run #79 |
| Large-file interruption/resume | PASS | 64 MiB ranged transfer, durable partial state, exact SHA-256 completion |
| Explicit packaged-host pause/resume | PASS | 64 MiB package acceptance via desktop IPC, run #79 |
| Unfinished download survives app/controller restart | PASS | Packaged-host restart path plus two-phase restart recovery harness, run #79 |
| Pause/resume control contracts | PASS | `pnpm test:transfer`, run #79 |
| Setup build exists | PASS | `Subutai-Setup-0.2.0-rc.2-x64.exe` |
| Portable build exists | PASS | `Subutai-Portable-0.2.0-rc.2-x64.exe` |
| Packaged yt-dlp/FFmpeg/Node media stack | PASS | Real neutral media download + ffprobe validation, run #79 |
| Packaged YouTube PO-token provider | PASS | `bgutil-ytdlp-pot-provider` 1.3.1 package validation, run #79 |
| Resilient YouTube player-client defaults | PASS | default + mweb PO-token + android_vr + web_embedded + web_safari attempts |
| Real app retries local Chromium-family and Firefox browser profiles | PASS | Packaged media implementation and package/launch acceptance |
| Owner acceptance launcher inside Windows package | PASS | Package validation, run #79 |
| Owner launcher packaged-app-first control flow | PASS | PR #82 deterministic Windows CMD smoke in run #79 |
| Browser-cookie fallback avoids stale Cookie/header precedence conflicts | PASS | Fresh browser jar takes precedence while useful headers are retained |
| Chrome/Edge/Firefox extension contract | PASS | Build/contract checks; installer registration preserved |
| Real public YouTube on GitHub-hosted Windows | BLOCKED BY HOST NETWORK | YouTube challenges datacenter IP; neutral fallback is not counted as YouTube acceptance |
| Real owner-network YouTube using packaged tools/browser state | PENDING | Final owner-use acceptance gap |

## Exact recent Windows evidence

Subutai Internal Windows MVP workflow run `32682195251` / run number `79` on PR #82 head `e43c0774e529fffc2ec975ce38ba423879c4b7ef` passed the strengthened hosted owner-test path end-to-end.

The run passed:

- owner-acceptance PowerShell/Node syntax validation;
- deterministic Windows CMD launcher control-flow regression cases;
- packaged media/runtime staging with yt-dlp `2026.08.19`, FFmpeg/ffprobe and Node `22.23.2`;
- pinned `bgutil-ytdlp-pot-provider` `1.3.1` staging and package validation;
- TypeScript/browser extension contracts;
- checksum-verified native HTTP download;
- live 64 MiB interruption/restart recovery;
- transfer pause/resume contracts;
- Windows Setup/Portable construction;
- packaged desktop-host normal HTTP, explicit pause/resume and restart recovery;
- packaged Electron launch smoke;
- internal prerelease publication.

The native direct smoke downloaded `5,243,017` bytes and verified SHA-256 `4bc7cd930235cf958669301899dfefad8d2462ef752e8b109f55274e3177de7f`. The packaged desktop-host acceptance reported `SUBUTAI_OWNER_CRITICAL_DIRECT_ACCEPTANCE=PASS` after normal HTTP, pause/resume after 8 MiB, restart recovery after 8 MiB and exact completion of a 64 MiB payload.

Package validation confirmed the actual app launched and reached `Launch smoke completed successfully`, and confirmed these release artifacts:

- `Subutai-Setup-0.2.0-rc.2-x64.exe`
- `Subutai-Portable-0.2.0-rc.2-x64.exe`
- `SHA256SUMS.txt`
- bundled `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd`

The internal tag `internal-v0.2.0-rc.2` was republished from PR #82 head with the Setup, Portable, checksums and owner-network acceptance assets.

## YouTube acceptance boundary

Run #79 attempted three public YouTube videos through the packaged stack using `default`, `mweb` with the packaged PO-token provider, `android_vr`, `web_embedded` and `web_safari` profiles. GitHub-hosted Windows remained challenged by YouTube's datacenter/network controls. The workflow therefore validated a neutral media file and emitted:

`SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PENDING_HOSTED_RUNNER_CHALLENGE`

That fallback proves the packaged yt-dlp/FFmpeg/Node/provider media stack is functional, but it intentionally does **not** satisfy the real YouTube owner-readiness requirement.

## Final owner-network acceptance path

The launcher is available both beside the internal prerelease assets and inside the packaged application at:

`resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd`

The current launcher:

1. prefers the real packaged/installed Subutai application and invokes `--subutai-owner-youtube-acceptance`;
2. if packaged-app acceptance fails, runs the direct packaged owner acceptance script for diagnostics;
3. if that fails, runs the bounded fresh-media-URL retry script;
4. propagates the true final exit status without stale CMD block expansion;
5. reports success only when an actual acceptance path succeeds.

The harness and packaged media service use the actual packaged binaries, local browser sessions/profiles, resilient player-client fallbacks and the packaged PO-token provider. A true real-network success must produce a playable YouTube media file validated by packaged `ffprobe`, record its SHA-256 and emit `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS`.

The final harness still must pass on a real owner Windows network before the exact completion sentence is permitted.

## Browser interception/media behavior

The Chromium/Firefox extension implementation retains download interception, native messaging, request-header capture, local browser cookies, referer/user-agent forwarding, context-menu download routing and direct handoff into the desktop queue. Existing installer acceptance preserves browser native-messaging registration. These capabilities must not be removed while resolving YouTube acceptance.

## Production release boundary

The following remain required for a signed public release but are not prerequisites for an unsigned owner-test decision:

- `SUBUTAI_RELEASES_TOKEN`;
- `WIN_CSC_LINK`;
- `WIN_CSC_KEY_PASSWORD`;
- `SUBUTAI_UPDATE_SIGNING_KEY_BASE64`;
- `SUBUTAI_UPDATE_PUBLIC_KEY_BASE64`;
- clean physical Windows 10 x64 signed acceptance;
- clean physical Windows 11 x64 signed acceptance.

## Next correct sequence

1. Keep the run-#79-class hosted Windows gates passing without weakening direct/recovery/package/launch checks.
2. Run the bundled packaged-app-first owner acceptance launcher on a real Windows owner network.
3. If real YouTube still fails, use the exact packaged-app/browser-profile diagnostics to harden the media path; do not substitute neutral hosted media for YouTube acceptance.
4. Declare owner readiness only after `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS` plus the already-passing direct/recovery/package/launch gates.
5. Keep production signing and clean-machine public-release promotion as a later release track.

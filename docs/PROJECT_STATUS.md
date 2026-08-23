# Subutai — Authoritative Project Status

Last audited: 2026-08-24  
Audited `main`: `522e62c400765bc52809626a3124fb2c5216ef69` (through PR #72)

## Current conclusion

Subutai has a working unsigned **`0.2.0-rc.2` owner-test Windows baseline** with real Setup and Portable artifacts. It is **not yet declared owner-ready** because a real owner-network YouTube download through the packaged application/tools has not produced `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS` evidence.

Normal HTTP downloads through the first-party native engine, packaged desktop-host HTTP downloads, explicit large-file pause/resume, controller/app restart recovery, packaging, launch, browser integration and the packaged media runtime are passing. Production signing/public-release gates remain separate from owner-test readiness.

## Merged owner-test baseline

| PR | Result |
|---|---|
| #45 | Focused one-link UI, automatic media routing, packaged yt-dlp/FFmpeg/Node stack, Setup/Portable owner-test publication |
| #47 | Real live HTTP transfer interruption, durable partial/journal persistence and exact restart-resume verification |
| #51 | Bounded YouTube player-client fallback attempts before neutral hosted-runner fallback |
| #52 | yt-dlp `2026.08.19`, strict real-owner YouTube acceptance harness, Chrome/Edge/Firefox browser-cookie fallback |
| #53 | Packaged `yt-dlp.conf` makes the real application media engine try the resilient YouTube player-client set automatically |
| #54 | One-click owner-network YouTube acceptance launcher published beside the Windows owner-test artifacts |
| #56 | Owner-network YouTube acceptance harness bundled inside Setup/Portable resources and package validation |
| #57 | Windows owner build gated by a checksum-verified normal HTTP download through the first-party native engine; obsolete aria2c smoke removed from readiness |
| #58 | Real packaged media service retries Chrome, Edge and Firefox browser sessions automatically after a YouTube authentication challenge |
| #60 | Owner-network acceptance broadens browser-session discovery to Firefox first, Chromium default/recent profiles, Edge profiles and Brave while preserving strict YouTube PASS semantics |
| #62 | Owner acceptance discovers installed Firefox and Chromium-family profiles on Windows and covers Chrome, Edge, Brave, Chromium and Vivaldi profile directories before deterministic fallbacks |
| #63 | Real packaged MediaService mirrors installed Chromium-family profile discovery from the owner acceptance harness while preserving extension headers/cookies and transfer/recovery gates |
| #65 | Owner-network acceptance reads Firefox `profiles.ini`, retries named Firefox profiles and preserves deterministic `default-release` / `default` fallbacks before Chromium-family attempts |
| #67 | Owner acceptance retries explicit Firefox profile paths when named-profile cookie lookup is insufficient |
| #68 | The packaged media path mirrors the named/explicit Firefox profile fallback behavior |
| #69 | Windows owner build now exercises the packaged `subutai-engine-host.exe` over the real desktop IPC protocol for normal HTTP, explicit pause/resume and controller shutdown/restart recovery before publication |
| #70 | Removes the superseded packaged acceptance harness and refreshes the authoritative owner-readiness evidence after PR #69 |
| #71 | Packaged MediaService refreshes Firefox explicit profile-path discovery at retry/resume time and keeps the final owner-network YouTube PASS boundary strict |
| #72 | Browser-session fallback now drops only the stale intercepted `Cookie` header when switching to a fresh `--cookies-from-browser` jar, while preserving referer, user-agent and other request headers |

Earlier merged release engineering remains preserved, including native direct engine, queue/persistence, browser integration, transactional update/rollback, checksum rejection, Authenticode release policy and signed update-manifest policy.

## Current owner-use acceptance matrix

| Critical path | Status | Evidence |
|---|---:|---|
| Windows app launches | PASS | Packaged Electron launch smoke |
| Normal HTTP/direct engine | PASS | Checksum-verified real download through `subutai-engine` |
| Packaged desktop host normal HTTP | PASS | PR #69, Internal Windows MVP run #63 |
| Large-file interruption/resume | PASS | 64 MiB ranged transfer, durable partial state, exact SHA-256 completion |
| Explicit packaged-host pause/resume | PASS | PR #69, 64 MiB package acceptance via desktop IPC |
| Unfinished download survives app/controller restart | PASS | PR #69 packaged-host EOF/restart path plus two-phase restart recovery harness |
| Pause/resume control contracts | PASS | `pnpm test:transfer` |
| Setup build exists | PASS | `Subutai-Setup-0.2.0-rc.2-x64.exe` |
| Portable build exists | PASS | `Subutai-Portable-0.2.0-rc.2-x64.exe` |
| Packaged yt-dlp/FFmpeg/Node media stack | PASS | Real neutral media download + ffprobe validation |
| Resilient YouTube player-client defaults are in packaged app | PASS | PR #53 + staging validation |
| Real app retries local Chromium-family and Firefox browser profiles | PASS | PR #71/#72 + package/launch acceptance |
| Owner acceptance launcher is inside the Windows package | PASS | PR #56 + package validation |
| Owner acceptance discovers installed Chromium-family and named/explicit Firefox profiles | PASS | PR #67/#71 |
| Browser-cookie fallback avoids stale Cookie/header precedence conflicts | PASS | PR #72 + Internal Windows MVP run #63 |
| Real public YouTube on GitHub-hosted Windows | BLOCKED BY HOST NETWORK | YouTube challenges datacenter IP; neutral fallback is not counted as YouTube acceptance |
| Real owner-network YouTube using packaged tools/browser state | PENDING | Final owner-use acceptance gap |
| Chrome/Edge/Firefox extension contract | PASS | Build/contract checks; installer registration preserved |

## Exact recent Windows evidence

Subutai Internal Windows MVP workflow run `32653835572` / run number `63` on PR #72 head `053f32d25fa17bfd91aecff780b894c279342dc4` passed the strengthened hosted owner-test path. The run passed owner-acceptance harness syntax validation, packaged media/runtime validation, TypeScript/browser contracts, first-party native HTTP download, live 64 MiB interruption/restart recovery, pause/resume control contracts, Windows Setup/Portable construction, packaged desktop-host normal HTTP + explicit pause/resume + controller shutdown/restart recovery, packaged Electron launch smoke and prerelease publication.

The packaged-host gate uses the actual `win-unpacked\resources\engines\subutai-engine-host.exe` and packaged Node runtime. It drives the same binary desktop IPC protocol used by the application, pauses an in-flight 64 MiB ranged transfer, requires persisted resumable state, restarts the host, resumes to an exact SHA-256 match, then repeats the recovery path by closing the controller input to model application/controller shutdown.

Run #63 also confirmed that the current PR #72 media path still packages yt-dlp `2026.08.19`, FFmpeg/ffprobe and Node `22.23.2`, validates a real neutral media file, and then records `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PENDING_HOSTED_RUNNER_CHALLENGE` after YouTube rejects the GitHub-hosted datacenter runner. This remains intentionally insufficient for owner-ready declaration.

Published internal owner-test tag remains `internal-v0.2.0-rc.2`; run #63 republished its Setup, Portable, checksums and owner-network acceptance assets from PR #72 head `053f32d25fa17bfd91aecff780b894c279342dc4`.

## Final owner-network acceptance path

The owner acceptance launcher is available both beside the internal prerelease assets and inside the packaged application at `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd`.

`scripts/owner-youtube-acceptance.ps1` uses the actual packaged binaries from the unpacked/installed application and:

- tries anonymous YouTube extraction first;
- reads Firefox `profiles.ini`, tries named Firefox profiles and explicit profile paths, then deterministic fallbacks;
- discovers Chromium-family profile directories on Windows;
- covers Chrome, Edge, Brave, Chromium and Vivaldi `Default` / numbered profiles when present;
- tries bounded `default`, `android_vr`, `web_embedded` and `web_safari` player-client profiles;
- accepts only a real playable YouTube media file validated by packaged `ffprobe`;
- records the result SHA-256;
- emits `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS` only on a true success.

The packaged application mirrors these browser-session fallbacks while retaining extension-supplied cookies/headers and the bounded player-client defaults from `resources/engines/yt-dlp.conf`. On a browser-profile retry it intentionally suppresses only the previously intercepted `Cookie` header so the fresh browser cookie jar is authoritative; referer, user-agent and other useful request headers remain intact.

The final harness still must pass on a real owner Windows network before the exact completion sentence is permitted.

## Browser interception/media behavior

The Chromium/Firefox extension implementation retains download interception, native messaging, request-header capture, local browser cookies, referer/user-agent forwarding, context-menu download routing and direct handoff into the desktop queue. Existing installer acceptance also preserves browser native-messaging registration. These capabilities must not be removed while resolving YouTube acceptance.

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

1. Keep the strengthened hosted Windows MVP gates passing without weakening packaged direct/recovery/package/launch checks.
2. Run the bundled `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd` against the packaged/installed rc.2 build on a real Windows owner network, preferably while signed into YouTube in Firefox, Chrome, Edge, Brave, Chromium or Vivaldi.
3. If it fails, use the exact browser/profile diagnostics to harden the packaged media path; do not substitute neutral hosted media for YouTube acceptance.
4. Declare owner readiness only after `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS` plus the already-passing direct/recovery/package/launch gates.
5. Keep production signing and clean-machine public-release promotion as a later release track.

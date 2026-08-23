# Subutai — Authoritative Project Status

Last audited: 2026-08-23  
Audited `main`: `d5c68b2cb83cce029b36ad45b58c282680f1d005` (through PR #65)

## Current conclusion

Subutai has a working unsigned **`0.2.0-rc.2` owner-test Windows baseline** with real Setup and Portable artifacts. It is **not yet declared owner-ready** because a real owner-network YouTube download through the packaged application/tools has not produced `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS` evidence.

Normal HTTP downloads through the first-party native engine, large-file interruption/restart recovery, pause/resume control, packaging, launch, browser integration and the packaged media runtime are passing. Production signing/public-release gates remain separate from owner-test readiness.

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
| #62 | Owner acceptance now discovers installed Firefox and Chromium-family profiles on Windows and covers Chrome, Edge, Brave, Chromium and Vivaldi profile directories before deterministic fallbacks |
| #63 | Real packaged MediaService now mirrors installed Chromium-family profile discovery from the owner acceptance harness while preserving extension headers/cookies and all existing transfer/recovery gates |
| #65 | Owner-network acceptance now reads Firefox `profiles.ini`, retries named Firefox profiles and preserves deterministic `default-release` / `default` fallbacks before Chromium-family attempts |

Earlier merged release engineering remains preserved, including native direct engine, queue/persistence, browser integration, transactional update/rollback, checksum rejection, Authenticode release policy and signed update-manifest policy.

## Current owner-use acceptance matrix

| Critical path | Status | Evidence |
|---|---:|---|
| Windows app launches | PASS | Packaged Electron launch smoke |
| Normal HTTP/direct engine | PASS | Checksum-verified real download through `subutai-engine` |
| Large-file interruption/resume | PASS | 64 MiB ranged transfer, durable partial state, exact SHA-256 completion |
| Unfinished download survives app/engine restart | PASS | Two-phase restart recovery harness |
| Pause/resume control contracts | PASS | `pnpm test:transfer` |
| Setup build exists | PASS | `Subutai-Setup-0.2.0-rc.2-x64.exe` |
| Portable build exists | PASS | `Subutai-Portable-0.2.0-rc.2-x64.exe` |
| Packaged yt-dlp/FFmpeg/Node media stack | PASS | Real neutral media download + ffprobe validation |
| Resilient YouTube player-client defaults are in packaged app | PASS | PR #53 + staging validation |
| Real app retries local browser sessions and installed Chromium-family profiles | PASS | PR #63 + TypeScript/package/launch acceptance |
| Owner acceptance launcher is inside the Windows package | PASS | PR #56 + package validation |
| Owner acceptance discovers installed Chromium-family and named Firefox profiles | PASS | PR #65 + Internal Windows MVP run #51 |
| Real public YouTube on GitHub-hosted Windows | BLOCKED BY HOST NETWORK | YouTube challenges datacenter IP; neutral fallback is not counted as YouTube acceptance |
| Real owner-network YouTube using packaged tools/browser state | PENDING | Final owner-use acceptance gap |
| Chrome/Edge/Firefox extension contract | PASS | Build/contract checks; installer registration preserved |

## Exact recent Windows evidence

Subutai Internal Windows MVP workflow run `32635872223` / run number `51` on PR #65 head `e60f0701be041a9cc22c13f6d2d5a8ca673aded3` passed the complete hosted owner-test workflow after named Firefox profile discovery was added to the bundled owner acceptance harness. The run passed owner-acceptance harness syntax validation, packaged media/runtime validation, TypeScript/browser contracts, first-party native HTTP download, live interruption/restart recovery, pause/resume control contracts, Windows Setup/Portable construction, packaged Electron launch smoke and prerelease publication.

The fully enumerated owner-use path remains validated: real direct transfer, live 64 MiB interruption with durable partial/journal state, restart/resume to exact SHA-256 output, pause/resume contracts, packaged media stack, Setup/Portable build and launch smoke all pass. The hosted runner still cannot establish the final owner-network YouTube condition because YouTube challenges datacenter addresses. This is an external acceptance-environment limitation, not grounds to weaken the gate.

Published internal owner-test tag remains `internal-v0.2.0-rc.2` and contains the Windows owner-test packages plus bundled owner-network acceptance assets.

## Final owner-network acceptance path

The owner acceptance launcher is available both beside the internal prerelease assets and inside the packaged application at `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd`.

`scripts/owner-youtube-acceptance.ps1` uses the actual packaged binaries from the unpacked/installed application and:

- tries anonymous YouTube extraction first;
- reads Firefox `profiles.ini` and tries named Firefox profiles, then deterministic `default-release` / `default` fallbacks;
- discovers Chromium-family profile directories on Windows;
- covers Chrome, Edge, Brave, Chromium and Vivaldi `Default` / numbered profiles when present, while preserving deterministic fallbacks;
- tries bounded `default`, `android_vr`, `web_embedded` and `web_safari` player-client profiles;
- accepts only a real playable YouTube media file validated by packaged `ffprobe`;
- records the result SHA-256;
- emits `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS` only on a true success.

The packaged application itself mirrors installed Chromium-family profile discovery and retries local browser sessions automatically if an anonymous YouTube probe/download is challenged, while retaining extension-supplied cookies/headers and the bounded player-client defaults from `resources/engines/yt-dlp.conf`.

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

1. Keep the current hosted Windows MVP gates passing without weakening direct/recovery/package/launch checks.
2. Run the bundled `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd` against the packaged/installed rc.2 build on a real Windows owner network, preferably while signed into YouTube in Firefox, Chrome, Edge, Brave, Chromium or Vivaldi.
3. If it fails, use the exact browser/profile diagnostics to harden the packaged media path; do not substitute neutral hosted media for YouTube acceptance.
4. Declare owner readiness only after `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS` plus the already-passing direct/recovery/package/launch gates.
5. Keep production signing and clean-machine public-release promotion as a later release track.
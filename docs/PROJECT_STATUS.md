# Subutai — Authoritative Project Status

Last audited: 2026-08-23  
Audited `main`: `37b90e878319d6da56a77769439612969e454767` (through PR #58)

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
| Real app retries local Chrome/Edge/Firefox sessions | PASS | PR #58 + TypeScript/package/launch acceptance |
| Owner acceptance launcher is inside the Windows package | PASS | PR #56 + package validation |
| Real public YouTube on GitHub-hosted Windows | BLOCKED BY HOST NETWORK | YouTube challenges datacenter IP; neutral fallback is not counted as YouTube acceptance |
| Real owner-network YouTube using packaged tools/browser state | PENDING | Final owner-use acceptance gap |
| Chrome/Edge/Firefox extension contract | PASS | Build/contract checks; installer registration preserved |

## Exact recent Windows evidence

Subutai Internal Windows MVP workflow run `32619773928` / run number `47` on PR #58 head `00ab972f8d620aedbfe4f4abd918f948a0085f5c` passed all hosted owner-test gates:

1. owner-network harness syntax validation;
2. packaged yt-dlp/FFmpeg/ffprobe/Node staging;
3. hosted YouTube attempts and neutral fallback media validation when the datacenter IP is challenged;
4. TypeScript + browser extension contracts, including the new app-side browser-session retry path;
5. production Rust direct-engine build;
6. checksum-verified normal HTTP download through `subutai-engine`;
7. live 64 MiB HTTP interruption with durable partial/journal state;
8. restart/resume to exact SHA-256 output;
9. pause/resume transfer control contracts;
10. Windows Setup and Portable construction;
11. packaged Electron launch smoke;
12. internal prerelease asset publication.

Published internal owner-test tag remains `internal-v0.2.0-rc.2`; run #47 refreshed the Setup/Portable owner-test assets after PR #58.

The hosted runner cannot establish the final owner-network YouTube condition because YouTube challenges the datacenter address. This is an external acceptance-environment limitation, not grounds to weaken the gate.

## Final owner-network acceptance path

The owner acceptance launcher is available both beside the internal prerelease assets and inside the packaged application at `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd`.

`scripts/owner-youtube-acceptance.ps1` uses the actual packaged binaries from the unpacked/installed application and:

- tries anonymous YouTube extraction first;
- tries Chrome, Edge and Firefox local browser-cookie state;
- tries bounded `default`, `android_vr`, `web_embedded` and `web_safari` player-client profiles;
- accepts only a real playable YouTube media file validated by packaged `ffprobe`;
- records the result SHA-256;
- emits `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS` only on a true success.

The packaged application itself now also retries Chrome, Edge and Firefox local browser sessions automatically if an anonymous YouTube probe/download is challenged, while retaining the bounded player-client defaults from `resources/engines/yt-dlp.conf`.

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
2. Run the bundled `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd` against the packaged/installed rc.2 build on a real Windows owner network, preferably while signed into YouTube in Chrome/Edge/Firefox.
3. If it fails, use the exact browser/profile diagnostics to harden the packaged media path; do not substitute neutral hosted media for YouTube acceptance.
4. Declare owner readiness only after `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS` plus the already-passing direct/recovery/package/launch gates.
5. Keep production signing and clean-machine public-release promotion as a later release track.

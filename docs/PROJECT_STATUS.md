# Subutai — Authoritative Project Status

Last audited: 2026-08-23  
Audited `main`: `b348c929b3d605694fa74cc57355e7572cadc892` (through PR #51)

## Current conclusion

Subutai has a working unsigned **`0.2.0-rc.2` owner-test Windows baseline** with real Setup and Portable artifacts. It is **not yet declared owner-ready** because a real owner-network YouTube download through the packaged media stack has not produced acceptance evidence. GitHub-hosted Windows is challenged by YouTube before extraction, so neutral media fallback is not counted as YouTube acceptance.

For normal direct downloads, restart recovery, pause/resume contracts, packaging and launch, the current rc.2 path is passing. Production signing/public-release gates remain separate from owner-test readiness.

## Merged owner-test baseline

| PR | Result |
|---|---|
| #45 | Focused one-link UI, automatic media routing, packaged yt-dlp/FFmpeg/Node stack, Setup/Portable owner-test publication |
| #47 | Real live HTTP transfer interruption, durable partial/journal persistence and exact restart-resume verification |
| #51 | Bounded YouTube player-client fallback attempts before neutral hosted-runner fallback |

Earlier merged release engineering remains preserved, including native direct engine, queue/persistence, browser integration, transactional update/rollback, checksum rejection, Authenticode release policy and signed update-manifest policy.

## Current owner-use acceptance matrix

| Critical path | Status | Evidence |
|---|---:|---|
| Windows app launches | PASS | Packaged Electron launch smoke |
| Normal HTTP/direct engine | PASS | Live native HTTP transfer harness |
| Large-file interruption/resume | PASS | 64 MiB ranged transfer, durable partial state, exact SHA-256 completion |
| Unfinished download survives app/engine restart | PASS | Two-phase restart recovery harness |
| Pause/resume control contracts | PASS | `pnpm test:transfer` |
| Setup build exists | PASS | `Subutai-Setup-0.2.0-rc.2-x64.exe` |
| Portable build exists | PASS | `Subutai-Portable-0.2.0-rc.2-x64.exe` |
| Packaged yt-dlp/FFmpeg/Node media stack | PASS | Real neutral media download + ffprobe validation |
| Real public YouTube on GitHub-hosted Windows | BLOCKED BY HOST NETWORK | YouTube challenges datacenter IP; not counted as product pass |
| Real owner-network YouTube using packaged tools/browser state | PENDING | Final owner-use acceptance gap |
| Chrome/Edge/Firefox extension contract | PASS | Build/contract checks; controlled installer registration exists from release acceptance |

## Exact recent Windows evidence

Subutai Internal Windows MVP workflow run `32595813634` / run number `35` on PR #51 head `3fc8df350aa1c1a41db771195d4e4864473c517f` passed:

1. packaged media tool staging;
2. hosted YouTube attempts across default, `android_vr`, `web_embedded` and `web_safari` profiles;
3. neutral fallback media download and ffprobe validation when YouTube challenged the runner;
4. TypeScript + extension contracts;
5. production Rust direct-engine build;
6. live 64 MiB HTTP interruption with 8 MiB durable partial progress;
7. restart/resume to exact 64 MiB verified output;
8. pause/resume transfer policy contracts;
9. Windows Setup and Portable construction;
10. packaged Electron launch smoke;
11. internal prerelease asset publication.

Published internal owner-test tag: `internal-v0.2.0-rc.2`.

The hosted-runner media result intentionally records `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PENDING_HOSTED_RUNNER_CHALLENGE`; therefore this evidence is not sufficient to declare owner readiness.

## Active final owner-test work

PR #52 (`agent/rc2-owner-youtube-final`) is the current final owner-network acceptance path. It:

- refreshes the checksum-pinned standalone Windows yt-dlp to upstream stable `2026.08.19`;
- adds `scripts/owner-youtube-acceptance.ps1`;
- uses the packaged yt-dlp/FFmpeg/ffprobe/Node binaries from the built or installed app;
- tries anonymous mode plus Chrome, Edge and Firefox local browser-cookie state;
- tries bounded YouTube player-client profiles;
- accepts only a real playable media file validated by packaged ffprobe;
- records SHA-256 evidence;
- emits `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS` only on a true real YouTube success.

The owner-network harness must pass on a real Windows owner machine before the exact sentence announcing completion is permitted.

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

1. Make PR #52 pass all current Windows CI gates without weakening any existing acceptance.
2. Merge the current yt-dlp refresh and owner-network acceptance harness.
3. Run the owner-network harness against the packaged/installed rc.2 build on a real Windows owner machine, preferably with the owner already signed into YouTube in Chrome/Edge/Firefox.
4. If it fails, use the harness diagnostics to harden the packaged media path; do not substitute neutral hosted media for YouTube acceptance.
5. Declare owner readiness only after `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS` plus the already-passing direct/recovery/package/launch gates.
6. Keep production signing and clean-machine public-release promotion as a later release track.

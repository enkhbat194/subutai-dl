# Subutai YouTube owner acceptance status

Last audited: 2026-08-23 after PR #75 (`13125ba34e8d1322b280a4e7e4e2d3c89138703b`).

## Readiness boundary

Subutai is **not yet owner-ready**. The remaining release-blocking gate is a real YouTube media download through the packaged Windows media stack on a non-datacenter owner network. Do not replace this gate with a neutral media download, metadata-only probe, code completion, or hosted CI success.

Required terminal evidence remains:

```text
SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS
```

from the packaged `resources\owner-acceptance\Run-Subutai-Owner-Acceptance.cmd` path or an equivalent real packaged-app execution.

## Critical paths already proved

The current `0.2.0-rc.2` owner-test package has real Setup and Portable executables. The Windows MVP acceptance has proved application launch, normal HTTP download, packaged-host 64 MiB transfer, explicit pause/resume, controller/app restart recovery with exact completion, browser integration contracts, packaged media binaries/runtime, and package validation.

## PR #75 progress

PR #75 added the current yt-dlp-recommended proof-of-origin-token engineering path without weakening the readiness boundary:

- stages `bgutil-ytdlp-pot-provider` version `1.3.1` from exact commit `7608dd51ee813b48cf9a6d68c6e42cb197ce10e0`;
- packages the yt-dlp plugin, local Node script provider, production dependencies, GPL-3.0 license, corresponding provider source and provenance;
- configures the packaged Electron main process to expose the provider server path to yt-dlp;
- adds `mweb` PO-token attempts while preserving existing `default`, `android_vr`, `web_embedded` and `web_safari` fallback paths;
- validates the provider runtime after Windows packaging;
- preserves browser-cookie fallback and explicit HTTP 403 handling.

The PR #75 Windows MVP run passed every local/package gate, including the staged provider build and packaged provider version check. GitHub-hosted Windows still received YouTube/datacenter challenges and therefore correctly emitted:

```text
SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PENDING_HOSTED_RUNNER_CHALLENGE
```

This is expected to remain **PENDING**, not PASS, until a real packaged download succeeds on the owner network.

## Next action

Continue engineering only where it can increase the probability or observability of the real owner-network packaged YouTube pass. Do not regress the already-passing direct-download, pause/resume, recovery, browser interception, Setup/Portable, update, or launch paths. Once the real packaged YouTube run produces playable media and `SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS`, re-run the full critical acceptance boundary before declaring Subutai ready.

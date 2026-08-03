# Subutai Direct 1.0 / 0.2.0 Release Gate

This file separates engineering completion from signed public-release readiness.

## Gate states

- **PASS** — evidence exists for the exact commit and artifact.
- **BLOCKED** — required external infrastructure is unavailable.
- **PENDING** — executable work has not been performed.
- **FAIL** — required behavior did not pass.

## G0 — Current engineering baseline

Status: **PASS on merged source and engineering workflows**

- [x] first-party Rust direct-download engine;
- [x] frozen pnpm dependency graph;
- [x] Setup and Portable packaging;
- [x] packaged, installed and uninstalled app acceptance;
- [x] transactional update journal;
- [x] real two-installer healthy update;
- [x] forced target-health rollback;
- [x] checksum-mismatch rejection;
- [x] browser registration restoration;
- [x] updater error redaction;
- [x] public binary-only update channel;
- [x] Authenticode signing policy and verification scripts;
- [x] Ed25519 update-manifest signing and verification policy.

## G1 — Version preflight

Status: **IN PROGRESS on this PR**

- [x] root package version is `0.2.0-rc.1`;
- [x] desktop package version matches;
- [x] extension package version matches;
- [x] shared package version matches;
- [x] release version supports `rc.N`;
- [ ] all PR workflows pass on the exact commit.

## G2 — Protected external credentials

Status: **BLOCKED**

The following repository/environment secrets must be provisioned outside source control:

- [ ] `SUBUTAI_RELEASES_TOKEN`
- [ ] `WIN_CSC_LINK`
- [ ] `WIN_CSC_KEY_PASSWORD`
- [ ] `SUBUTAI_UPDATE_SIGNING_KEY_BASE64`
- [ ] `SUBUTAI_UPDATE_PUBLIC_KEY_BASE64`

Rules:

- no secret or private key in source, logs, artifacts, issue comments or PR comments;
- `SUBUTAI_RELEASES_TOKEN` must have least-privilege Contents write access only to `enkhbat194/subutai-releases`;
- Authenticode material must come from a trusted production certificate/signing service;
- the Ed25519 private key must be retained offline or in approved protected infrastructure.

## G3 — Signed candidate build

Status: **BLOCKED by G2**

Required evidence:

- [ ] signed desktop executable;
- [ ] signed Rust native host;
- [ ] signed NSIS Setup;
- [ ] signed Portable executable;
- [ ] SHA-256 digest;
- [ ] valid certificate chain;
- [ ] valid RFC 3161 timestamp;
- [ ] consistent publisher subject;
- [ ] signed `subutai-update-manifest.json`;
- [ ] exact candidate commit SHA and artifact hashes.

The build must be produced without creating a public release until G4 and G5 pass.

## G4 — Clean physical Windows 10 acceptance

Status: **BLOCKED: machine unavailable**

Required on a clean physical Windows 10 x64 machine:

- [ ] Setup install and first launch;
- [ ] Portable launch;
- [ ] first-party native engine download;
- [ ] Chrome, Edge and Firefox registration;
- [ ] healthy signed update;
- [ ] failed-target automatic rollback;
- [ ] checksum/tamper rejection;
- [ ] settings, database, queue and partial-file preservation;
- [ ] uninstall and complete cleanup;
- [ ] no remaining process, shortcut, registry entry, updater cache or test installation.

## G5 — Clean physical Windows 11 acceptance

Status: **BLOCKED: clean machine unavailable**

Apply the same acceptance matrix as G4 on a clean physical Windows 11 x64 machine. The existing BYBE engineering runner does not satisfy this gate because it is not a clean physical release-acceptance environment.

## G6 — Prerelease publication

Status: **PENDING**

Only after G2–G5 pass:

- [ ] merge the accepted version/preflight PR;
- [ ] create exact tag `v0.2.0-rc.1`;
- [ ] run the protected release workflow;
- [ ] publish to `enkhbat194/subutai-releases` as a prerelease;
- [ ] verify anonymous client discovery and signed-manifest validation;
- [ ] record workflow IDs, hashes and cleanup evidence.

## Hard boundary for this PR

This PR must not:

- create a tag;
- create a GitHub Release;
- publish Setup or Portable artifacts;
- deploy a production channel;
- create or expose production secrets.

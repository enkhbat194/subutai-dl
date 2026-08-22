# Subutai — Authoritative Project Status

Last audited: 2026-08-03  
Audited `main`: `aec8e72c8eb5a7a8acc3656a70a535349f3e80ca` (PR #43)

## Current conclusion

Subutai is an engineering-complete **`0.2.0-rc.1` release-candidate baseline**, not a signed public release.

The core runtime, package, update transaction, rollback, public update channel, release-signing policy and signed update-manifest verification are implemented. Remaining blockers are external credentials and clean physical Windows acceptance.

## Merged release baseline

| PR | Result |
|---|---|
| #34 | Real NSIS two-installer update, forced rollback and checksum-rejection acceptance |
| #40 | User-visible updater error redaction and Windows watchdog reliability hardening |
| #41 | Fail-closed Authenticode build, signature and timestamp verification |
| #42 | Anonymous client updates through public binary-only `subutai-releases` |
| #43 | Ed25519-signed update manifests, channel isolation and downgrade/replay protection |

PR #33 was closed without merge because it was based on the pre-#34 `main` state and contained obsolete release claims.

## Capability status

| Area | Implemented | Automated/runner evidence | External acceptance |
|---|---:|---:|---:|
| First-party Rust direct engine | Yes | PASS | Physical smoke pending |
| Queue, scheduler and persistence | Yes | PASS | Physical UX pending |
| Chrome, Edge and Firefox integration | Yes | PASS on controlled install | Installed-browser matrix pending |
| Media path using temporary tools | Yes | Automated partial | Physical media matrix pending |
| Setup and Portable packaging | Yes | PASS | Clean-machine signed acceptance pending |
| Transactional update and rollback | Yes | Real A/B installer PASS | Signed public-channel acceptance pending |
| Checksum/tamper rejection | Yes | PASS | Signed candidate retest pending |
| Public binary update channel | Yes | Policy PASS | Publishing token required |
| Authenticode signing workflow | Yes | Policy PASS | Production certificate required |
| Signed update manifest | Yes | Policy/unit PASS | Offline release key required |

## Exact verified updater behavior

The merged Windows acceptance verifies:

1. healthy `0.1.0 -> 0.2.0` update and committed startup health;
2. deterministic target-health failure and automatic rollback to `0.1.0`;
3. corrupted target installer rejection before transaction arm/install;
4. preservation of settings, SQLite state, queue and partial-download sentinels;
5. Chrome, Edge and Firefox native-messaging restoration;
6. bounded watchdog execution and cleanup.

The candidate version bump to `0.2.0-rc.1` changes package identity only. It does not publish a tag, release or installer.

## Release workflow status

The release workflow already fails closed when any required secret is missing:

- `SUBUTAI_RELEASES_TOKEN`
- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`
- `SUBUTAI_UPDATE_SIGNING_KEY_BASE64`
- `SUBUTAI_UPDATE_PUBLIC_KEY_BASE64`

It also requires version/tag equality, frozen dependencies, native and product policy tests, updater acceptance, signed package construction, Authenticode verification, signed update-manifest generation and package acceptance before publication.

## Remaining external blockers

### Production signing

- obtain a trusted Windows Authenticode certificate or approved signing service;
- provision `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` in protected GitHub release infrastructure;
- retain the private key outside source, logs, artifacts and PR comments.

### Update-manifest signing

- generate and securely retain an offline Ed25519 key pair;
- provision `SUBUTAI_UPDATE_SIGNING_KEY_BASE64`;
- provision the matching `SUBUTAI_UPDATE_PUBLIC_KEY_BASE64`;
- rotate keys only through an explicit trust migration.

### Publication

- provision a least-privilege `SUBUTAI_RELEASES_TOKEN` with Contents write access only to `enkhbat194/subutai-releases`;
- do not embed the token in the application.

### Clean physical acceptance

- clean physical Windows 10 x64 machine;
- clean physical Windows 11 x64 machine;
- signed Setup and Portable acceptance on both;
- install, first launch, native engine, browser registration, update, rollback, checksum rejection, uninstall and user-data preservation;
- exact commit SHA, OS build, workflow IDs, artifact hashes and cleanup evidence.

## Release state

| Stage | Status |
|---|---|
| Source implementation | PASS |
| Automated policy/typecheck | Required on this PR |
| Windows engineering runner | Required on this PR |
| Production credentials | BLOCKED |
| Signed candidate build | BLOCKED |
| Clean Windows 10 physical acceptance | BLOCKED |
| Clean Windows 11 physical acceptance | BLOCKED |
| `v0.2.0-rc.1` tag/prerelease | NOT CREATED |
| Public installer publication | NOT PERFORMED |

## Next correct sequence

1. Merge this preflight/version PR only after all branch checks pass.
2. Provision protected release credentials.
3. Build signed `0.2.0-rc.1` artifacts without publishing.
4. Run clean physical Windows 10/11 signed acceptance.
5. Create `v0.2.0-rc.1` and publish a prerelease only after the external gates pass.
6. Promote to stable `0.2.0` only after prerelease evidence is accepted.

No tag, GitHub Release, installer publication or deployment is part of this PR.

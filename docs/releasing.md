# Subutai Download Manager release process

Subutai uses isolated stable and beta/RC Windows updater channels backed by the public binary-only repository `enkhbat194/subutai-releases`. Application source remains private.

## Current candidate

The source packages are aligned to **`0.2.0-rc.1`**. This version bump is preflight work only; it does not create a tag, release, installer publication or deployment.

## Required release gates

Before publishing:

1. merge an exact version PR only after all policy, typecheck, updater and Windows acceptance workflows pass;
2. provision protected `SUBUTAI_RELEASES_TOKEN` with Contents write access only to `enkhbat194/subutai-releases`;
3. provision protected `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`;
4. provision offline-generated `SUBUTAI_UPDATE_SIGNING_KEY_BASE64` and matching `SUBUTAI_UPDATE_PUBLIC_KEY_BASE64`;
5. build and verify signed Setup, Portable, desktop and native-host artifacts;
6. run signed acceptance on clean physical Windows 10 x64;
7. run signed acceptance on clean physical Windows 11 x64;
8. create the exact matching tag only after those gates pass.

The required RC tag is `v0.2.0-rc.1`. Package versions must exactly match the tag without the leading `v`.

## Fail-closed workflow behavior

The release workflow rejects:

- missing publication/signing secrets;
- tag/package version mismatch;
- unsupported prerelease syntax;
- unsigned or invalid Authenticode files;
- missing or invalid RFC 3161 timestamps;
- inconsistent publisher certificates;
- missing update trust;
- invalid signed update manifests;
- missing updater metadata or native engine;
- package launch/install/uninstall failures.

Stable clients accept only stable releases. Beta/RC clients accept GitHub prereleases. The app disables downgrade, remembers the highest verified release and verifies the Ed25519 release manifest before automatic download. Standard `electron-updater` SHA-512 and Windows Authenticode verification remain mandatory.

## Published files

A release contains:

- `Subutai-Setup-<version>-<arch>.exe`
- `Subutai-Portable-<version>-<arch>.exe`
- `latest.yml`
- updater blockmap files
- `SHA256SUMS.txt`
- `SIGNATURES.json`
- `subutai-update-manifest.json`

## Secret handling

Never commit, print, upload or paste:

- `SUBUTAI_RELEASES_TOKEN`
- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`
- `SUBUTAI_UPDATE_SIGNING_KEY_BASE64`

The public update key may be packaged only through the approved trust-generation step. Private keys remain outside the repository.

## Recovery

A failed release workflow must not publish partial assets because all validation precedes the publication step. Fix the branch, rerun the full gates and use a new version if any binary was already published. Never replace a published binary under the same version.

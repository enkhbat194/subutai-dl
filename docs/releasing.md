# Subutai Download Manager release process

Subutai uses isolated stable and beta/RC Windows updater channels backed by the public binary-only repository [`enkhbat194/subutai-releases`](https://github.com/enkhbat194/subutai-releases). Application source remains private.

## Release gate

Before publishing a release:

1. Update `version` in both root `package.json` and `apps/desktop/package.json`.
2. Open a normal branch and PR.
3. Require Linux CI, Linux/Windows resilience, Windows package validation, packaged-app launch smoke, and artifact upload to pass.
4. Merge the version PR to `main`.
5. Configure a protected `SUBUTAI_RELEASES_TOKEN` GitHub Actions secret with Contents write access only to `enkhbat194/subutai-releases`.
6. Configure protected signing secrets `WIN_CSC_LINK` (the base64-encoded PFX) and `WIN_CSC_KEY_PASSWORD`; never commit either value.
7. Configure `SUBUTAI_UPDATE_SIGNING_KEY_BASE64` as an Ed25519 PKCS#8 DER private key encoded in base64, and `SUBUTAI_UPDATE_PUBLIC_KEY_BASE64` as the matching SPKI DER public key encoded in base64. Generate and retain the key pair outside the repository; never log or commit the private key.
8. Create and push an exact matching stable tag such as `v0.1.0`, or a controlled prerelease tag such as `v0.2.0-beta.1` or `v0.2.0-rc.1`. The package versions must exactly match the tag without the leading `v`.

The release workflow rejects mismatched or unsupported tags, missing signing credentials, invalid or untimestamped Authenticode signatures, inconsistent publisher certificates, missing updater metadata, missing bundled engines, undersized installers, and packaged apps that cannot start and exit cleanly in smoke mode. Stable clients accept only stable releases; beta/RC clients accept only GitHub prereleases. The app disables downgrade, remembers the highest verified release, and verifies the Ed25519 release manifest before any automatic download. Standard `electron-updater` SHA-512 and Windows Authenticode verification remain mandatory for the installer itself.

## Published files

Each GitHub Release contains:

- `Subutai-Setup-<version>-<arch>.exe`
- `Subutai-Portable-<version>-<arch>.exe`
- `latest.yml`
- updater blockmap files
- `SHA256SUMS.txt`
- `SIGNATURES.json`
- `subutai-update-manifest.json`

Installed builds anonymously read the public `enkhbat194/subutai-releases` GitHub provider. The signed manifest binds the release tag, channel, `latest.yml`, Setup SHA-512, and SHA-256 hashes for all publication evidence. Portable builds are distributed for manual use; the NSIS Setup build is the supported automatic-update path.

## Recovery

A failed release workflow does not publish partial assets because package validation runs before the GitHub Release step. Fix the branch, rerun all PR gates, merge, and rerun the tag workflow. Never replace a published binary under the same version; increment the patch version instead.

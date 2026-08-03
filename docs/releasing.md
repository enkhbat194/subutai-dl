# Subutai Download Manager release process

Subutai uses one stable Windows updater channel backed by the public binary-only repository [`enkhbat194/subutai-releases`](https://github.com/enkhbat194/subutai-releases). Application source remains private.

## Release gate

Before publishing a release:

1. Update `version` in both root `package.json` and `apps/desktop/package.json`.
2. Open a normal branch and PR.
3. Require Linux CI, Linux/Windows resilience, Windows package validation, packaged-app launch smoke, and artifact upload to pass.
4. Merge the version PR to `main`.
5. Configure a protected `SUBUTAI_RELEASES_TOKEN` GitHub Actions secret with Contents write access only to `enkhbat194/subutai-releases`.
6. Configure protected signing secrets `WIN_CSC_LINK` (the base64-encoded PFX) and `WIN_CSC_KEY_PASSWORD`; never commit either value.
7. Create and push an exact matching stable tag such as `v0.1.0`, or run **Subutai Release** manually with that tag.

The release workflow rejects mismatched tags, prerelease suffixes, missing signing credentials, invalid or untimestamped Authenticode signatures, inconsistent publisher certificates, missing updater metadata, missing bundled engines, undersized installers, and packaged apps that cannot start and exit cleanly in smoke mode. It publishes `SIGNATURES.json` with SHA-256 and certificate evidence next to the release artifacts.

## Published files

Each GitHub Release contains:

- `Subutai-Setup-<version>-<arch>.exe`
- `Subutai-Portable-<version>-<arch>.exe`
- `latest.yml`
- updater blockmap files
- `SHA256SUMS.txt`
- `SIGNATURES.json`

Installed builds anonymously read the public `enkhbat194/subutai-releases` GitHub provider and `latest.yml` for update checks. Portable builds are distributed for manual use; the NSIS Setup build is the supported automatic-update path.

## Recovery

A failed release workflow does not publish partial assets because package validation runs before the GitHub Release step. Fix the branch, rerun all PR gates, merge, and rerun the tag workflow. Never replace a published binary under the same version; increment the patch version instead.

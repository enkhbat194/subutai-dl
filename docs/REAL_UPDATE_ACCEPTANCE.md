# Subutai 0.2.0 real two-installer update acceptance

This package validates Subutai's transactional updater with two real NSIS Setup installers without creating a tag, GitHub Release, deployment, or public download.

## Builds

- Baseline: `0.1.0`, built from the current updater/rollback code.
- Target: `0.2.0`, built from the same commit as the next installed version.
- Both packages contain the real Electron desktop application, Rust native engine, browser bridge, updater resources, and NSIS installer hooks.

## Feed

The target package, `latest.yml`, blockmap, and SHA-256 evidence are served only from an ephemeral `127.0.0.1` HTTP server on the Windows acceptance runner. The production GitHub update provider remains unchanged.

## Required flows

1. Baseline Setup install.
2. Healthy baseline-to-target update and committed startup health.
3. Preservation of acceptance settings, queue, database, `.subutai.part`, and `.subutai.job` sentinels.
4. Chrome, Edge, and Firefox native-messaging registration validation.
5. Baseline reinstall.
6. Target installation with a test-only startup health failure.
7. External watchdog rollback to the verified baseline Setup.
8. Successful rollback journal state, one-attempt bound, data preservation, browser bridge restoration, and final uninstall.

## Evidence

The workflow retains installer and executable SHA-256 values, update/rollback result JSON, transaction journals, preservation sentinel hashes, browser registry snapshots, installer exit codes, runtime logs, and the exact tested commit SHA.

## Safety boundary

The acceptance runtime is compiled only when `SUBUTAI_REAL_UPDATE_ACCEPTANCE_BUILD=1`. It accepts only loopback HTTP feed URLs. The workflow has `contents: read` permission and performs no tag, release, publish, deployment, or merge action.

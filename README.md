# Subutai

Subutai is a private Windows download manager for fast transfers, recovery, browser integration, media downloads, queues and scheduling.

## Product identity

- Product: **Subutai**
- Formal name: **Subutai Download Manager**
- Windows artifacts: `Subutai-Setup-*` and `Subutai-Portable-*`
- Source repository: private `subutai-dl`
- Binary update repository: public `enkhbat194/subutai-releases`

Subutai is delivered as one application. Bundled dependencies are internal implementation details, not separate user-facing products.

## Current release candidate

The repository is prepared for **`0.2.0-rc.1`** engineering validation.

Implemented and merged through PR #43:

- first-party Rust direct-download engine;
- persistent queue, scheduler, browser bridge and recovery;
- Windows Setup and Portable packaging;
- transactional update and automatic rollback;
- real two-installer healthy-update, rollback and checksum-rejection acceptance;
- updater error redaction and watchdog hardening;
- public binary-only update distribution;
- fail-closed Windows Authenticode signing policy;
- Ed25519-signed update manifests with downgrade/replay protection.

This is **not yet a public release**. Publishing remains blocked until protected credentials exist and the signed candidate passes clean physical Windows 10 and Windows 11 acceptance.

## Required external release inputs

- `SUBUTAI_RELEASES_TOKEN`
- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`
- `SUBUTAI_UPDATE_SIGNING_KEY_BASE64`
- `SUBUTAI_UPDATE_PUBLIC_KEY_BASE64`
- clean physical Windows 10 x64 acceptance
- clean physical Windows 11 x64 acceptance

See:

- [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) — authoritative implementation status.
- [`docs/DIRECT_1_0_RELEASE_GATE.md`](docs/DIRECT_1_0_RELEASE_GATE.md) — ordered release gates.
- [`docs/releasing.md`](docs/releasing.md) — protected release workflow and publication contract.

## Brand rule

Public UI, notifications, browser extension, installer, artifacts and public errors use only **Subutai** or **Subutai Download Manager**. Dependency names remain only where technically or legally required.

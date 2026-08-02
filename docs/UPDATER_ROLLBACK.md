# Subutai transactional updater and rollback

## Stable updater contract

Subutai Windows Setup updates use a durable transaction under:

`%LOCALAPPDATA%\Subutai\Updater`

The authoritative journal is `update-transaction.json`. Writes use a synced temporary file, replacement and a recoverable `.bak` file. A missing primary journal may recover from the synced `.bak` file. A present but damaged primary journal fails safely and never falls back to a potentially stale transaction that could trigger destructive rollback.

Before an update can install, Subutai requires:

- a cached Setup installer for the current working version;
- a matching SHA-256 manifest;
- a staged copy and SHA-256 of the downloaded target installer;
- a verified copy of the external PowerShell watchdog;
- a supported installed Setup path under the standard per-user or Program Files roots.

Portable and arbitrary custom installation paths do not claim installed-app rollback support. The update is blocked rather than installed without rollback evidence.

## Previous-version cache

Each Setup installation copies its own installer to:

`%LOCALAPPDATA%\Subutai\Updater\packages\<version>`

The installer copy is hashed after copying and stored with an atomic metadata manifest. Retention is bounded. An unverified package is never executed.

## Startup health

After installation, the new version must confirm all of the following before the transaction is committed:

- Electron app readiness;
- renderer and preload load completion;
- Subutai native host presence;
- Chrome, Edge and Firefox native-messaging registration;
- readable settings, queue jobs, schedules and SQLite integrity.

Startup attempts and health deadlines are bounded. A normal intentional exit before confirmation is recorded so the watchdog does not roll back merely because the user closed the app.

## External rollback watchdog

The watchdog runs outside the application process. It validates controlled paths and SHA-256 before running the cached previous Setup installer silently. It permits only one rollback attempt, restores browser registration, preserves user data and download partial/journal files, then relaunches the previous installed version when safe.

The watchdog never restarts, shuts down, sleeps or hibernates Windows.

## Acceptance scope

Automated Windows acceptance covers:

1. healthy transaction commit;
2. failed startup and verified rollback;
3. installer checksum mismatch fail-safe;
4. corrupt journal fail-safe;
5. bounded repeated failure;
6. settings, jobs, partial metadata and database preservation;
7. Chrome, Edge and Firefox registration evidence;
8. existing Setup, Portable, installed launch and uninstall regression through the existing N5 gates.

The Windows gate builds two distinct local Rust fixture executables for the previous and target versions, exercises healthy startup and failed-startup rollback through the production watchdog, and verifies browser registration plus user-data preservation. It does not yet execute two independently published production installers and does not claim public GitHub update-channel acceptance. Clean Windows 10/11 machines, a real published previous release, real reboot acceptance, code signing and overnight update soak remain pending until performed.

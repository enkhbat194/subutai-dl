# Subutai Windows Acceptance Matrix

This checklist is the physical-device gate for declaring a Subutai build suitable for normal use. Automated runner success does not replace these tests.

## Test record

- Subutai version:
- Commit SHA:
- Setup SHA-256:
- Portable SHA-256:
- Tester:
- Date:
- Windows edition/build:
- Clean VM or physical PC:

Each case must be marked **PASS**, **FAIL** or **BLOCKED**, with evidence and issue links for failures.

## A. Install, launch and uninstall

| ID | Test | Result | Evidence / issue |
|---|---|---|---|
| A01 | Install Setup build as a standard user |  |  |
| A02 | Launch from Start menu and desktop shortcut |  |  |
| A03 | Launch Portable build from a writable folder |  |  |
| A04 | Only one Subutai instance is active |  |  |
| A05 | Close-to-tray, minimize-to-tray and tray exit behave correctly |  |  |
| A06 | Launch-at-login preference persists |  |  |
| A07 | Uninstall removes application files and browser host registration |  |  |
| A08 | User history is retained or removed according to the selected uninstall policy |  |  |

## B. Browser integration

Repeat the complete section for current stable Chrome, Edge and Firefox.

| ID | Test | Result | Evidence / issue |
|---|---|---|---|
| B01 | Subutai extension installs through the supported user flow |  |  |
| B02 | Native host connection reports healthy |  |  |
| B03 | Normal file download is intercepted once, without duplicate browser download |  |  |
| B04 | Right-click link action queues the correct URL |  |  |
| B05 | Right-click media/page/selected URL actions work |  |  |
| B06 | Cancel in Subutai does not restart the browser download unexpectedly |  |  |
| B07 | Disabled interception leaves the browser download untouched |  |  |
| B08 | Site/file exclusions are honored |  |  |
| B09 | Cookies and referer allow a legitimate signed-in download |  |  |
| B10 | Authorization/request headers are forwarded without being displayed or logged |  |  |
| B11 | Browser and extension restart reconnect automatically |  |  |

## C. Direct download correctness

| ID | Test | Result | Evidence / issue |
|---|---|---|---|
| C01 | Range-supported file uses multiple connections and checksum matches |  |  |
| C02 | Server without range support falls back safely |  |  |
| C03 | Redirect chain resolves to the correct filename and file |  |  |
| C04 | Unknown content length downloads correctly |  |  |
| C05 | Existing destination file follows the selected conflict policy |  |  |
| C06 | Pause and resume preserve data integrity |  |  |
| C07 | App close/reopen resumes an incomplete download |  |  |
| C08 | Windows restart resumes an incomplete download |  |  |
| C09 | Expired URL produces an actionable error without corrupt output |  |  |
| C10 | Destination permission failure is reported before data loss |  |  |
| C11 | Insufficient disk space is reported and partial data is handled safely |  |  |
| C12 | Proxy and speed limit apply to direct downloads |  |  |

## D. Media download correctness

Use only content the tester is authorized to download. Protected streams are out of scope.

| ID | Test | Result | Evidence / issue |
|---|---|---|---|
| D01 | Standard video download completes and plays |  |  |
| D02 | Separate video/audio streams merge and play |  |  |
| D03 | 2160p selection produces the requested quality when available |  |  |
| D04 | Audio-only MP3 and M4A outputs play |  |  |
| D05 | HLS video completes and checksum/playback is valid |  |  |
| D06 | DASH video completes and playback is valid |  |  |
| D07 | Playlist count and item order are correct |  |  |
| D08 | Subtitle language and embed/separate-file choices are correct |  |  |
| D09 | Pause/resume and app restart preserve media partial files |  |  |
| D10 | Merge failure is recoverable without downloading all source data again |  |  |
| D11 | Proxy, cookies and referer apply to media downloads |  |  |

## E. Queue, scheduler and tools

| ID | Test | Result | Evidence / issue |
|---|---|---|---|
| E01 | Priority and manual order determine start order |  |  |
| E02 | Maximum concurrent download setting is enforced |  |  |
| E03 | Overnight schedule starts, pauses and resumes correctly |  |  |
| E04 | Queue and schedules persist across restart |  |  |
| E05 | Batch ranges preserve padding, steps and limits |  |  |
| E06 | Clipboard monitor applies cooldown, exclusions and confirmation policy |  |  |
| E07 | Site Grabber respects depth, host, type and count limits |  |  |
| E08 | Site Grabber cancellation stops new requests and preserves results safely |  |  |

## F. Recovery and long-running behavior

| ID | Test | Result | Evidence / issue |
|---|---|---|---|
| F01 | Wi-Fi disconnect/reconnect resumes active downloads |  |  |
| F02 | Network adapter or VPN change recovers correctly |  |  |
| F03 | Sleep/wake resumes direct and media jobs |  |  |
| F04 | Forced process termination recovers queue state |  |  |
| F05 | Remote server drop/restart recovers within retry policy |  |  |
| F06 | 10 GB or larger transfer completes with matching checksum |  |  |
| F07 | 1000-job history remains responsive |  |  |
| F08 | Repeated pause/resume cycle does not leak memory or corrupt data |  |  |
| F09 | Cookies, authorization data and private URLs are absent from normal logs |  |  |

## G. Notifications and update delivery

| ID | Test | Result | Evidence / issue |
|---|---|---|---|
| G01 | Completion and failure notifications appear once |  |  |
| G02 | Clicking a notification restores the correct Subutai window |  |  |
| G03 | Update check finds a newer stable release |  |  |
| G04 | Update downloads in the background and reports progress |  |  |
| G05 | Restart-to-install upgrades the Setup build successfully |  |  |
| G06 | Queue, history and settings survive an update |  |  |
| G07 | Failed update leaves the previous installation usable |  |  |
| G08 | Portable build does not claim unsupported automatic-update behavior |  |  |

## Release decision

A stable release is allowed only when:

1. No P0 or data-integrity test is failed or blocked.
2. Every supported browser passes section B.
3. Direct and media checksum/playback cases pass.
4. Update and recovery cases pass on the supported Setup path.
5. Remaining known issues are documented with severity and workaround.

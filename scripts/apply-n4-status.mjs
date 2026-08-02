import { readFile, writeFile } from 'node:fs/promises';

const path = 'docs/PROJECT_STATUS.md';
let source = (await readFile(path, 'utf8')).replace(/\r\n/gu, '\n');

source = source.replace(
  '| N4 | Replace the desktop direct-download path | Pending | Pending | Pending |',
  '| N4 | Replace the desktop direct-download path | Complete | PASS | PR #19 pending merge |',
);

const marker = '## Latest N3 verification evidence\n';
const n4Section = `## N4 — completed and verified

- Desktop direct-download tasks now run through the first-party \`subutai-engine-host\` Rust process.
- The existing desktop, browser bridge, queue, scheduler and renderer contracts remain stable while the internal direct engine adapter is replaced.
- One native host process owns one direct task, keeping pause, resume, cancel and failure isolation explicit.
- Desktop and host communicate through the N0 versioned, length-prefixed and checksummed binary IPC frame format.
- A separate versioned desktop payload carries task ID, URL, destination, connection budget, chunk/checkpoint sizes and validated request headers.
- Cookie, referer, authorization and other forwarded values travel through stdin IPC and are never placed in process command-line arguments.
- The Electron task registry maps native waiting, active, paused, complete, error and removed events back into the existing queue status format.
- Pause sends a native control frame, preserves the partial file and durable journal, and allows the host process to exit cleanly.
- Resume starts a new native process with the same task and destination; N2 restores every unfinished chunk from its saved byte offset.
- Cancel removes the native partial file and both durable journal recovery slots.
- Browser-created direct jobs and scheduled direct jobs enter the same first-party engine path through the existing runtime queue.
- Desktop shutdown pauses active native tasks before the application exits.
- The packaged Windows application builds and embeds \`subutai-engine-host.exe\` as a release resource.
- The replaced direct-download service source was removed from the desktop runtime.
- Media downloads remain on the temporary media path until the M1 first-party HLS/DASH replacement is complete.

## Latest N4 verification evidence

The Windows self-hosted runner passed:

1. Rust desktop payload round-trip, malformed input and task-state tests.
2. N0 IPC checksum, partial-read, multi-frame and corruption tests.
3. A real \`subutai-engine-host.exe\` child process started from the integration test.
4. A private request header crossed the binary IPC boundary and reached the local HTTP range server.
5. A real direct download advanced beyond 256 KiB before desktop pause was requested.
6. The first host checkpointed progress, emitted paused state and exited successfully.
7. The partial file and durable journal remained after pause.
8. A second host process resumed the same task from saved state and completed the file.
9. The resumed final file matched the source byte-for-byte, and partial/journal files were removed.
10. A separate real-process cancel test emitted removed state and cleaned every resumable file.
11. Release \`subutai-engine-host.exe\` build.
12. Public Subutai identity gate.
13. Desktop and browser TypeScript checks.
14. Queue, scheduler, transfer, batch, clipboard, Site Grabber, tray/update and failure-policy tests.
15. Release-version consistency.
16. Full desktop production build.

`;

if (!source.includes('## N4 — completed and verified')) {
  if (!source.includes(marker)) throw new Error('N3 evidence marker was not found.');
  source = source.replace(marker, `${n4Section}${marker}`);
}

source = source.replace(
  'N0, N1, N2 and N3 are complete and runner verified. Subutai now owns its durable state foundation, Windows HTTP/HTTPS transport, concurrent resumable transfer and adaptive connection/chunk engine. The installed desktop application still uses its existing direct-download path until N4 connects the desktop, browser bridge, queue and scheduler to this first-party engine.',
  'N0 through N4 are complete and runner verified. Desktop direct downloads created from the app, browser bridge, queue and scheduler now run through Subutai’s first-party native engine. The first-party media replacement, physical installed-browser acceptance and N5 production migration gates remain incomplete.',
);

source = source.replace(
  `1. N4 desktop process integration and native-engine lifecycle management.
2. Map desktop pause, resume, cancel, queue and scheduler commands to the first-party engine.
3. Forward browser cookies, referer, authorization and validated request headers into the new engine path.
4. Persist and display N3 connection, queue, retry and replacement telemetry in the desktop UI.
5. Implement explicit file-conflict and changed-remote restart policies at the product layer.
6. N5 long-running network interruption, sleep/wake, process-kill and large-file acceptance.
7. Add proxy, speed-limit, authentication challenge and mirror-fallback acceptance to the first-party path.
8. Validate Setup, Portable, updater and rollback with the first-party engine bundled.
9. Remove temporary release engines only after every migration gate passes.`,
  `1. Persist and display N3 connection, queue, retry and replacement telemetry in the desktop UI.
2. Implement explicit file-conflict and changed-remote restart policies at the product layer.
3. N5 long-running network interruption, sleep/wake, process-kill and large-file acceptance.
4. Add proxy, speed-limit, authentication challenge and mirror-fallback acceptance to the first-party path.
5. Validate Setup, Portable, updater and rollback with the first-party engine bundled.
6. Remove temporary media engines only after the M1/M2 replacement gates pass.`,
);

source = source.replace(
  `1. **N4 desktop replacement**.
2. **N5 production migration and release gate**.
3. **M1/M2 first-party media replacement**.`,
  `1. **N5 production migration and release gate**.
2. **M1/M2 first-party media replacement**.`,
);

if (!source.includes('| N4 | Replace the desktop direct-download path | Complete | PASS | PR #19 pending merge |')) {
  throw new Error('N4 status row was not updated.');
}
if (!source.includes('## N4 — completed and verified')) {
  throw new Error('N4 status section was not added.');
}

await writeFile(path, source, 'utf8');
console.log('N4 project status applied.');

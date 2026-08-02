import { readFile, writeFile } from 'node:fs/promises';

const path = 'engines/native/tests/desktop_host.rs';
let source = (await readFile(path, 'utf8')).replace(/\r\n/gu, '\n');
source = source.replace(
  'use std::sync::mpsc::{self, Receiver};',
  'use std::sync::mpsc::{self, Receiver, RecvTimeoutError};',
);

const before = `        let frame = events
            .recv_timeout(Duration::from_millis(500))
            .expect("receive desktop host frame");`;
const after = `        let frame = match events.recv_timeout(Duration::from_millis(500)) {
            Ok(frame) => frame,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                panic!("desktop host event stream disconnected before the expected state")
            }
        };`;

const occurrences = source.split(before).length - 1;
if (occurrences === 2) {
  source = source.split(before).join(after);
} else if (!source.includes('RecvTimeoutError::Disconnected')) {
  throw new Error(`Expected two desktop host timeout blocks, found ${occurrences}`);
}

await writeFile(path, source, 'utf8');
console.log('N4 host test timeout handling applied.');

import { readFile, writeFile } from 'node:fs/promises';

const path = 'docs/PROJECT_STATUS.md';
const source = (await readFile(path, 'utf8')).replace(/\r\n/gu, '\n');
const before = '| N4 | Replace the desktop direct-download path | Complete | PASS | PR #19 pending merge |';
const after = '| N4 | Replace the desktop direct-download path | Complete | PASS | PR #19 |';

if (source.includes(before)) {
  await writeFile(path, source.replace(before, after), 'utf8');
  console.log('N4 status finalized.');
} else if (source.includes(after)) {
  await writeFile(path, source, 'utf8');
  console.log('N4 status was already finalized.');
} else {
  throw new Error('N4 status row was not found.');
}

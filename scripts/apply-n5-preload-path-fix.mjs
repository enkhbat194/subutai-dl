import { readFileSync, writeFileSync } from 'node:fs';

const path = 'apps/desktop/src/main/subutai-runtime.ts';
const source = readFileSync(path, 'utf8');
const legacy = "preload: join(__dirname, '../preload/index.js')";
const corrected = "preload: join(__dirname, '../preload/index.mjs')";

if (source.includes(corrected)) {
  console.log('Packaged preload path is already current.');
} else if (source.includes(legacy)) {
  writeFileSync(path, source.replace(legacy, corrected));
  console.log('Packaged preload path updated to the emitted index.mjs file.');
} else {
  throw new Error('Desktop runtime preload path contract was not found.');
}

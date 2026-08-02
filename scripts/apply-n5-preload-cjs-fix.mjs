import { readFileSync, writeFileSync } from 'node:fs';

const path = 'apps/desktop/src/main/subutai-runtime.ts';
const source = readFileSync(path, 'utf8');
const candidates = [
  "preload: join(__dirname, '../preload/index.mjs')",
  "preload: join(__dirname, '../preload/index.js')",
];
const corrected = "preload: join(__dirname, '../preload/index.cjs')";

if (source.includes(corrected)) {
  console.log('Packaged preload CommonJS path is already current.');
} else {
  const current = candidates.find((candidate) => source.includes(candidate));
  if (!current) throw new Error('Desktop runtime preload path contract was not found.');
  writeFileSync(path, source.replace(current, corrected));
  console.log('Packaged preload path updated to index.cjs.');
}

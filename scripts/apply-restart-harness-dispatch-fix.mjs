import { readFileSync, writeFileSync } from 'node:fs';

const path = 'scripts/restart-recovery-harness.mjs';
const original = readFileSync(path, 'utf8');
const newline = original.includes('\r\n') ? '\r\n' : '\n';
let source = original.replace(/\r\n/gu, '\n');
const before = `switch (command) {\n  case 'prepare':\n    await prepare();\n    break;\n  case 'verify':\n    await verify();\n    break;\n  case 'status':\n    await status();\n    break;\n  case 'cleanup':\n    await cleanup();\n    break;\n  case 'self-test':\n    await selfTest();\n    break;\n  default:\n    throw new Error('usage: restart-recovery-harness.mjs <prepare|verify|status|cleanup|self-test> [--require-boot-change]');\n}\n`;
const after = `const execution = (async () => {\n  switch (command) {\n    case 'prepare':\n      await prepare();\n      break;\n    case 'verify':\n      await verify();\n      break;\n    case 'status':\n      await status();\n      break;\n    case 'cleanup':\n      await cleanup();\n      break;\n    case 'self-test':\n      await selfTest();\n      break;\n    default:\n      throw new Error('usage: restart-recovery-harness.mjs <prepare|verify|status|cleanup|self-test> [--require-boot-change]');\n  }\n})();\n`;

if (source.includes('const execution = (async () => {') && source.trimEnd().endsWith('await execution;')) {
  console.log('Restart harness dispatch fix is already applied.');
} else {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error('Restart harness top-level dispatch block was not found uniquely.');
  }
  source = source.slice(0, first) + after + source.slice(first + before.length);
  source = `${source.trimEnd()}\n\nawait execution;\n`;
  writeFileSync(path, source.replace(/\n/gu, newline));
  console.log('Restart harness dispatch fix applied.');
}

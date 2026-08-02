import { readFileSync, writeFileSync } from 'node:fs';

const path = 'scripts/restart-recovery-harness.mjs';
const original = readFileSync(path, 'utf8');
const newline = original.includes('\r\n') ? '\r\n' : '\n';
let source = original.replace(/\r\n/gu, '\n');
let changed = false;

const dispatchBefore = `switch (command) {\n  case 'prepare':\n    await prepare();\n    break;\n  case 'verify':\n    await verify();\n    break;\n  case 'status':\n    await status();\n    break;\n  case 'cleanup':\n    await cleanup();\n    break;\n  case 'self-test':\n    await selfTest();\n    break;\n  default:\n    throw new Error('usage: restart-recovery-harness.mjs <prepare|verify|status|cleanup|self-test> [--require-boot-change]');\n}\n`;
const dispatchAfter = `const execution = (async () => {\n  switch (command) {\n    case 'prepare':\n      await prepare();\n      break;\n    case 'verify':\n      await verify();\n      break;\n    case 'status':\n      await status();\n      break;\n    case 'cleanup':\n      await cleanup();\n      break;\n    case 'self-test':\n      await selfTest();\n      break;\n    default:\n      throw new Error('usage: restart-recovery-harness.mjs <prepare|verify|status|cleanup|self-test> [--require-boot-change]');\n  }\n})();\n`;

if (!source.includes('const execution = (async () => {')) {
  const first = source.indexOf(dispatchBefore);
  if (first < 0 || source.indexOf(dispatchBefore, first + dispatchBefore.length) >= 0) {
    throw new Error('Restart harness top-level dispatch block was not found uniquely.');
  }
  source = source.slice(0, first) + dispatchAfter + source.slice(first + dispatchBefore.length);
  source = `${source.trimEnd()}\n\nawait execution;\n`;
  changed = true;
}

const interruptionBefore = `  try {\n    run = runNative(url, destinationPath);\n    persistedBytes = await waitForProgress(run, minimumProgressBytes);\n    await terminateProcessTree(run.child.pid);\n    await run.completion.catch(() => undefined);\n  } finally {`;
const interruptionAfter = `  try {\n    run = runNative(url, destinationPath);\n    const interruptedCompletion = run.completion.catch((error) => error);\n    persistedBytes = await waitForProgress(run, minimumProgressBytes);\n    await terminateProcessTree(run.child.pid);\n    await interruptedCompletion;\n  } finally {`;

if (!source.includes('const interruptedCompletion = run.completion.catch')) {
  const first = source.indexOf(interruptionBefore);
  if (first < 0 || source.indexOf(interruptionBefore, first + interruptionBefore.length) >= 0) {
    throw new Error('Restart harness interruption block was not found uniquely.');
  }
  source = source.slice(0, first) + interruptionAfter + source.slice(first + interruptionBefore.length);
  changed = true;
}

if (changed) {
  writeFileSync(path, source.replace(/\n/gu, newline));
  console.log('Restart harness initialization and interruption fixes applied.');
} else {
  console.log('Restart harness initialization and interruption fixes are already applied.');
}

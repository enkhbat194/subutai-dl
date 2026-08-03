import assert from 'node:assert/strict';
import {
  WATCHDOG_DIAGNOSTIC_RETRY_ATTEMPTS,
  appendWatchdogDiagnostic,
} from '../apps/desktop/src/main/system/watchdog-diagnostic.ts';

function codedError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

let attempts = 0;
let delays = 0;
const recovered = await appendWatchdogDiagnostic('ignored.log', 'line\n', {
  writer: () => {
    attempts += 1;
    if (attempts < 3) throw codedError('EBUSY');
  },
  delay: async () => { delays += 1; },
});
assert.equal(recovered, true);
assert.equal(attempts, 3);
assert.equal(delays, 2);

attempts = 0;
const exhausted = await appendWatchdogDiagnostic('ignored.log', 'line\n', {
  writer: () => {
    attempts += 1;
    throw codedError('EACCES');
  },
  delay: async () => {},
});
assert.equal(exhausted, false);
assert.equal(attempts, WATCHDOG_DIAGNOSTIC_RETRY_ATTEMPTS);

attempts = 0;
const permanentFailure = await appendWatchdogDiagnostic('ignored.log', 'line\n', {
  writer: () => {
    attempts += 1;
    throw codedError('ENOSPC');
  },
  delay: async () => { throw new Error('non-retryable diagnostics must not delay'); },
});
assert.equal(permanentFailure, false);
assert.equal(attempts, 1);

console.log('Watchdog diagnostic regression passed: transient Windows file locks retry within bounds and exhausted or permanent log failures never abort the update path.');

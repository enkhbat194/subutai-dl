import { appendFileSync } from 'node:fs';

export const WATCHDOG_DIAGNOSTIC_RETRY_ATTEMPTS = 5;
export const WATCHDOG_DIAGNOSTIC_RETRY_MS = 50;

type DiagnosticWriter = (path: string, data: string, encoding: BufferEncoding) => void;

export interface WatchdogDiagnosticOptions {
  writer?: DiagnosticWriter;
  delay?: (milliseconds: number) => Promise<void>;
}

const RETRYABLE_DIAGNOSTIC_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function diagnosticErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code.toUpperCase() : undefined;
}

/** Diagnostic output must never decide whether an update transaction can proceed. */
export async function appendWatchdogDiagnostic(
  path: string,
  line: string,
  options: WatchdogDiagnosticOptions = {},
): Promise<boolean> {
  const writer = options.writer ?? appendFileSync;
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 1; attempt <= WATCHDOG_DIAGNOSTIC_RETRY_ATTEMPTS; attempt += 1) {
    try {
      writer(path, line, 'utf8');
      return true;
    } catch (error) {
      const retryable = RETRYABLE_DIAGNOSTIC_CODES.has(diagnosticErrorCode(error) ?? '');
      if (!retryable || attempt === WATCHDOG_DIAGNOSTIC_RETRY_ATTEMPTS) return false;
      await delay(WATCHDOG_DIAGNOSTIC_RETRY_MS);
    }
  }

  return false;
}

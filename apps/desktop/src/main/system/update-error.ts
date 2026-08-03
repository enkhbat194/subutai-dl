import { redactDiagnosticMessage } from '../engines/public-error.ts';

export const PUBLIC_UPDATE_ERROR_MESSAGE =
  'Шинэчлэлийн серверт хандаж чадсангүй. Дараа дахин оролдоно уу.';

const MAX_UPDATE_DIAGNOSTIC_LENGTH = 2_000;

export interface SanitizedUpdateFailure {
  publicMessage: string;
  diagnosticMessage: string;
}

export function toSanitizedUpdateFailure(error: unknown): SanitizedUpdateFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const diagnosticMessage = redactDiagnosticMessage(raw)
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(0, MAX_UPDATE_DIAGNOSTIC_LENGTH);

  return {
    publicMessage: PUBLIC_UPDATE_ERROR_MESSAGE,
    diagnosticMessage: diagnosticMessage || 'Unknown updater failure.',
  };
}

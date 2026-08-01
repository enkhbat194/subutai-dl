import type { BatchPreviewRequest, BatchPreviewResult } from '@subutai/shared';

const MAX_BATCH_ITEMS = 10_000;
const BRACKET_RANGE = /\[(-?\d+)-(-?\d+)(?::(-?\d+))?\]/;
const BRACE_RANGE = /\{(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?\}/;

interface RangeMatch {
  index: number;
  length: number;
  startText: string;
  endText: string;
  stepText?: string;
}

function matchRange(value: string): RangeMatch | null {
  const bracket = BRACKET_RANGE.exec(value);
  const brace = BRACE_RANGE.exec(value);
  const match = !bracket ? brace : !brace ? bracket : bracket.index <= brace.index ? bracket : brace;
  if (!match) return null;
  return {
    index: match.index,
    length: match[0].length,
    startText: match[1],
    endText: match[2],
    stepText: match[3],
  };
}

function digitWidth(value: string): number {
  return value.replace(/^-/, '').length;
}

function formatNumber(value: number, width: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}${String(Math.abs(value)).padStart(width, '0')}`;
}

function expandLine(line: string, limit: number): { values: string[]; truncated: boolean } {
  const output: string[] = [];
  let truncated = false;

  const visit = (value: string): void => {
    if (output.length >= limit) {
      truncated = true;
      return;
    }
    const range = matchRange(value);
    if (!range) {
      output.push(value);
      return;
    }

    const start = Number(range.startText);
    const end = Number(range.endText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new Error(`Range тоо буруу: ${value}`);
    const direction = end >= start ? 1 : -1;
    const requestedStep = range.stepText ? Math.abs(Number(range.stepText)) : 1;
    if (!Number.isSafeInteger(requestedStep) || requestedStep < 1) throw new Error(`Range алхам буруу: ${value}`);
    const step = requestedStep * direction;
    const width = Math.max(digitWidth(range.startText), digitWidth(range.endText));
    const count = Math.floor(Math.abs(end - start) / requestedStep) + 1;
    if (count > MAX_BATCH_ITEMS) throw new Error(`Нэг range ${MAX_BATCH_ITEMS}-аас олон утгатай байна.`);

    for (let current = start; direction > 0 ? current <= end : current >= end; current += step) {
      const expanded = `${value.slice(0, range.index)}${formatNumber(current, width)}${value.slice(range.index + range.length)}`;
      visit(expanded);
      if (truncated) break;
    }
  };

  visit(line);
  return { values: output, truncated };
}

function validDownloadUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'ftp:', 'sftp:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function previewBatch(request: BatchPreviewRequest): BatchPreviewResult {
  const maxItems = Math.max(1, Math.min(MAX_BATCH_ITEMS, Math.trunc(request.maxItems ?? MAX_BATCH_ITEMS)));
  const lines = request.input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const urls: string[] = [];
  const seen = new Set<string>();
  const invalidLines: string[] = [];
  let duplicateCount = 0;
  let truncated = false;

  for (const line of lines) {
    if (urls.length >= maxItems) {
      truncated = true;
      break;
    }
    let expanded: { values: string[]; truncated: boolean };
    try {
      expanded = expandLine(line, maxItems - urls.length);
    } catch {
      invalidLines.push(line);
      continue;
    }
    if (expanded.truncated) truncated = true;
    for (const value of expanded.values) {
      if (!validDownloadUrl(value)) {
        invalidLines.push(value);
        continue;
      }
      if (seen.has(value)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(value);
      urls.push(value);
    }
  }

  return {
    urls,
    total: urls.length,
    duplicateCount,
    invalidLines,
    truncated,
  };
}

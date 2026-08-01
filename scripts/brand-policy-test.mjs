import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const roots = [
  'README.md',
  'apps/desktop/package.json',
  'apps/desktop/build',
  'apps/desktop/src/renderer',
  'apps/extension/chromium',
  'apps/extension/firefox',
];

const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.nsh', '.ts', '.tsx']);
const forbidden = [
  { pattern: /SubutaiDL/giu, reason: 'obsolete product alias' },
  { pattern: /Subutai\s+IDM/giu, reason: 'benchmark acronym used as product identity' },
  { pattern: /SUBUTAI\s+IDM/gu, reason: 'benchmark acronym used as product identity' },
  { pattern: /Internet\s+Download\s+Manager/giu, reason: 'third-party product name in a public surface' },
  { pattern: /\baria2c?\b/giu, reason: 'implementation dependency exposed publicly' },
  { pattern: /\byt-dlp\b/giu, reason: 'implementation dependency exposed publicly' },
  { pattern: /\bffmpeg\b/giu, reason: 'implementation dependency exposed publicly' },
  { pattern: /\bMotrix\b/gu, reason: 'unrelated product name in a public surface' },
  { pattern: /\bGopeed\b/gu, reason: 'unrelated product name in a public surface' },
  { pattern: /\bPersepolis\b/gu, reason: 'unrelated product name in a public surface' },
  { pattern: /\bFileCentipede\b/gu, reason: 'unrelated product name in a public surface' },
];

async function collect(path) {
  const entry = await stat(path);
  if (entry.isFile()) return textExtensions.has(extname(path)) ? [path] : [];
  const children = await readdir(path);
  const nested = await Promise.all(children.map((child) => collect(join(path, child))));
  return nested.flat();
}

const files = (await Promise.all(roots.map(collect))).flat();
const violations = [];

for (const file of files) {
  const content = await readFile(file, 'utf8');
  for (const rule of forbidden) {
    rule.pattern.lastIndex = 0;
    for (const match of content.matchAll(rule.pattern)) {
      const line = content.slice(0, match.index).split('\n').length;
      violations.push(`${relative('.', file)}:${line}: ${rule.reason}: ${match[0]}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Subutai public brand policy failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Subutai public brand policy passed for ${files.length} files.`);
}

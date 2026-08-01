import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const identityRoots = [
  'README.md',
  'docs',
  'package.json',
  'apps/desktop/package.json',
  'apps/desktop/build',
  'apps/desktop/src/renderer',
  'apps/extension/chromium',
  'apps/extension/firefox',
];

const publicRoots = [
  'README.md',
  'apps/desktop/package.json',
  'apps/desktop/build',
  'apps/desktop/src/renderer',
  'apps/extension/chromium',
  'apps/extension/firefox',
];

const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.nsh', '.ts', '.tsx']);
const identityRules = [
  { pattern: /SubutaiDL/giu, reason: 'obsolete product alias' },
  { pattern: /\bIDM\b/gu, reason: 'benchmark acronym used as Subutai identity' },
  { pattern: /Internet\s+Download\s+Manager/giu, reason: 'third-party product name used in Subutai identity' },
];
const publicDependencyRules = [
  { pattern: /\baria2c?\b/giu, reason: 'implementation dependency exposed publicly' },
  { pattern: /\byt-dlp\b/giu, reason: 'implementation dependency exposed publicly' },
  { pattern: /\bffmpeg\b/giu, reason: 'implementation dependency exposed publicly' },
  { pattern: /\bMotrix\b/gu, reason: 'unrelated product name exposed publicly' },
  { pattern: /\bGopeed\b/gu, reason: 'unrelated product name exposed publicly' },
  { pattern: /\bPersepolis\b/gu, reason: 'unrelated product name exposed publicly' },
  { pattern: /\bFileCentipede\b/gu, reason: 'unrelated product name exposed publicly' },
];

async function collect(path) {
  const entry = await stat(path);
  if (entry.isFile()) return textExtensions.has(extname(path)) ? [path] : [];
  const children = await readdir(path);
  const nested = await Promise.all(children.map((child) => collect(join(path, child))));
  return nested.flat();
}

async function scan(files, rules, violations) {
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      for (const match of content.matchAll(rule.pattern)) {
        const line = content.slice(0, match.index).split('\n').length;
        violations.push(`${relative('.', file)}:${line}: ${rule.reason}: ${match[0]}`);
      }
    }
  }
}

const identityFiles = [...new Set((await Promise.all(identityRoots.map(collect))).flat())];
const publicFiles = [...new Set((await Promise.all(publicRoots.map(collect))).flat())];
const violations = [];

await scan(identityFiles, identityRules, violations);
await scan(publicFiles, publicDependencyRules, violations);

if (violations.length > 0) {
  console.error('Subutai brand policy failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Subutai brand policy passed for ${identityFiles.length} identity files and ${publicFiles.length} public files.`);
}

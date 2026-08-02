import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = 'engines/native';
const textExtensions = new Set(['.lock', '.md', '.rs', '.toml']);
const forbiddenNames = [
  /\baria2c?\b/giu,
  /\byt-dlp\b/giu,
  /\bffmpeg\b/giu,
  /\bffprobe\b/giu,
  /\bIDM\b/gu,
  /SubutaiDL/giu,
  /Internet\s+Download\s+Manager/giu,
];

async function collect(path) {
  const entry = await stat(path);
  if (entry.isFile()) return textExtensions.has(extname(path)) ? [path] : [];
  const children = await readdir(path);
  const nested = await Promise.all(children.map((child) => collect(join(path, child))));
  return nested.flat();
}

function dependencyEntries(cargoToml) {
  const entries = [];
  let dependencySection = false;

  for (const [index, rawLine] of cargoToml.split('\n').entries()) {
    const line = rawLine.trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      dependencySection = /(?:^|\.)\b(?:dependencies|dev-dependencies|build-dependencies)\b/.test(
        line.slice(1, -1),
      );
      continue;
    }
    if (dependencySection && line && !line.startsWith('#')) {
      entries.push(`Cargo.toml:${index + 1}: ${line}`);
    }
  }
  return entries;
}

const files = await collect(root);
const violations = [];

for (const file of files) {
  const content = await readFile(file, 'utf8');
  for (const pattern of forbiddenNames) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const line = content.slice(0, match.index).split('\n').length;
      violations.push(`${relative('.', file)}:${line}: forbidden external identity: ${match[0]}`);
    }
  }
  if (/\bunsafe\s+(?:fn|impl|trait|extern)\b|\bunsafe\s*\{/u.test(content)) {
    violations.push(`${relative('.', file)}: executable unsafe Rust is forbidden`);
  }
}

const cargoToml = await readFile(join(root, 'Cargo.toml'), 'utf8');
for (const entry of dependencyEntries(cargoToml)) {
  violations.push(`${entry}: N0 must have no third-party crates`);
}

const cargoLock = await readFile(join(root, 'Cargo.lock'), 'utf8');
const packageCount = (cargoLock.match(/^\[\[package\]\]$/gmu) ?? []).length;
if (packageCount !== 1 || !/name = "subutai-native-engine"/u.test(cargoLock)) {
  violations.push('Cargo.lock must contain only the Subutai native engine package in N0');
}

const libSource = await readFile(join(root, 'src', 'lib.rs'), 'utf8');
if (!libSource.includes('#![forbid(unsafe_code)]')) {
  violations.push('src/lib.rs must forbid unsafe Rust');
}

const temporaryFiles = files.filter((file) => /(?:\.tmp|~)$/u.test(file));
for (const file of temporaryFiles) {
  violations.push(`${relative('.', file)}: temporary file is not allowed`);
}

if (violations.length > 0) {
  console.error('Subutai native engine policy failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    `Subutai native engine policy passed: ${files.length} files, zero third-party crates, zero external product identities, unsafe Rust forbidden.`,
  );
}

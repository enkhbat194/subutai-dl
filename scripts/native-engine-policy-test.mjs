import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

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
const auditedUnsafeFile = ['engines', 'native', 'src', 'platform', 'windows.rs'].join(sep);

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

  const hasUnsafe = /\bunsafe\s+(?:fn|impl|trait|extern)\b|\bunsafe\s*\{/u.test(content);
  if (hasUnsafe && file !== auditedUnsafeFile) {
    violations.push(`${relative('.', file)}: unsafe Rust is allowed only in the audited Windows API boundary`);
  }
}

const cargoToml = await readFile(join(root, 'Cargo.toml'), 'utf8');
for (const entry of dependencyEntries(cargoToml)) {
  violations.push(`${entry}: Subutai native engine must have no third-party crates`);
}

const cargoLock = await readFile(join(root, 'Cargo.lock'), 'utf8');
const packageCount = (cargoLock.match(/^\[\[package\]\]$/gmu) ?? []).length;
if (packageCount !== 1 || !/name = "subutai-native-engine"/u.test(cargoLock)) {
  violations.push('Cargo.lock must contain only the Subutai native engine package');
}

const libSource = await readFile(join(root, 'src', 'lib.rs'), 'utf8');
if (!libSource.includes('#![deny(unsafe_code)]')) {
  violations.push('src/lib.rs must deny unsafe Rust by default');
}
if (!libSource.includes('#![deny(unsafe_op_in_unsafe_fn)]')) {
  violations.push('src/lib.rs must deny unchecked operations inside unsafe functions');
}

const windowsBoundary = await readFile(auditedUnsafeFile, 'utf8');
if (!windowsBoundary.includes('#![allow(unsafe_code)]')) {
  violations.push('Windows API boundary must explicitly declare its audited unsafe exception');
}
if (!windowsBoundary.includes('#![deny(unsafe_op_in_unsafe_fn)]')) {
  violations.push('Windows API boundary must require explicit unsafe blocks');
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
    `Subutai native engine policy passed: ${files.length} files, zero third-party crates, zero external product identities, unsafe Rust restricted to one audited Windows boundary.`,
  );
}

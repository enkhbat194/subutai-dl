import { readFile, writeFile } from 'node:fs/promises';

async function replaceInFile(path, replacements) {
  let content = await readFile(path, 'utf8');
  const original = content;
  for (const [from, to] of replacements) {
    if (from instanceof RegExp) content = content.replace(from, to);
    else content = content.replaceAll(from, to);
  }
  if (content === original) throw new Error(`No cleanup changes were applied to ${path}`);
  await writeFile(path, content);
}

await replaceInFile('apps/desktop/src/renderer/src/SubutaiApp.tsx', [
  ['SUBUTAI IDM', 'SUBUTAI'],
  ['Subutai IDM', 'Subutai'],
  ['DESKTOP APPLICATION', 'DOWNLOAD MANAGER'],
]);

await replaceInFile('apps/extension/chromium/popup.html', [
  ['Browser Integration', 'Хөтөчийн холболт'],
  ['Desktop app шалгах', 'Subutai шалгах'],
]);

let runtime = await readFile('apps/desktop/src/main/subutai-runtime.ts', 'utf8');
const originalRuntime = runtime;
const engineImport = "import { SubutaiEngine, type SubutaiTaskStatus } from './engines/subutai-engine';";
if (!runtime.includes("from './engines/public-error'")) {
  runtime = runtime.replace(engineImport, `${engineImport}\nimport { toPublicError } from './engines/public-error';`);
}
runtime = runtime.replace(
  "const message = error instanceof Error ? error.message : String(error);",
  'const message = toPublicError(error);',
);
runtime = runtime.replaceAll(
  "job.error = error instanceof Error ? error.message : String(error);",
  'job.error = toPublicError(error);',
);
const oldProbe = `async function probeMedia(request: MediaProbeRequest): Promise<MediaProbeResult> {\n  validateRequest({ url: request.url, destination: '', engine: 'media' });\n  return engine.probeMedia(request.url.trim(), request.headers, request.sourcePageUrl);\n}`;
const newProbe = `async function probeMedia(request: MediaProbeRequest): Promise<MediaProbeResult> {\n  validateRequest({ url: request.url, destination: '', engine: 'media' });\n  try {\n    return await engine.probeMedia(request.url.trim(), request.headers, request.sourcePageUrl);\n  } catch (error) {\n    throw new Error(toPublicError(error));\n  }\n}`;
if (runtime.includes(oldProbe)) runtime = runtime.replace(oldProbe, newProbe);
if (runtime === originalRuntime) throw new Error('No runtime cleanup changes were applied');
await writeFile('apps/desktop/src/main/subutai-runtime.ts', runtime);

console.log('Subutai product cleanup patch applied.');

import { readFileSync, writeFileSync } from 'node:fs';

const path = 'apps/desktop/src/main/engines/media-service.ts';
let source = readFileSync(path, 'utf8');

function replaceOnce(before, after, label) {
  if (!source.includes(before)) {
    if (source.includes(after)) return;
    throw new Error(`Patch anchor not found: ${label}`);
  }
  source = source.replace(before, after);
}

replaceOnce(
  "import { existsSync } from 'node:fs';",
  "import { existsSync, readdirSync } from 'node:fs';",
  'fs import',
);

replaceOnce(
  "type BrowserCookieSource = 'chrome' | 'edge' | 'firefox';\n\nconst BROWSER_COOKIE_SOURCES: readonly BrowserCookieSource[] = ['chrome', 'edge', 'firefox'];",
  `type BrowserCookieSource = string;\n\nfunction addUniqueBrowserCookieSource(target: BrowserCookieSource[], seen: Set<string>, source: string): void {\n  if (!source) return;\n  const key = source.toLowerCase();\n  if (seen.has(key)) return;\n  seen.add(key);\n  target.push(source);\n}\n\nfunction addChromiumProfiles(\n  target: BrowserCookieSource[],\n  seen: Set<string>,\n  browser: string,\n  userDataRoot: string,\n): void {\n  addUniqueBrowserCookieSource(target, seen, browser);\n  if (!userDataRoot || !existsSync(userDataRoot)) return;\n\n  const profileNames: string[] = [];\n  if (existsSync(join(userDataRoot, 'Default'))) profileNames.push('Default');\n  try {\n    const numbered = readdirSync(userDataRoot, { withFileTypes: true })\n      .filter((entry) => entry.isDirectory() && /^Profile \\d+$/.test(entry.name))\n      .map((entry) => entry.name)\n      .sort((left, right) => Number(left.slice(8)) - Number(right.slice(8)))\n      .slice(0, 20);\n    profileNames.push(...numbered);\n  } catch {\n    // Browser profile discovery is best-effort; deterministic fallbacks remain below.\n  }\n\n  for (const profileName of profileNames) {\n    addUniqueBrowserCookieSource(target, seen, browser + ':' + profileName);\n  }\n}\n\nfunction discoverBrowserCookieSources(): readonly BrowserCookieSource[] {\n  const result: BrowserCookieSource[] = [];\n  const seen = new Set<string>();\n\n  if (process.platform === 'win32') {\n    const roaming = process.env.APPDATA?.trim();\n    if (roaming && existsSync(join(roaming, 'Mozilla', 'Firefox', 'Profiles'))) {\n      addUniqueBrowserCookieSource(result, seen, 'firefox');\n    }\n\n    const local = process.env.LOCALAPPDATA?.trim();\n    if (local) {\n      addChromiumProfiles(result, seen, 'chrome', join(local, 'Google', 'Chrome', 'User Data'));\n      addChromiumProfiles(result, seen, 'edge', join(local, 'Microsoft', 'Edge', 'User Data'));\n      addChromiumProfiles(result, seen, 'brave', join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'));\n      addChromiumProfiles(result, seen, 'chromium', join(local, 'Chromium', 'User Data'));\n      addChromiumProfiles(result, seen, 'vivaldi', join(local, 'Vivaldi', 'User Data'));\n    }\n  }\n\n  for (const fallback of [\n    'firefox',\n    'chrome',\n    'chrome:Default',\n    'chrome:Profile 1',\n    'chrome:Profile 2',\n    'chrome:Profile 3',\n    'chrome:Profile 4',\n    'chrome:Profile 5',\n    'edge',\n    'edge:Default',\n    'edge:Profile 1',\n    'edge:Profile 2',\n    'edge:Profile 3',\n    'edge:Profile 4',\n    'edge:Profile 5',\n    'brave',\n    'brave:Default',\n    'brave:Profile 1',\n    'chromium',\n    'vivaldi',\n  ]) {\n    addUniqueBrowserCookieSource(result, seen, fallback);\n  }\n\n  return result;\n}\n\nconst BROWSER_COOKIE_SOURCES = discoverBrowserCookieSources();`,
  'browser cookie source discovery',
);

replaceOnce(
  "return 'YouTube энэ видеонд нэвтрэлт шаардаж байна. Subutai Chrome, Edge, Firefox session-оос автоматаар оролдсон ч амжилтгүй бол browser-доо YouTube-д нэвтэрч дахин оролдоно уу.';",
  "return 'YouTube энэ видеонд нэвтрэлт шаардаж байна. Subutai Firefox болон Chromium төрлийн суулгасан browser/profile session-уудаас автоматаар оролдсон ч амжилтгүй бол browser-доо YouTube-д нэвтэрч дахин оролдоно уу.';",
  'public YouTube session message',
);

writeFileSync(path, source);

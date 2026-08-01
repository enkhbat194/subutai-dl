import { app } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

function resolveRegistrationScript(): string | null {
  const candidates = [
    app.isPackaged ? join(process.resourcesPath, 'native-messaging', 'register-native-host.ps1') : '',
    resolve(process.cwd(), 'resources', 'native-messaging', 'register-native-host.ps1'),
    resolve(app.getAppPath(), 'resources', 'native-messaging', 'register-native-host.ps1'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function ensureNativeMessagingRegistered(): Promise<void> {
  if (process.platform !== 'win32') return;
  const script = resolveRegistrationScript();
  if (!script) return;

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-ExecutablePath',
        process.execPath,
      ],
      {
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Browser integration registration failed with exit code ${code ?? 'unknown'}.`));
    });
  });
}

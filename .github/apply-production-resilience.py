from __future__ import annotations

import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(content: str, old: str, new: str, label: str) -> str:
    if new in content:
        return content
    if old not in content:
        raise RuntimeError(f"Patch anchor not found: {label}")
    return content.replace(old, new, 1)


# Shared contracts.
path = "packages/shared/src/index.ts"
text = read(path)
text = replace_once(
    text,
    "export type ProxyMode = 'off' | 'system' | 'manual';",
    "export type ProxyMode = 'off' | 'system' | 'manual';\nexport type DownloadFailureKind = 'network' | 'server' | 'authentication' | 'disk' | 'cancelled' | 'unknown';",
    "failure kind",
)
match = re.search(r"export interface DownloadJob \{.*?\n\}", text, flags=re.S)
if not match:
    raise RuntimeError("DownloadJob interface not found")
block = match.group(0)
if "failureKind?: DownloadFailureKind" not in block:
    block = replace_once(
        block,
        "  speedLimitBytesPerSecond?: number;",
        "  speedLimitBytesPerSecond?: number;\n  failureKind?: DownloadFailureKind;\n  retryCount?: number;\n  lastRetryAt?: string;",
        "download resilience fields",
    )
    text = text[:match.start()] + block + text[match.end():]
network_contract = """export interface NetworkResilienceState {
  online: boolean;
  recoveredFromCrash: boolean;
  sessionStartedAt: string;
  lastOnlineAt?: string;
  lastOfflineAt?: string;
  lastRecoveryAt?: string;
  recoveredJobs: number;
  pendingNetworkFailures: number;
}

"""
if "export interface NetworkResilienceState" not in text:
    text = replace_once(text, "export interface SubutaiEngineHealth {", network_contract + "export interface SubutaiEngineHealth {", "network state")
api_match = re.search(r"export interface SubutaiDesktopApi \{.*?\n\}", text, flags=re.S)
if not api_match:
    raise RuntimeError("SubutaiDesktopApi interface not found")
api = api_match.group(0)
if "getNetworkResilienceState" not in api:
    api = replace_once(
        api,
        "  getEngineHealth(): Promise<EngineHealth>;",
        "  getNetworkResilienceState(): Promise<NetworkResilienceState>;\n  retryNetworkDownloads(): Promise<NetworkResilienceState>;\n  getEngineHealth(): Promise<EngineHealth>;",
        "resilience API methods",
    )
if "onNetworkResilienceChanged" not in api:
    api = replace_once(
        api,
        "  minimizeWindow(): Promise<void>;",
        "  onNetworkResilienceChanged(listener: (state: NetworkResilienceState) => void): () => void;\n  minimizeWindow(): Promise<void>;",
        "resilience event",
    )
text = text[:api_match.start()] + api + text[api_match.end():]
write(path, text)

# Main runtime failure tracking and recovery.
path = "apps/desktop/src/main/subutai-runtime.ts"
text = read(path)
if "DownloadFailureKind," not in text:
    text = replace_once(text, "  DownloadCreateRequest,", "  DownloadCreateRequest,\n  DownloadFailureKind,", "runtime failure import")
if "./resilience/failure-policy" not in text:
    anchor = "import { isRunningStatus, queueAllowance, sortQueuedJobs } from './queue/queue-policy';"
    text = replace_once(
        text,
        anchor,
        anchor + "\nimport { canAutoRetry, classifyDownloadFailure } from './resilience/failure-policy';",
        "failure policy import",
    )
helper = """
function markJobFailed(job: DownloadJob, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  job.status = 'failed';
  job.error = message;
  job.failureKind = classifyDownloadFailure(message);
  job.speedBytesPerSecond = 0;
  job.etaSeconds = null;
  job.updatedAt = new Date().toISOString();
}

"""
if "function markJobFailed" not in text:
    text = replace_once(text, "function statusFromEngine", helper + "function statusFromEngine", "failure helper")
text = re.sub(
    r"job\.status = 'failed';\n(?P<i>\s*)job\.error = error instanceof Error \? error\.message : String\(error\);\n(?P=i)job\.speedBytesPerSecond = 0;\n(?P=i)job\.etaSeconds = null;\n(?P=i)job\.updatedAt = new Date\(\)\.toISOString\(\);",
    "markJobFailed(job, error);",
    text,
)
text = re.sub(
    r"job\.status = 'failed';\n(?P<i>\s*)job\.error = error instanceof Error \? error\.message : String\(error\);\n(?P=i)job\.updatedAt = new Date\(\)\.toISOString\(\);",
    "markJobFailed(job, error);",
    text,
)
text = re.sub(
    r"job\.status = 'failed';\n(?P<i>\s*)job\.error = message;\n(?P=i)job\.speedBytesPerSecond = 0;\n(?P=i)job\.etaSeconds = null;\n(?P=i)job\.updatedAt = new Date\(\)\.toISOString\(\);",
    "markJobFailed(job, message);",
    text,
)
if "delete job.failureKind;" not in text[text.find("async function assignTask"):text.find("async function startQueuedJob")]:
    text = replace_once(
        text,
        "  job.engineTaskId = await engine.addDownload(options);\n  job.status = 'queued';",
        "  job.engineTaskId = await engine.addDownload(options);\n  delete job.error;\n  delete job.failureKind;\n  job.status = 'queued';",
        "assign success cleanup",
    )
job_object_anchor = "    queueOrder: nextQueueOrder(),"
if "retryCount: 0," not in text[text.find("export async function createDownload"):text.find("jobs.set(id, job)")]:
    text = replace_once(text, job_object_anchor, job_object_anchor + "\n    retryCount: 0,", "new retry count")
if "restored.retryCount ??= 0;" not in text:
    text = replace_once(text, "    restored.queueOrder ??= order;", "    restored.queueOrder ??= order;\n    restored.retryCount ??= 0;", "restored retry count")
old_status_error = """  if (status.errorMessage) job.error = status.errorMessage;
  else if (job.status !== 'failed') delete job.error;"""
new_status_error = """  if (status.errorMessage) {
    job.error = status.errorMessage;
    job.failureKind = classifyDownloadFailure(status.errorMessage);
  } else if (job.status !== 'failed') {
    delete job.error;
    delete job.failureKind;
  }"""
if old_status_error in text:
    text = text.replace(old_status_error, new_status_error, 1)
recovery = """
export function getDownloadSnapshot(): DownloadJob[] {
  return snapshot();
}

export async function recoverNetworkInterruptedDownloads(maxRetries = 5): Promise<number> {
  let recovered = 0;
  for (const job of jobs.values()) {
    if (!canAutoRetry(job, maxRetries)) continue;
    if (job.engineTaskId) {
      try {
        await engine.cancel(job.engineTaskId);
      } catch {
        // The failed task may already have disappeared from the engine.
      }
    }
    delete job.engineTaskId;
    delete job.error;
    delete job.failureKind;
    job.status = 'queued';
    job.retryCount = (job.retryCount ?? 0) + 1;
    job.lastRetryAt = new Date().toISOString();
    job.updatedAt = job.lastRetryAt;
    saveJob(job);
    recovered += 1;
  }
  if (recovered > 0) {
    broadcastAll();
    await processQueue(true);
  }
  return recovered;
}

"""
if "export function getDownloadSnapshot" not in text:
    text = replace_once(text, "function updateJobFromStatus", recovery + "function updateJobFromStatus", "network recovery exports")
write(path, text)

# Load resilience runtime in the main process.
path = "apps/desktop/src/main/index.ts"
text = read(path)
if "./resilience/resilience-runtime" not in text:
    batch_anchor = "      void import('./batch/batch-runtime');"
    text = replace_once(text, batch_anchor, batch_anchor + "\n      void import('./resilience/resilience-runtime');", "resilience runtime import")
write(path, text)

# Preload API.
path = "apps/desktop/src/preload/index.ts"
text = read(path)
if "NetworkResilienceState," not in text:
    text = replace_once(text, "  MediaProbeResult,", "  MediaProbeResult,\n  NetworkResilienceState,", "preload resilience import")
if "getNetworkResilienceState:" not in text:
    text = replace_once(
        text,
        "  getEngineHealth: (): Promise<EngineHealth> => ipcRenderer.invoke('engines:health'),",
        "  getNetworkResilienceState: (): Promise<NetworkResilienceState> => ipcRenderer.invoke('network-resilience:get'),\n  retryNetworkDownloads: (): Promise<NetworkResilienceState> => ipcRenderer.invoke('network-resilience:retry'),\n  getEngineHealth: (): Promise<EngineHealth> => ipcRenderer.invoke('engines:health'),",
        "preload resilience methods",
    )
if "onNetworkResilienceChanged:" not in text:
    text = replace_once(
        text,
        "  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),",
        "  onNetworkResilienceChanged: (listener: (state: NetworkResilienceState) => void): (() => void) => {\n    const handler = (_event: Electron.IpcRendererEvent, state: NetworkResilienceState): void => listener(state);\n    ipcRenderer.on('network-resilience:changed', handler);\n    return () => ipcRenderer.removeListener('network-resilience:changed', handler);\n  },\n  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),",
        "preload resilience event",
    )
write(path, text)

# Renderer composition and stylesheet.
path = "apps/desktop/src/renderer/src/RootApp.tsx"
text = read(path)
if "ResilienceLauncher" not in text:
    text = replace_once(text, "import { QueueSchedulerLauncher }", "import { ResilienceLauncher } from './ResilienceLauncher';\nimport { QueueSchedulerLauncher }", "resilience launcher import")
    text = replace_once(text, "      <SubutaiApp />", "      <SubutaiApp />\n      <ResilienceLauncher />", "resilience launcher mount")
write(path, text)

path = "apps/desktop/src/renderer/src/main.tsx"
text = read(path)
if "./resilience.css" not in text:
    import_lines = list(re.finditer(r"^import './[^']+\.css';$", text, flags=re.M))
    if not import_lines:
        raise RuntimeError("Renderer CSS imports not found")
    last = import_lines[-1]
    text = text[:last.end()] + "\nimport './resilience.css';" + text[last.end():]
write(path, text)

# Root commands.
path = "package.json"
data = json.loads(read(path))
scripts = data.setdefault("scripts", {})
scripts["test:failure-policy"] = "node --experimental-strip-types scripts/failure-policy-test.mts"
scripts["test:resilience"] = "node scripts/resilience-download-test.mjs"
write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")

# Main CI policy test.
path = ".github/workflows/ci.yml"
text = read(path)
if "Failure and recovery policy tests" not in text:
    anchor = "      - name: Build desktop\n        run: pnpm build"
    step = "      - name: Failure and recovery policy tests\n        run: pnpm test:failure-policy\n\n"
    text = replace_once(text, anchor, step + anchor, "failure policy CI step")
write(path, text)

print("Production resilience integration applied.")

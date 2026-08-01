import type {
  SiteGrabberJob,
  SiteGrabberResource,
  SiteGrabberStartRequest,
} from '@subutai/shared';
import {
  extensionOf,
  extractPageLinks,
  filenameOf,
  hostAllowed,
  isHtmlContentType,
  kindOfExtension,
  matchesExcludedPattern,
  normalizeSiteExtensions,
} from './site-parser';

interface PendingPage {
  url: string;
  depth: number;
}

interface InternalJob {
  snapshot: SiteGrabberJob;
  controller: AbortController;
  completion: Promise<void>;
  resolveCompletion: () => void;
}

function cloneJob(job: SiteGrabberJob): SiteGrabberJob {
  const clone: SiteGrabberJob = {
    ...job,
    includeExtensions: [...job.includeExtensions],
    excludePatterns: [...job.excludePatterns],
    resources: job.resources.map((resource) => ({ ...resource })),
    errors: job.errors.map((error) => ({ ...error })),
  };
  if (job.headers) clone.headers = { ...job.headers };
  return clone;
}

function makeInternal(snapshot: SiteGrabberJob, completed: boolean): InternalJob {
  let resolveCompletion = (): void => undefined;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  const internal: InternalJob = {
    snapshot,
    controller: new AbortController(),
    completion,
    resolveCompletion,
  };
  if (completed) resolveCompletion();
  return internal;
}

function isCancelled(job: InternalJob): boolean {
  return job.controller.signal.aborted || job.snapshot.status === 'cancelled';
}

function normalizedRequest(request: SiteGrabberStartRequest): SiteGrabberJob {
  const root = new URL(request.rootUrl.trim());
  if (!['http:', 'https:'].includes(root.protocol)) throw new Error('Site Grabber зөвхөн HTTP/HTTPS сайт дэмжинэ.');
  root.hash = '';
  const now = new Date().toISOString();
  const job: SiteGrabberJob = {
    id: crypto.randomUUID(),
    rootUrl: root.toString(),
    destination: request.destination.trim(),
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    maxDepth: Math.max(0, Math.min(10, Math.trunc(request.maxDepth ?? 2))),
    maxPages: Math.max(1, Math.min(5_000, Math.trunc(request.maxPages ?? 250))),
    maxResources: Math.max(1, Math.min(20_000, Math.trunc(request.maxResources ?? 5_000))),
    sameHostOnly: request.sameHostOnly ?? true,
    includeSubdomains: request.includeSubdomains ?? true,
    includeExtensions: normalizeSiteExtensions(request.includeExtensions),
    excludePatterns: (request.excludePatterns ?? []).map((pattern) => pattern.trim()).filter(Boolean),
    priority: request.priority ?? 'normal',
    connections: Math.max(1, Math.min(16, Math.trunc(request.connections ?? 8))),
    scannedPages: 0,
    pendingPages: 1,
    resources: [],
    errors: [],
  };
  if (request.headers && Object.keys(request.headers).length > 0) job.headers = { ...request.headers };
  return job;
}

export class SiteGrabberService {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly onChanged: (job: SiteGrabberJob) => void;

  constructor(onChanged: (job: SiteGrabberJob) => void) {
    this.onChanged = onChanged;
  }

  restore(snapshots: SiteGrabberJob[]): void {
    for (const original of snapshots.slice(0, 20)) {
      const snapshot = cloneJob(original);
      if (snapshot.status === 'queued' || snapshot.status === 'running') {
        snapshot.status = 'failed';
        snapshot.error = 'Апп хаагдсан тул өмнөх crawl тасалдсан.';
        snapshot.pendingPages = 0;
        snapshot.updatedAt = new Date().toISOString();
        snapshot.completedAt = snapshot.updatedAt;
      }
      this.jobs.set(snapshot.id, makeInternal(snapshot, true));
    }
  }

  start(request: SiteGrabberStartRequest): SiteGrabberJob {
    const snapshot = normalizedRequest(request);
    const internal = makeInternal(snapshot, false);
    this.jobs.set(snapshot.id, internal);
    void this.crawl(internal);
    return cloneJob(snapshot);
  }

  list(): SiteGrabberJob[] {
    return Array.from(this.jobs.values())
      .map((job) => cloneJob(job.snapshot))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): SiteGrabberJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Site Grabber job олдсонгүй: ${id}`);
    return cloneJob(job.snapshot);
  }

  cancel(id: string): SiteGrabberJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Site Grabber job олдсонгүй: ${id}`);
    if (job.snapshot.status === 'running' || job.snapshot.status === 'queued') {
      job.controller.abort();
      job.snapshot.status = 'cancelled';
      job.snapshot.updatedAt = new Date().toISOString();
      job.snapshot.completedAt = job.snapshot.updatedAt;
      this.emit(job.snapshot);
      job.resolveCompletion();
    }
    return cloneJob(job.snapshot);
  }

  updateResource(id: string, resourceId: string, update: Partial<SiteGrabberResource>): SiteGrabberJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Site Grabber job олдсонгүй: ${id}`);
    const resource = job.snapshot.resources.find((item) => item.id === resourceId);
    if (!resource) throw new Error(`Site resource олдсонгүй: ${resourceId}`);
    Object.assign(resource, update);
    job.snapshot.updatedAt = new Date().toISOString();
    this.emit(job.snapshot);
    return cloneJob(job.snapshot);
  }

  waitForCompletion(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Site Grabber job олдсонгүй: ${id}`);
    return job.completion;
  }

  private async crawl(job: InternalJob): Promise<void> {
    const snapshot = job.snapshot;
    snapshot.status = 'running';
    snapshot.updatedAt = new Date().toISOString();
    this.emit(snapshot);

    const root = new URL(snapshot.rootUrl);
    const pending: PendingPage[] = [{ url: snapshot.rootUrl, depth: 0 }];
    const visitedPages = new Set<string>();
    const discoveredPages = new Set<string>([snapshot.rootUrl]);
    const resourceUrls = new Set<string>();
    const allowedExtensions = new Set(snapshot.includeExtensions);

    try {
      while (pending.length > 0 && visitedPages.size < snapshot.maxPages && !job.controller.signal.aborted) {
        const page = pending.shift();
        if (!page || visitedPages.has(page.url)) continue;
        visitedPages.add(page.url);
        snapshot.pendingPages = pending.length;
        snapshot.updatedAt = new Date().toISOString();
        this.emit(snapshot);

        let response: Response;
        try {
          response = await fetch(page.url, {
            signal: job.controller.signal,
            redirect: 'follow',
            headers: {
              'user-agent': 'Subutai Download Manager Site Grabber/1.0',
              accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
              ...(snapshot.headers ?? {}),
            },
          });
        } catch (error) {
          if (job.controller.signal.aborted) break;
          snapshot.errors.push({ url: page.url, error: error instanceof Error ? error.message : String(error) });
          continue;
        }

        snapshot.scannedPages += 1;
        if (!response.ok) {
          snapshot.errors.push({ url: page.url, error: `HTTP ${response.status}` });
          continue;
        }
        const contentType = response.headers.get('content-type');
        if (!isHtmlContentType(contentType)) {
          const extension = extensionOf(page.url);
          if (extension && allowedExtensions.has(extension) && resourceUrls.size < snapshot.maxResources) {
            resourceUrls.add(page.url);
            snapshot.resources.push(this.resource(page.url, page.url, page.depth));
          }
          continue;
        }

        const html = await response.text();
        for (const link of extractPageLinks(html, response.url || page.url)) {
          if (matchesExcludedPattern(link, snapshot.excludePatterns)) continue;
          let parsed: URL;
          try { parsed = new URL(link); } catch { continue; }
          if (!hostAllowed(root, parsed, snapshot.sameHostOnly, snapshot.includeSubdomains)) continue;

          const extension = extensionOf(link);
          if (extension && allowedExtensions.has(extension)) {
            if (!resourceUrls.has(link) && resourceUrls.size < snapshot.maxResources) {
              resourceUrls.add(link);
              snapshot.resources.push(this.resource(link, page.url, page.depth));
            }
            continue;
          }

          if (extension) continue;
          if (page.depth >= snapshot.maxDepth || discoveredPages.has(link) || discoveredPages.size >= snapshot.maxPages) continue;
          discoveredPages.add(link);
          pending.push({ url: link, depth: page.depth + 1 });
        }
        snapshot.pendingPages = pending.length;
        snapshot.updatedAt = new Date().toISOString();
        this.emit(snapshot);
        if (snapshot.resources.length >= snapshot.maxResources) break;
      }

      if (!isCancelled(job)) snapshot.status = 'completed';
    } catch (error) {
      if (!isCancelled(job)) {
        snapshot.status = 'failed';
        snapshot.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      snapshot.pendingPages = 0;
      snapshot.updatedAt = new Date().toISOString();
      snapshot.completedAt = snapshot.updatedAt;
      this.emit(snapshot);
      job.resolveCompletion();
    }
  }

  private resource(url: string, sourcePageUrl: string, depth: number): SiteGrabberResource {
    const extension = extensionOf(url);
    return {
      id: crypto.randomUUID(),
      url,
      sourcePageUrl,
      filename: filenameOf(url),
      extension,
      kind: kindOfExtension(extension),
      depth,
      queued: false,
    };
  }

  private emit(job: SiteGrabberJob): void {
    this.onChanged(cloneJob(job));
  }
}

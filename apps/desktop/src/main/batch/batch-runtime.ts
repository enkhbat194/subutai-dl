import { ipcMain } from 'electron';
import type {
  BatchCreateRequest,
  BatchCreateResult,
  BatchPreviewRequest,
  BatchPreviewResult,
} from '@subutai/shared';
import { createDownload } from '../subutai-runtime';
import { previewBatch } from './batch-expander';

async function createBatchDownloads(request: BatchCreateRequest): Promise<BatchCreateResult> {
  const preview = previewBatch(request);
  if (preview.urls.length === 0) {
    throw new Error(preview.invalidLines.length > 0
      ? 'Татаж болох зөв URL олдсонгүй.'
      : 'Batch URL шаардлагатай.');
  }

  const result: BatchCreateResult = { jobs: [], rejected: [] };
  for (const url of preview.urls) {
    try {
      const job = await createDownload({
        url,
        destination: request.destination,
        connections: request.connections,
        priority: request.priority,
        speedLimitBytesPerSecond: request.speedLimitBytesPerSecond,
        source: 'batch',
      });
      result.jobs.push(job);
    } catch (error) {
      result.rejected.push({
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

ipcMain.handle('batch:preview', (_event, request: BatchPreviewRequest): BatchPreviewResult => previewBatch(request));
ipcMain.handle('batch:create', (_event, request: BatchCreateRequest) => createBatchDownloads(request));

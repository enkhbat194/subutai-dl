import fs from 'node:fs';

function replaceOnce(source, needle, replacement, label) {
  const index = source.indexOf(needle);
  if (index < 0) {
    throw new Error(`N3 migration could not find ${label}`);
  }
  if (source.indexOf(needle, index + needle.length) >= 0) {
    throw new Error(`N3 migration found duplicate ${label}`);
  }
  return source.slice(0, index) + replacement + source.slice(index + needle.length);
}

const resumablePath = 'engines/native/src/resumable.rs';
let resumable = fs.readFileSync(resumablePath, 'utf8').replaceAll('\r\n', '\n');

resumable = replaceOnce(
  resumable,
  'use crate::platform;\n',
  'use crate::adaptive::{AdaptiveGate, AdaptivePolicy};\nuse crate::platform;\n',
  'adaptive import',
);

resumable = replaceOnce(
  resumable,
  '    pub checkpoint_bytes: u64,\n}',
  '    pub checkpoint_bytes: u64,\n    pub adaptive: AdaptivePolicy,\n}',
  'adaptive request field',
);

resumable = replaceOnce(
  resumable,
  '            checkpoint_bytes: 1024 * 1024,\n',
  '            checkpoint_bytes: 1024 * 1024,\n            adaptive: AdaptivePolicy::default(),\n',
  'adaptive request default',
);

resumable = replaceOnce(
  resumable,
  '    pub bytes_per_second: u64,\n}',
  '    pub bytes_per_second: u64,\n    pub active_connections: usize,\n    pub connection_limit: usize,\n    pub peak_connections: usize,\n    pub queued_segments: usize,\n    pub replacement_count: u64,\n    pub retry_count: u64,\n}',
  'adaptive progress fields',
);

resumable = replaceOnce(
  resumable,
  '    let manifest = Arc::new(Mutex::new(manifest));\n    let started = Instant::now();\n',
  `    let unfinished_chunks = manifest\n        .segments\n        .iter()\n        .filter(|segment| segment.state != SegmentState::Completed)\n        .count();\n    let manifest = Arc::new(Mutex::new(manifest));\n    let adaptive = Arc::new(AdaptiveGate::new(\n        request.adaptive.clone(),\n        request.requested_segments as usize,\n        unfinished_chunks,\n    ));\n    let started = Instant::now();\n`,
  'adaptive gate creation',
);

resumable = replaceOnce(
  resumable,
  '            let worker_sender = progress_sender.clone();\n            handles.push(scope.spawn(move || {\n',
  '            let worker_sender = progress_sender.clone();\n            let worker_adaptive = Arc::clone(&adaptive);\n            handles.push(scope.spawn(move || {\n',
  'worker adaptive clone',
);

resumable = replaceOnce(
  resumable,
  '                    started,\n                    &worker_sender,\n',
  '                    started,\n                    &worker_sender,\n                    &worker_adaptive,\n',
  'worker adaptive argument',
);

resumable = replaceOnce(
  resumable,
  '    if request.checkpoint_bytes == 0 {\n        return Err(TransferError::Protocol(\n            "checkpoint size must be greater than zero".into(),\n        ));\n    }\n',
  `    if request.checkpoint_bytes == 0 {\n        return Err(TransferError::Protocol(\n            "checkpoint size must be greater than zero".into(),\n        ));\n    }\n    request\n        .adaptive\n        .validate(request.requested_segments as usize)\n        .map_err(TransferError::Protocol)?;\n`,
  'adaptive request validation',
);

resumable = replaceOnce(
  resumable,
  `    let segments = plan_ranges(\n        total_size,\n        request.requested_segments,\n        request.minimum_segment_size,\n    )\n    .map_err(|error| TransferError::Protocol(error.to_string()))?;\n`,
  `    let chunk_count = request\n        .adaptive\n        .planned_chunk_count(\n            total_size,\n            request.requested_segments as usize,\n            request.minimum_segment_size,\n        )\n        .map_err(TransferError::Protocol)?;\n    let segments = plan_ranges(total_size, chunk_count, request.minimum_segment_size)\n        .map_err(|error| TransferError::Protocol(error.to_string()))?;\n`,
  'dynamic chunk planning',
);

const workerStart = resumable.indexOf('#[allow(clippy::too_many_arguments)]\nfn run_segment_worker(');
const workerEnd = resumable.indexOf('\nfn checkpoint_segment(', workerStart);
if (workerStart < 0 || workerEnd < 0) {
  throw new Error('N3 migration could not locate segment worker block');
}

const workerReplacement = `#[derive(Debug)]\nenum WorkerAttempt {\n    Completed { transferred: u64, elapsed: Duration },\n    Paused,\n    Cancelled,\n    ReplaceSlow { transferred: u64, elapsed: Duration },\n}\n\n#[allow(clippy::too_many_arguments)]\nfn run_segment_worker(\n    index: usize,\n    request: &SegmentedDownloadRequest,\n    control: &DownloadControl,\n    manifest: &Arc<Mutex<JobManifest>>,\n    store: &JournalStore,\n    partial: &Path,\n    probe: &HttpProbe,\n    started: Instant,\n    progress_sender: &mpsc::Sender<SegmentedProgress>,\n    adaptive: &AdaptiveGate,\n) -> Result<WorkerStop, TransferError> {\n    let mut replacements = 0_u32;\n    loop {\n        match control.state() {\n            CONTROL_PAUSED => return Ok(WorkerStop::Paused),\n            CONTROL_CANCELLED => return Ok(WorkerStop::Cancelled),\n            _ => {}\n        }\n\n        let permit = adaptive.acquire();\n        let attempt = match control.state() {\n            CONTROL_PAUSED => Ok(WorkerAttempt::Paused),\n            CONTROL_CANCELLED => Ok(WorkerAttempt::Cancelled),\n            _ => run_segment_attempt(\n                index,\n                request,\n                control,\n                manifest,\n                store,\n                partial,\n                probe,\n                started,\n                progress_sender,\n                adaptive,\n            ),\n        };\n        drop(permit);\n\n        match attempt {\n            Ok(WorkerAttempt::Completed { transferred, elapsed }) => {\n                if transferred > 0 && !adaptive.should_replace(transferred, elapsed) {\n                    adaptive.record_healthy();\n                }\n                return Ok(WorkerStop::Completed);\n            }\n            Ok(WorkerAttempt::Paused) => return Ok(WorkerStop::Paused),\n            Ok(WorkerAttempt::Cancelled) => return Ok(WorkerStop::Cancelled),\n            Ok(WorkerAttempt::ReplaceSlow { transferred, elapsed }) => {\n                if replacements >= request.adaptive.max_replacements {\n                    return Err(TransferError::AdaptiveRetriesExhausted {\n                        segment: index,\n                        attempts: replacements.saturating_add(1),\n                        reason: format!(\n                            "worker remained below the configured rate after {transferred} bytes in {} ms",\n                            elapsed.as_millis()\n                        ),\n                    });\n                }\n                replacements = replacements.saturating_add(1);\n                checkpoint_pending(index, manifest, store)?;\n                adaptive.record_replacement();\n                thread::sleep(adaptive.backoff(replacements));\n            }\n            Err(error) if is_retryable(&error) => {\n                if replacements >= request.adaptive.max_replacements {\n                    return Err(TransferError::AdaptiveRetriesExhausted {\n                        segment: index,\n                        attempts: replacements.saturating_add(1),\n                        reason: error.to_string(),\n                    });\n                }\n                replacements = replacements.saturating_add(1);\n                checkpoint_pending(index, manifest, store)?;\n                adaptive.record_retry();\n                thread::sleep(adaptive.backoff(replacements));\n            }\n            Err(error) => return Err(error),\n        }\n    }\n}\n\n#[allow(clippy::too_many_arguments)]\nfn run_segment_attempt(\n    index: usize,\n    request: &SegmentedDownloadRequest,\n    control: &DownloadControl,\n    manifest: &Arc<Mutex<JobManifest>>,\n    store: &JournalStore,\n    partial: &Path,\n    probe: &HttpProbe,\n    started: Instant,\n    progress_sender: &mpsc::Sender<SegmentedProgress>,\n    adaptive: &AdaptiveGate,\n) -> Result<WorkerAttempt, TransferError> {\n    match control.state() {\n        CONTROL_PAUSED => return Ok(WorkerAttempt::Paused),\n        CONTROL_CANCELLED => return Ok(WorkerAttempt::Cancelled),\n        _ => {}\n    }\n\n    let segment = {\n        let guard = lock_manifest(manifest)?;\n        guard\n            .segments\n            .get(index)\n            .cloned()\n            .ok_or_else(|| TransferError::Protocol(format!("missing segment {index}")))?\n    };\n    if segment.state == SegmentState::Completed {\n        return Ok(WorkerAttempt::Completed {\n            transferred: 0,\n            elapsed: Duration::ZERO,\n        });\n    }\n\n    let initial_completed = segment.completed_bytes;\n    let start = segment\n        .start\n        .checked_add(segment.completed_bytes)\n        .ok_or_else(|| TransferError::Protocol("segment offset overflowed".into()))?;\n    let end = segment\n        .end_exclusive\n        .checked_sub(1)\n        .ok_or_else(|| TransferError::Protocol("segment end underflowed".into()))?;\n    if start > end {\n        return Err(TransferError::Protocol(format!(\n            "segment {index} has no remaining bytes"\n        )));\n    }\n\n    let mut headers = request.headers.clone();\n    headers.push(RequestHeader::new("Range", format!("bytes={start}-{end}"))?);\n    if let Some(value) = if_range_validator(probe) {\n        headers.push(RequestHeader::new("If-Range", value)?);\n    }\n\n    let attempt_started = Instant::now();\n    let mut response = platform::open_response("GET", &request.url, &headers)?;\n    let metadata = response.metadata().clone();\n    if metadata.status_code == 200 && if_range_validator(probe).is_some() {\n        return Err(TransferError::RemoteChanged(\n            "server rejected the saved range validator".into(),\n        ));\n    }\n    if metadata.status_code != 206 {\n        return Err(TransferError::ByteRangesUnsupported);\n    }\n    let raw_content_range = metadata\n        .content_range\n        .as_deref()\n        .ok_or_else(|| TransferError::InvalidContentRange("missing Content-Range".into()))?;\n    let (actual_start, actual_end, actual_total) = parse_content_range(raw_content_range)?;\n    let expected_total = probe\n        .content_length\n        .ok_or(TransferError::MissingContentLength)?;\n    if actual_start != start || actual_end != end || actual_total != expected_total {\n        return Err(TransferError::InvalidContentRange(\n            raw_content_range.to_string(),\n        ));\n    }\n\n    let mut file = OpenOptions::new().write(true).open(partial)?;\n    file.seek(SeekFrom::Start(start))?;\n    let mut completed = segment.completed_bytes;\n    let mut checkpoint_completed = completed;\n    let mut remaining = segment\n        .end_exclusive\n        .checked_sub(start)\n        .ok_or_else(|| TransferError::Protocol("segment remaining size underflowed".into()))?;\n    let mut buffer = vec![0_u8; READ_BUFFER_BYTES];\n    let mut window_started = Instant::now();\n    let mut window_bytes = 0_u64;\n\n    while remaining > 0 {\n        match control.state() {\n            CONTROL_PAUSED => {\n                checkpoint_segment(index, completed, SegmentState::Pending, manifest, store)?;\n                return Ok(WorkerAttempt::Paused);\n            }\n            CONTROL_CANCELLED => {\n                checkpoint_segment(index, completed, SegmentState::Pending, manifest, store)?;\n                return Ok(WorkerAttempt::Cancelled);\n            }\n            _ => {}\n        }\n\n        let request_bytes = usize::try_from(remaining.min(READ_BUFFER_BYTES as u64))\n            .map_err(|_| TransferError::Protocol("read size conversion failed".into()))?;\n        let read = response.read(&mut buffer[..request_bytes])?;\n        if read == 0 {\n            return Err(TransferError::SizeMismatch {\n                expected: segment.len(),\n                actual: completed,\n            });\n        }\n        file.write_all(&buffer[..read])?;\n        completed = completed\n            .checked_add(read as u64)\n            .ok_or_else(|| TransferError::Protocol("segment progress overflowed".into()))?;\n        remaining = remaining\n            .checked_sub(read as u64)\n            .ok_or_else(|| TransferError::Protocol("server exceeded requested range".into()))?;\n        window_bytes = window_bytes.saturating_add(read as u64);\n\n        let state = if remaining == 0 {\n            SegmentState::Completed\n        } else {\n            SegmentState::Active\n        };\n        let should_checkpoint = completed.saturating_sub(checkpoint_completed)\n            >= request.checkpoint_bytes\n            || state == SegmentState::Completed;\n        let update = {\n            let mut guard = lock_manifest(manifest)?;\n            guard\n                .set_segment_progress(index, completed, state)\n                .map_err(|error| TransferError::Journal(error.to_string()))?;\n            if should_checkpoint {\n                store\n                    .save(&guard)\n                    .map_err(|error| TransferError::Journal(error.to_string()))?;\n                checkpoint_completed = completed;\n            }\n            aggregate_progress(&guard, started, adaptive)?\n        };\n        let _ = progress_sender.send(update);\n\n        let window_elapsed = window_started.elapsed();\n        if remaining > 0 && window_elapsed >= request.adaptive.slow_window {\n            if adaptive.should_replace(window_bytes, window_elapsed) {\n                checkpoint_segment(index, completed, SegmentState::Pending, manifest, store)?;\n                return Ok(WorkerAttempt::ReplaceSlow {\n                    transferred: completed.saturating_sub(initial_completed),\n                    elapsed: attempt_started.elapsed(),\n                });\n            }\n            adaptive.record_healthy();\n            window_started = Instant::now();\n            window_bytes = 0;\n        }\n    }\n\n    file.sync_all()?;\n    checkpoint_segment(index, completed, SegmentState::Completed, manifest, store)?;\n    Ok(WorkerAttempt::Completed {\n        transferred: completed.saturating_sub(initial_completed),\n        elapsed: attempt_started.elapsed(),\n    })\n}\n\nfn checkpoint_pending(\n    index: usize,\n    manifest: &Arc<Mutex<JobManifest>>,\n    store: &JournalStore,\n) -> Result<(), TransferError> {\n    let completed = {\n        let guard = lock_manifest(manifest)?;\n        guard\n            .segments\n            .get(index)\n            .map(|segment| segment.completed_bytes)\n            .ok_or_else(|| TransferError::Protocol(format!("missing segment {index}")))?\n    };\n    checkpoint_segment(index, completed, SegmentState::Pending, manifest, store)\n}\n\nfn is_retryable(error: &TransferError) -> bool {\n    match error {\n        TransferError::Windows { .. } | TransferError::Io(_) | TransferError::SizeMismatch { .. } => {\n            true\n        }\n        TransferError::HttpStatus(status) => {\n            matches!(status, 408 | 425 | 429 | 500..=599)\n        }\n        _ => false,\n    }\n}\n`;

resumable = resumable.slice(0, workerStart) + workerReplacement + resumable.slice(workerEnd);

resumable = replaceOnce(
  resumable,
  'fn aggregate_progress(\n    manifest: &JobManifest,\n    started: Instant,\n) -> Result<SegmentedProgress, TransferError> {',
  'fn aggregate_progress(\n    manifest: &JobManifest,\n    started: Instant,\n    adaptive: &AdaptiveGate,\n) -> Result<SegmentedProgress, TransferError> {',
  'adaptive aggregate signature',
);

resumable = replaceOnce(
  resumable,
  `    Ok(SegmentedProgress {\n        downloaded_bytes,\n        total_bytes,\n        completed_segments: manifest\n            .segments\n            .iter()\n            .filter(|segment| segment.state == SegmentState::Completed)\n            .count(),\n        total_segments: manifest.segments.len(),\n        elapsed,\n        bytes_per_second,\n    })\n`,
  `    let completed_segments = manifest\n        .segments\n        .iter()\n        .filter(|segment| segment.state == SegmentState::Completed)\n        .count();\n    let adaptive_snapshot = adaptive.snapshot();\n    let unfinished_segments = manifest.segments.len().saturating_sub(completed_segments);\n    Ok(SegmentedProgress {\n        downloaded_bytes,\n        total_bytes,\n        completed_segments,\n        total_segments: manifest.segments.len(),\n        elapsed,\n        bytes_per_second,\n        active_connections: adaptive_snapshot.active_connections,\n        connection_limit: adaptive_snapshot.connection_limit,\n        peak_connections: adaptive_snapshot.peak_connections,\n        queued_segments: unfinished_segments\n            .saturating_sub(adaptive_snapshot.active_connections),\n        replacement_count: adaptive_snapshot.replacement_count,\n        retry_count: adaptive_snapshot.retry_count,\n    })\n`,
  'adaptive progress payload',
);

fs.writeFileSync(resumablePath, resumable, 'utf8');

const transferPath = 'engines/native/src/transfer.rs';
let transfer = fs.readFileSync(transferPath, 'utf8').replaceAll('\r\n', '\n');
transfer = replaceOnce(
  transfer,
  '    WorkerPanic,\n    Windows { operation: &\'static str, code: u32 },\n',
  '    WorkerPanic,\n    AdaptiveRetriesExhausted {\n        segment: usize,\n        attempts: u32,\n        reason: String,\n    },\n    Windows { operation: &\'static str, code: u32 },\n',
  'adaptive transfer error variant',
);
transfer = replaceOnce(
  transfer,
  '            Self::WorkerPanic => {\n                write!(formatter, "segmented transfer worker stopped unexpectedly")\n            }\n            Self::Windows { operation, code } => write!(\n',
  '            Self::WorkerPanic => {\n                write!(formatter, "segmented transfer worker stopped unexpectedly")\n            }\n            Self::AdaptiveRetriesExhausted {\n                segment,\n                attempts,\n                reason,\n            } => write!(\n                formatter,\n                "adaptive transfer exhausted {attempts} attempts for segment {segment}: {reason}"\n            ),\n            Self::Windows { operation, code } => write!(\n',
  'adaptive transfer error display',
);
fs.writeFileSync(transferPath, transfer, 'utf8');

console.log('Applied N3 adaptive source migration.');

import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(path, before, after) {
  const source = readFileSync(path, 'utf8');
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${path}: expected source block was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${path}: expected source block is not unique`);
  }
  writeFileSync(path, source.slice(0, first) + after + source.slice(first + before.length));
}

replaceOnce(
  'apps/desktop/src/main/engines/native-engine-service.ts',
  "import { DEFAULT_TRANSFER_SETTINGS } from '../network/transfer-policy';",
  "import {\n  DEFAULT_TRANSFER_SETTINGS,\n  effectiveSpeedLimit,\n  resolveNativeProxyEndpoint,\n} from '../network/transfer-policy';",
);

replaceOnce(
  'apps/desktop/src/main/engines/native-engine-service.ts',
  `            minimumChunkBytes: BigInt(DEFAULT_MINIMUM_CHUNK_BYTES),
            checkpointBytes: BigInt(DEFAULT_CHECKPOINT_BYTES),
            headers: task.request.headers,`,
  `            minimumChunkBytes: BigInt(DEFAULT_MINIMUM_CHUNK_BYTES),
            checkpointBytes: BigInt(DEFAULT_CHECKPOINT_BYTES),
            proxyMode: this.transferSettings.proxyMode,
            proxyUrl: resolveNativeProxyEndpoint(this.transferSettings),
            proxyUsername: this.transferSettings.proxyUsername,
            proxyPassword: this.proxyPassword,
            speedLimitBytesPerSecond: BigInt(effectiveSpeedLimit(
              this.transferSettings,
              task.request.speedLimitBytesPerSecond ?? 0,
            )),
            retryMaxAttempts: this.transferSettings.retryMaxAttempts,
            retryBaseDelayMilliseconds: BigInt(this.transferSettings.retryBaseDelaySeconds * 1000),
            connectTimeoutMilliseconds: BigInt(this.transferSettings.connectTimeoutSeconds * 1000),
            transferTimeoutMilliseconds: BigInt(this.transferSettings.transferTimeoutSeconds * 1000),
            headers: task.request.headers,`,
);

replaceOnce(
  'engines/native/src/desktop_main.rs',
  `    request.checkpoint_bytes = start.checkpoint_bytes;
    request.headers = start.headers;
    request.adaptive.minimum_connections = request`,
  `    request.checkpoint_bytes = start.checkpoint_bytes;
    request.headers = start.headers;
    request.transport = start.transport;
    request.adaptive.max_replacements = request.transport.retry_max_attempts.saturating_sub(1);
    request.adaptive.retry_backoff = request.transport.retry_base_delay;
    request.adaptive.minimum_connections = request`,
);

replaceOnce(
  'engines/native/src/transfer.rs',
  `use crate::platform;
use crate::platform::ResponseReader;
use crate::sha256::Sha256;`,
  `use crate::platform;
use crate::platform::ResponseReader;
use crate::sha256::Sha256;
use crate::transport_settings::{SharedRateLimiter, TransportSettings};`,
);

replaceOnce(
  'engines/native/src/transfer.rs',
  `pub struct DownloadRequest {
    pub url: String,
    pub destination: PathBuf,
    pub headers: Vec<RequestHeader>,
}`,
  `pub struct DownloadRequest {
    pub url: String,
    pub destination: PathBuf,
    pub headers: Vec<RequestHeader>,
    pub transport: TransportSettings,
}`,
);

replaceOnce(
  'engines/native/src/transfer.rs',
  `            destination: destination.into(),
            headers: Vec::new(),
        }`,
  `            destination: destination.into(),
            headers: Vec::new(),
            transport: TransportSettings::default(),
        }`,
);

replaceOnce(
  'engines/native/src/transfer.rs',
  `pub fn probe_url(url: &str, headers: &[RequestHeader]) -> Result<HttpProbe, TransferError> {
    for header in headers {
        header.validate()?;
    }

    let mut response = platform::open_response("HEAD", url, headers)?;
    if matches!(response.metadata().status_code, 405 | 501) {
        drop(response);
        let range = RequestHeader::new("Range", "bytes=0-0")?;
        let mut fallback_headers = headers.to_vec();
        fallback_headers.push(range);
        response = platform::open_response("GET", url, &fallback_headers)?;
    }

    let probe = response.metadata().clone();
    if !(200..300).contains(&probe.status_code) {
        return Err(TransferError::HttpStatus(probe.status_code));
    }
    Ok(probe)
}`,
  `pub fn probe_url(url: &str, headers: &[RequestHeader]) -> Result<HttpProbe, TransferError> {
    probe_url_with_settings(url, headers, &TransportSettings::default())
}

pub fn probe_url_with_settings(
    url: &str,
    headers: &[RequestHeader],
    settings: &TransportSettings,
) -> Result<HttpProbe, TransferError> {
    settings.validate().map_err(TransferError::Protocol)?;
    for header in headers {
        header.validate()?;
    }

    let mut response = platform::open_response("HEAD", url, headers, settings)?;
    if matches!(response.metadata().status_code, 405 | 501) {
        drop(response);
        let range = RequestHeader::new("Range", "bytes=0-0")?;
        let mut fallback_headers = headers.to_vec();
        fallback_headers.push(range);
        response = platform::open_response("GET", url, &fallback_headers, settings)?;
    }

    let probe = response.metadata().clone();
    if !(200..300).contains(&probe.status_code) {
        return Err(TransferError::HttpStatus(probe.status_code));
    }
    Ok(probe)
}`,
);

replaceOnce(
  'engines/native/src/transfer.rs',
  `    let mut response = platform::open_response("GET", &request.url, &request.headers)?;`,
  `    request.transport.validate().map_err(TransferError::Protocol)?;
    let mut response = platform::open_response(
        "GET",
        &request.url,
        &request.headers,
        &request.transport,
    )?;`,
);

replaceOnce(
  'engines/native/src/transfer.rs',
  `    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];`,
  `    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let rate_limiter = SharedRateLimiter::new(request.transport.speed_limit_bytes_per_second);`,
);

replaceOnce(
  'engines/native/src/transfer.rs',
  `        file.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);`,
  `        file.write_all(&buffer[..read])?;
        if let Some(limiter) = rate_limiter.as_deref() {
            limiter.throttle(read);
        }
        hasher.update(&buffer[..read]);`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `use crate::transfer::{
    DownloadResult, HttpProbe, RequestHeader, TransferError, partial_path, probe_url,
};`,
  `use crate::transfer::{
    DownloadResult, HttpProbe, RequestHeader, TransferError, partial_path,
    probe_url_with_settings,
};
use crate::transport_settings::{SharedRateLimiter, TransportSettings};`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `    pub checkpoint_bytes: u64,
    pub adaptive: AdaptivePolicy,`,
  `    pub checkpoint_bytes: u64,
    pub adaptive: AdaptivePolicy,
    pub transport: TransportSettings,`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `            checkpoint_bytes: 1024 * 1024,
            adaptive: AdaptivePolicy::default(),`,
  `            checkpoint_bytes: 1024 * 1024,
            adaptive: AdaptivePolicy::default(),
            transport: TransportSettings::default(),`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `    let segment_probe = probe_segment_support(&request.url, &request.headers)?;`,
  `    let segment_probe = probe_segment_support(request)?;`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `    let (progress_sender, progress_receiver) = mpsc::channel::<SegmentedProgress>();
    let mut worker_results = Vec::new();`,
  `    let (progress_sender, progress_receiver) = mpsc::channel::<SegmentedProgress>();
    let rate_limiter = SharedRateLimiter::new(request.transport.speed_limit_bytes_per_second);
    let mut worker_results = Vec::new();`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `            let worker_sender = progress_sender.clone();
            let worker_adaptive = Arc::clone(&adaptive);
            handles.push(scope.spawn(move || {`,
  `            let worker_sender = progress_sender.clone();
            let worker_adaptive = Arc::clone(&adaptive);
            let worker_rate_limiter = rate_limiter.clone();
            handles.push(scope.spawn(move || {`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `                    &worker_sender,
                    &worker_adaptive,
                )`,
  `                    &worker_sender,
                    &worker_adaptive,
                    worker_rate_limiter.as_deref(),
                )`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `    request
        .adaptive
        .validate(request.requested_segments as usize)
        .map_err(TransferError::Protocol)?;`,
  `    request
        .adaptive
        .validate(request.requested_segments as usize)
        .map_err(TransferError::Protocol)?;
    request.transport.validate().map_err(TransferError::Protocol)?;`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `fn probe_segment_support(url: &str, headers: &[RequestHeader]) -> Result<HttpProbe, TransferError> {
    let general_probe = probe_url(url, headers)?;
    let mut range_headers = headers.to_vec();
    range_headers.push(RequestHeader::new("Range", "bytes=0-0")?);
    let response = platform::open_response("GET", url, &range_headers)?;
    let range_probe = response.metadata().clone();
    if range_probe.status_code != 206 {
        return Err(TransferError::ByteRangesUnsupported);
    }
    let content_range = range_probe
        .content_range
        .as_deref()
        .ok_or_else(|| TransferError::InvalidContentRange("missing Content-Range".into()))?;
    let (start, end, total) = parse_content_range(content_range)?;
    if start != 0 || end != 0 {
        return Err(TransferError::InvalidContentRange(content_range.into()));
    }

    let mut merged = general_probe;
    merged.final_url = range_probe.final_url;
    merged.content_length = Some(total);
    merged.accepts_byte_ranges = true;
    merged.content_range = range_probe.content_range;
    if range_probe.etag.is_some() {
        merged.etag = range_probe.etag;
    }
    if range_probe.last_modified.is_some() {
        merged.last_modified = range_probe.last_modified;
    }
    Ok(merged)
}`,
  `fn probe_segment_support(request: &SegmentedDownloadRequest) -> Result<HttpProbe, TransferError> {
    let mut last_error = None;
    for attempt in 1..=request.transport.retry_max_attempts {
        match probe_segment_support_once(request) {
            Ok(probe) => return Ok(probe),
            Err(error)
                if is_retryable(&error) && attempt < request.transport.retry_max_attempts =>
            {
                last_error = Some(error);
                thread::sleep(request.transport.retry_delay(attempt));
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        TransferError::Protocol("remote probe exhausted without a result".into())
    }))
}

fn probe_segment_support_once(
    request: &SegmentedDownloadRequest,
) -> Result<HttpProbe, TransferError> {
    let general_probe =
        probe_url_with_settings(&request.url, &request.headers, &request.transport)?;
    let mut range_headers = request.headers.clone();
    range_headers.push(RequestHeader::new("Range", "bytes=0-0")?);
    let response = platform::open_response(
        "GET",
        &request.url,
        &range_headers,
        &request.transport,
    )?;
    let range_probe = response.metadata().clone();
    if range_probe.status_code != 206 {
        return Err(TransferError::ByteRangesUnsupported);
    }
    let content_range = range_probe
        .content_range
        .as_deref()
        .ok_or_else(|| TransferError::InvalidContentRange("missing Content-Range".into()))?;
    let (start, end, total) = parse_content_range(content_range)?;
    if start != 0 || end != 0 {
        return Err(TransferError::InvalidContentRange(content_range.into()));
    }

    let mut merged = general_probe;
    merged.final_url = range_probe.final_url;
    merged.content_length = Some(total);
    merged.accepts_byte_ranges = true;
    merged.content_range = range_probe.content_range;
    if range_probe.etag.is_some() {
        merged.etag = range_probe.etag;
    }
    if range_probe.last_modified.is_some() {
        merged.last_modified = range_probe.last_modified;
    }
    Ok(merged)
}`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `    progress_sender: &mpsc::Sender<SegmentedProgress>,
    adaptive: &AdaptiveGate,
) -> Result<WorkerStop, TransferError> {`,
  `    progress_sender: &mpsc::Sender<SegmentedProgress>,
    adaptive: &AdaptiveGate,
    rate_limiter: Option<&SharedRateLimiter>,
) -> Result<WorkerStop, TransferError> {`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `                progress_sender,
                adaptive,
            ),`,
  `                progress_sender,
                adaptive,
                rate_limiter,
            ),`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `    progress_sender: &mpsc::Sender<SegmentedProgress>,
    adaptive: &AdaptiveGate,
) -> Result<WorkerAttempt, TransferError> {`,
  `    progress_sender: &mpsc::Sender<SegmentedProgress>,
    adaptive: &AdaptiveGate,
    rate_limiter: Option<&SharedRateLimiter>,
) -> Result<WorkerAttempt, TransferError> {`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `    let mut response = platform::open_response("GET", &request.url, &headers)?;`,
  `    let mut response =
        platform::open_response("GET", &request.url, &headers, &request.transport)?;`,
);

replaceOnce(
  'engines/native/src/resumable.rs',
  `        file.write_all(&buffer[..read])?;
        completed = completed`,
  `        file.write_all(&buffer[..read])?;
        if let Some(limiter) = rate_limiter {
            limiter.throttle(read);
        }
        completed = completed`,
);

replaceOnce(
  'engines/native/tests/desktop_host.rs',
  `        checkpoint_bytes: 64 * 1024,
        headers: vec![RequestHeader::new(TEST_HEADER_NAME, TEST_HEADER_VALUE).unwrap()],`,
  `        checkpoint_bytes: 64 * 1024,
        transport: subutai_native_engine::TransportSettings::default(),
        headers: vec![RequestHeader::new(TEST_HEADER_NAME, TEST_HEADER_VALUE).unwrap()],`,
);

console.log('N5 native transfer settings source migration applied.');

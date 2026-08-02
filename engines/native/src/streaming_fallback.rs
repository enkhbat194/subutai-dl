use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use crate::platform;
use crate::platform::ResponseReader;
use crate::resumable::{
    DownloadControl, SegmentedDownloadRequest, SegmentedOutcome, SegmentedProgress,
    resume_journal_path,
};
use crate::sha256::Sha256;
use crate::transfer::{
    DownloadResult, HttpProbe, TransferError, partial_path, probe_url_with_settings,
};
use crate::transport_settings::SharedRateLimiter;
use crate::{JobManifest, JobState, JournalStore, SegmentState, StoreError, plan_ranges};

const READ_BUFFER_BYTES: usize = 64 * 1024;

pub(crate) fn download_without_ranges<F>(
    request: &SegmentedDownloadRequest,
    control: &DownloadControl,
    progress: &mut F,
) -> Result<SegmentedOutcome, TransferError>
where
    F: FnMut(SegmentedProgress),
{
    let partial = partial_path(&request.destination);
    let journal_path = resume_journal_path(&request.destination);
    let store = JournalStore::new(&journal_path);
    let snapshot = match store.load() {
        Ok(snapshot) => Some(snapshot),
        Err(StoreError::NoSnapshot) => None,
        Err(error) => return Err(TransferError::Journal(error.to_string())),
    };

    if request.destination.exists() {
        return Err(TransferError::DestinationExists(request.destination.clone()));
    }

    let probe = probe_with_retries(request)?;
    let total_size = probe
        .content_length
        .ok_or(TransferError::MissingContentLength)?;
    if total_size == 0 {
        return Err(TransferError::Protocol(
            "streaming fallback does not accept an empty remote file".into(),
        ));
    }

    if let Some(snapshot) = snapshot.as_ref() {
        validate_saved_transfer(request, &partial, total_size, &probe, &snapshot.manifest)?;
        if snapshot.manifest.all_segments_complete() && partial.exists() {
            return recover_completed_download(
                request,
                &store,
                &partial,
                &probe.final_url,
                total_size,
            );
        }
    } else if partial.exists() {
        return Err(TransferError::PartialFileExists(partial));
    }

    let parent = destination_parent(&request.destination)?;
    fs::create_dir_all(&parent)?;
    let available = platform::available_disk_space(&parent)?;
    if available < total_size {
        return Err(TransferError::InsufficientDiskSpace {
            required: total_size,
            available,
        });
    }

    // A no-range server cannot safely continue at a persisted offset. A valid
    // saved transfer is therefore restarted from byte zero instead of mixing
    // old bytes with a new full response.
    remove_if_exists(&partial)?;
    let mut manifest = create_streaming_manifest(request, &partial, total_size, &probe)?;
    store
        .save(&manifest)
        .map_err(|error| TransferError::Journal(error.to_string()))?;

    let started = Instant::now();
    let rate_limiter = SharedRateLimiter::new(request.transport.speed_limit_bytes_per_second);
    let mut last_error = None;

    for attempt in 1..=request.transport.retry_max_attempts {
        match run_stream_attempt(
            request,
            control,
            &store,
            &partial,
            &probe,
            total_size,
            started,
            attempt,
            rate_limiter.as_deref(),
            progress,
            &mut manifest,
        ) {
            Ok(StreamAttempt::Completed) => {
                return finalize_download(
                    request,
                    &store,
                    &partial,
                    &probe.final_url,
                    total_size,
                    started,
                    &mut manifest,
                );
            }
            Ok(StreamAttempt::Paused(downloaded_bytes)) => {
                return Ok(SegmentedOutcome::Paused {
                    downloaded_bytes,
                    total_bytes: total_size,
                    journal_path,
                });
            }
            Ok(StreamAttempt::Cancelled) => return Ok(SegmentedOutcome::Cancelled),
            Err(error) if is_retryable(&error) && attempt < request.transport.retry_max_attempts => {
                last_error = Some(error);
                reset_for_retry(&store, &partial, total_size, &mut manifest)?;
                thread::sleep(request.transport.retry_delay(attempt));
            }
            Err(error) => {
                mark_failed(&store, &mut manifest)?;
                return Err(error);
            }
        }
    }

    mark_failed(&store, &mut manifest)?;
    Err(last_error.unwrap_or_else(|| {
        TransferError::Protocol("streaming fallback exhausted without a result".into())
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamAttempt {
    Completed,
    Paused(u64),
    Cancelled,
}

#[allow(clippy::too_many_arguments)]
fn run_stream_attempt<F>(
    request: &SegmentedDownloadRequest,
    control: &DownloadControl,
    store: &JournalStore,
    partial: &Path,
    probe: &HttpProbe,
    total_size: u64,
    started: Instant,
    attempt: u32,
    rate_limiter: Option<&SharedRateLimiter>,
    progress: &mut F,
    manifest: &mut JobManifest,
) -> Result<StreamAttempt, TransferError>
where
    F: FnMut(SegmentedProgress),
{
    if control.is_cancelled() {
        cancel_download(store, partial, manifest)?;
        return Ok(StreamAttempt::Cancelled);
    }
    if control.is_paused() {
        pause_download(store, manifest, 0)?;
        return Ok(StreamAttempt::Paused(0));
    }

    reset_for_retry(store, partial, total_size, manifest)?;
    let mut response =
        platform::open_response("GET", &request.url, &request.headers, &request.transport)?;
    let metadata = response.metadata().clone();
    if metadata.status_code != 200 {
        return Err(TransferError::HttpStatus(metadata.status_code));
    }
    if let Some(actual_size) = metadata.content_length
        && actual_size != total_size
    {
        return Err(TransferError::RemoteChanged(format!(
            "streaming response size changed from {total_size} to {actual_size}"
        )));
    }
    validate_response_validators(probe, &metadata)?;

    let mut file = OpenOptions::new().write(true).open(partial)?;
    let mut downloaded = 0_u64;
    let mut checkpoint_downloaded = 0_u64;
    let mut remaining = total_size;
    let mut buffer = vec![0_u8; READ_BUFFER_BYTES];

    while remaining > 0 {
        if control.is_cancelled() {
            file.sync_all()?;
            drop(file);
            cancel_download(store, partial, manifest)?;
            return Ok(StreamAttempt::Cancelled);
        }
        if control.is_paused() {
            file.sync_all()?;
            pause_download(store, manifest, downloaded)?;
            return Ok(StreamAttempt::Paused(downloaded));
        }

        let requested = usize::try_from(remaining.min(READ_BUFFER_BYTES as u64))
            .map_err(|_| TransferError::Protocol("fallback read size conversion failed".into()))?;
        let read = response.read(&mut buffer[..requested])?;
        if read == 0 {
            file.sync_all()?;
            return Err(TransferError::SizeMismatch {
                expected: total_size,
                actual: downloaded,
            });
        }
        file.write_all(&buffer[..read])?;
        if let Some(limiter) = rate_limiter {
            limiter.throttle(read);
        }
        downloaded = downloaded
            .checked_add(read as u64)
            .ok_or_else(|| TransferError::Protocol("fallback progress overflowed".into()))?;
        remaining = remaining
            .checked_sub(read as u64)
            .ok_or_else(|| TransferError::Protocol("fallback response exceeded expected size".into()))?;

        let state = if remaining == 0 {
            SegmentState::Completed
        } else {
            SegmentState::Active
        };
        manifest
            .set_segment_progress(0, downloaded, state)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
        if downloaded.saturating_sub(checkpoint_downloaded) >= request.checkpoint_bytes
            || state == SegmentState::Completed
        {
            store
                .save(manifest)
                .map_err(|error| TransferError::Journal(error.to_string()))?;
            checkpoint_downloaded = downloaded;
        }

        let elapsed = started.elapsed();
        let nanos = elapsed.as_nanos().max(1);
        let bytes_per_second = ((u128::from(downloaded) * 1_000_000_000) / nanos)
            .min(u128::from(u64::MAX)) as u64;
        progress(SegmentedProgress {
            downloaded_bytes: downloaded,
            total_bytes: total_size,
            completed_segments: usize::from(state == SegmentState::Completed),
            total_segments: 1,
            elapsed,
            bytes_per_second,
            active_connections: 1,
            connection_limit: 1,
            peak_connections: 1,
            queued_segments: 0,
            replacement_count: 0,
            retry_count: u64::from(attempt.saturating_sub(1)),
        });
    }

    let mut extra = [0_u8; 1];
    if response.read(&mut extra)? != 0 {
        return Err(TransferError::SizeMismatch {
            expected: total_size,
            actual: total_size.saturating_add(1),
        });
    }
    file.sync_all()?;
    store
        .save(manifest)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    Ok(StreamAttempt::Completed)
}

fn probe_with_retries(request: &SegmentedDownloadRequest) -> Result<HttpProbe, TransferError> {
    let mut last_error = None;
    for attempt in 1..=request.transport.retry_max_attempts {
        match probe_url_with_settings(&request.url, &request.headers, &request.transport) {
            Ok(probe) => return Ok(probe),
            Err(error) if is_retryable(&error) && attempt < request.transport.retry_max_attempts => {
                last_error = Some(error);
                thread::sleep(request.transport.retry_delay(attempt));
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        TransferError::Protocol("fallback probe exhausted without a result".into())
    }))
}

fn create_streaming_manifest(
    request: &SegmentedDownloadRequest,
    partial: &Path,
    total_size: u64,
    probe: &HttpProbe,
) -> Result<JobManifest, TransferError> {
    let segments = plan_ranges(total_size, 1, 1)
        .map_err(|error| TransferError::Protocol(error.to_string()))?;
    let mut manifest = JobManifest::new(
        &request.job_id,
        &request.url,
        partial.to_string_lossy(),
        Some(total_size),
        segments,
    )
    .map_err(|error| TransferError::Journal(error.to_string()))?;
    manifest.etag = probe.etag.clone();
    manifest.last_modified = probe.last_modified.clone();
    manifest
        .transition_to(JobState::Probing)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    manifest
        .transition_to(JobState::Downloading)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    Ok(manifest)
}

fn validate_saved_transfer(
    request: &SegmentedDownloadRequest,
    partial: &Path,
    total_size: u64,
    probe: &HttpProbe,
    manifest: &JobManifest,
) -> Result<(), TransferError> {
    if manifest.job_id != request.job_id
        || manifest.url != request.url
        || manifest.destination != partial.to_string_lossy()
    {
        return Err(TransferError::ResumeMismatch(
            "job id, URL or destination differs from the saved transfer".into(),
        ));
    }
    if manifest.total_size != Some(total_size) {
        return Err(TransferError::RemoteChanged(
            "remote file size changed before no-range restart".into(),
        ));
    }
    if manifest.state == JobState::Cancelled {
        return Err(TransferError::ResumeMismatch(
            "cancelled transfers cannot be restarted".into(),
        ));
    }
    if let Some(saved) = manifest.etag.as_deref()
        && probe.etag.as_deref() != Some(saved)
    {
        return Err(TransferError::RemoteChanged("ETag changed".into()));
    }
    if manifest.etag.is_none()
        && let Some(saved) = manifest.last_modified.as_deref()
        && probe.last_modified.as_deref() != Some(saved)
    {
        return Err(TransferError::RemoteChanged("Last-Modified changed".into()));
    }
    Ok(())
}

fn validate_response_validators(
    expected: &HttpProbe,
    actual: &HttpProbe,
) -> Result<(), TransferError> {
    if let Some(saved) = expected.etag.as_deref()
        && actual.etag.as_deref() != Some(saved)
    {
        return Err(TransferError::RemoteChanged(
            "ETag changed between probe and streaming response".into(),
        ));
    }
    if expected.etag.is_none()
        && let Some(saved) = expected.last_modified.as_deref()
        && actual.last_modified.as_deref() != Some(saved)
    {
        return Err(TransferError::RemoteChanged(
            "Last-Modified changed between probe and streaming response".into(),
        ));
    }
    Ok(())
}

fn reset_for_retry(
    store: &JournalStore,
    partial: &Path,
    total_size: u64,
    manifest: &mut JobManifest,
) -> Result<(), TransferError> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open(partial)?;
    file.set_len(total_size)?;
    file.sync_all()?;
    manifest
        .set_segment_progress(0, 0, SegmentState::Pending)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    if manifest.state == JobState::Paused {
        manifest
            .transition_to(JobState::Downloading)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
    } else if manifest.state == JobState::Failed {
        manifest
            .transition_to(JobState::Probing)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
        manifest
            .transition_to(JobState::Downloading)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
    }
    store
        .save(manifest)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    Ok(())
}

fn pause_download(
    store: &JournalStore,
    manifest: &mut JobManifest,
    downloaded: u64,
) -> Result<(), TransferError> {
    manifest
        .set_segment_progress(0, downloaded, SegmentState::Pending)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    if manifest.state != JobState::Paused {
        manifest
            .transition_to(JobState::Paused)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
    }
    store
        .save(manifest)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    Ok(())
}

fn cancel_download(
    store: &JournalStore,
    partial: &Path,
    manifest: &mut JobManifest,
) -> Result<(), TransferError> {
    if manifest.state != JobState::Cancelled {
        manifest
            .transition_to(JobState::Cancelled)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
        store
            .save(manifest)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
    }
    remove_if_exists(partial)?;
    store
        .remove()
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    Ok(())
}

fn mark_failed(store: &JournalStore, manifest: &mut JobManifest) -> Result<(), TransferError> {
    if manifest.state != JobState::Failed {
        manifest
            .transition_to(JobState::Failed)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
    }
    store
        .save(manifest)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    Ok(())
}

fn finalize_download(
    request: &SegmentedDownloadRequest,
    store: &JournalStore,
    partial: &Path,
    final_url: &str,
    total_size: u64,
    started: Instant,
    manifest: &mut JobManifest,
) -> Result<SegmentedOutcome, TransferError> {
    if !manifest.all_segments_complete() {
        return Err(TransferError::Protocol(
            "streaming fallback ended before the full file completed".into(),
        ));
    }
    manifest
        .transition_to(JobState::Verifying)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    store
        .save(manifest)
        .map_err(|error| TransferError::Journal(error.to_string()))?;

    let actual_size = fs::metadata(partial)?.len();
    if actual_size != total_size {
        return Err(TransferError::SizeMismatch {
            expected: total_size,
            actual: actual_size,
        });
    }
    let sha256 = hash_file(partial)?;
    platform::atomic_move(partial, &request.destination)?;
    manifest
        .transition_to(JobState::Completed)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    store
        .save(manifest)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    store
        .remove()
        .map_err(|error| TransferError::Journal(error.to_string()))?;

    Ok(SegmentedOutcome::Completed(DownloadResult {
        destination: request.destination.clone(),
        final_url: final_url.to_string(),
        downloaded_bytes: total_size,
        sha256,
        elapsed: started.elapsed(),
    }))
}

fn recover_completed_download(
    request: &SegmentedDownloadRequest,
    store: &JournalStore,
    partial: &Path,
    final_url: &str,
    total_size: u64,
) -> Result<SegmentedOutcome, TransferError> {
    let actual_size = fs::metadata(partial)?.len();
    if actual_size != total_size {
        return Err(TransferError::SizeMismatch {
            expected: total_size,
            actual: actual_size,
        });
    }
    let sha256 = hash_file(partial)?;
    platform::atomic_move(partial, &request.destination)?;
    store
        .remove()
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    Ok(SegmentedOutcome::Completed(DownloadResult {
        destination: request.destination.clone(),
        final_url: final_url.to_string(),
        downloaded_bytes: total_size,
        sha256,
        elapsed: Duration::ZERO,
    }))
}

fn hash_file(path: &Path) -> Result<String, TransferError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize_hex())
}

fn is_retryable(error: &TransferError) -> bool {
    match error {
        TransferError::Windows { .. }
        | TransferError::Io(_)
        | TransferError::SizeMismatch { .. } => true,
        TransferError::HttpStatus(status) => matches!(status, 408 | 425 | 429 | 500..=599),
        _ => false,
    }
}

fn destination_parent(destination: &Path) -> Result<PathBuf, TransferError> {
    match destination.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => Ok(parent.to_path_buf()),
        Some(_) => Ok(std::env::current_dir()?),
        None => Err(TransferError::MissingParent(destination.to_path_buf())),
    }
}

fn remove_if_exists(path: &Path) -> Result<(), TransferError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

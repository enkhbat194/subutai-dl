use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::platform;
use crate::platform::ResponseReader;
use crate::sha256::Sha256;
use crate::transfer::{
    DownloadResult, HttpProbe, RequestHeader, TransferError, partial_path, probe_url,
};
use crate::{JobManifest, JobState, JournalStore, SegmentState, StoreError, plan_ranges};

const CONTROL_RUNNING: u8 = 0;
const CONTROL_PAUSED: u8 = 1;
const CONTROL_CANCELLED: u8 = 2;
const READ_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct DownloadControl {
    state: Arc<AtomicU8>,
}

impl Default for DownloadControl {
    fn default() -> Self {
        Self {
            state: Arc::new(AtomicU8::new(CONTROL_RUNNING)),
        }
    }
}

impl DownloadControl {
    pub fn pause(&self) {
        self.state.store(CONTROL_PAUSED, Ordering::Release);
    }

    pub fn resume(&self) {
        self.state.store(CONTROL_RUNNING, Ordering::Release);
    }

    pub fn cancel(&self) {
        self.state.store(CONTROL_CANCELLED, Ordering::Release);
    }

    pub fn is_paused(&self) -> bool {
        self.state.load(Ordering::Acquire) == CONTROL_PAUSED
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.load(Ordering::Acquire) == CONTROL_CANCELLED
    }

    fn state(&self) -> u8 {
        self.state.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone)]
pub struct SegmentedDownloadRequest {
    pub job_id: String,
    pub url: String,
    pub destination: PathBuf,
    pub headers: Vec<RequestHeader>,
    pub requested_segments: u32,
    pub minimum_segment_size: u64,
    pub checkpoint_bytes: u64,
}

impl SegmentedDownloadRequest {
    pub fn new(
        job_id: impl Into<String>,
        url: impl Into<String>,
        destination: impl Into<PathBuf>,
    ) -> Self {
        Self {
            job_id: job_id.into(),
            url: url.into(),
            destination: destination.into(),
            headers: Vec::new(),
            requested_segments: 8,
            minimum_segment_size: 4 * 1024 * 1024,
            checkpoint_bytes: 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentedProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub completed_segments: usize,
    pub total_segments: usize,
    pub elapsed: Duration,
    pub bytes_per_second: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SegmentedOutcome {
    Completed(DownloadResult),
    Paused {
        downloaded_bytes: u64,
        total_bytes: u64,
        journal_path: PathBuf,
    },
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerStop {
    Completed,
    Paused,
    Cancelled,
}

pub fn resume_journal_path(destination: &Path) -> PathBuf {
    let mut value = destination.as_os_str().to_os_string();
    value.push(".subutai.job");
    PathBuf::from(value)
}

pub fn download_segmented(
    request: &SegmentedDownloadRequest,
    control: &DownloadControl,
) -> Result<SegmentedOutcome, TransferError> {
    download_segmented_with_progress(request, control, |_| {})
}

pub fn download_segmented_with_progress<F>(
    request: &SegmentedDownloadRequest,
    control: &DownloadControl,
    mut progress: F,
) -> Result<SegmentedOutcome, TransferError>
where
    F: FnMut(SegmentedProgress),
{
    validate_request(request)?;

    let partial = partial_path(&request.destination);
    let journal_path = resume_journal_path(&request.destination);
    let store = JournalStore::new(&journal_path);
    let snapshot = match store.load() {
        Ok(snapshot) => Some(snapshot),
        Err(StoreError::NoSnapshot) => None,
        Err(error) => return Err(TransferError::Journal(error.to_string())),
    };

    if request.destination.exists() {
        if let Some(snapshot) = snapshot {
            if snapshot.manifest.all_segments_complete() {
                return recover_completed_download(request, &store, &partial, snapshot.manifest);
            }
        }
        return Err(TransferError::DestinationExists(
            request.destination.clone(),
        ));
    }

    let segment_probe = probe_segment_support(&request.url, &request.headers)?;
    let total_size = segment_probe
        .content_length
        .ok_or(TransferError::MissingContentLength)?;
    if total_size == 0 {
        return Err(TransferError::Protocol(
            "segmented transfer does not accept an empty remote file".into(),
        ));
    }

    let parent = destination_parent(&request.destination)?;
    fs::create_dir_all(&parent)?;

    let mut manifest = match snapshot {
        Some(snapshot) => {
            validate_resume_manifest(
                request,
                &partial,
                total_size,
                &segment_probe,
                &snapshot.manifest,
            )?;
            snapshot.manifest
        }
        None => create_manifest(
            request,
            &store,
            &partial,
            &parent,
            total_size,
            &segment_probe,
        )?,
    };

    if manifest.state == JobState::Completed || manifest.state == JobState::Verifying {
        return recover_completed_download(request, &store, &partial, manifest);
    }

    prepare_manifest_for_run(&mut manifest)?;
    store
        .save(&manifest)
        .map_err(|error| TransferError::Journal(error.to_string()))?;

    let manifest = Arc::new(Mutex::new(manifest));
    let started = Instant::now();
    let (progress_sender, progress_receiver) = mpsc::channel::<SegmentedProgress>();
    let mut worker_results = Vec::new();

    thread::scope(|scope| {
        let indices = {
            let guard = lock_manifest(&manifest)?;
            guard
                .segments
                .iter()
                .enumerate()
                .filter_map(|(index, segment)| {
                    (segment.state != SegmentState::Completed).then_some(index)
                })
                .collect::<Vec<_>>()
        };

        let mut handles = Vec::with_capacity(indices.len());
        for index in indices {
            let worker_request = request.clone();
            let worker_control = control.clone();
            let worker_manifest = Arc::clone(&manifest);
            let worker_store = store.clone();
            let worker_partial = partial.clone();
            let worker_probe = segment_probe.clone();
            let worker_sender = progress_sender.clone();
            handles.push(scope.spawn(move || {
                run_segment_worker(
                    index,
                    &worker_request,
                    &worker_control,
                    &worker_manifest,
                    &worker_store,
                    &worker_partial,
                    &worker_probe,
                    started,
                    &worker_sender,
                )
            }));
        }
        drop(progress_sender);

        for update in progress_receiver {
            progress(update);
        }

        for handle in handles {
            worker_results.push(
                handle
                    .join()
                    .map_err(|_| TransferError::WorkerPanic)
                    .and_then(|result| result),
            );
        }
        Ok::<(), TransferError>(())
    })?;

    let mut first_error = None;
    let mut paused = false;
    let mut cancelled = false;
    for result in worker_results {
        match result {
            Ok(WorkerStop::Completed) => {}
            Ok(WorkerStop::Paused) => paused = true,
            Ok(WorkerStop::Cancelled) => cancelled = true,
            Err(error) if first_error.is_none() => first_error = Some(error),
            Err(_) => {}
        }
    }

    if cancelled || control.is_cancelled() {
        let mut guard = lock_manifest(&manifest)?;
        normalize_active_segments(&mut guard)?;
        transition_manifest(&mut guard, JobState::Cancelled)?;
        store
            .save(&guard)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
        drop(guard);
        remove_if_exists(&partial)?;
        store
            .remove()
            .map_err(|error| TransferError::Journal(error.to_string()))?;
        return Ok(SegmentedOutcome::Cancelled);
    }

    if let Some(error) = first_error {
        let mut guard = lock_manifest(&manifest)?;
        normalize_active_segments(&mut guard)?;
        transition_manifest(&mut guard, JobState::Failed)?;
        store
            .save(&guard)
            .map_err(|save_error| TransferError::Journal(save_error.to_string()))?;
        return Err(error);
    }

    if paused || control.is_paused() {
        let mut guard = lock_manifest(&manifest)?;
        normalize_active_segments(&mut guard)?;
        transition_manifest(&mut guard, JobState::Paused)?;
        let downloaded_bytes = guard
            .completed_bytes()
            .map_err(|error| TransferError::Journal(error.to_string()))?;
        store
            .save(&guard)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
        return Ok(SegmentedOutcome::Paused {
            downloaded_bytes,
            total_bytes: total_size,
            journal_path,
        });
    }

    finalize_download(
        request,
        &store,
        &partial,
        &segment_probe.final_url,
        manifest,
        started,
    )
}

fn validate_request(request: &SegmentedDownloadRequest) -> Result<(), TransferError> {
    if request.job_id.trim().is_empty() {
        return Err(TransferError::Protocol("job id is empty".into()));
    }
    if request.requested_segments == 0 {
        return Err(TransferError::Protocol(
            "segment count must be greater than zero".into(),
        ));
    }
    if request.minimum_segment_size == 0 {
        return Err(TransferError::Protocol(
            "minimum segment size must be greater than zero".into(),
        ));
    }
    if request.checkpoint_bytes == 0 {
        return Err(TransferError::Protocol(
            "checkpoint size must be greater than zero".into(),
        ));
    }
    for header in &request.headers {
        if header.name.eq_ignore_ascii_case("range") || header.name.eq_ignore_ascii_case("if-range")
        {
            return Err(TransferError::ReservedHeader(header.name.clone()));
        }
    }
    Ok(())
}

fn probe_segment_support(url: &str, headers: &[RequestHeader]) -> Result<HttpProbe, TransferError> {
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
}

fn create_manifest(
    request: &SegmentedDownloadRequest,
    store: &JournalStore,
    partial: &Path,
    parent: &Path,
    total_size: u64,
    probe: &HttpProbe,
) -> Result<JobManifest, TransferError> {
    if partial.exists() {
        return Err(TransferError::PartialFileExists(partial.to_path_buf()));
    }
    let available = platform::available_disk_space(parent)?;
    if available < total_size {
        return Err(TransferError::InsufficientDiskSpace {
            required: total_size,
            available,
        });
    }

    let file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(partial)?;
    file.set_len(total_size)?;
    file.sync_all()?;

    let segments = plan_ranges(
        total_size,
        request.requested_segments,
        request.minimum_segment_size,
    )
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
    store
        .save(&manifest)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    Ok(manifest)
}

fn validate_resume_manifest(
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
            "remote file size changed".into(),
        ));
    }
    if manifest.state == JobState::Cancelled {
        return Err(TransferError::ResumeMismatch(
            "cancelled transfers cannot be resumed".into(),
        ));
    }

    let downloaded = manifest
        .completed_bytes()
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    validate_remote_validators(manifest, probe, downloaded)?;

    if !partial.exists() && !manifest.all_segments_complete() {
        return Err(TransferError::ResumeMismatch(
            "saved partial file is missing".into(),
        ));
    }
    if partial.exists() {
        let length = fs::metadata(partial)?.len();
        if length != total_size {
            return Err(TransferError::ResumeMismatch(format!(
                "partial file length is {length}, expected {total_size}"
            )));
        }
    }
    Ok(())
}

fn validate_remote_validators(
    manifest: &JobManifest,
    probe: &HttpProbe,
    downloaded: u64,
) -> Result<(), TransferError> {
    if let Some(saved_etag) = manifest.etag.as_deref() {
        if probe.etag.as_deref() != Some(saved_etag) {
            return Err(TransferError::RemoteChanged("ETag changed".into()));
        }
        return Ok(());
    }
    if let Some(saved_last_modified) = manifest.last_modified.as_deref() {
        if probe.last_modified.as_deref() != Some(saved_last_modified) {
            return Err(TransferError::RemoteChanged("Last-Modified changed".into()));
        }
        return Ok(());
    }
    if downloaded > 0 {
        return Err(TransferError::UnsafeResume(
            "remote server provides neither ETag nor Last-Modified".into(),
        ));
    }
    Ok(())
}

fn prepare_manifest_for_run(manifest: &mut JobManifest) -> Result<(), TransferError> {
    normalize_active_segments(manifest)?;
    match manifest.state {
        JobState::Planned => {
            transition_manifest(manifest, JobState::Probing)?;
            transition_manifest(manifest, JobState::Downloading)
        }
        JobState::Probing | JobState::Paused => {
            transition_manifest(manifest, JobState::Downloading)
        }
        JobState::Failed => {
            transition_manifest(manifest, JobState::Probing)?;
            transition_manifest(manifest, JobState::Downloading)
        }
        JobState::Downloading => Ok(()),
        JobState::Verifying | JobState::Completed => Ok(()),
        JobState::Cancelled => Err(TransferError::ResumeMismatch(
            "cancelled transfer cannot be restarted".into(),
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn run_segment_worker(
    index: usize,
    request: &SegmentedDownloadRequest,
    control: &DownloadControl,
    manifest: &Arc<Mutex<JobManifest>>,
    store: &JournalStore,
    partial: &Path,
    probe: &HttpProbe,
    started: Instant,
    progress_sender: &mpsc::Sender<SegmentedProgress>,
) -> Result<WorkerStop, TransferError> {
    match control.state() {
        CONTROL_PAUSED => return Ok(WorkerStop::Paused),
        CONTROL_CANCELLED => return Ok(WorkerStop::Cancelled),
        _ => {}
    }

    let segment = {
        let guard = lock_manifest(manifest)?;
        guard
            .segments
            .get(index)
            .cloned()
            .ok_or_else(|| TransferError::Protocol(format!("missing segment {index}")))?
    };
    if segment.state == SegmentState::Completed {
        return Ok(WorkerStop::Completed);
    }

    let start = segment
        .start
        .checked_add(segment.completed_bytes)
        .ok_or_else(|| TransferError::Protocol("segment offset overflowed".into()))?;
    let end = segment
        .end_exclusive
        .checked_sub(1)
        .ok_or_else(|| TransferError::Protocol("segment end underflowed".into()))?;
    if start > end {
        return Err(TransferError::Protocol(format!(
            "segment {index} has no remaining bytes"
        )));
    }

    let mut headers = request.headers.clone();
    headers.push(RequestHeader::new("Range", format!("bytes={start}-{end}"))?);
    if let Some(value) = if_range_validator(probe) {
        headers.push(RequestHeader::new("If-Range", value)?);
    }

    let mut response = platform::open_response("GET", &request.url, &headers)?;
    let metadata = response.metadata().clone();
    if metadata.status_code == 200 && if_range_validator(probe).is_some() {
        return Err(TransferError::RemoteChanged(
            "server rejected the saved range validator".into(),
        ));
    }
    if metadata.status_code != 206 {
        return Err(TransferError::ByteRangesUnsupported);
    }
    let raw_content_range = metadata
        .content_range
        .as_deref()
        .ok_or_else(|| TransferError::InvalidContentRange("missing Content-Range".into()))?;
    let (actual_start, actual_end, actual_total) = parse_content_range(raw_content_range)?;
    let expected_total = probe
        .content_length
        .ok_or(TransferError::MissingContentLength)?;
    if actual_start != start || actual_end != end || actual_total != expected_total {
        return Err(TransferError::InvalidContentRange(
            raw_content_range.to_string(),
        ));
    }

    let mut file = OpenOptions::new().write(true).open(partial)?;
    file.seek(SeekFrom::Start(start))?;
    let mut completed = segment.completed_bytes;
    let mut checkpoint_completed = completed;
    let mut remaining = segment
        .end_exclusive
        .checked_sub(start)
        .ok_or_else(|| TransferError::Protocol("segment remaining size underflowed".into()))?;
    let mut buffer = vec![0_u8; READ_BUFFER_BYTES];

    while remaining > 0 {
        match control.state() {
            CONTROL_PAUSED => {
                checkpoint_segment(index, completed, SegmentState::Pending, manifest, store)?;
                return Ok(WorkerStop::Paused);
            }
            CONTROL_CANCELLED => {
                checkpoint_segment(index, completed, SegmentState::Pending, manifest, store)?;
                return Ok(WorkerStop::Cancelled);
            }
            _ => {}
        }

        let request_bytes = usize::try_from(remaining.min(READ_BUFFER_BYTES as u64))
            .map_err(|_| TransferError::Protocol("read size conversion failed".into()))?;
        let read = response.read(&mut buffer[..request_bytes])?;
        if read == 0 {
            return Err(TransferError::SizeMismatch {
                expected: segment.len(),
                actual: completed,
            });
        }
        file.write_all(&buffer[..read])?;
        completed = completed
            .checked_add(read as u64)
            .ok_or_else(|| TransferError::Protocol("segment progress overflowed".into()))?;
        remaining = remaining
            .checked_sub(read as u64)
            .ok_or_else(|| TransferError::Protocol("server exceeded requested range".into()))?;

        let state = if remaining == 0 {
            SegmentState::Completed
        } else {
            SegmentState::Active
        };
        let should_checkpoint = completed.saturating_sub(checkpoint_completed)
            >= request.checkpoint_bytes
            || state == SegmentState::Completed;
        let update = {
            let mut guard = lock_manifest(manifest)?;
            guard
                .set_segment_progress(index, completed, state)
                .map_err(|error| TransferError::Journal(error.to_string()))?;
            if should_checkpoint {
                store
                    .save(&guard)
                    .map_err(|error| TransferError::Journal(error.to_string()))?;
                checkpoint_completed = completed;
            }
            aggregate_progress(&guard, started)?
        };
        let _ = progress_sender.send(update);
    }

    file.sync_all()?;
    checkpoint_segment(index, completed, SegmentState::Completed, manifest, store)?;
    Ok(WorkerStop::Completed)
}

fn checkpoint_segment(
    index: usize,
    completed: u64,
    state: SegmentState,
    manifest: &Arc<Mutex<JobManifest>>,
    store: &JournalStore,
) -> Result<(), TransferError> {
    let mut guard = lock_manifest(manifest)?;
    guard
        .set_segment_progress(index, completed, state)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    store
        .save(&guard)
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    Ok(())
}

fn aggregate_progress(
    manifest: &JobManifest,
    started: Instant,
) -> Result<SegmentedProgress, TransferError> {
    let downloaded_bytes = manifest
        .completed_bytes()
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    let total_bytes = manifest
        .total_size
        .ok_or(TransferError::MissingContentLength)?;
    let elapsed = started.elapsed();
    let nanos = elapsed.as_nanos().max(1);
    let bytes_per_second =
        ((u128::from(downloaded_bytes) * 1_000_000_000) / nanos).min(u128::from(u64::MAX)) as u64;
    Ok(SegmentedProgress {
        downloaded_bytes,
        total_bytes,
        completed_segments: manifest
            .segments
            .iter()
            .filter(|segment| segment.state == SegmentState::Completed)
            .count(),
        total_segments: manifest.segments.len(),
        elapsed,
        bytes_per_second,
    })
}

fn finalize_download(
    request: &SegmentedDownloadRequest,
    store: &JournalStore,
    partial: &Path,
    final_url: &str,
    manifest: Arc<Mutex<JobManifest>>,
    started: Instant,
) -> Result<SegmentedOutcome, TransferError> {
    {
        let mut guard = lock_manifest(&manifest)?;
        if !guard.all_segments_complete() {
            return Err(TransferError::Protocol(
                "workers ended before all segments completed".into(),
            ));
        }
        transition_manifest(&mut guard, JobState::Verifying)?;
        store
            .save(&guard)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
    }

    let downloaded_bytes = fs::metadata(partial)?.len();
    let expected = {
        let guard = lock_manifest(&manifest)?;
        guard
            .total_size
            .ok_or(TransferError::MissingContentLength)?
    };
    if downloaded_bytes != expected {
        return Err(TransferError::SizeMismatch {
            expected,
            actual: downloaded_bytes,
        });
    }
    let sha256 = hash_file(partial)?;
    platform::atomic_move(partial, &request.destination)?;

    {
        let mut guard = lock_manifest(&manifest)?;
        transition_manifest(&mut guard, JobState::Completed)?;
        store
            .save(&guard)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
    }
    store
        .remove()
        .map_err(|error| TransferError::Journal(error.to_string()))?;

    Ok(SegmentedOutcome::Completed(DownloadResult {
        destination: request.destination.clone(),
        final_url: final_url.to_string(),
        downloaded_bytes,
        sha256,
        elapsed: started.elapsed(),
    }))
}

fn recover_completed_download(
    request: &SegmentedDownloadRequest,
    store: &JournalStore,
    partial: &Path,
    mut manifest: JobManifest,
) -> Result<SegmentedOutcome, TransferError> {
    let source = if request.destination.exists() {
        request.destination.as_path()
    } else if partial.exists() {
        partial
    } else {
        return Err(TransferError::ResumeMismatch(
            "completed journal has neither partial nor final file".into(),
        ));
    };
    let expected = manifest
        .total_size
        .ok_or(TransferError::MissingContentLength)?;
    let actual = fs::metadata(source)?.len();
    if actual != expected {
        return Err(TransferError::SizeMismatch { expected, actual });
    }
    let sha256 = hash_file(source)?;
    if source == partial {
        platform::atomic_move(partial, &request.destination)?;
    }
    if manifest.state != JobState::Completed {
        if manifest.state != JobState::Verifying {
            transition_manifest(&mut manifest, JobState::Verifying)?;
        }
        transition_manifest(&mut manifest, JobState::Completed)?;
        store
            .save(&manifest)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
    }
    store
        .remove()
        .map_err(|error| TransferError::Journal(error.to_string()))?;
    Ok(SegmentedOutcome::Completed(DownloadResult {
        destination: request.destination.clone(),
        final_url: request.url.clone(),
        downloaded_bytes: actual,
        sha256,
        elapsed: Duration::ZERO,
    }))
}

fn normalize_active_segments(manifest: &mut JobManifest) -> Result<(), TransferError> {
    let updates = manifest
        .segments
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| {
            matches!(segment.state, SegmentState::Active | SegmentState::Failed)
                .then_some((index, segment.completed_bytes))
        })
        .collect::<Vec<_>>();
    for (index, completed) in updates {
        manifest
            .set_segment_progress(index, completed, SegmentState::Pending)
            .map_err(|error| TransferError::Journal(error.to_string()))?;
    }
    Ok(())
}

fn transition_manifest(manifest: &mut JobManifest, state: JobState) -> Result<(), TransferError> {
    manifest
        .transition_to(state)
        .map_err(|error| TransferError::Journal(error.to_string()))
}

fn if_range_validator(probe: &HttpProbe) -> Option<String> {
    probe
        .etag
        .as_deref()
        .filter(|value| !value.trim_start().starts_with("W/"))
        .map(ToOwned::to_owned)
        .or_else(|| probe.last_modified.clone())
}

fn parse_content_range(value: &str) -> Result<(u64, u64, u64), TransferError> {
    let value = value.trim();
    let bytes = value
        .strip_prefix("bytes ")
        .or_else(|| value.strip_prefix("Bytes "))
        .ok_or_else(|| TransferError::InvalidContentRange(value.into()))?;
    let (range, total) = bytes
        .split_once('/')
        .ok_or_else(|| TransferError::InvalidContentRange(value.into()))?;
    let (start, end) = range
        .split_once('-')
        .ok_or_else(|| TransferError::InvalidContentRange(value.into()))?;
    let start = start
        .trim()
        .parse::<u64>()
        .map_err(|_| TransferError::InvalidContentRange(value.into()))?;
    let end = end
        .trim()
        .parse::<u64>()
        .map_err(|_| TransferError::InvalidContentRange(value.into()))?;
    let total = total
        .trim()
        .parse::<u64>()
        .map_err(|_| TransferError::InvalidContentRange(value.into()))?;
    if start > end || end >= total {
        return Err(TransferError::InvalidContentRange(value.into()));
    }
    Ok((start, end, total))
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

fn destination_parent(destination: &Path) -> Result<PathBuf, TransferError> {
    match destination.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => Ok(parent.to_path_buf()),
        Some(_) => Ok(std::env::current_dir()?),
        None => Err(TransferError::MissingParent(destination.to_path_buf())),
    }
}

fn lock_manifest(
    manifest: &Arc<Mutex<JobManifest>>,
) -> Result<std::sync::MutexGuard<'_, JobManifest>, TransferError> {
    manifest
        .lock()
        .map_err(|_| TransferError::Protocol("manifest lock was poisoned".into()))
}

fn remove_if_exists(path: &Path) -> Result<(), TransferError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(TransferError::Io(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_content_range;

    #[test]
    fn parses_content_range() {
        assert_eq!(
            parse_content_range("bytes 10-19/100").unwrap(),
            (10, 19, 100)
        );
        assert!(parse_content_range("bytes */100").is_err());
        assert!(parse_content_range("bytes 20-10/100").is_err());
    }
}

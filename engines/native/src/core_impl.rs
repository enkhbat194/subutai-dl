#![forbid(unsafe_code)]

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const ENGINE_NAME: &str = "Subutai Native Engine";
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const JOURNAL_SCHEMA_VERSION: u16 = 1;

const JOURNAL_MAGIC: &[u8; 8] = b"SUBUTAI1";
const SNAPSHOT_MAGIC: &[u8; 8] = b"SUBSNAP1";
const CHECKSUM_BYTES: usize = 8;
const MAX_STRING_BYTES: usize = 1024 * 1024;
const MAX_SEGMENTS: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum JobState {
    Planned = 0,
    Probing = 1,
    Downloading = 2,
    Paused = 3,
    Verifying = 4,
    Completed = 5,
    Failed = 6,
    Cancelled = 7,
}

impl JobState {
    pub fn can_transition_to(self, next: Self) -> bool {
        if self == next {
            return true;
        }

        match self {
            Self::Planned => matches!(next, Self::Probing | Self::Failed | Self::Cancelled),
            Self::Probing => {
                matches!(next, Self::Downloading | Self::Failed | Self::Cancelled)
            }
            Self::Downloading => matches!(
                next,
                Self::Paused | Self::Verifying | Self::Failed | Self::Cancelled
            ),
            Self::Paused => {
                matches!(next, Self::Downloading | Self::Failed | Self::Cancelled)
            }
            Self::Verifying => matches!(next, Self::Completed | Self::Failed),
            Self::Failed => matches!(next, Self::Probing | Self::Cancelled),
            Self::Completed | Self::Cancelled => false,
        }
    }
}

impl TryFrom<u8> for JobState {
    type Error = JournalError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Planned),
            1 => Ok(Self::Probing),
            2 => Ok(Self::Downloading),
            3 => Ok(Self::Paused),
            4 => Ok(Self::Verifying),
            5 => Ok(Self::Completed),
            6 => Ok(Self::Failed),
            7 => Ok(Self::Cancelled),
            other => Err(JournalError::InvalidState(other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SegmentState {
    Pending = 0,
    Active = 1,
    Completed = 2,
    Failed = 3,
}

impl TryFrom<u8> for SegmentState {
    type Error = JournalError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Pending),
            1 => Ok(Self::Active),
            2 => Ok(Self::Completed),
            3 => Ok(Self::Failed),
            other => Err(JournalError::InvalidSegmentState(other)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub start: u64,
    pub end_exclusive: u64,
    pub completed_bytes: u64,
    pub state: SegmentState,
}

impl Segment {
    pub fn len(&self) -> u64 {
        self.end_exclusive.saturating_sub(self.start)
    }

    pub fn is_empty(&self) -> bool {
        self.start >= self.end_exclusive
    }

    pub fn remaining_bytes(&self) -> u64 {
        self.len().saturating_sub(self.completed_bytes)
    }

    pub fn validate(&self) -> Result<(), JournalError> {
        if self.is_empty() {
            return Err(JournalError::InvalidSegmentBounds {
                start: self.start,
                end_exclusive: self.end_exclusive,
            });
        }

        if self.completed_bytes > self.len() {
            return Err(JournalError::CompletedBeyondSegment {
                completed: self.completed_bytes,
                length: self.len(),
            });
        }

        if self.state == SegmentState::Completed && self.completed_bytes != self.len() {
            return Err(JournalError::CompletedSegmentIncomplete {
                completed: self.completed_bytes,
                length: self.len(),
            });
        }

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobManifest {
    pub schema_version: u16,
    pub job_id: String,
    pub url: String,
    pub destination: String,
    pub total_size: Option<u64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub state: JobState,
    pub segments: Vec<Segment>,
}

impl JobManifest {
    pub fn new(
        job_id: impl Into<String>,
        url: impl Into<String>,
        destination: impl Into<String>,
        total_size: Option<u64>,
        segments: Vec<Segment>,
    ) -> Result<Self, JournalError> {
        let manifest = Self {
            schema_version: JOURNAL_SCHEMA_VERSION,
            job_id: job_id.into(),
            url: url.into(),
            destination: destination.into(),
            total_size,
            etag: None,
            last_modified: None,
            state: JobState::Planned,
            segments,
        };
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn completed_bytes(&self) -> Result<u64, JournalError> {
        self.segments.iter().try_fold(0_u64, |total, segment| {
            total
                .checked_add(segment.completed_bytes)
                .ok_or(JournalError::ArithmeticOverflow)
        })
    }

    pub fn all_segments_complete(&self) -> bool {
        match self.total_size {
            Some(0) => self.segments.is_empty(),
            Some(_) => {
                !self.segments.is_empty()
                    && self.segments.iter().all(|segment| {
                        segment.state == SegmentState::Completed
                            && segment.completed_bytes == segment.len()
                    })
            }
            None => false,
        }
    }

    pub fn transition_to(&mut self, next: JobState) -> Result<(), JournalError> {
        if !self.state.can_transition_to(next) {
            return Err(JournalError::InvalidTransition {
                from: self.state,
                to: next,
            });
        }

        let previous = self.state;
        self.state = next;
        if let Err(error) = self.validate() {
            self.state = previous;
            return Err(error);
        }
        Ok(())
    }

    pub fn set_segment_progress(
        &mut self,
        index: usize,
        completed_bytes: u64,
        state: SegmentState,
    ) -> Result<(), JournalError> {
        let segment = self
            .segments
            .get_mut(index)
            .ok_or(JournalError::SegmentIndexOutOfRange(index))?;
        let previous_completed = segment.completed_bytes;
        let previous_state = segment.state;
        segment.completed_bytes = completed_bytes;
        segment.state = state;

        if let Err(error) = segment.validate() {
            segment.completed_bytes = previous_completed;
            segment.state = previous_state;
            return Err(error);
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), JournalError> {
        if self.schema_version != JOURNAL_SCHEMA_VERSION {
            return Err(JournalError::UnsupportedSchema(self.schema_version));
        }
        if self.job_id.trim().is_empty() {
            return Err(JournalError::EmptyRequiredField("job_id"));
        }
        if !is_supported_http_url(&self.url) {
            return Err(JournalError::InvalidUrl);
        }
        if self.destination.trim().is_empty() {
            return Err(JournalError::EmptyRequiredField("destination"));
        }
        if self.segments.len() > MAX_SEGMENTS {
            return Err(JournalError::LimitExceeded("segments"));
        }

        for segment in &self.segments {
            segment.validate()?;
        }

        match self.total_size {
            Some(0) if self.segments.is_empty() => {}
            Some(total_size) => validate_segment_coverage(total_size, &self.segments)?,
            None if self.segments.is_empty() => {}
            None => return Err(JournalError::UnknownSizeWithSegments),
        }

        if matches!(self.state, JobState::Verifying | JobState::Completed)
            && !self.all_segments_complete()
        {
            return Err(JournalError::JobStateRequiresCompleteSegments(self.state));
        }

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    EmptyFile,
    ZeroSegments,
    ZeroMinimumSegmentSize,
    ArithmeticOverflow,
}

impl Display for PlanError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyFile => write!(formatter, "file size must be greater than zero"),
            Self::ZeroSegments => write!(formatter, "segment count must be greater than zero"),
            Self::ZeroMinimumSegmentSize => {
                write!(formatter, "minimum segment size must be greater than zero")
            }
            Self::ArithmeticOverflow => write!(formatter, "range planning overflowed"),
        }
    }
}

impl Error for PlanError {}

pub fn plan_ranges(
    total_size: u64,
    requested_segments: u32,
    minimum_segment_size: u64,
) -> Result<Vec<Segment>, PlanError> {
    if total_size == 0 {
        return Err(PlanError::EmptyFile);
    }
    if requested_segments == 0 {
        return Err(PlanError::ZeroSegments);
    }
    if minimum_segment_size == 0 {
        return Err(PlanError::ZeroMinimumSegmentSize);
    }

    let complete_groups = total_size / minimum_segment_size;
    let maximum_useful_segments = complete_groups
        .checked_add(if total_size.is_multiple_of(minimum_segment_size) {
            0
        } else {
            1
        })
        .ok_or(PlanError::ArithmeticOverflow)?;
    let segment_count = u64::from(requested_segments)
        .min(maximum_useful_segments)
        .max(1);
    let base_length = total_size / segment_count;
    let remainder = total_size % segment_count;

    let capacity = usize::try_from(segment_count).map_err(|_| PlanError::ArithmeticOverflow)?;
    let mut ranges = Vec::with_capacity(capacity);
    let mut cursor = 0_u64;

    for index in 0..segment_count {
        let extra = if index < remainder { 1 } else { 0 };
        let length = base_length
            .checked_add(extra)
            .ok_or(PlanError::ArithmeticOverflow)?;
        let end_exclusive = cursor
            .checked_add(length)
            .ok_or(PlanError::ArithmeticOverflow)?;
        ranges.push(Segment {
            start: cursor,
            end_exclusive,
            completed_bytes: 0,
            state: SegmentState::Pending,
        });
        cursor = end_exclusive;
    }

    debug_assert_eq!(cursor, total_size);
    Ok(ranges)
}

pub fn is_supported_http_url(value: &str) -> bool {
    let trimmed = value.trim();
    let remainder = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"));

    remainder.is_some_and(|rest| {
        !rest.is_empty() && !rest.starts_with('/') && !rest.chars().any(char::is_whitespace)
    })
}

pub fn encode_manifest(manifest: &JobManifest) -> Result<Vec<u8>, JournalError> {
    manifest.validate()?;

    let mut output = Vec::new();
    output.extend_from_slice(JOURNAL_MAGIC);
    push_u16(&mut output, manifest.schema_version);
    push_string(&mut output, &manifest.job_id, "job_id")?;
    push_string(&mut output, &manifest.url, "url")?;
    push_string(&mut output, &manifest.destination, "destination")?;
    push_optional_u64(&mut output, manifest.total_size);
    push_optional_string(&mut output, manifest.etag.as_deref(), "etag")?;
    push_optional_string(
        &mut output,
        manifest.last_modified.as_deref(),
        "last_modified",
    )?;
    output.push(manifest.state as u8);
    push_u32(
        &mut output,
        u32::try_from(manifest.segments.len())
            .map_err(|_| JournalError::FieldTooLarge("segments"))?,
    );

    for segment in &manifest.segments {
        push_u64(&mut output, segment.start);
        push_u64(&mut output, segment.end_exclusive);
        push_u64(&mut output, segment.completed_bytes);
        output.push(segment.state as u8);
    }

    let checksum = checksum64(&output);
    push_u64(&mut output, checksum);
    Ok(output)
}

pub fn decode_manifest(input: &[u8]) -> Result<JobManifest, JournalError> {
    if input.len() < JOURNAL_MAGIC.len() {
        return Err(JournalError::UnexpectedEnd);
    }
    if input.get(..JOURNAL_MAGIC.len()) != Some(JOURNAL_MAGIC.as_slice()) {
        return Err(JournalError::InvalidMagic);
    }
    if input.len() < JOURNAL_MAGIC.len() + CHECKSUM_BYTES {
        return Err(JournalError::UnexpectedEnd);
    }

    let payload_length = input
        .len()
        .checked_sub(CHECKSUM_BYTES)
        .ok_or(JournalError::UnexpectedEnd)?;
    let (payload, checksum_bytes) = input.split_at(payload_length);
    let expected_checksum = u64::from_le_bytes(
        checksum_bytes
            .try_into()
            .map_err(|_| JournalError::UnexpectedEnd)?,
    );
    let actual_checksum = checksum64(payload);
    if expected_checksum != actual_checksum {
        return Err(JournalError::ChecksumMismatch {
            expected: expected_checksum,
            actual: actual_checksum,
        });
    }

    let mut cursor = Cursor::new(payload);
    if cursor.take(JOURNAL_MAGIC.len())? != JOURNAL_MAGIC {
        return Err(JournalError::InvalidMagic);
    }

    let schema_version = cursor.read_u16()?;
    if schema_version != JOURNAL_SCHEMA_VERSION {
        return Err(JournalError::UnsupportedSchema(schema_version));
    }

    let job_id = cursor.read_string("job_id")?;
    let url = cursor.read_string("url")?;
    let destination = cursor.read_string("destination")?;
    let total_size = cursor.read_optional_u64()?;
    let etag = cursor.read_optional_string("etag")?;
    let last_modified = cursor.read_optional_string("last_modified")?;
    let state = JobState::try_from(cursor.read_u8()?)?;
    let segment_count = cursor.read_u32()? as usize;
    if segment_count > MAX_SEGMENTS {
        return Err(JournalError::LimitExceeded("segments"));
    }

    let mut segments = Vec::with_capacity(segment_count);
    for _ in 0..segment_count {
        segments.push(Segment {
            start: cursor.read_u64()?,
            end_exclusive: cursor.read_u64()?,
            completed_bytes: cursor.read_u64()?,
            state: SegmentState::try_from(cursor.read_u8()?)?,
        });
    }

    if !cursor.is_finished() {
        return Err(JournalError::TrailingBytes(cursor.remaining()));
    }

    let manifest = JobManifest {
        schema_version,
        job_id,
        url,
        destination,
        total_size,
        etag,
        last_modified,
        state,
        segments,
    };
    manifest.validate()?;
    Ok(manifest)
}

fn validate_segment_coverage(total_size: u64, segments: &[Segment]) -> Result<(), JournalError> {
    if total_size == 0 && segments.is_empty() {
        return Ok(());
    }
    if segments.is_empty() {
        return Err(JournalError::MissingSegments);
    }

    let mut expected_start = 0_u64;
    for segment in segments {
        if segment.start != expected_start {
            return Err(JournalError::SegmentGapOrOverlap {
                expected_start,
                actual_start: segment.start,
            });
        }
        expected_start = segment.end_exclusive;
    }

    if expected_start != total_size {
        return Err(JournalError::CoverageMismatch {
            expected: total_size,
            actual: expected_start,
        });
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalError {
    UnexpectedEnd,
    InvalidMagic,
    UnsupportedSchema(u16),
    InvalidState(u8),
    InvalidSegmentState(u8),
    InvalidUtf8,
    InvalidFlag(u8),
    InvalidUrl,
    EmptyRequiredField(&'static str),
    FieldTooLarge(&'static str),
    LimitExceeded(&'static str),
    InvalidSegmentBounds {
        start: u64,
        end_exclusive: u64,
    },
    CompletedBeyondSegment {
        completed: u64,
        length: u64,
    },
    CompletedSegmentIncomplete {
        completed: u64,
        length: u64,
    },
    MissingSegments,
    UnknownSizeWithSegments,
    SegmentGapOrOverlap {
        expected_start: u64,
        actual_start: u64,
    },
    CoverageMismatch {
        expected: u64,
        actual: u64,
    },
    JobStateRequiresCompleteSegments(JobState),
    InvalidTransition {
        from: JobState,
        to: JobState,
    },
    SegmentIndexOutOfRange(usize),
    ArithmeticOverflow,
    ChecksumMismatch {
        expected: u64,
        actual: u64,
    },
    TrailingBytes(usize),
}

impl Display for JournalError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnexpectedEnd => write!(formatter, "journal ended unexpectedly"),
            Self::InvalidMagic => write!(formatter, "journal magic is invalid"),
            Self::UnsupportedSchema(version) => {
                write!(formatter, "unsupported journal schema {version}")
            }
            Self::InvalidState(state) => write!(formatter, "invalid job state {state}"),
            Self::InvalidSegmentState(state) => {
                write!(formatter, "invalid segment state {state}")
            }
            Self::InvalidUtf8 => write!(formatter, "journal string is not UTF-8"),
            Self::InvalidFlag(flag) => {
                write!(formatter, "invalid optional-field flag {flag}")
            }
            Self::InvalidUrl => {
                write!(formatter, "only valid HTTP and HTTPS URLs are supported")
            }
            Self::EmptyRequiredField(field) => {
                write!(formatter, "required field {field} is empty")
            }
            Self::FieldTooLarge(field) => write!(formatter, "field {field} is too large"),
            Self::LimitExceeded(field) => {
                write!(formatter, "journal limit exceeded for {field}")
            }
            Self::InvalidSegmentBounds {
                start,
                end_exclusive,
            } => write!(formatter, "invalid segment bounds {start}..{end_exclusive}"),
            Self::CompletedBeyondSegment { completed, length } => write!(
                formatter,
                "segment completed bytes {completed} exceed length {length}"
            ),
            Self::CompletedSegmentIncomplete { completed, length } => write!(
                formatter,
                "completed segment has {completed} of {length} bytes"
            ),
            Self::MissingSegments => write!(formatter, "known-size job has no segments"),
            Self::UnknownSizeWithSegments => {
                write!(formatter, "unknown-size job cannot have fixed segments")
            }
            Self::SegmentGapOrOverlap {
                expected_start,
                actual_start,
            } => write!(
                formatter,
                "segment coverage expected {expected_start}, found {actual_start}"
            ),
            Self::CoverageMismatch { expected, actual } => write!(
                formatter,
                "segment coverage expected total {expected}, found {actual}"
            ),
            Self::JobStateRequiresCompleteSegments(state) => {
                write!(formatter, "job state {state:?} requires complete segments")
            }
            Self::InvalidTransition { from, to } => {
                write!(formatter, "invalid job transition {from:?} -> {to:?}")
            }
            Self::SegmentIndexOutOfRange(index) => {
                write!(formatter, "segment index {index} is out of range")
            }
            Self::ArithmeticOverflow => write!(formatter, "journal arithmetic overflowed"),
            Self::ChecksumMismatch { expected, actual } => write!(
                formatter,
                "journal checksum mismatch: expected {expected:016x}, actual {actual:016x}"
            ),
            Self::TrailingBytes(count) => {
                write!(formatter, "journal contains {count} trailing bytes")
            }
        }
    }
}

impl Error for JournalError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalSnapshot {
    pub generation: u64,
    pub manifest: JobManifest,
}

#[derive(Debug)]
pub enum StoreError {
    Io(std::io::Error),
    Journal(JournalError),
    NoSnapshot,
    NoValidSnapshot(Vec<String>),
    GenerationOverflow,
    VerificationFailed,
}

impl Display for StoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "journal I/O error: {error}"),
            Self::Journal(error) => write!(formatter, "journal format error: {error}"),
            Self::NoSnapshot => write!(formatter, "no journal snapshot exists"),
            Self::NoValidSnapshot(errors) => {
                write!(
                    formatter,
                    "no valid journal snapshot: {}",
                    errors.join("; ")
                )
            }
            Self::GenerationOverflow => write!(formatter, "journal generation overflowed"),
            Self::VerificationFailed => write!(formatter, "journal write verification failed"),
        }
    }
}

impl Error for StoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Journal(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for StoreError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<JournalError> for StoreError {
    fn from(value: JournalError) -> Self {
        Self::Journal(value)
    }
}

#[derive(Debug, Clone)]
pub struct JournalStore {
    base_path: PathBuf,
}

impl JournalStore {
    pub fn new(base_path: impl Into<PathBuf>) -> Self {
        Self {
            base_path: base_path.into(),
        }
    }

    pub fn save(&self, manifest: &JobManifest) -> Result<u64, StoreError> {
        manifest.validate()?;

        let generation = match self.load() {
            Ok(snapshot) => snapshot
                .generation
                .checked_add(1)
                .ok_or(StoreError::GenerationOverflow)?,
            Err(StoreError::NoSnapshot) | Err(StoreError::NoValidSnapshot(_)) => 1,
            Err(error) => return Err(error),
        };

        let target = if generation % 2 == 1 {
            self.slot_path("a")
        } else {
            self.slot_path("b")
        };
        let temporary = self.temporary_path(if generation % 2 == 1 { "a" } else { "b" });

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        if temporary.exists() {
            fs::remove_file(&temporary)?;
        }

        let bytes = encode_snapshot(generation, manifest)?;
        {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }

        if target.exists() {
            fs::remove_file(&target)?;
        }
        fs::rename(&temporary, &target)?;

        let verified = read_snapshot_file(&target)?;
        if verified.generation != generation || verified.manifest != *manifest {
            return Err(StoreError::VerificationFailed);
        }
        Ok(generation)
    }

    pub fn load(&self) -> Result<JournalSnapshot, StoreError> {
        let paths = [self.slot_path("a"), self.slot_path("b")];
        let mut snapshots = Vec::new();
        let mut errors = Vec::new();
        let mut found_file = false;

        for path in paths {
            match read_snapshot_file(&path) {
                Ok(snapshot) => {
                    found_file = true;
                    snapshots.push(snapshot);
                }
                Err(StoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    found_file = true;
                    errors.push(format!("{}: {error}", path.display()));
                }
            }
        }

        snapshots.sort_by_key(|snapshot| snapshot.generation);
        if let Some(snapshot) = snapshots.pop() {
            return Ok(snapshot);
        }
        if found_file {
            Err(StoreError::NoValidSnapshot(errors))
        } else {
            Err(StoreError::NoSnapshot)
        }
    }

    pub fn remove(&self) -> Result<(), StoreError> {
        for path in [
            self.slot_path("a"),
            self.slot_path("b"),
            self.temporary_path("a"),
            self.temporary_path("b"),
        ] {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(StoreError::Io(error)),
            }
        }
        Ok(())
    }

    fn slot_path(&self, slot: &str) -> PathBuf {
        append_suffix(&self.base_path, &format!(".{slot}"))
    }

    fn temporary_path(&self, slot: &str) -> PathBuf {
        append_suffix(&self.base_path, &format!(".{slot}.tmp"))
    }
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn encode_snapshot(generation: u64, manifest: &JobManifest) -> Result<Vec<u8>, JournalError> {
    let manifest_bytes = encode_manifest(manifest)?;
    let manifest_length =
        u32::try_from(manifest_bytes.len()).map_err(|_| JournalError::FieldTooLarge("manifest"))?;

    let mut output = Vec::new();
    output.extend_from_slice(SNAPSHOT_MAGIC);
    push_u64(&mut output, generation);
    push_u32(&mut output, manifest_length);
    output.extend_from_slice(&manifest_bytes);
    let checksum = checksum64(&output);
    push_u64(&mut output, checksum);
    Ok(output)
}

fn decode_snapshot(input: &[u8]) -> Result<JournalSnapshot, JournalError> {
    if input.len() < SNAPSHOT_MAGIC.len() {
        return Err(JournalError::UnexpectedEnd);
    }
    if input.get(..SNAPSHOT_MAGIC.len()) != Some(SNAPSHOT_MAGIC.as_slice()) {
        return Err(JournalError::InvalidMagic);
    }
    if input.len() < SNAPSHOT_MAGIC.len() + 8 + 4 + CHECKSUM_BYTES {
        return Err(JournalError::UnexpectedEnd);
    }

    let payload_length = input
        .len()
        .checked_sub(CHECKSUM_BYTES)
        .ok_or(JournalError::UnexpectedEnd)?;
    let (payload, checksum_bytes) = input.split_at(payload_length);
    let expected_checksum = u64::from_le_bytes(
        checksum_bytes
            .try_into()
            .map_err(|_| JournalError::UnexpectedEnd)?,
    );
    let actual_checksum = checksum64(payload);
    if expected_checksum != actual_checksum {
        return Err(JournalError::ChecksumMismatch {
            expected: expected_checksum,
            actual: actual_checksum,
        });
    }

    let mut cursor = Cursor::new(payload);
    if cursor.take(SNAPSHOT_MAGIC.len())? != SNAPSHOT_MAGIC {
        return Err(JournalError::InvalidMagic);
    }
    let generation = cursor.read_u64()?;
    let manifest_length = cursor.read_u32()? as usize;
    let manifest = decode_manifest(cursor.take(manifest_length)?)?;
    if !cursor.is_finished() {
        return Err(JournalError::TrailingBytes(cursor.remaining()));
    }

    Ok(JournalSnapshot {
        generation,
        manifest,
    })
}

fn read_snapshot_file(path: &Path) -> Result<JournalSnapshot, StoreError> {
    let mut file = OpenOptions::new().read(true).open(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    decode_snapshot(&bytes).map_err(StoreError::Journal)
}

fn checksum64(input: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x00000100000001b3;

    input.iter().fold(OFFSET, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(PRIME)
    })
}

fn push_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(output: &mut Vec<u8>, value: u64) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_string(output: &mut Vec<u8>, value: &str, field: &'static str) -> Result<(), JournalError> {
    let bytes = value.as_bytes();
    if bytes.len() > MAX_STRING_BYTES {
        return Err(JournalError::LimitExceeded(field));
    }
    let length = u32::try_from(bytes.len()).map_err(|_| JournalError::FieldTooLarge(field))?;
    push_u32(output, length);
    output.extend_from_slice(bytes);
    Ok(())
}

fn push_optional_string(
    output: &mut Vec<u8>,
    value: Option<&str>,
    field: &'static str,
) -> Result<(), JournalError> {
    match value {
        Some(value) => {
            output.push(1);
            push_string(output, value, field)
        }
        None => {
            output.push(0);
            Ok(())
        }
    }
}

fn push_optional_u64(output: &mut Vec<u8>, value: Option<u64>) {
    match value {
        Some(value) => {
            output.push(1);
            push_u64(output, value);
        }
        None => output.push(0),
    }
}

struct Cursor<'a> {
    input: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, offset: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], JournalError> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or(JournalError::UnexpectedEnd)?;
        let value = self
            .input
            .get(self.offset..end)
            .ok_or(JournalError::UnexpectedEnd)?;
        self.offset = end;
        Ok(value)
    }

    fn read_u8(&mut self) -> Result<u8, JournalError> {
        self.take(1).map(|bytes| bytes[0])
    }

    fn read_u16(&mut self) -> Result<u16, JournalError> {
        let bytes: [u8; 2] = self
            .take(2)?
            .try_into()
            .map_err(|_| JournalError::UnexpectedEnd)?;
        Ok(u16::from_le_bytes(bytes))
    }

    fn read_u32(&mut self) -> Result<u32, JournalError> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| JournalError::UnexpectedEnd)?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn read_u64(&mut self) -> Result<u64, JournalError> {
        let bytes: [u8; 8] = self
            .take(8)?
            .try_into()
            .map_err(|_| JournalError::UnexpectedEnd)?;
        Ok(u64::from_le_bytes(bytes))
    }

    fn read_string(&mut self, field: &'static str) -> Result<String, JournalError> {
        let length = self.read_u32()? as usize;
        if length > MAX_STRING_BYTES {
            return Err(JournalError::LimitExceeded(field));
        }
        String::from_utf8(self.take(length)?.to_vec()).map_err(|_| JournalError::InvalidUtf8)
    }

    fn read_optional_string(
        &mut self,
        field: &'static str,
    ) -> Result<Option<String>, JournalError> {
        match self.read_u8()? {
            0 => Ok(None),
            1 => self.read_string(field).map(Some),
            flag => Err(JournalError::InvalidFlag(flag)),
        }
    }

    fn read_optional_u64(&mut self) -> Result<Option<u64>, JournalError> {
        match self.read_u8()? {
            0 => Ok(None),
            1 => self.read_u64().map(Some),
            flag => Err(JournalError::InvalidFlag(flag)),
        }
    }

    fn remaining(&self) -> usize {
        self.input.len().saturating_sub(self.offset)
    }

    fn is_finished(&self) -> bool {
        self.offset == self.input.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn manifest(total_size: u64, segment_count: u32) -> JobManifest {
        JobManifest::new(
            "job-test",
            "https://example.test/archive.bin",
            r"C:\Downloads\archive.bin.subutai.part",
            Some(total_size),
            plan_ranges(total_size, segment_count, 1).expect("range plan"),
        )
        .expect("manifest")
    }

    fn unique_store_path() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "subutai-native-journal-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn range_plan_covers_file_exactly_without_gaps() {
        let ranges = plan_ranges(10, 3, 1).expect("range plan");
        assert_eq!(
            ranges.iter().map(Segment::len).collect::<Vec<_>>(),
            vec![4, 3, 3]
        );
        validate_segment_coverage(10, &ranges).expect("coverage");
    }

    #[test]
    fn range_plan_respects_minimum_segment_size() {
        let ranges = plan_ranges(10, 32, 4).expect("range plan");
        assert_eq!(ranges.len(), 3);
        assert_eq!(ranges.last().map(|segment| segment.end_exclusive), Some(10));
    }

    #[test]
    fn journal_round_trip_preserves_recovery_state() {
        let mut value = manifest(64 * 1024 * 1024, 8);
        let first_length = value.segments[0].len();
        value
            .set_segment_progress(0, first_length, SegmentState::Completed)
            .expect("complete first segment");
        value
            .set_segment_progress(1, 1024, SegmentState::Active)
            .expect("activate second segment");
        value.etag = Some("\"abc123\"".into());
        value.last_modified = Some("Sat, 01 Aug 2026 12:00:00 GMT".into());
        value.transition_to(JobState::Probing).expect("probe");
        value
            .transition_to(JobState::Downloading)
            .expect("download");

        let encoded = encode_manifest(&value).expect("encode");
        let decoded = decode_manifest(&encoded).expect("decode");
        assert_eq!(decoded, value);
    }

    #[test]
    fn payload_corruption_is_rejected_by_checksum() {
        let value = manifest(1024, 1);
        let mut encoded = encode_manifest(&value).expect("encode");
        let payload_index = JOURNAL_MAGIC.len() + 4;
        encoded[payload_index] ^= 0x01;
        assert!(matches!(
            decode_manifest(&encoded),
            Err(JournalError::ChecksumMismatch { .. })
        ));
    }

    #[test]
    fn corrupted_magic_is_rejected() {
        let value = manifest(1024, 1);
        let mut encoded = encode_manifest(&value).expect("encode");
        encoded[0] ^= 0xff;
        assert_eq!(decode_manifest(&encoded), Err(JournalError::InvalidMagic));
    }

    #[test]
    fn completed_job_requires_every_segment_to_be_complete() {
        let mut value = manifest(1024, 2);
        value.transition_to(JobState::Probing).expect("probe");
        value
            .transition_to(JobState::Downloading)
            .expect("download");
        assert!(matches!(
            value.transition_to(JobState::Verifying),
            Err(JournalError::JobStateRequiresCompleteSegments(
                JobState::Verifying
            ))
        ));
    }

    #[test]
    fn legal_state_path_reaches_completed() {
        let mut value = manifest(1024, 2);
        for index in 0..value.segments.len() {
            let length = value.segments[index].len();
            value
                .set_segment_progress(index, length, SegmentState::Completed)
                .expect("complete segment");
        }
        value.transition_to(JobState::Probing).expect("probe");
        value
            .transition_to(JobState::Downloading)
            .expect("download");
        value.transition_to(JobState::Verifying).expect("verify");
        value.transition_to(JobState::Completed).expect("complete");
        assert!(value.all_segments_complete());
        assert_eq!(value.completed_bytes().expect("completed bytes"), 1024);
    }

    #[test]
    fn overlapping_segments_are_rejected() {
        let segments = vec![
            Segment {
                start: 0,
                end_exclusive: 10,
                completed_bytes: 0,
                state: SegmentState::Pending,
            },
            Segment {
                start: 9,
                end_exclusive: 20,
                completed_bytes: 0,
                state: SegmentState::Pending,
            },
        ];
        let result = JobManifest::new(
            "job-overlap",
            "https://example.test/file.bin",
            r"C:\Downloads\file.bin.subutai.part",
            Some(20),
            segments,
        );
        assert!(matches!(
            result,
            Err(JournalError::SegmentGapOrOverlap { .. })
        ));
    }

    #[test]
    fn dual_slot_store_falls_back_to_previous_valid_snapshot() {
        let path = unique_store_path();
        let store = JournalStore::new(&path);
        let mut value = manifest(2048, 2);

        assert_eq!(store.save(&value).expect("save generation one"), 1);
        value
            .set_segment_progress(0, 256, SegmentState::Active)
            .expect("progress");
        assert_eq!(store.save(&value).expect("save generation two"), 2);
        assert_eq!(store.load().expect("latest").generation, 2);

        let second_slot = append_suffix(&path, ".b");
        let mut bytes = fs::read(&second_slot).expect("read second slot");
        let middle = bytes.len() / 2;
        bytes[middle] ^= 0x80;
        fs::write(&second_slot, bytes).expect("corrupt second slot");

        let recovered = store.load().expect("fallback snapshot");
        assert_eq!(recovered.generation, 1);
        assert_eq!(recovered.manifest.completed_bytes().expect("bytes"), 0);
        store.remove().expect("cleanup");
    }

    #[test]
    fn only_http_and_https_urls_are_accepted() {
        assert!(is_supported_http_url("https://example.test/file"));
        assert!(is_supported_http_url("http://127.0.0.1:8080/file"));
        assert!(!is_supported_http_url("ftp://example.test/file"));
        assert!(!is_supported_http_url("https:///missing-host"));
        assert!(!is_supported_http_url("https://bad host/file"));
    }
}

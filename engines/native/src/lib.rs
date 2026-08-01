#![forbid(unsafe_code)]

use std::error::Error;
use std::fmt::{Display, Formatter};

pub const ENGINE_NAME: &str = "Subutai Native Engine";
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const JOURNAL_SCHEMA_VERSION: u16 = 1;
const JOURNAL_MAGIC: &[u8; 8] = b"SUBUTAI1";

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

        for segment in &self.segments {
            segment.validate()?;
        }

        if let Some(total_size) = self.total_size {
            validate_segment_coverage(total_size, &self.segments)?;
        } else if !self.segments.is_empty() {
            return Err(JournalError::UnknownSizeWithSegments);
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
            Self::ZeroMinimumSegmentSize => write!(formatter, "minimum segment size must be greater than zero"),
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

    let maximum_useful_segments = total_size
        .checked_add(minimum_segment_size - 1)
        .ok_or(PlanError::ArithmeticOverflow)?
        / minimum_segment_size;
    let segment_count = u64::from(requested_segments)
        .min(maximum_useful_segments)
        .max(1);
    let base_length = total_size / segment_count;
    let remainder = total_size % segment_count;

    let mut ranges = Vec::with_capacity(segment_count as usize);
    let mut cursor = 0_u64;

    for index in 0..segment_count {
        let length = base_length + u64::from(index < remainder);
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
        !rest.is_empty()
            && !rest.starts_with('/')
            && !rest.chars().any(char::is_whitespace)
    })
}

pub fn encode_manifest(manifest: &JobManifest) -> Result<Vec<u8>, JournalError> {
    manifest.validate()?;

    let mut output = Vec::new();
    output.extend_from_slice(JOURNAL_MAGIC);
    push_u16(&mut output, manifest.schema_version);
    push_string(&mut output, &manifest.job_id)?;
    push_string(&mut output, &manifest.url)?;
    push_string(&mut output, &manifest.destination)?;
    push_optional_u64(&mut output, manifest.total_size);
    push_optional_string(&mut output, manifest.etag.as_deref())?;
    push_optional_string(&mut output, manifest.last_modified.as_deref())?;
    output.push(manifest.state as u8);
    push_u32(
        &mut output,
        u32::try_from(manifest.segments.len()).map_err(|_| JournalError::FieldTooLarge("segments"))?,
    );

    for segment in &manifest.segments {
        push_u64(&mut output, segment.start);
        push_u64(&mut output, segment.end_exclusive);
        push_u64(&mut output, segment.completed_bytes);
        output.push(segment.state as u8);
    }

    Ok(output)
}

pub fn decode_manifest(input: &[u8]) -> Result<JobManifest, JournalError> {
    let mut cursor = Cursor::new(input);
    if cursor.take(JOURNAL_MAGIC.len())? != JOURNAL_MAGIC {
        return Err(JournalError::InvalidMagic);
    }

    let schema_version = cursor.read_u16()?;
    if schema_version != JOURNAL_SCHEMA_VERSION {
        return Err(JournalError::UnsupportedSchema(schema_version));
    }

    let job_id = cursor.read_string()?;
    let url = cursor.read_string()?;
    let destination = cursor.read_string()?;
    let total_size = cursor.read_optional_u64()?;
    let etag = cursor.read_optional_string()?;
    let last_modified = cursor.read_optional_string()?;
    let state = JobState::try_from(cursor.read_u8()?)?;
    let segment_count = cursor.read_u32()? as usize;
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
    InvalidSegmentBounds { start: u64, end_exclusive: u64 },
    CompletedBeyondSegment { completed: u64, length: u64 },
    MissingSegments,
    UnknownSizeWithSegments,
    SegmentGapOrOverlap { expected_start: u64, actual_start: u64 },
    CoverageMismatch { expected: u64, actual: u64 },
    TrailingBytes(usize),
}

impl Display for JournalError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnexpectedEnd => write!(formatter, "journal ended unexpectedly"),
            Self::InvalidMagic => write!(formatter, "journal magic is invalid"),
            Self::UnsupportedSchema(version) => write!(formatter, "unsupported journal schema {version}"),
            Self::InvalidState(state) => write!(formatter, "invalid job state {state}"),
            Self::InvalidSegmentState(state) => write!(formatter, "invalid segment state {state}"),
            Self::InvalidUtf8 => write!(formatter, "journal string is not UTF-8"),
            Self::InvalidFlag(flag) => write!(formatter, "invalid optional-field flag {flag}"),
            Self::InvalidUrl => write!(formatter, "only valid HTTP and HTTPS URLs are supported"),
            Self::EmptyRequiredField(field) => write!(formatter, "required field {field} is empty"),
            Self::FieldTooLarge(field) => write!(formatter, "field {field} is too large"),
            Self::InvalidSegmentBounds { start, end_exclusive } => write!(formatter, "invalid segment bounds {start}..{end_exclusive}"),
            Self::CompletedBeyondSegment { completed, length } => write!(formatter, "segment completed bytes {completed} exceed length {length}"),
            Self::MissingSegments => write!(formatter, "known-size job has no segments"),
            Self::UnknownSizeWithSegments => write!(formatter, "unknown-size job cannot have fixed segments"),
            Self::SegmentGapOrOverlap { expected_start, actual_start } => write!(formatter, "segment coverage expected {expected_start}, found {actual_start}"),
            Self::CoverageMismatch { expected, actual } => write!(formatter, "segment coverage expected total {expected}, found {actual}"),
            Self::TrailingBytes(count) => write!(formatter, "journal contains {count} trailing bytes"),
        }
    }
}

impl Error for JournalError {}

fn push_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(output: &mut Vec<u8>, value: u64) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_string(output: &mut Vec<u8>, value: &str) -> Result<(), JournalError> {
    let bytes = value.as_bytes();
    let length = u32::try_from(bytes.len()).map_err(|_| JournalError::FieldTooLarge("string"))?;
    push_u32(output, length);
    output.extend_from_slice(bytes);
    Ok(())
}

fn push_optional_string(output: &mut Vec<u8>, value: Option<&str>) -> Result<(), JournalError> {
    match value {
        Some(value) => {
            output.push(1);
            push_string(output, value)
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
        let end = self.offset.checked_add(count).ok_or(JournalError::UnexpectedEnd)?;
        let value = self.input.get(self.offset..end).ok_or(JournalError::UnexpectedEnd)?;
        self.offset = end;
        Ok(value)
    }

    fn read_u8(&mut self) -> Result<u8, JournalError> {
        self.take(1).map(|bytes| bytes[0])
    }

    fn read_u16(&mut self) -> Result<u16, JournalError> {
        let bytes: [u8; 2] = self.take(2)?.try_into().map_err(|_| JournalError::UnexpectedEnd)?;
        Ok(u16::from_le_bytes(bytes))
    }

    fn read_u32(&mut self) -> Result<u32, JournalError> {
        let bytes: [u8; 4] = self.take(4)?.try_into().map_err(|_| JournalError::UnexpectedEnd)?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn read_u64(&mut self) -> Result<u64, JournalError> {
        let bytes: [u8; 8] = self.take(8)?.try_into().map_err(|_| JournalError::UnexpectedEnd)?;
        Ok(u64::from_le_bytes(bytes))
    }

    fn read_string(&mut self) -> Result<String, JournalError> {
        let length = self.read_u32()? as usize;
        String::from_utf8(self.take(length)?.to_vec()).map_err(|_| JournalError::InvalidUtf8)
    }

    fn read_optional_string(&mut self) -> Result<Option<String>, JournalError> {
        match self.read_u8()? {
            0 => Ok(None),
            1 => self.read_string().map(Some),
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

    #[test]
    fn range_plan_covers_file_exactly_without_gaps() {
        let ranges = plan_ranges(10, 3, 1).expect("range plan");
        assert_eq!(ranges.iter().map(Segment::len).collect::<Vec<_>>(), vec![4, 3, 3]);
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
        let mut ranges = plan_ranges(64 * 1024 * 1024, 8, 1024 * 1024).expect("range plan");
        ranges[0].completed_bytes = ranges[0].len();
        ranges[0].state = SegmentState::Completed;
        ranges[1].completed_bytes = 1024;
        ranges[1].state = SegmentState::Active;

        let mut manifest = JobManifest::new(
            "job-001",
            "https://example.test/archive.bin",
            r"C:\Downloads\archive.bin.subutai.part",
            Some(64 * 1024 * 1024),
            ranges,
        )
        .expect("manifest");
        manifest.etag = Some("\"abc123\"".into());
        manifest.last_modified = Some("Sat, 01 Aug 2026 12:00:00 GMT".into());
        manifest.state = JobState::Downloading;

        let encoded = encode_manifest(&manifest).expect("encode");
        let decoded = decode_manifest(&encoded).expect("decode");
        assert_eq!(decoded, manifest);
    }

    #[test]
    fn corrupted_magic_is_rejected() {
        let ranges = plan_ranges(1024, 1, 1).expect("range plan");
        let manifest = JobManifest::new(
            "job-002",
            "https://example.test/file.bin",
            r"C:\Downloads\file.bin.subutai.part",
            Some(1024),
            ranges,
        )
        .expect("manifest");
        let mut encoded = encode_manifest(&manifest).expect("encode");
        encoded[0] ^= 0xff;
        assert_eq!(decode_manifest(&encoded), Err(JournalError::InvalidMagic));
    }

    #[test]
    fn overlapping_segments_are_rejected() {
        let segments = vec![
            Segment { start: 0, end_exclusive: 10, completed_bytes: 0, state: SegmentState::Pending },
            Segment { start: 9, end_exclusive: 20, completed_bytes: 0, state: SegmentState::Pending },
        ];
        let result = JobManifest::new(
            "job-003",
            "https://example.test/file.bin",
            r"C:\Downloads\file.bin.subutai.part",
            Some(20),
            segments,
        );
        assert!(matches!(result, Err(JournalError::SegmentGapOrOverlap { .. })));
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

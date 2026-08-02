use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::platform;
use crate::platform::ResponseReader;
use crate::sha256::Sha256;
use crate::transport_settings::{SharedRateLimiter, TransportSettings};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestHeader {
    pub name: String,
    pub value: String,
}

impl RequestHeader {
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Result<Self, TransferError> {
        let header = Self {
            name: name.into(),
            value: value.into(),
        };
        header.validate()?;
        Ok(header)
    }

    fn validate(&self) -> Result<(), TransferError> {
        if self.name.is_empty()
            || !self
                .name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
        {
            return Err(TransferError::InvalidHeaderName(self.name.clone()));
        }
        if self.value.contains(['\r', '\n', '\0']) {
            return Err(TransferError::InvalidHeaderValue(self.name.clone()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpProbe {
    pub requested_url: String,
    pub final_url: String,
    pub status_code: u16,
    pub content_length: Option<u64>,
    pub content_range: Option<String>,
    pub accepts_byte_ranges: bool,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_type: Option<String>,
    pub content_disposition: Option<String>,
    pub suggested_filename: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DownloadRequest {
    pub url: String,
    pub destination: PathBuf,
    pub headers: Vec<RequestHeader>,
    pub transport: TransportSettings,
}

impl DownloadRequest {
    pub fn new(url: impl Into<String>, destination: impl Into<PathBuf>) -> Self {
        Self {
            url: url.into(),
            destination: destination.into(),
            headers: Vec::new(),
            transport: TransportSettings::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub elapsed: Duration,
    pub bytes_per_second: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadResult {
    pub destination: PathBuf,
    pub final_url: String,
    pub downloaded_bytes: u64,
    pub sha256: String,
    pub elapsed: Duration,
}

#[derive(Debug)]
pub enum TransferError {
    UnsupportedPlatform,
    InvalidUrl(String),
    InvalidHeaderName(String),
    InvalidHeaderValue(String),
    HttpStatus(u16),
    DestinationExists(PathBuf),
    PartialFileExists(PathBuf),
    MissingParent(PathBuf),
    InsufficientDiskSpace {
        required: u64,
        available: u64,
    },
    SizeMismatch {
        expected: u64,
        actual: u64,
    },
    MissingContentLength,
    ByteRangesUnsupported,
    InvalidContentRange(String),
    ReservedHeader(String),
    RemoteChanged(String),
    UnsafeResume(String),
    ResumeMismatch(String),
    Journal(String),
    WorkerPanic,
    AdaptiveRetriesExhausted {
        segment: usize,
        attempts: u32,
        reason: String,
    },
    Windows {
        operation: &'static str,
        code: u32,
    },
    Io(std::io::Error),
    Protocol(String),
}

impl Display for TransferError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedPlatform => {
                write!(
                    formatter,
                    "native transfer is currently available on Windows"
                )
            }
            Self::InvalidUrl(value) => write!(formatter, "invalid HTTP/HTTPS URL: {value}"),
            Self::InvalidHeaderName(name) => {
                write!(formatter, "invalid request header name: {name}")
            }
            Self::InvalidHeaderValue(name) => write!(
                formatter,
                "request header {name} contains a forbidden character"
            ),
            Self::HttpStatus(status) => write!(formatter, "server returned HTTP status {status}"),
            Self::DestinationExists(path) => {
                write!(formatter, "destination already exists: {}", path.display())
            }
            Self::PartialFileExists(path) => {
                write!(formatter, "partial file already exists: {}", path.display())
            }
            Self::MissingParent(path) => write!(
                formatter,
                "destination has no parent directory: {}",
                path.display()
            ),
            Self::InsufficientDiskSpace {
                required,
                available,
            } => write!(
                formatter,
                "insufficient disk space: required {required} bytes, available {available} bytes"
            ),
            Self::SizeMismatch { expected, actual } => write!(
                formatter,
                "download size mismatch: expected {expected} bytes, received {actual} bytes"
            ),
            Self::MissingContentLength => {
                write!(
                    formatter,
                    "server did not provide a stable remote file size"
                )
            }
            Self::ByteRangesUnsupported => {
                write!(
                    formatter,
                    "server does not support verified byte-range transfer"
                )
            }
            Self::InvalidContentRange(value) => {
                write!(formatter, "invalid or unexpected Content-Range: {value}")
            }
            Self::ReservedHeader(name) => {
                write!(
                    formatter,
                    "request header {name} is managed by the segmented engine"
                )
            }
            Self::RemoteChanged(reason) => {
                write!(
                    formatter,
                    "remote file changed and cannot be resumed safely: {reason}"
                )
            }
            Self::UnsafeResume(reason) => write!(formatter, "unsafe resume refused: {reason}"),
            Self::ResumeMismatch(reason) => write!(formatter, "saved transfer mismatch: {reason}"),
            Self::Journal(reason) => write!(formatter, "transfer journal error: {reason}"),
            Self::WorkerPanic => {
                write!(formatter, "segmented transfer worker stopped unexpectedly")
            }
            Self::AdaptiveRetriesExhausted {
                segment,
                attempts,
                reason,
            } => write!(
                formatter,
                "adaptive transfer exhausted {attempts} attempts for segment {segment}: {reason}"
            ),
            Self::Windows { operation, code } => write!(
                formatter,
                "Windows operation {operation} failed with error {code}"
            ),
            Self::Io(error) => write!(formatter, "file I/O error: {error}"),
            Self::Protocol(message) => write!(formatter, "HTTP protocol error: {message}"),
        }
    }
}

impl Error for TransferError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for TransferError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

pub fn probe_url(url: &str, headers: &[RequestHeader]) -> Result<HttpProbe, TransferError> {
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
}

pub fn download_file(request: &DownloadRequest) -> Result<DownloadResult, TransferError> {
    download_file_with_progress(request, |_| {})
}

pub fn download_file_with_progress<F>(
    request: &DownloadRequest,
    mut progress: F,
) -> Result<DownloadResult, TransferError>
where
    F: FnMut(TransferProgress),
{
    for header in &request.headers {
        header.validate()?;
    }
    validate_destination(&request.destination)?;

    let partial = partial_path(&request.destination);
    if partial.exists() {
        return Err(TransferError::PartialFileExists(partial));
    }

    request.transport.validate().map_err(TransferError::Protocol)?;
    let mut response = platform::open_response(
        "GET",
        &request.url,
        &request.headers,
        &request.transport,
    )?;
    let metadata = response.metadata().clone();
    if !(200..300).contains(&metadata.status_code) {
        return Err(TransferError::HttpStatus(metadata.status_code));
    }

    let parent = destination_parent(&request.destination)?;
    fs::create_dir_all(&parent)?;

    if let Some(required) = metadata.content_length {
        let available = platform::available_disk_space(&parent)?;
        if available < required {
            return Err(TransferError::InsufficientDiskSpace {
                required,
                available,
            });
        }
    }

    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&partial)?;

    let started = Instant::now();
    let mut downloaded = 0_u64;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let rate_limiter = SharedRateLimiter::new(request.transport.speed_limit_bytes_per_second);

    loop {
        let read = response.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])?;
        if let Some(limiter) = rate_limiter.as_deref() {
            limiter.throttle(read);
        }
        hasher.update(&buffer[..read]);
        downloaded = downloaded
            .checked_add(read as u64)
            .ok_or_else(|| TransferError::Protocol("download byte count overflowed".into()))?;
        let elapsed = started.elapsed();
        let nanos = elapsed.as_nanos().max(1);
        let rate =
            ((u128::from(downloaded) * 1_000_000_000) / nanos).min(u128::from(u64::MAX)) as u64;
        progress(TransferProgress {
            downloaded_bytes: downloaded,
            total_bytes: metadata.content_length,
            elapsed,
            bytes_per_second: rate,
        });
    }

    if let Some(expected) = metadata.content_length
        && expected != downloaded
    {
        file.sync_all()?;
        return Err(TransferError::SizeMismatch {
            expected,
            actual: downloaded,
        });
    }

    file.sync_all()?;
    drop(file);
    platform::atomic_move(&partial, &request.destination)?;

    Ok(DownloadResult {
        destination: request.destination.clone(),
        final_url: metadata.final_url,
        downloaded_bytes: downloaded,
        sha256: hasher.finalize_hex(),
        elapsed: started.elapsed(),
    })
}

fn validate_destination(destination: &Path) -> Result<(), TransferError> {
    if destination.as_os_str().is_empty() {
        return Err(TransferError::MissingParent(destination.to_path_buf()));
    }
    if destination.exists() {
        return Err(TransferError::DestinationExists(destination.to_path_buf()));
    }
    if destination.file_name().is_none() {
        return Err(TransferError::MissingParent(destination.to_path_buf()));
    }
    Ok(())
}

fn destination_parent(destination: &Path) -> Result<PathBuf, TransferError> {
    match destination.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => Ok(parent.to_path_buf()),
        Some(_) => Ok(std::env::current_dir()?),
        None => Err(TransferError::MissingParent(destination.to_path_buf())),
    }
}

pub fn partial_path(destination: &Path) -> PathBuf {
    let mut value = destination.as_os_str().to_os_string();
    value.push(".subutai.part");
    PathBuf::from(value)
}

pub(crate) fn probe_from_headers(
    requested_url: &str,
    final_url: String,
    status_code: u16,
    headers: &[(String, String)],
) -> HttpProbe {
    let header = |name: &str| {
        headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim().to_string())
    };

    let content_range = header("content-range");
    let content_length = content_range
        .clone()
        .and_then(parse_content_range_total)
        .or_else(|| header("content-length").and_then(|value| value.parse::<u64>().ok()));
    let content_disposition = header("content-disposition");

    HttpProbe {
        requested_url: requested_url.to_string(),
        final_url,
        status_code,
        content_length,
        content_range,
        accepts_byte_ranges: header("accept-ranges")
            .is_some_and(|value| value.eq_ignore_ascii_case("bytes")),
        etag: header("etag"),
        last_modified: header("last-modified"),
        content_type: header("content-type"),
        suggested_filename: content_disposition
            .as_deref()
            .and_then(suggested_filename_from_disposition),
        content_disposition,
    }
}

fn parse_content_range_total(value: String) -> Option<u64> {
    value.rsplit_once('/')?.1.trim().parse().ok()
}

fn suggested_filename_from_disposition(value: &str) -> Option<String> {
    for part in value.split(';').skip(1) {
        let Some((name, raw_value)) = part.trim().split_once('=') else {
            continue;
        };
        if name.eq_ignore_ascii_case("filename*") {
            let encoded = raw_value.trim_matches('"');
            let encoded = encoded.split_once("''").map_or(encoded, |(_, rest)| rest);
            return percent_decode_filename(encoded);
        }
        if name.eq_ignore_ascii_case("filename") {
            return sanitize_filename(raw_value.trim().trim_matches('"'));
        }
    }
    None
}

fn percent_decode_filename(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1)?;
            let low = *bytes.get(index + 2)?;
            decoded.push((hex_value(high)? << 4) | hex_value(low)?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    sanitize_filename(std::str::from_utf8(&decoded).ok()?)
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn sanitize_filename(value: &str) -> Option<String> {
    let filename = value
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) || character.is_control()
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let filename = filename.trim().trim_end_matches(['.', ' ']).to_string();
    (!filename.is_empty() && filename != "." && filename != "..").then_some(filename)
}

#[cfg(test)]
mod tests {
    use super::{RequestHeader, probe_from_headers, suggested_filename_from_disposition};

    #[test]
    fn rejects_header_injection() {
        assert!(RequestHeader::new("Cookie", "safe=value\r\nInjected: yes").is_err());
    }

    #[test]
    fn parses_probe_metadata_and_filename() {
        let probe = probe_from_headers(
            "https://example.test/a",
            "https://example.test/final".into(),
            206,
            &[
                ("Content-Length".into(), "1".into()),
                ("Content-Range".into(), "bytes 0-0/123".into()),
                ("Accept-Ranges".into(), "bytes".into()),
                (
                    "Content-Disposition".into(),
                    "attachment; filename*=UTF-8''Subutai%20Guide.pdf".into(),
                ),
            ],
        );
        assert_eq!(probe.content_length, Some(123));
        assert_eq!(probe.content_range.as_deref(), Some("bytes 0-0/123"));
        assert!(probe.accepts_byte_ranges);
        assert_eq!(
            probe.suggested_filename.as_deref(),
            Some("Subutai Guide.pdf")
        );
    }

    #[test]
    fn skips_malformed_disposition_parts_before_filename() {
        assert_eq!(
            suggested_filename_from_disposition("attachment; malformed; filename=Subutai-N1.bin")
                .as_deref(),
            Some("Subutai-N1.bin")
        );
    }
}

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::time::Duration;

use crate::transfer::RequestHeader;
use crate::{ProxyMode, TransportSettings};

pub const DESKTOP_PAYLOAD_SCHEMA_VERSION: u16 = 2;
pub const DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION: u16 = 3;
const LEGACY_DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION: u16 = 2;
const START_MAGIC: &[u8; 8] = b"SUBSTRT1";
const STATUS_MAGIC: &[u8; 8] = b"SUBSTAT1";
const MAX_FIELD_BYTES: usize = 1024 * 1024;
const MAX_HEADER_COUNT: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopStartRequest {
    pub task_id: String,
    pub url: String,
    pub destination: String,
    pub maximum_connections: u32,
    pub minimum_chunk_bytes: u64,
    pub checkpoint_bytes: u64,
    pub transport: TransportSettings,
    pub headers: Vec<RequestHeader>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum DesktopTaskState {
    Waiting = 1,
    Active = 2,
    Paused = 3,
    Complete = 4,
    Error = 5,
    Removed = 6,
}

impl TryFrom<u8> for DesktopTaskState {
    type Error = DesktopProtocolError;

    fn try_from(value: u8) -> Result<Self, DesktopProtocolError> {
        match value {
            1 => Ok(Self::Waiting),
            2 => Ok(Self::Active),
            3 => Ok(Self::Paused),
            4 => Ok(Self::Complete),
            5 => Ok(Self::Error),
            6 => Ok(Self::Removed),
            other => Err(DesktopProtocolError::InvalidTaskState(other)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopStatusEvent {
    pub task_id: String,
    pub state: DesktopTaskState,
    pub total_bytes: u64,
    pub completed_bytes: u64,
    pub bytes_per_second: u64,
    pub active_connections: u32,
    pub connection_limit: u32,
    pub peak_connections: u32,
    pub queued_segments: u32,
    pub replacement_count: u64,
    pub retry_count: u64,
    pub elapsed_milliseconds: u64,
    pub file_path: String,
    pub error_code: String,
    pub error_message: String,
}

pub fn encode_start_request(value: &DesktopStartRequest) -> Result<Vec<u8>, DesktopProtocolError> {
    validate_start(value)?;
    let mut output = Vec::new();
    output.extend_from_slice(START_MAGIC);
    output.extend_from_slice(&DESKTOP_PAYLOAD_SCHEMA_VERSION.to_le_bytes());
    write_string(&mut output, &value.task_id)?;
    write_string(&mut output, &value.url)?;
    write_string(&mut output, &value.destination)?;
    output.extend_from_slice(&value.maximum_connections.to_le_bytes());
    output.extend_from_slice(&value.minimum_chunk_bytes.to_le_bytes());
    output.extend_from_slice(&value.checkpoint_bytes.to_le_bytes());
    output.push(value.transport.proxy_mode as u8);
    write_string(&mut output, &value.transport.proxy_url)?;
    write_string(&mut output, &value.transport.proxy_username)?;
    write_string(&mut output, &value.transport.proxy_password)?;
    output.extend_from_slice(&value.transport.speed_limit_bytes_per_second.to_le_bytes());
    output.extend_from_slice(&value.transport.retry_max_attempts.to_le_bytes());
    output.extend_from_slice(&duration_millis(value.transport.retry_base_delay)?.to_le_bytes());
    output.extend_from_slice(&duration_millis(value.transport.connect_timeout)?.to_le_bytes());
    output.extend_from_slice(&duration_millis(value.transport.transfer_timeout)?.to_le_bytes());
    output.extend_from_slice(
        &u32::try_from(value.headers.len())
            .map_err(|_| DesktopProtocolError::TooManyHeaders(value.headers.len()))?
            .to_le_bytes(),
    );
    for header in &value.headers {
        write_string(&mut output, &header.name)?;
        write_string(&mut output, &header.value)?;
    }
    Ok(output)
}

pub fn decode_start_request(input: &[u8]) -> Result<DesktopStartRequest, DesktopProtocolError> {
    let mut cursor = Cursor::new(input);
    if cursor.take(START_MAGIC.len())? != START_MAGIC {
        return Err(DesktopProtocolError::InvalidMagic);
    }
    read_schema(&mut cursor)?;
    let task_id = cursor.read_string()?;
    let url = cursor.read_string()?;
    let destination = cursor.read_string()?;
    let maximum_connections = cursor.read_u32()?;
    let minimum_chunk_bytes = cursor.read_u64()?;
    let checkpoint_bytes = cursor.read_u64()?;
    let proxy_mode =
        ProxyMode::try_from(cursor.read_u8()?).map_err(DesktopProtocolError::InvalidValue)?;
    let proxy_url = cursor.read_string()?;
    let proxy_username = cursor.read_string()?;
    let proxy_password = cursor.read_string()?;
    let speed_limit_bytes_per_second = cursor.read_u64()?;
    let retry_max_attempts = cursor.read_u32()?;
    let retry_base_delay = Duration::from_millis(cursor.read_u64()?);
    let connect_timeout = Duration::from_millis(cursor.read_u64()?);
    let transfer_timeout = Duration::from_millis(cursor.read_u64()?);
    let header_count = cursor.read_u32()? as usize;
    if header_count > MAX_HEADER_COUNT {
        return Err(DesktopProtocolError::TooManyHeaders(header_count));
    }
    let mut headers = Vec::with_capacity(header_count);
    for _ in 0..header_count {
        let name = cursor.read_string()?;
        let value = cursor.read_string()?;
        headers.push(
            RequestHeader::new(name, value)
                .map_err(|error| DesktopProtocolError::InvalidHeader(error.to_string()))?,
        );
    }
    cursor.finish()?;

    let value = DesktopStartRequest {
        task_id,
        url,
        destination,
        maximum_connections,
        minimum_chunk_bytes,
        checkpoint_bytes,
        transport: TransportSettings {
            proxy_mode,
            proxy_url,
            proxy_username,
            proxy_password,
            speed_limit_bytes_per_second,
            retry_max_attempts,
            retry_base_delay,
            connect_timeout,
            transfer_timeout,
        },
        headers,
    };
    validate_start(&value)?;
    Ok(value)
}

pub fn encode_status_event(value: &DesktopStatusEvent) -> Result<Vec<u8>, DesktopProtocolError> {
    let mut output = Vec::new();
    output.extend_from_slice(STATUS_MAGIC);
    output.extend_from_slice(&DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION.to_le_bytes());
    write_string(&mut output, &value.task_id)?;
    output.push(value.state as u8);
    output.extend_from_slice(&value.total_bytes.to_le_bytes());
    output.extend_from_slice(&value.completed_bytes.to_le_bytes());
    output.extend_from_slice(&value.bytes_per_second.to_le_bytes());
    output.extend_from_slice(&value.active_connections.to_le_bytes());
    output.extend_from_slice(&value.connection_limit.to_le_bytes());
    output.extend_from_slice(&value.peak_connections.to_le_bytes());
    output.extend_from_slice(&value.queued_segments.to_le_bytes());
    output.extend_from_slice(&value.replacement_count.to_le_bytes());
    output.extend_from_slice(&value.retry_count.to_le_bytes());
    output.extend_from_slice(&value.elapsed_milliseconds.to_le_bytes());
    write_string(&mut output, &value.file_path)?;
    write_string(&mut output, &value.error_code)?;
    write_string(&mut output, &value.error_message)?;
    Ok(output)
}

pub fn decode_status_event(input: &[u8]) -> Result<DesktopStatusEvent, DesktopProtocolError> {
    let mut cursor = Cursor::new(input);
    if cursor.take(STATUS_MAGIC.len())? != STATUS_MAGIC {
        return Err(DesktopProtocolError::InvalidMagic);
    }
    let schema = cursor.read_u16()?;
    if schema != DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION
        && schema != LEGACY_DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION
    {
        return Err(DesktopProtocolError::UnsupportedSchema(schema));
    }
    let task_id = cursor.read_string()?;
    let state = DesktopTaskState::try_from(cursor.read_u8()?)?;
    let total_bytes = cursor.read_u64()?;
    let completed_bytes = cursor.read_u64()?;
    let bytes_per_second = cursor.read_u64()?;
    let active_connections = cursor.read_u32()?;
    let (
        connection_limit,
        peak_connections,
        queued_segments,
        replacement_count,
        retry_count,
        elapsed_milliseconds,
    ) = if schema == DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION {
        (
            cursor.read_u32()?,
            cursor.read_u32()?,
            cursor.read_u32()?,
            cursor.read_u64()?,
            cursor.read_u64()?,
            cursor.read_u64()?,
        )
    } else {
        (active_connections, active_connections, 0, 0, 0, 0)
    };
    let value = DesktopStatusEvent {
        task_id,
        state,
        total_bytes,
        completed_bytes,
        bytes_per_second,
        active_connections,
        connection_limit,
        peak_connections,
        queued_segments,
        replacement_count,
        retry_count,
        elapsed_milliseconds,
        file_path: cursor.read_string()?,
        error_code: cursor.read_string()?,
        error_message: cursor.read_string()?,
    };
    cursor.finish()?;
    Ok(value)
}

fn validate_start(value: &DesktopStartRequest) -> Result<(), DesktopProtocolError> {
    if value.task_id.trim().is_empty()
        || value.url.trim().is_empty()
        || value.destination.trim().is_empty()
    {
        return Err(DesktopProtocolError::InvalidValue(
            "task id, URL and destination are required".into(),
        ));
    }
    if value.maximum_connections == 0
        || value.minimum_chunk_bytes == 0
        || value.checkpoint_bytes == 0
    {
        return Err(DesktopProtocolError::InvalidValue(
            "connection, chunk and checkpoint values must be greater than zero".into(),
        ));
    }
    if value.headers.len() > MAX_HEADER_COUNT {
        return Err(DesktopProtocolError::TooManyHeaders(value.headers.len()));
    }
    value
        .transport
        .validate()
        .map_err(DesktopProtocolError::InvalidValue)
}

fn duration_millis(value: Duration) -> Result<u64, DesktopProtocolError> {
    u64::try_from(value.as_millis()).map_err(|_| DesktopProtocolError::ArithmeticOverflow)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopProtocolError {
    UnexpectedEnd,
    InvalidMagic,
    UnsupportedSchema(u16),
    InvalidTaskState(u8),
    FieldTooLarge(usize),
    TooManyHeaders(usize),
    InvalidUtf8,
    InvalidHeader(String),
    InvalidValue(String),
    TrailingBytes(usize),
    ArithmeticOverflow,
}

impl Display for DesktopProtocolError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnexpectedEnd => write!(formatter, "desktop payload ended unexpectedly"),
            Self::InvalidMagic => write!(formatter, "desktop payload magic is invalid"),
            Self::UnsupportedSchema(version) => {
                write!(formatter, "unsupported desktop payload schema {version}")
            }
            Self::InvalidTaskState(state) => {
                write!(formatter, "invalid desktop task state {state}")
            }
            Self::FieldTooLarge(size) => {
                write!(formatter, "desktop payload field is too large: {size}")
            }
            Self::TooManyHeaders(count) => {
                write!(formatter, "too many desktop request headers: {count}")
            }
            Self::InvalidUtf8 => write!(formatter, "desktop payload string is not UTF-8"),
            Self::InvalidHeader(message) => {
                write!(formatter, "invalid desktop request header: {message}")
            }
            Self::InvalidValue(message) => {
                write!(formatter, "invalid desktop payload value: {message}")
            }
            Self::TrailingBytes(count) => {
                write!(formatter, "desktop payload has {count} trailing bytes")
            }
            Self::ArithmeticOverflow => write!(formatter, "desktop payload arithmetic overflowed"),
        }
    }
}

impl Error for DesktopProtocolError {}

fn read_schema(cursor: &mut Cursor<'_>) -> Result<(), DesktopProtocolError> {
    let schema = cursor.read_u16()?;
    if schema != DESKTOP_PAYLOAD_SCHEMA_VERSION {
        return Err(DesktopProtocolError::UnsupportedSchema(schema));
    }
    Ok(())
}

fn write_string(output: &mut Vec<u8>, value: &str) -> Result<(), DesktopProtocolError> {
    let bytes = value.as_bytes();
    if bytes.len() > MAX_FIELD_BYTES {
        return Err(DesktopProtocolError::FieldTooLarge(bytes.len()));
    }
    let length =
        u32::try_from(bytes.len()).map_err(|_| DesktopProtocolError::FieldTooLarge(bytes.len()))?;
    output.extend_from_slice(&length.to_le_bytes());
    output.extend_from_slice(bytes);
    Ok(())
}

struct Cursor<'a> {
    input: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, offset: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], DesktopProtocolError> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or(DesktopProtocolError::ArithmeticOverflow)?;
        let value = self
            .input
            .get(self.offset..end)
            .ok_or(DesktopProtocolError::UnexpectedEnd)?;
        self.offset = end;
        Ok(value)
    }

    fn read_u8(&mut self) -> Result<u8, DesktopProtocolError> {
        self.take(1).map(|bytes| bytes[0])
    }

    fn read_u16(&mut self) -> Result<u16, DesktopProtocolError> {
        let bytes: [u8; 2] = self
            .take(2)?
            .try_into()
            .map_err(|_| DesktopProtocolError::UnexpectedEnd)?;
        Ok(u16::from_le_bytes(bytes))
    }

    fn read_u32(&mut self) -> Result<u32, DesktopProtocolError> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| DesktopProtocolError::UnexpectedEnd)?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn read_u64(&mut self) -> Result<u64, DesktopProtocolError> {
        let bytes: [u8; 8] = self
            .take(8)?
            .try_into()
            .map_err(|_| DesktopProtocolError::UnexpectedEnd)?;
        Ok(u64::from_le_bytes(bytes))
    }

    fn read_string(&mut self) -> Result<String, DesktopProtocolError> {
        let length = self.read_u32()? as usize;
        if length > MAX_FIELD_BYTES {
            return Err(DesktopProtocolError::FieldTooLarge(length));
        }
        String::from_utf8(self.take(length)?.to_vec())
            .map_err(|_| DesktopProtocolError::InvalidUtf8)
    }

    fn finish(&self) -> Result<(), DesktopProtocolError> {
        if self.offset == self.input.len() {
            Ok(())
        } else {
            Err(DesktopProtocolError::TrailingBytes(
                self.input.len().saturating_sub(self.offset),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_request_round_trip_preserves_transport_settings_and_headers() {
        let value = DesktopStartRequest {
            task_id: "desktop-1".into(),
            url: "https://example.test/file.bin".into(),
            destination: r"C:\Downloads\file.bin".into(),
            maximum_connections: 8,
            minimum_chunk_bytes: 1024 * 1024,
            checkpoint_bytes: 256 * 1024,
            transport: TransportSettings {
                proxy_mode: ProxyMode::Manual,
                proxy_url: "http://127.0.0.1:8080".into(),
                proxy_username: "subutai".into(),
                proxy_password: "secret".into(),
                speed_limit_bytes_per_second: 2 * 1024 * 1024,
                retry_max_attempts: 7,
                retry_base_delay: Duration::from_millis(750),
                connect_timeout: Duration::from_secs(15),
                transfer_timeout: Duration::from_secs(90),
            },
            headers: vec![RequestHeader::new("Referer", "https://example.test/").unwrap()],
        };
        let encoded = encode_start_request(&value).expect("encode start");
        assert_eq!(decode_start_request(&encoded).expect("decode start"), value);
    }

    #[test]
    fn status_event_round_trip_preserves_progress() {
        let value = DesktopStatusEvent {
            task_id: "desktop-2".into(),
            state: DesktopTaskState::Active,
            total_bytes: 10_000,
            completed_bytes: 4_096,
            bytes_per_second: 2_048,
            active_connections: 3,
            connection_limit: 5,
            peak_connections: 6,
            queued_segments: 7,
            replacement_count: 8,
            retry_count: 9,
            elapsed_milliseconds: 10,
            file_path: r"C:\Downloads\file.bin".into(),
            error_code: String::new(),
            error_message: String::new(),
        };
        let encoded = encode_status_event(&value).expect("encode status");
        assert_eq!(decode_status_event(&encoded).expect("decode status"), value);
    }

    #[test]
    fn status_decoder_accepts_schema_v2_without_telemetry() {
        let mut encoded = Vec::new();
        encoded.extend_from_slice(STATUS_MAGIC);
        encoded.extend_from_slice(&LEGACY_DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION.to_le_bytes());
        write_string(&mut encoded, "legacy").unwrap();
        encoded.push(DesktopTaskState::Active as u8);
        encoded.extend_from_slice(&100_u64.to_le_bytes());
        encoded.extend_from_slice(&50_u64.to_le_bytes());
        encoded.extend_from_slice(&25_u64.to_le_bytes());
        encoded.extend_from_slice(&2_u32.to_le_bytes());
        write_string(&mut encoded, r"C:\legacy.bin").unwrap();
        write_string(&mut encoded, "").unwrap();
        write_string(&mut encoded, "").unwrap();

        let decoded = decode_status_event(&encoded).expect("decode legacy status");
        assert_eq!(decoded.active_connections, 2);
        assert_eq!(decoded.connection_limit, 2);
        assert_eq!(decoded.peak_connections, 2);
        assert_eq!(decoded.queued_segments, 0);
        assert_eq!(decoded.replacement_count, 0);
        assert_eq!(decoded.retry_count, 0);
        assert_eq!(decoded.elapsed_milliseconds, 0);
    }

    #[test]
    fn malformed_payloads_are_rejected() {
        let mut encoded = encode_status_event(&DesktopStatusEvent {
            task_id: "desktop-3".into(),
            state: DesktopTaskState::Paused,
            total_bytes: 1,
            completed_bytes: 1,
            bytes_per_second: 0,
            active_connections: 0,
            connection_limit: 0,
            peak_connections: 0,
            queued_segments: 0,
            replacement_count: 0,
            retry_count: 0,
            elapsed_milliseconds: 0,
            file_path: String::new(),
            error_code: String::new(),
            error_message: String::new(),
        })
        .expect("encode status");
        encoded[0] ^= 0x40;
        assert!(matches!(
            decode_status_event(&encoded),
            Err(DesktopProtocolError::InvalidMagic)
        ));
        assert!(decode_status_event(&encoded[..encoded.len() - 1]).is_err());
    }
}

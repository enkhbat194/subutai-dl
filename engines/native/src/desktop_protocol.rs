use std::error::Error;
use std::fmt::{Display, Formatter};

use crate::transfer::RequestHeader;

pub const DESKTOP_PAYLOAD_SCHEMA_VERSION: u16 = 1;
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

    fn try_from(value: u8) -> Result<Self, Self::Error> {
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
    pub file_path: String,
    pub error_code: String,
    pub error_message: String,
}

pub fn encode_start_request(value: &DesktopStartRequest) -> Result<Vec<u8>, DesktopProtocolError> {
    if value.maximum_connections == 0 {
        return Err(DesktopProtocolError::InvalidValue(
            "maximum connection count must be greater than zero".into(),
        ));
    }
    if value.minimum_chunk_bytes == 0 || value.checkpoint_bytes == 0 {
        return Err(DesktopProtocolError::InvalidValue(
            "chunk and checkpoint sizes must be greater than zero".into(),
        ));
    }
    if value.headers.len() > MAX_HEADER_COUNT {
        return Err(DesktopProtocolError::TooManyHeaders(value.headers.len()));
    }

    let mut output = Vec::new();
    output.extend_from_slice(START_MAGIC);
    output.extend_from_slice(&DESKTOP_PAYLOAD_SCHEMA_VERSION.to_le_bytes());
    write_string(&mut output, &value.task_id)?;
    write_string(&mut output, &value.url)?;
    write_string(&mut output, &value.destination)?;
    output.extend_from_slice(&value.maximum_connections.to_le_bytes());
    output.extend_from_slice(&value.minimum_chunk_bytes.to_le_bytes());
    output.extend_from_slice(&value.checkpoint_bytes.to_le_bytes());
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
        headers,
    };
    if value.task_id.trim().is_empty() || value.url.trim().is_empty() || value.destination.trim().is_empty() {
        return Err(DesktopProtocolError::InvalidValue(
            "task id, URL and destination are required".into(),
        ));
    }
    if value.maximum_connections == 0 || value.minimum_chunk_bytes == 0 || value.checkpoint_bytes == 0 {
        return Err(DesktopProtocolError::InvalidValue(
            "connection, chunk and checkpoint values must be greater than zero".into(),
        ));
    }
    Ok(value)
}

pub fn encode_status_event(value: &DesktopStatusEvent) -> Result<Vec<u8>, DesktopProtocolError> {
    let mut output = Vec::new();
    output.extend_from_slice(STATUS_MAGIC);
    output.extend_from_slice(&DESKTOP_PAYLOAD_SCHEMA_VERSION.to_le_bytes());
    write_string(&mut output, &value.task_id)?;
    output.push(value.state as u8);
    output.extend_from_slice(&value.total_bytes.to_le_bytes());
    output.extend_from_slice(&value.completed_bytes.to_le_bytes());
    output.extend_from_slice(&value.bytes_per_second.to_le_bytes());
    output.extend_from_slice(&value.active_connections.to_le_bytes());
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
    read_schema(&mut cursor)?;
    let value = DesktopStatusEvent {
        task_id: cursor.read_string()?,
        state: DesktopTaskState::try_from(cursor.read_u8()?)?,
        total_bytes: cursor.read_u64()?,
        completed_bytes: cursor.read_u64()?,
        bytes_per_second: cursor.read_u64()?,
        active_connections: cursor.read_u32()?,
        file_path: cursor.read_string()?,
        error_code: cursor.read_string()?,
        error_message: cursor.read_string()?,
    };
    cursor.finish()?;
    Ok(value)
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
            Self::InvalidTaskState(state) => write!(formatter, "invalid desktop task state {state}"),
            Self::FieldTooLarge(size) => write!(formatter, "desktop payload field is too large: {size}"),
            Self::TooManyHeaders(count) => write!(formatter, "too many desktop request headers: {count}"),
            Self::InvalidUtf8 => write!(formatter, "desktop payload string is not UTF-8"),
            Self::InvalidHeader(message) => write!(formatter, "invalid desktop request header: {message}"),
            Self::InvalidValue(message) => write!(formatter, "invalid desktop payload value: {message}"),
            Self::TrailingBytes(count) => write!(formatter, "desktop payload has {count} trailing bytes"),
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
    let length = u32::try_from(bytes.len())
        .map_err(|_| DesktopProtocolError::FieldTooLarge(bytes.len()))?;
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
        String::from_utf8(self.take(length)?.to_vec()).map_err(|_| DesktopProtocolError::InvalidUtf8)
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
    fn start_request_round_trip_preserves_headers() {
        let value = DesktopStartRequest {
            task_id: "desktop-1".into(),
            url: "https://example.test/file.bin".into(),
            destination: r"C:\Downloads\file.bin".into(),
            maximum_connections: 8,
            minimum_chunk_bytes: 1024 * 1024,
            checkpoint_bytes: 256 * 1024,
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
            file_path: r"C:\Downloads\file.bin".into(),
            error_code: String::new(),
            error_message: String::new(),
        };
        let encoded = encode_status_event(&value).expect("encode status");
        assert_eq!(decode_status_event(&encoded).expect("decode status"), value);
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

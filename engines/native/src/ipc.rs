use std::error::Error;
use std::fmt::{Display, Formatter};

pub const IPC_PROTOCOL_VERSION: u16 = 1;
pub const MAX_IPC_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_IPC_BUFFER_BYTES: usize = MAX_IPC_PAYLOAD_BYTES + 1024 * 1024;

const IPC_MAGIC: &[u8; 8] = b"SUBIPC01";
const LENGTH_PREFIX_BYTES: usize = 4;
const FIXED_BODY_BYTES: usize = 8 + 2 + 1 + 1 + 8 + 4 + 8;
const CHECKSUM_BYTES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum IpcMessageKind {
    Hello = 1,
    HelloAck = 2,
    ProbeRequest = 3,
    ProbeResult = 4,
    StartRequest = 5,
    PauseRequest = 6,
    ResumeRequest = 7,
    CancelRequest = 8,
    StatusRequest = 9,
    StatusEvent = 10,
    Error = 11,
    Shutdown = 12,
}

impl TryFrom<u8> for IpcMessageKind {
    type Error = IpcError;

    fn try_from(value: u8) -> Result<Self, IpcError> {
        match value {
            1 => Ok(Self::Hello),
            2 => Ok(Self::HelloAck),
            3 => Ok(Self::ProbeRequest),
            4 => Ok(Self::ProbeResult),
            5 => Ok(Self::StartRequest),
            6 => Ok(Self::PauseRequest),
            7 => Ok(Self::ResumeRequest),
            8 => Ok(Self::CancelRequest),
            9 => Ok(Self::StatusRequest),
            10 => Ok(Self::StatusEvent),
            11 => Ok(Self::Error),
            12 => Ok(Self::Shutdown),
            other => Err(IpcError::InvalidMessageKind(other)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IpcFrame {
    pub protocol_version: u16,
    pub request_id: u64,
    pub kind: IpcMessageKind,
    pub payload: Vec<u8>,
}

impl IpcFrame {
    pub fn new(request_id: u64, kind: IpcMessageKind, payload: Vec<u8>) -> Result<Self, IpcError> {
        if payload.len() > MAX_IPC_PAYLOAD_BYTES {
            return Err(IpcError::PayloadTooLarge(payload.len()));
        }

        Ok(Self {
            protocol_version: IPC_PROTOCOL_VERSION,
            request_id,
            kind,
            payload,
        })
    }

    pub fn encode(&self) -> Result<Vec<u8>, IpcError> {
        if self.protocol_version != IPC_PROTOCOL_VERSION {
            return Err(IpcError::UnsupportedVersion(self.protocol_version));
        }
        if self.payload.len() > MAX_IPC_PAYLOAD_BYTES {
            return Err(IpcError::PayloadTooLarge(self.payload.len()));
        }

        let body_length = FIXED_BODY_BYTES
            .checked_add(self.payload.len())
            .ok_or(IpcError::ArithmeticOverflow)?;
        let body_length_u32 =
            u32::try_from(body_length).map_err(|_| IpcError::FrameTooLarge(body_length))?;
        let total_length = LENGTH_PREFIX_BYTES
            .checked_add(body_length)
            .ok_or(IpcError::ArithmeticOverflow)?;

        let mut output = Vec::with_capacity(total_length);
        output.extend_from_slice(&body_length_u32.to_le_bytes());
        output.extend_from_slice(IPC_MAGIC);
        output.extend_from_slice(&self.protocol_version.to_le_bytes());
        output.push(self.kind as u8);
        output.push(0);
        output.extend_from_slice(&self.request_id.to_le_bytes());
        let payload_length = u32::try_from(self.payload.len())
            .map_err(|_| IpcError::PayloadTooLarge(self.payload.len()))?;
        output.extend_from_slice(&payload_length.to_le_bytes());
        output.extend_from_slice(&self.payload);

        let checksum = checksum64(&output[LENGTH_PREFIX_BYTES..]);
        output.extend_from_slice(&checksum.to_le_bytes());
        Ok(output)
    }
}

pub fn decode_frame(input: &[u8]) -> Result<IpcFrame, IpcError> {
    if input.len() < LENGTH_PREFIX_BYTES {
        return Err(IpcError::UnexpectedEnd);
    }

    let declared_body_length = u32::from_le_bytes(
        input[..LENGTH_PREFIX_BYTES]
            .try_into()
            .map_err(|_| IpcError::UnexpectedEnd)?,
    ) as usize;

    if declared_body_length < FIXED_BODY_BYTES {
        return Err(IpcError::InvalidBodyLength(declared_body_length));
    }
    if declared_body_length > MAX_IPC_BUFFER_BYTES {
        return Err(IpcError::FrameTooLarge(declared_body_length));
    }

    let expected_total_length = LENGTH_PREFIX_BYTES
        .checked_add(declared_body_length)
        .ok_or(IpcError::ArithmeticOverflow)?;
    if input.len() != expected_total_length {
        return Err(IpcError::LengthMismatch {
            declared: expected_total_length,
            actual: input.len(),
        });
    }

    let body = &input[LENGTH_PREFIX_BYTES..];
    let checksum_offset = body
        .len()
        .checked_sub(CHECKSUM_BYTES)
        .ok_or(IpcError::UnexpectedEnd)?;
    let (protected, checksum_bytes) = body.split_at(checksum_offset);
    let expected_checksum = u64::from_le_bytes(
        checksum_bytes
            .try_into()
            .map_err(|_| IpcError::UnexpectedEnd)?,
    );
    let actual_checksum = checksum64(protected);
    if expected_checksum != actual_checksum {
        return Err(IpcError::ChecksumMismatch {
            expected: expected_checksum,
            actual: actual_checksum,
        });
    }

    let mut cursor = Cursor::new(protected);
    if cursor.take(IPC_MAGIC.len())? != &IPC_MAGIC[..] {
        return Err(IpcError::InvalidMagic);
    }

    let protocol_version = cursor.read_u16()?;
    if protocol_version != IPC_PROTOCOL_VERSION {
        return Err(IpcError::UnsupportedVersion(protocol_version));
    }

    let kind = IpcMessageKind::try_from(cursor.read_u8()?)?;
    let flags = cursor.read_u8()?;
    if flags != 0 {
        return Err(IpcError::UnsupportedFlags(flags));
    }

    let request_id = cursor.read_u64()?;
    let payload_length = cursor.read_u32()? as usize;
    if payload_length > MAX_IPC_PAYLOAD_BYTES {
        return Err(IpcError::PayloadTooLarge(payload_length));
    }
    if cursor.remaining() != payload_length {
        return Err(IpcError::PayloadLengthMismatch {
            declared: payload_length,
            actual: cursor.remaining(),
        });
    }

    let payload = cursor.take(payload_length)?.to_vec();
    if !cursor.is_finished() {
        return Err(IpcError::TrailingBytes(cursor.remaining()));
    }

    Ok(IpcFrame {
        protocol_version,
        request_id,
        kind,
        payload,
    })
}

#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len()
    }

    pub fn push(&mut self, input: &[u8]) -> Result<Vec<IpcFrame>, IpcError> {
        let next_size = self
            .buffer
            .len()
            .checked_add(input.len())
            .ok_or(IpcError::ArithmeticOverflow)?;
        if next_size > MAX_IPC_BUFFER_BYTES {
            return Err(IpcError::BufferLimitExceeded(next_size));
        }
        self.buffer.extend_from_slice(input);

        let mut frames = Vec::new();
        loop {
            if self.buffer.len() < LENGTH_PREFIX_BYTES {
                break;
            }

            let body_length = u32::from_le_bytes(
                self.buffer[..LENGTH_PREFIX_BYTES]
                    .try_into()
                    .map_err(|_| IpcError::UnexpectedEnd)?,
            ) as usize;
            if body_length < FIXED_BODY_BYTES {
                return Err(IpcError::InvalidBodyLength(body_length));
            }
            if body_length > MAX_IPC_BUFFER_BYTES {
                return Err(IpcError::FrameTooLarge(body_length));
            }

            let frame_length = LENGTH_PREFIX_BYTES
                .checked_add(body_length)
                .ok_or(IpcError::ArithmeticOverflow)?;
            if self.buffer.len() < frame_length {
                break;
            }

            let frame_bytes = self.buffer.drain(..frame_length).collect::<Vec<_>>();
            frames.push(decode_frame(&frame_bytes)?);
        }

        Ok(frames)
    }

    pub fn finish(self) -> Result<(), IpcError> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err(IpcError::IncompleteStream(self.buffer.len()))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IpcError {
    UnexpectedEnd,
    InvalidMagic,
    UnsupportedVersion(u16),
    InvalidMessageKind(u8),
    UnsupportedFlags(u8),
    PayloadTooLarge(usize),
    FrameTooLarge(usize),
    BufferLimitExceeded(usize),
    InvalidBodyLength(usize),
    LengthMismatch { declared: usize, actual: usize },
    PayloadLengthMismatch { declared: usize, actual: usize },
    ChecksumMismatch { expected: u64, actual: u64 },
    TrailingBytes(usize),
    IncompleteStream(usize),
    ArithmeticOverflow,
}

impl Display for IpcError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnexpectedEnd => write!(formatter, "IPC frame ended unexpectedly"),
            Self::InvalidMagic => write!(formatter, "IPC frame magic is invalid"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported IPC protocol version {version}")
            }
            Self::InvalidMessageKind(kind) => write!(formatter, "invalid IPC message kind {kind}"),
            Self::UnsupportedFlags(flags) => write!(formatter, "unsupported IPC flags {flags}"),
            Self::PayloadTooLarge(size) => {
                write!(formatter, "IPC payload is too large: {size} bytes")
            }
            Self::FrameTooLarge(size) => write!(formatter, "IPC frame is too large: {size} bytes"),
            Self::BufferLimitExceeded(size) => {
                write!(formatter, "IPC decoder buffer limit exceeded: {size} bytes")
            }
            Self::InvalidBodyLength(size) => write!(formatter, "invalid IPC body length {size}"),
            Self::LengthMismatch { declared, actual } => write!(
                formatter,
                "IPC frame length mismatch: declared {declared}, actual {actual}"
            ),
            Self::PayloadLengthMismatch { declared, actual } => write!(
                formatter,
                "IPC payload length mismatch: declared {declared}, actual {actual}"
            ),
            Self::ChecksumMismatch { expected, actual } => write!(
                formatter,
                "IPC checksum mismatch: expected {expected:016x}, actual {actual:016x}"
            ),
            Self::TrailingBytes(count) => write!(formatter, "IPC frame has {count} trailing bytes"),
            Self::IncompleteStream(count) => {
                write!(formatter, "IPC stream ended with {count} buffered bytes")
            }
            Self::ArithmeticOverflow => write!(formatter, "IPC arithmetic overflowed"),
        }
    }
}

impl Error for IpcError {}

fn checksum64(input: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x00000100000001b3;

    input.iter().fold(OFFSET, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(PRIME)
    })
}

struct Cursor<'a> {
    input: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, offset: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], IpcError> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or(IpcError::ArithmeticOverflow)?;
        let value = self
            .input
            .get(self.offset..end)
            .ok_or(IpcError::UnexpectedEnd)?;
        self.offset = end;
        Ok(value)
    }

    fn read_u8(&mut self) -> Result<u8, IpcError> {
        self.take(1).map(|bytes| bytes[0])
    }

    fn read_u16(&mut self) -> Result<u16, IpcError> {
        let bytes: [u8; 2] = self
            .take(2)?
            .try_into()
            .map_err(|_| IpcError::UnexpectedEnd)?;
        Ok(u16::from_le_bytes(bytes))
    }

    fn read_u32(&mut self) -> Result<u32, IpcError> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| IpcError::UnexpectedEnd)?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn read_u64(&mut self) -> Result<u64, IpcError> {
        let bytes: [u8; 8] = self
            .take(8)?
            .try_into()
            .map_err(|_| IpcError::UnexpectedEnd)?;
        Ok(u64::from_le_bytes(bytes))
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

    fn frame(request_id: u64, kind: IpcMessageKind, payload: &[u8]) -> IpcFrame {
        IpcFrame::new(request_id, kind, payload.to_vec()).expect("frame")
    }

    #[test]
    fn frame_round_trip_preserves_header_and_payload() {
        let value = frame(
            42,
            IpcMessageKind::ProbeRequest,
            b"https://example.test/file",
        );
        let encoded = value.encode().expect("encode");
        assert_eq!(decode_frame(&encoded).expect("decode"), value);
    }

    #[test]
    fn streaming_decoder_handles_partial_pipe_reads() {
        let value = frame(7, IpcMessageKind::StatusEvent, b"progress=50");
        let encoded = value.encode().expect("encode");
        let mut decoder = FrameDecoder::new();
        let mut decoded = Vec::new();

        for chunk in encoded.chunks(3) {
            decoded.extend(decoder.push(chunk).expect("push"));
        }

        decoder.finish().expect("complete stream");
        assert_eq!(decoded, vec![value]);
    }

    #[test]
    fn streaming_decoder_extracts_multiple_frames() {
        let first = frame(1, IpcMessageKind::Hello, b"desktop");
        let second = frame(2, IpcMessageKind::HelloAck, b"engine");
        let mut bytes = first.encode().expect("first");
        bytes.extend_from_slice(&second.encode().expect("second"));

        let mut decoder = FrameDecoder::new();
        assert_eq!(decoder.push(&bytes).expect("decode"), vec![first, second]);
        decoder.finish().expect("complete stream");
    }

    #[test]
    fn payload_corruption_is_rejected() {
        let value = frame(99, IpcMessageKind::StartRequest, b"job=abc");
        let mut encoded = value.encode().expect("encode");
        let payload_index = LENGTH_PREFIX_BYTES + 8 + 2 + 1 + 1 + 8 + 4;
        encoded[payload_index] ^= 0x20;
        assert!(matches!(
            decode_frame(&encoded),
            Err(IpcError::ChecksumMismatch { .. })
        ));
    }

    #[test]
    fn oversized_payload_is_rejected_before_encoding() {
        let payload = vec![0_u8; MAX_IPC_PAYLOAD_BYTES + 1];
        assert_eq!(
            IpcFrame::new(1, IpcMessageKind::StartRequest, payload),
            Err(IpcError::PayloadTooLarge(MAX_IPC_PAYLOAD_BYTES + 1))
        );
    }

    #[test]
    fn incomplete_stream_is_not_silently_accepted() {
        let value = frame(1, IpcMessageKind::StatusRequest, b"");
        let encoded = value.encode().expect("encode");
        let mut decoder = FrameDecoder::new();
        assert!(decoder.push(&encoded[..5]).expect("partial").is_empty());
        assert_eq!(decoder.finish(), Err(IpcError::IncompleteStream(5)));
    }
}

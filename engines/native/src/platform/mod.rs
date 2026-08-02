#[cfg(not(windows))]
use std::path::Path;

#[cfg(not(windows))]
use crate::transfer::RequestHeader;
use crate::transfer::{HttpProbe, TransferError};
#[cfg(not(windows))]
use crate::TransportSettings;

#[cfg(windows)]
mod windows;

pub(crate) trait ResponseReader {
    fn metadata(&self) -> &HttpProbe;
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, TransferError>;
}

#[cfg(windows)]
pub(crate) use windows::{atomic_move, available_disk_space, open_response};

#[cfg(not(windows))]
pub(crate) struct UnsupportedResponse;

#[cfg(not(windows))]
impl ResponseReader for UnsupportedResponse {
    fn metadata(&self) -> &HttpProbe {
        unreachable!("unsupported platform response has no metadata")
    }

    fn read(&mut self, _buffer: &mut [u8]) -> Result<usize, TransferError> {
        Err(TransferError::UnsupportedPlatform)
    }
}

#[cfg(not(windows))]
pub(crate) fn open_response(
    _method: &str,
    _url: &str,
    _headers: &[RequestHeader],
    _settings: &TransportSettings,
) -> Result<UnsupportedResponse, TransferError> {
    Err(TransferError::UnsupportedPlatform)
}

#[cfg(not(windows))]
pub(crate) fn available_disk_space(_path: &Path) -> Result<u64, TransferError> {
    Err(TransferError::UnsupportedPlatform)
}

#[cfg(not(windows))]
pub(crate) fn atomic_move(_source: &Path, _destination: &Path) -> Result<(), TransferError> {
    Err(TransferError::UnsupportedPlatform)
}

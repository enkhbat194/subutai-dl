#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]

mod core;
mod platform;
mod sha256;
pub mod ipc;
pub mod transfer;

pub use core::*;
pub use transfer::{
    download_file, download_file_with_progress, partial_path, probe_url, DownloadRequest,
    DownloadResult, HttpProbe, RequestHeader, TransferError, TransferProgress,
};

#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]

mod core;
pub mod ipc;
mod platform;
mod sha256;
pub mod transfer;

pub use core::*;
pub use transfer::{
    DownloadRequest, DownloadResult, HttpProbe, RequestHeader, TransferError, TransferProgress,
    download_file, download_file_with_progress, partial_path, probe_url,
};

#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]

mod adaptive;
mod core;
pub mod ipc;
mod platform;
pub mod resumable;
mod sha256;
pub mod transfer;

pub use adaptive::AdaptivePolicy;
pub use core::*;
pub use resumable::{
    DownloadControl, SegmentedDownloadRequest, SegmentedOutcome, SegmentedProgress,
    download_segmented, download_segmented_with_progress, resume_journal_path,
};
pub use transfer::{
    DownloadRequest, DownloadResult, HttpProbe, RequestHeader, TransferError, TransferProgress,
    download_file, download_file_with_progress, partial_path, probe_url,
};

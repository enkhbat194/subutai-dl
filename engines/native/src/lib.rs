#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]

mod adaptive;
mod core;
pub mod desktop_protocol;
pub mod ipc;
mod platform;
pub mod resumable;
mod sha256;
pub mod transfer;
mod transport_settings;

pub use adaptive::AdaptivePolicy;
pub use core::*;
pub use desktop_protocol::{
    DESKTOP_PAYLOAD_SCHEMA_VERSION, DesktopProtocolError, DesktopStartRequest, DesktopStatusEvent,
    DesktopTaskState, decode_start_request, decode_status_event, encode_start_request,
    encode_status_event,
};
pub use resumable::{
    DownloadControl, SegmentedDownloadRequest, SegmentedOutcome, SegmentedProgress,
    download_segmented, download_segmented_with_progress, resume_journal_path,
};
pub use transfer::{
    DownloadRequest, DownloadResult, HttpProbe, RequestHeader, TransferError, TransferProgress,
    download_file, download_file_with_progress, partial_path, probe_url,
    probe_url_with_settings,
};
pub use transport_settings::{ProxyMode, TransportSettings};

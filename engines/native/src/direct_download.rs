use crate::resumable::{
    DownloadControl, SegmentedDownloadRequest, SegmentedOutcome, SegmentedProgress,
};
use crate::transfer::TransferError;

pub fn download_segmented(
    request: &SegmentedDownloadRequest,
    control: &DownloadControl,
) -> Result<SegmentedOutcome, TransferError> {
    download_segmented_with_progress(request, control, |_| {})
}

pub fn download_segmented_with_progress<F>(
    request: &SegmentedDownloadRequest,
    control: &DownloadControl,
    mut progress: F,
) -> Result<SegmentedOutcome, TransferError>
where
    F: FnMut(SegmentedProgress),
{
    match crate::resumable::download_segmented_with_progress(
        request,
        control,
        &mut progress,
    ) {
        Err(TransferError::ByteRangesUnsupported) => {
            crate::streaming_fallback::download_without_ranges(
                request,
                control,
                &mut progress,
            )
        }
        result => result,
    }
}

#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]

use std::io::{self, BufWriter, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::thread;

use subutai_native_engine::ipc::{
    IpcFrame, IpcMessageKind, MAX_IPC_BUFFER_BYTES, decode_frame,
};
use subutai_native_engine::{
    DesktopStartRequest, DesktopStatusEvent, DesktopTaskState, DownloadControl, ENGINE_NAME,
    ENGINE_VERSION, SegmentedDownloadRequest, SegmentedOutcome, decode_start_request,
    download_segmented_with_progress, encode_status_event,
};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Subutai desktop engine error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let start_frame = {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        read_frame(&mut input)?
    };
    if start_frame.kind != IpcMessageKind::StartRequest {
        return Err(format!(
            "expected StartRequest, received {:?}",
            start_frame.kind
        ));
    }
    let start = decode_start_request(&start_frame.payload).map_err(|error| error.to_string())?;
    let request_id = start_frame.request_id;
    let mut output = BufWriter::new(io::stdout());

    write_frame(
        &mut output,
        IpcFrame::new(
            request_id,
            IpcMessageKind::HelloAck,
            format!("{ENGINE_NAME} {ENGINE_VERSION}").into_bytes(),
        )
        .map_err(|error| error.to_string())?,
    )?;
    write_status(
        &mut output,
        request_id,
        &status_from_start(&start, DesktopTaskState::Waiting),
    )?;

    let control = DownloadControl::default();
    let command_control = control.clone();
    thread::spawn(move || command_loop(command_control));

    let mut request = SegmentedDownloadRequest::new(
        start.task_id.clone(),
        start.url.clone(),
        PathBuf::from(&start.destination),
    );
    request.requested_segments = start.maximum_connections.clamp(1, 32);
    request.minimum_segment_size = start.minimum_chunk_bytes;
    request.checkpoint_bytes = start.checkpoint_bytes;
    request.headers = start.headers;
    request.adaptive.minimum_connections = request
        .adaptive
        .minimum_connections
        .min(request.requested_segments as usize)
        .max(1);

    let progress_control = control.clone();
    let outcome = download_segmented_with_progress(&request, &control, |progress| {
        let event = DesktopStatusEvent {
            task_id: start.task_id.clone(),
            state: DesktopTaskState::Active,
            total_bytes: progress.total_bytes,
            completed_bytes: progress.downloaded_bytes,
            bytes_per_second: progress.bytes_per_second,
            active_connections: u32::try_from(progress.active_connections).unwrap_or(u32::MAX),
            file_path: start.destination.clone(),
            error_code: String::new(),
            error_message: String::new(),
        };
        if write_status(&mut output, request_id, &event).is_err() {
            progress_control.pause();
        }
    });

    match outcome {
        Ok(SegmentedOutcome::Completed(result)) => write_status(
            &mut output,
            request_id,
            &DesktopStatusEvent {
                task_id: start.task_id,
                state: DesktopTaskState::Complete,
                total_bytes: result.downloaded_bytes,
                completed_bytes: result.downloaded_bytes,
                bytes_per_second: 0,
                active_connections: 0,
                file_path: result.destination.to_string_lossy().into_owned(),
                error_code: String::new(),
                error_message: String::new(),
            },
        ),
        Ok(SegmentedOutcome::Paused {
            downloaded_bytes,
            total_bytes,
            ..
        }) => write_status(
            &mut output,
            request_id,
            &DesktopStatusEvent {
                task_id: start.task_id,
                state: DesktopTaskState::Paused,
                total_bytes,
                completed_bytes: downloaded_bytes,
                bytes_per_second: 0,
                active_connections: 0,
                file_path: start.destination,
                error_code: String::new(),
                error_message: String::new(),
            },
        ),
        Ok(SegmentedOutcome::Cancelled) => write_status(
            &mut output,
            request_id,
            &DesktopStatusEvent {
                task_id: start.task_id,
                state: DesktopTaskState::Removed,
                total_bytes: 0,
                completed_bytes: 0,
                bytes_per_second: 0,
                active_connections: 0,
                file_path: start.destination,
                error_code: String::new(),
                error_message: String::new(),
            },
        ),
        Err(error) => {
            let message = error.to_string();
            let event = DesktopStatusEvent {
                task_id: start.task_id,
                state: DesktopTaskState::Error,
                total_bytes: 0,
                completed_bytes: 0,
                bytes_per_second: 0,
                active_connections: 0,
                file_path: start.destination,
                error_code: "TRANSFER".into(),
                error_message: message.clone(),
            };
            write_status(&mut output, request_id, &event)?;
            Err(message)
        }
    }
}

fn status_from_start(start: &DesktopStartRequest, state: DesktopTaskState) -> DesktopStatusEvent {
    DesktopStatusEvent {
        task_id: start.task_id.clone(),
        state,
        total_bytes: 0,
        completed_bytes: 0,
        bytes_per_second: 0,
        active_connections: 0,
        file_path: start.destination.clone(),
        error_code: String::new(),
        error_message: String::new(),
    }
}

fn command_loop(control: DownloadControl) {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    loop {
        match read_frame(&mut input) {
            Ok(frame) => match frame.kind {
                IpcMessageKind::PauseRequest | IpcMessageKind::Shutdown => {
                    control.pause();
                    break;
                }
                IpcMessageKind::CancelRequest => {
                    control.cancel();
                    break;
                }
                IpcMessageKind::ResumeRequest | IpcMessageKind::StatusRequest => {}
                _ => {}
            },
            Err(_) => {
                control.pause();
                break;
            }
        }
    }
}

fn read_frame(input: &mut impl Read) -> Result<IpcFrame, String> {
    let mut prefix = [0_u8; 4];
    input
        .read_exact(&mut prefix)
        .map_err(|error| format!("failed to read IPC length: {error}"))?;
    let body_length = u32::from_le_bytes(prefix) as usize;
    if body_length > MAX_IPC_BUFFER_BYTES {
        return Err(format!("IPC frame is too large: {body_length}"));
    }
    let mut bytes = Vec::with_capacity(4 + body_length);
    bytes.extend_from_slice(&prefix);
    bytes.resize(4 + body_length, 0);
    input
        .read_exact(&mut bytes[4..])
        .map_err(|error| format!("failed to read IPC frame: {error}"))?;
    decode_frame(&bytes).map_err(|error| error.to_string())
}

fn write_status(
    output: &mut impl Write,
    request_id: u64,
    status: &DesktopStatusEvent,
) -> Result<(), String> {
    let payload = encode_status_event(status).map_err(|error| error.to_string())?;
    let frame = IpcFrame::new(request_id, IpcMessageKind::StatusEvent, payload)
        .map_err(|error| error.to_string())?;
    write_frame(output, frame)
}

fn write_frame(output: &mut impl Write, frame: IpcFrame) -> Result<(), String> {
    let encoded = frame.encode().map_err(|error| error.to_string())?;
    output
        .write_all(&encoded)
        .map_err(|error| format!("failed to write IPC frame: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("failed to flush IPC frame: {error}"))
}

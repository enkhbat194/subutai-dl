#![cfg(windows)]

use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use subutai_native_engine::ipc::{IpcFrame, IpcMessageKind, decode_frame};
use subutai_native_engine::{
    DesktopStartRequest, DesktopStatusEvent, DesktopTaskState, RequestHeader,
    decode_status_event, encode_start_request,
};

const HOST_PATH: &str = env!("CARGO_BIN_EXE_subutai-engine-host");
const TEST_HEADER_NAME: &str = "X-Subutai-Bridge-Test";
const TEST_HEADER_VALUE: &str = "desktop-host-secret";

struct RangeServer {
    base_url: String,
    stop: Arc<AtomicBool>,
    header_seen: Arc<AtomicBool>,
    accept_handle: Option<thread::JoinHandle<()>>,
    connection_handles: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
}

impl RangeServer {
    fn start(data: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind desktop host server");
        listener
            .set_nonblocking(true)
            .expect("set desktop host listener nonblocking");
        let address = listener.local_addr().expect("desktop host server address");
        let data = Arc::new(data);
        let stop = Arc::new(AtomicBool::new(false));
        let header_seen = Arc::new(AtomicBool::new(false));
        let connection_handles = Arc::new(Mutex::new(Vec::new()));

        let thread_data = Arc::clone(&data);
        let thread_stop = Arc::clone(&stop);
        let thread_header_seen = Arc::clone(&header_seen);
        let thread_handles = Arc::clone(&connection_handles);
        let accept_handle = thread::spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if stream.set_nonblocking(false).is_err() {
                            continue;
                        }
                        let connection_data = Arc::clone(&thread_data);
                        let connection_header_seen = Arc::clone(&thread_header_seen);
                        let handle = thread::spawn(move || {
                            if let Err(error) = handle_request(
                                &mut stream,
                                &connection_data,
                                &connection_header_seen,
                            ) && !is_expected_disconnect(&error)
                            {
                                eprintln!("desktop host test server error: {error}");
                            }
                        });
                        match thread_handles.lock() {
                            Ok(mut handles) => handles.push(handle),
                            Err(poisoned) => {
                                poisoned.into_inner().push(handle);
                                break;
                            }
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });

        Self {
            base_url: format!("http://{address}"),
            stop,
            header_seen,
            accept_handle: Some(accept_handle),
            connection_handles,
        }
    }

    fn url(&self) -> String {
        format!("{}/desktop-host.bin", self.base_url)
    }

    fn header_seen(&self) -> bool {
        self.header_seen.load(Ordering::Acquire)
    }
}

impl Drop for RangeServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.accept_handle.take() {
            let _ = handle.join();
        }
        let handles = match self.connection_handles.lock() {
            Ok(mut handles) => std::mem::take(&mut *handles),
            Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
        };
        for handle in handles {
            let _ = handle.join();
        }
    }
}

#[test]
fn desktop_host_forwards_headers_pauses_and_resumes_in_a_new_process() {
    let data = test_data(8 * 1024 * 1024 + 317);
    let server = RangeServer::start(data.clone());
    let destination = unique_path("pause-resume.bin");
    cleanup_download(&destination);
    let start = start_request("desktop-pause-resume", server.url(), &destination);

    let (mut first_child, mut first_input, first_events) = spawn_host(&start);
    wait_for_active_progress(&first_events, 256 * 1024);
    send_control(&mut first_input, 2, IpcMessageKind::PauseRequest);
    let paused = wait_for_state(&first_events, DesktopTaskState::Paused);
    assert!(paused.completed_bytes >= 256 * 1024);
    assert!(paused.completed_bytes < paused.total_bytes);
    drop(first_input);
    assert!(first_child.wait().expect("wait paused host").success());
    assert!(partial_path(&destination).exists());
    assert!(journal_slot_exists(&destination));

    let (mut resumed_child, resumed_input, resumed_events) = spawn_host(&start);
    let completed = wait_for_state(&resumed_events, DesktopTaskState::Complete);
    assert_eq!(completed.completed_bytes, data.len() as u64);
    drop(resumed_input);
    assert!(resumed_child.wait().expect("wait resumed host").success());
    assert_eq!(fs::read(&destination).expect("read resumed destination"), data);
    assert!(server.header_seen());
    assert!(!partial_path(&destination).exists());
    assert!(!journal_slot_exists(&destination));
    cleanup_download(&destination);
}

#[test]
fn desktop_host_cancel_removes_partial_and_resume_state() {
    let data = test_data(6 * 1024 * 1024 + 91);
    let server = RangeServer::start(data);
    let destination = unique_path("cancel.bin");
    cleanup_download(&destination);
    let start = start_request("desktop-cancel", server.url(), &destination);

    let (mut child, mut input, events) = spawn_host(&start);
    wait_for_active_progress(&events, 128 * 1024);
    send_control(&mut input, 3, IpcMessageKind::CancelRequest);
    wait_for_state(&events, DesktopTaskState::Removed);
    drop(input);
    assert!(child.wait().expect("wait cancelled host").success());
    assert!(!destination.exists());
    assert!(!partial_path(&destination).exists());
    assert!(!journal_slot_exists(&destination));
    cleanup_download(&destination);
}

fn start_request(task_id: &str, url: String, destination: &Path) -> DesktopStartRequest {
    DesktopStartRequest {
        task_id: task_id.into(),
        url,
        destination: destination.to_string_lossy().into_owned(),
        maximum_connections: 4,
        minimum_chunk_bytes: 256 * 1024,
        checkpoint_bytes: 64 * 1024,
        headers: vec![RequestHeader::new(TEST_HEADER_NAME, TEST_HEADER_VALUE).unwrap()],
    }
}

fn spawn_host(start: &DesktopStartRequest) -> (Child, ChildStdin, Receiver<IpcFrame>) {
    let mut child = Command::new(HOST_PATH)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn Subutai desktop host");
    let mut input = child.stdin.take().expect("desktop host stdin");
    let mut output = child.stdout.take().expect("desktop host stdout");
    let payload = encode_start_request(start).expect("encode desktop start request");
    let frame = IpcFrame::new(1, IpcMessageKind::StartRequest, payload)
        .expect("build desktop start frame");
    input
        .write_all(&frame.encode().expect("encode desktop start frame"))
        .expect("write desktop start frame");
    input.flush().expect("flush desktop start frame");

    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        while let Ok(frame) = read_frame(&mut output) {
            if sender.send(frame).is_err() {
                break;
            }
        }
    });
    (child, input, receiver)
}

fn send_control(input: &mut ChildStdin, request_id: u64, kind: IpcMessageKind) {
    let frame = IpcFrame::new(request_id, kind, Vec::new()).expect("build desktop control frame");
    input
        .write_all(&frame.encode().expect("encode desktop control frame"))
        .expect("write desktop control frame");
    input.flush().expect("flush desktop control frame");
}

fn wait_for_active_progress(events: &Receiver<IpcFrame>, minimum_bytes: u64) -> DesktopStatusEvent {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        assert!(std::time::Instant::now() < deadline, "desktop host active progress timed out");
        let frame = events
            .recv_timeout(Duration::from_millis(500))
            .expect("receive desktop host frame");
        if frame.kind != IpcMessageKind::StatusEvent {
            continue;
        }
        let status = decode_status_event(&frame.payload).expect("decode desktop status");
        if status.state == DesktopTaskState::Error {
            panic!("desktop host error: {}", status.error_message);
        }
        if status.state == DesktopTaskState::Active && status.completed_bytes >= minimum_bytes {
            return status;
        }
    }
}

fn wait_for_state(events: &Receiver<IpcFrame>, expected: DesktopTaskState) -> DesktopStatusEvent {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        assert!(std::time::Instant::now() < deadline, "desktop host state {expected:?} timed out");
        let frame = events
            .recv_timeout(Duration::from_millis(500))
            .expect("receive desktop host frame");
        if frame.kind != IpcMessageKind::StatusEvent {
            continue;
        }
        let status = decode_status_event(&frame.payload).expect("decode desktop status");
        if status.state == DesktopTaskState::Error {
            panic!("desktop host error: {}", status.error_message);
        }
        if status.state == expected {
            return status;
        }
    }
}

fn read_frame(input: &mut impl Read) -> Result<IpcFrame, String> {
    let mut prefix = [0_u8; 4];
    input
        .read_exact(&mut prefix)
        .map_err(|error| error.to_string())?;
    let body_length = u32::from_le_bytes(prefix) as usize;
    let mut encoded = Vec::with_capacity(body_length + 4);
    encoded.extend_from_slice(&prefix);
    encoded.resize(body_length + 4, 0);
    input
        .read_exact(&mut encoded[4..])
        .map_err(|error| error.to_string())?;
    decode_frame(&encoded).map_err(|error| error.to_string())
}

fn handle_request(
    stream: &mut TcpStream,
    data: &[u8],
    header_seen: &AtomicBool,
) -> io::Result<()> {
    let request = read_request(stream)?;
    let mut lines = request.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request line"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing method"))?;
    let path = request_parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing path"))?;
    if path != "/desktop-host.bin" {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "unexpected path"));
    }
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect::<Vec<_>>();
    let header = |name: &str| {
        headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    if header(&TEST_HEADER_NAME.to_ascii_lowercase()) == Some(TEST_HEADER_VALUE) {
        header_seen.store(true, Ordering::Release);
    }
    let common = [
        ("Accept-Ranges", "bytes".to_string()),
        ("ETag", "\"subutai-n4-v1\"".to_string()),
        ("Last-Modified", "Sun, 02 Aug 2026 12:00:00 GMT".to_string()),
        ("Connection", "close".to_string()),
    ];

    if method == "HEAD" {
        let mut response_headers = common.to_vec();
        response_headers.push(("Content-Length", data.len().to_string()));
        return write_response(stream, "200 OK", &response_headers, &[], false);
    }
    if method != "GET" {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "unexpected method"));
    }
    let range = header("range")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing range"))?;
    let (start, end) = parse_range(range, data.len())?;
    let body = &data[start..=end];
    let mut response_headers = common.to_vec();
    response_headers.push(("Content-Length", body.len().to_string()));
    response_headers.push((
        "Content-Range",
        format!("bytes {start}-{end}/{}", data.len()),
    ));
    write_response(
        stream,
        "206 Partial Content",
        &response_headers,
        body,
        body.len() > 1,
    )
}

fn parse_range(value: &str, total: usize) -> io::Result<(usize, usize)> {
    let bounds = value
        .strip_prefix("bytes=")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid range prefix"))?;
    let (start, end) = bounds
        .split_once('-')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid range bounds"))?;
    let start = start
        .parse::<usize>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid range start"))?;
    let end = end
        .parse::<usize>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid range end"))?;
    if start > end || end >= total {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "range outside file"));
    }
    Ok((start, end))
}

fn read_request(stream: &mut TcpStream) -> io::Result<String> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "request ended early"));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if bytes.len() >= 64 * 1024 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request too large"));
        }
    }
    String::from_utf8(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "request is not UTF-8"))
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    headers: &[(&str, String)],
    body: &[u8],
    slow: bool,
) -> io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\n")?;
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(stream, "\r\n")?;
    for chunk in body.chunks(16 * 1024) {
        stream.write_all(chunk)?;
        stream.flush()?;
        if slow {
            thread::sleep(Duration::from_millis(4));
        }
    }
    Ok(())
}

fn is_expected_disconnect(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::UnexpectedEof
    )
}

fn test_data(length: usize) -> Vec<u8> {
    (0..length)
        .map(|index| ((index * 67 + 41) % 251) as u8)
        .collect()
}

fn unique_path(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!("subutai-n4-{}-{nonce}-{name}", std::process::id()))
}

fn partial_path(destination: &Path) -> PathBuf {
    PathBuf::from(format!("{}.subutai.part", destination.to_string_lossy()))
}

fn journal_slot_exists(destination: &Path) -> bool {
    let base = format!("{}.subutai.job", destination.to_string_lossy());
    Path::new(&format!("{base}.a")).exists() || Path::new(&format!("{base}.b")).exists()
}

fn cleanup_download(destination: &Path) {
    let base = destination.to_string_lossy();
    for path in [
        destination.to_path_buf(),
        PathBuf::from(format!("{base}.subutai.part")),
        PathBuf::from(format!("{base}.subutai.job")),
        PathBuf::from(format!("{base}.subutai.job.a")),
        PathBuf::from(format!("{base}.subutai.job.b")),
    ] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => panic!("cleanup {} failed: {error}", path.display()),
        }
    }
}

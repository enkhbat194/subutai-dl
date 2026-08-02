#![cfg(windows)]

use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use subutai_native_engine::ipc::{IpcFrame, IpcMessageKind, decode_frame};
use subutai_native_engine::{
    DesktopStartRequest, DesktopStatusEvent, DesktopTaskState, ProxyMode, TransportSettings,
    decode_status_event, encode_start_request,
};

const HOST_PATH: &str = env!("CARGO_BIN_EXE_subutai-engine-host");

struct ProxyServer {
    endpoint: String,
    stop: Arc<AtomicBool>,
    request_seen: Arc<AtomicBool>,
    accept_handle: Option<thread::JoinHandle<()>>,
    connection_handles: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
}

impl ProxyServer {
    fn start(data: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind proxy server");
        listener.set_nonblocking(true).expect("set proxy nonblocking");
        let address = listener.local_addr().expect("proxy address");
        let data = Arc::new(data);
        let stop = Arc::new(AtomicBool::new(false));
        let request_seen = Arc::new(AtomicBool::new(false));
        let connection_handles = Arc::new(Mutex::new(Vec::new()));

        let accept_data = Arc::clone(&data);
        let accept_stop = Arc::clone(&stop);
        let accept_seen = Arc::clone(&request_seen);
        let accept_connections = Arc::clone(&connection_handles);
        let accept_handle = thread::spawn(move || {
            while !accept_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let connection_data = Arc::clone(&accept_data);
                        let connection_seen = Arc::clone(&accept_seen);
                        let handle = thread::spawn(move || {
                            if let Err(error) = handle_proxy_request(stream, &connection_data) {
                                if !matches!(
                                    error.kind(),
                                    io::ErrorKind::ConnectionReset
                                        | io::ErrorKind::BrokenPipe
                                        | io::ErrorKind::UnexpectedEof
                                ) {
                                    eprintln!("proxy acceptance server error: {error}");
                                }
                            } else {
                                connection_seen.store(true, Ordering::Release);
                            }
                        });
                        match accept_connections.lock() {
                            Ok(mut handles) => handles.push(handle),
                            Err(poisoned) => poisoned.into_inner().push(handle),
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
            endpoint: format!("http://{address}"),
            stop,
            request_seen,
            accept_handle: Some(accept_handle),
            connection_handles,
        }
    }
}

impl Drop for ProxyServer {
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
fn desktop_host_routes_through_manual_proxy_and_applies_shared_speed_limit() {
    let data = test_data(1024 * 1024 + 37);
    let proxy = ProxyServer::start(data.clone());
    let destination = unique_path("proxy-speed.bin");
    cleanup_download(&destination);

    let start = DesktopStartRequest {
        task_id: "desktop-proxy-speed".into(),
        url: "http://example.invalid/native-proxy.bin".into(),
        destination: destination.to_string_lossy().into_owned(),
        maximum_connections: 1,
        minimum_chunk_bytes: 256 * 1024,
        checkpoint_bytes: 64 * 1024,
        transport: TransportSettings {
            proxy_mode: ProxyMode::Manual,
            proxy_url: proxy.endpoint.clone(),
            proxy_username: String::new(),
            proxy_password: String::new(),
            speed_limit_bytes_per_second: 512 * 1024,
            retry_max_attempts: 4,
            retry_base_delay: Duration::from_millis(50),
            connect_timeout: Duration::from_secs(5),
            transfer_timeout: Duration::from_secs(5),
        },
        headers: Vec::new(),
    };

    let started = Instant::now();
    let (mut child, input, events) = spawn_host(&start);
    let completed = wait_for_state(&events, DesktopTaskState::Complete);
    let elapsed = started.elapsed();
    drop(input);
    assert!(child.wait().expect("wait proxy host").success());

    assert_eq!(completed.completed_bytes, data.len() as u64);
    assert_eq!(fs::read(&destination).expect("read destination"), data);
    assert!(proxy.request_seen.load(Ordering::Acquire));
    assert!(
        elapsed >= Duration::from_millis(900),
        "shared rate limiter completed too quickly: {elapsed:?}"
    );
    cleanup_download(&destination);
}

fn spawn_host(start: &DesktopStartRequest) -> (Child, ChildStdin, Receiver<IpcFrame>) {
    let mut child = Command::new(HOST_PATH)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn desktop host");
    let mut input = child.stdin.take().expect("desktop host stdin");
    let mut output = child.stdout.take().expect("desktop host stdout");
    let payload = encode_start_request(start).expect("encode start request");
    let frame = IpcFrame::new(1, IpcMessageKind::StartRequest, payload).expect("build frame");
    input
        .write_all(&frame.encode().expect("encode frame"))
        .expect("write frame");
    input.flush().expect("flush frame");

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

fn wait_for_state(events: &Receiver<IpcFrame>, expected: DesktopTaskState) -> DesktopStatusEvent {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < deadline, "desktop host state timed out");
        let frame = match events.recv_timeout(Duration::from_millis(500)) {
            Ok(frame) => frame,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => panic!("desktop event stream disconnected"),
        };
        if frame.kind != IpcMessageKind::StatusEvent {
            continue;
        }
        let status = decode_status_event(&frame.payload).expect("decode status");
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
    input.read_exact(&mut prefix).map_err(|error| error.to_string())?;
    let body_length = u32::from_le_bytes(prefix) as usize;
    let mut encoded = Vec::with_capacity(body_length + 4);
    encoded.extend_from_slice(&prefix);
    encoded.resize(body_length + 4, 0);
    input
        .read_exact(&mut encoded[4..])
        .map_err(|error| error.to_string())?;
    decode_frame(&encoded).map_err(|error| error.to_string())
}

fn handle_proxy_request(mut stream: TcpStream, data: &[u8]) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(8)))?;
    let request = read_request(&mut stream)?;
    let mut lines = request.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request line"))?;
    let method = request_line
        .split_whitespace()
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing method"))?;
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

    let mut response_headers = vec![
        ("Accept-Ranges", "bytes".into()),
        ("ETag", "\"subutai-n5-proxy\"".into()),
        ("Last-Modified", "Sun, 02 Aug 2026 13:00:00 GMT".into()),
        ("Connection", "close".into()),
    ];
    if method == "HEAD" {
        response_headers.push(("Content-Length", data.len().to_string()));
        return write_response(&mut stream, "200 OK", &response_headers, &[]);
    }
    if method != "GET" {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "unexpected method"));
    }
    let range = header("range")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing range"))?;
    let (start, end) = parse_range(range, data.len())?;
    let body = &data[start..=end];
    response_headers.push(("Content-Length", body.len().to_string()));
    response_headers.push((
        "Content-Range",
        format!("bytes {start}-{end}/{}", data.len()),
    ));
    write_response(&mut stream, "206 Partial Content", &response_headers, body)
}

fn read_request(stream: &mut TcpStream) -> io::Result<String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "request ended"));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            return String::from_utf8(bytes)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "request encoding"));
        }
        if bytes.len() > 64 * 1024 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request too large"));
        }
    }
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\n")?;
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(stream, "\r\n")?;
    stream.write_all(body)?;
    stream.flush()
}

fn parse_range(value: &str, total: usize) -> io::Result<(usize, usize)> {
    let bounds = value
        .strip_prefix("bytes=")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid range"))?;
    let (start, end) = bounds
        .split_once('-')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid bounds"))?;
    let start = start
        .parse::<usize>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid start"))?;
    let end = end
        .parse::<usize>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid end"))?;
    if start > end || end >= total {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "range outside file"));
    }
    Ok((start, end))
}

fn test_data(length: usize) -> Vec<u8> {
    (0..length)
        .map(|index| ((index.wrapping_mul(29).wrapping_add(17)) % 251) as u8)
        .collect()
}

fn unique_path(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    std::env::temp_dir().join(format!("subutai-n5-{nonce}-{name}"))
}

fn cleanup_download(destination: &Path) {
    for path in [
        destination.to_path_buf(),
        PathBuf::from(format!("{}.subutai.part", destination.display())),
        PathBuf::from(format!("{}.subutai.job", destination.display())),
        PathBuf::from(format!("{}.subutai.job.a", destination.display())),
        PathBuf::from(format!("{}.subutai.job.b", destination.display())),
    ] {
        let _ = fs::remove_file(path);
    }
}

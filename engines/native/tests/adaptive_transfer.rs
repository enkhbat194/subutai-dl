#![cfg(windows)]

use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use subutai_native_engine::{
    DownloadControl, SegmentedDownloadRequest, SegmentedOutcome, download_segmented_with_progress,
};

struct AdaptiveServer {
    base_url: String,
    stop: Arc<AtomicBool>,
    accept_handle: Option<thread::JoinHandle<()>>,
    connection_handles: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
    maximum_active: Arc<AtomicUsize>,
}

impl AdaptiveServer {
    fn start(data: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind adaptive server");
        listener
            .set_nonblocking(true)
            .expect("set adaptive listener nonblocking");
        let address = listener.local_addr().expect("adaptive server address");
        let data = Arc::new(data);
        let stop = Arc::new(AtomicBool::new(false));
        let slow_served = Arc::new(AtomicBool::new(false));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum_active = Arc::new(AtomicUsize::new(0));
        let connection_handles = Arc::new(Mutex::new(Vec::new()));

        let thread_data = Arc::clone(&data);
        let thread_stop = Arc::clone(&stop);
        let thread_slow_served = Arc::clone(&slow_served);
        let thread_active = Arc::clone(&active);
        let thread_maximum = Arc::clone(&maximum_active);
        let thread_handles = Arc::clone(&connection_handles);
        let accept_handle = thread::spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if stream.set_nonblocking(false).is_err() {
                            continue;
                        }
                        let connection_data = Arc::clone(&thread_data);
                        let connection_slow_served = Arc::clone(&thread_slow_served);
                        let connection_active = Arc::clone(&thread_active);
                        let connection_maximum = Arc::clone(&thread_maximum);
                        let handle = thread::spawn(move || {
                            let current = connection_active.fetch_add(1, Ordering::AcqRel) + 1;
                            connection_maximum.fetch_max(current, Ordering::AcqRel);
                            let result = handle_request(
                                &mut stream,
                                &connection_data,
                                &connection_slow_served,
                            );
                            connection_active.fetch_sub(1, Ordering::AcqRel);
                            if let Err(error) = result
                                && !is_expected_disconnect(&error)
                            {
                                eprintln!("adaptive test server connection error: {error}");
                            }
                        });
                        match thread_handles.lock() {
                            Ok(mut handles) => handles.push(handle),
                            Err(_) => {
                                let _ = handle.join();
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
            accept_handle: Some(accept_handle),
            connection_handles,
            maximum_active,
        }
    }

    fn url(&self) -> String {
        format!("{}/adaptive.bin", self.base_url)
    }

    fn maximum_active(&self) -> usize {
        self.maximum_active.load(Ordering::Acquire)
    }
}

impl Drop for AdaptiveServer {
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
fn replaces_a_slow_range_and_scales_connections() {
    let data = test_data(6 * 1024 * 1024 + 123);
    let server = AdaptiveServer::start(data.clone());
    let destination = unique_path("adaptive-complete.bin");
    let mut request = SegmentedDownloadRequest::new("n3-adaptive", server.url(), &destination);
    request.requested_segments = 4;
    request.minimum_segment_size = 128 * 1024;
    request.checkpoint_bytes = 32 * 1024;
    request.adaptive.minimum_connections = 1;
    request.adaptive.target_chunk_bytes = 256 * 1024;
    request.adaptive.chunks_per_connection = 8;
    request.adaptive.slow_window = Duration::from_millis(100);
    request.adaptive.slow_bytes_per_second = 1024 * 1024;
    request.adaptive.max_replacements = 4;
    request.adaptive.retry_backoff = Duration::from_millis(5);

    let control = DownloadControl::default();
    let mut observed_peak = 0_usize;
    let mut observed_limit = 0_usize;
    let mut observed_replacements = 0_u64;
    let mut observed_chunks = 0_usize;
    let outcome = download_segmented_with_progress(&request, &control, |progress| {
        observed_peak = observed_peak.max(progress.peak_connections);
        observed_limit = observed_limit.max(progress.connection_limit);
        observed_replacements = observed_replacements.max(progress.replacement_count);
        observed_chunks = observed_chunks.max(progress.total_segments);
    })
    .expect("adaptive segmented transfer");

    let result = match outcome {
        SegmentedOutcome::Completed(result) => result,
        other => panic!("expected completed adaptive transfer, got {other:?}"),
    };
    assert_eq!(result.downloaded_bytes, data.len() as u64);
    assert_eq!(fs::read(&destination).expect("read adaptive result"), data);
    assert!(observed_chunks > request.requested_segments as usize);
    assert!(observed_replacements >= 1);
    assert!(observed_limit >= 2);
    assert!(observed_peak >= 2);
    assert!(server.maximum_active() >= 2);
    cleanup(&destination);
}

fn handle_request(stream: &mut TcpStream, data: &[u8], slow_served: &AtomicBool) -> io::Result<()> {
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
    if path != "/adaptive.bin" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unexpected path",
        ));
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
    let common = [
        ("Accept-Ranges", "bytes".to_string()),
        ("ETag", "\"subutai-n3-v1\"".to_string()),
        ("Last-Modified", "Sun, 02 Aug 2026 11:00:00 GMT".to_string()),
        ("Connection", "close".to_string()),
    ];

    if method == "HEAD" {
        let mut response_headers = common.to_vec();
        response_headers.push(("Content-Length", data.len().to_string()));
        return write_response(stream, "200 OK", &response_headers, &[], false);
    }
    if method != "GET" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unexpected method",
        ));
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
    let slow = end > start && !slow_served.swap(true, Ordering::AcqRel);
    write_response(stream, "206 Partial Content", &response_headers, body, slow)
}

fn parse_range(value: &str, total: usize) -> io::Result<(usize, usize)> {
    let value = value
        .strip_prefix("bytes=")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid range prefix"))?;
    let (start, end) = value
        .split_once('-')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid range bounds"))?;
    let start = start
        .parse::<usize>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid range start"))?;
    let end = end
        .parse::<usize>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid range end"))?;
    if start > end || end >= total {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "range outside file",
        ));
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
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "request headers ended early",
            ));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if bytes.len() >= 64 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request headers are too large",
            ));
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
            thread::sleep(Duration::from_millis(35));
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
        .map(|index| ((index * 43 + 29) % 251) as u8)
        .collect()
}

fn unique_path(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!("subutai-n3-{}-{nonce}-{name}", std::process::id()))
}

fn cleanup(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => panic!("cleanup {} failed: {error}", path.display()),
    }
}

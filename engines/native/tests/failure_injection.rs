#![cfg(all(windows, feature = "failure-injection"))]

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use subutai_native_engine::{
    DownloadControl, FailureInjection, SegmentedDownloadRequest, SegmentedOutcome, TransferError,
    download_segmented, partial_path, resume_journal_path,
};

struct RangeServer {
    url: String,
    stop: Arc<AtomicBool>,
    accept_handle: Option<thread::JoinHandle<()>>,
    connection_handles: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
}

impl RangeServer {
    fn start(data: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind range server");
        listener.set_nonblocking(true).expect("set nonblocking");
        let address = listener.local_addr().expect("server address");
        let data = Arc::new(data);
        let stop = Arc::new(AtomicBool::new(false));
        let connection_handles = Arc::new(Mutex::new(Vec::new()));

        let accept_data = Arc::clone(&data);
        let accept_stop = Arc::clone(&stop);
        let accept_connections = Arc::clone(&connection_handles);
        let accept_handle = thread::spawn(move || {
            while !accept_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let connection_data = Arc::clone(&accept_data);
                        let handle = thread::spawn(move || {
                            let _ = handle_request(stream, &connection_data);
                        });
                        match accept_connections.lock() {
                            Ok(mut handles) => handles.push(handle),
                            Err(poisoned) => poisoned.into_inner().push(handle),
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });

        Self {
            url: format!("http://{address}/file.bin"),
            stop,
            accept_handle: Some(accept_handle),
            connection_handles,
        }
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
fn insufficient_space_fails_before_partial_or_journal_creation() {
    let data = test_data(512 * 1024 + 19);
    let server = RangeServer::start(data);
    let directory = unique_directory("space");
    fs::create_dir_all(&directory).expect("create test directory");
    let destination = directory.join("space.bin");
    let injection = FailureInjection::default();
    injection.set_available_disk_space(0);
    let request = request_with_injection("space", &server.url, &destination, injection);

    let error = download_segmented(&request, &DownloadControl::default())
        .expect_err("insufficient space must fail");
    assert!(matches!(error, TransferError::InsufficientDiskSpace { .. }));
    assert!(!partial_path(&destination).exists());
    assert!(
        journal_slots(&destination)
            .iter()
            .all(|path| !path.exists())
    );
    fs::remove_dir_all(directory).expect("cleanup space test");
}

#[test]
fn write_failure_is_not_retried_and_saved_state_resumes() {
    let data = test_data(512 * 1024 + 37);
    let server = RangeServer::start(data.clone());
    let directory = unique_directory("write");
    fs::create_dir_all(&directory).expect("create test directory");
    let destination = directory.join("write.bin");
    let injection = FailureInjection::default();
    injection.fail_writes_after(128 * 1024);
    let request = request_with_injection("write", &server.url, &destination, injection.clone());

    let error = download_segmented(&request, &DownloadControl::default())
        .expect_err("injected write must fail");
    assert!(error.to_string().contains("injected partial file write"));
    assert_eq!(
        injection.write_failures(),
        1,
        "local write error was retried"
    );
    assert!(partial_path(&destination).exists());
    assert!(journal_slots(&destination).iter().any(|path| path.exists()));

    let recovery = request_without_failure("write", &server.url, &destination);
    let outcome = download_segmented(&recovery, &DownloadControl::default())
        .expect("resume after write failure");
    assert_completed(outcome, &destination, &data);
    assert_clean_state(&destination);
    fs::remove_dir_all(directory).expect("cleanup write test");
}

#[test]
fn sync_failure_preserves_complete_partial_for_recovery() {
    let data = test_data(384 * 1024 + 11);
    let server = RangeServer::start(data.clone());
    let directory = unique_directory("sync");
    fs::create_dir_all(&directory).expect("create test directory");
    let destination = directory.join("sync.bin");
    let injection = FailureInjection::default();
    injection.fail_next_sync();
    let request = request_with_injection("sync", &server.url, &destination, injection.clone());

    let error = download_segmented(&request, &DownloadControl::default())
        .expect_err("injected sync must fail");
    assert!(error.to_string().contains("injected partial file sync"));
    assert_eq!(injection.sync_failures(), 1);
    assert!(partial_path(&destination).exists());
    assert!(journal_slots(&destination).iter().any(|path| path.exists()));

    let recovery = request_without_failure("sync", &server.url, &destination);
    let outcome = download_segmented(&recovery, &DownloadControl::default())
        .expect("recover after sync failure");
    assert_completed(outcome, &destination, &data);
    assert_clean_state(&destination);
    fs::remove_dir_all(directory).expect("cleanup sync test");
}

#[test]
fn atomic_move_failure_preserves_verifiable_partial_for_recovery() {
    let data = test_data(448 * 1024 + 7);
    let server = RangeServer::start(data.clone());
    let directory = unique_directory("move");
    fs::create_dir_all(&directory).expect("create test directory");
    let destination = directory.join("move.bin");
    let injection = FailureInjection::default();
    injection.fail_atomic_move();
    let request = request_with_injection("move", &server.url, &destination, injection.clone());

    let error = download_segmented(&request, &DownloadControl::default())
        .expect_err("injected atomic move must fail");
    assert!(
        error
            .to_string()
            .contains("injected atomic destination move")
    );
    assert_eq!(injection.atomic_move_failures(), 1);
    assert!(!destination.exists());
    assert_eq!(
        fs::read(partial_path(&destination)).expect("read complete partial"),
        data
    );
    assert!(journal_slots(&destination).iter().any(|path| path.exists()));

    let recovery = request_without_failure("move", &server.url, &destination);
    let outcome = download_segmented(&recovery, &DownloadControl::default())
        .expect("recover atomic destination move");
    assert_completed(outcome, &destination, &data);
    assert_clean_state(&destination);
    fs::remove_dir_all(directory).expect("cleanup move test");
}

fn request_with_injection(
    job_id: &str,
    url: &str,
    destination: &Path,
    failure_injection: FailureInjection,
) -> SegmentedDownloadRequest {
    let mut request = request_without_failure(job_id, url, destination);
    request.failure_injection = failure_injection;
    request
}

fn request_without_failure(
    job_id: &str,
    url: &str,
    destination: &Path,
) -> SegmentedDownloadRequest {
    let mut request = SegmentedDownloadRequest::new(job_id, url, destination);
    request.requested_segments = 1;
    request.minimum_segment_size = 2 * 1024 * 1024;
    request.checkpoint_bytes = 64 * 1024;
    request.transport.retry_max_attempts = 4;
    request.transport.retry_base_delay = Duration::from_millis(5);
    request
}

fn assert_completed(outcome: SegmentedOutcome, destination: &Path, expected: &[u8]) {
    match outcome {
        SegmentedOutcome::Completed(result) => {
            assert_eq!(result.downloaded_bytes, expected.len() as u64);
            assert_eq!(
                fs::read(destination).expect("read completed file"),
                expected
            );
        }
        other => panic!("expected completed download, received {other:?}"),
    }
}

fn assert_clean_state(destination: &Path) {
    assert!(!partial_path(destination).exists());
    assert!(journal_slots(destination).iter().all(|path| !path.exists()));
}

fn handle_request(mut stream: TcpStream, data: &[u8]) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let request = read_request(&mut stream)?;
    let mut lines = request.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "request line"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "method"))?;
    let path = parts
        .next()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "path"))?;
    if path != "/file.bin" {
        return write_response(&mut stream, "404 Not Found", &[], &[]);
    }

    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect::<Vec<_>>();
    let range = headers
        .iter()
        .find(|(name, _)| name == "range")
        .map(|(_, value)| value.as_str());

    if method == "HEAD" {
        return write_response(
            &mut stream,
            "200 OK",
            &[
                ("Content-Length", data.len().to_string()),
                ("Accept-Ranges", "bytes".into()),
                ("ETag", "\"subutai-failure-matrix\"".into()),
                ("Last-Modified", "Sun, 02 Aug 2026 16:00:00 GMT".into()),
            ],
            &[],
        );
    }
    if method != "GET" {
        return write_response(&mut stream, "405 Method Not Allowed", &[], &[]);
    }

    let range = range.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "range header required")
    })?;
    let (start, end) = parse_range(range, data.len())?;
    let body = &data[start..=end];
    write_response(
        &mut stream,
        "206 Partial Content",
        &[
            ("Content-Length", body.len().to_string()),
            ("Accept-Ranges", "bytes".into()),
            (
                "Content-Range",
                format!("bytes {start}-{end}/{}", data.len()),
            ),
            ("ETag", "\"subutai-failure-matrix\"".into()),
            ("Last-Modified", "Sun, 02 Aug 2026 16:00:00 GMT".into()),
        ],
        body,
    )
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "request ended before headers",
            ));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            return String::from_utf8(bytes)
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "UTF-8"));
        }
        if bytes.len() > 64 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request too large",
            ));
        }
    }
}

fn parse_range(value: &str, total: usize) -> std::io::Result<(usize, usize)> {
    let bounds = value
        .strip_prefix("bytes=")
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "range prefix"))?;
    let (start, end) = bounds
        .split_once('-')
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "range bounds"))?;
    let start = start
        .parse::<usize>()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "range start"))?;
    let end = end
        .parse::<usize>()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "range end"))?;
    if start > end || end >= total {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "range outside file",
        ));
    }
    Ok((start, end))
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> std::io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\n")?;
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(stream, "Connection: close\r\n\r\n")?;
    match stream.write_all(body) {
        Ok(()) => stream.flush(),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn journal_slots(destination: &Path) -> [PathBuf; 2] {
    let journal = resume_journal_path(destination);
    [append_suffix(&journal, ".a"), append_suffix(&journal, ".b")]
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn test_data(length: usize) -> Vec<u8> {
    (0..length)
        .map(|index| ((index.wrapping_mul(41).wrapping_add(23)) % 251) as u8)
        .collect()
}

fn unique_directory(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "subutai-failure-{label}-{}-{nonce}",
        std::process::id()
    ))
}

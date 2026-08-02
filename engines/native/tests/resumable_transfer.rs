#![cfg(windows)]

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use subutai_native_engine::{
    DownloadControl, SegmentedDownloadRequest, SegmentedOutcome, TransferError,
    download_segmented, partial_path, resume_journal_path,
};

struct RangeServer {
    base_url: String,
    etag: Arc<Mutex<String>>,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl RangeServer {
    fn start(data: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local range server");
        listener
            .set_nonblocking(true)
            .expect("set nonblocking listener");
        let address = listener.local_addr().expect("local address");
        let data = Arc::new(data);
        let etag = Arc::new(Mutex::new("\"subutai-n2-v1\"".to_string()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread_data = Arc::clone(&data);
        let thread_etag = Arc::clone(&etag);
        let thread_stop = Arc::clone(&stop);
        let handle = thread::spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        handle_request(&mut stream, &thread_data, &thread_etag);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("local range server accept failed: {error}"),
                }
            }
        });
        Self {
            base_url: format!("http://{address}"),
            etag,
            stop,
            handle: Some(handle),
        }
    }

    fn url(&self) -> String {
        format!("{}/file.bin", self.base_url)
    }

    fn set_etag(&self, value: &str) {
        *self.etag.lock().expect("etag lock") = value.to_string();
    }
}

impl Drop for RangeServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            handle.join().expect("range server join");
        }
    }
}

#[test]
fn pauses_with_durable_state_then_resumes_all_segments() {
    let data = test_data(2 * 1024 * 1024 + 137);
    let server = RangeServer::start(data.clone());
    let destination = unique_path("resume-complete.bin");
    let mut request = SegmentedDownloadRequest::new("n2-resume", server.url(), &destination);
    request.requested_segments = 4;
    request.minimum_segment_size = 256 * 1024;
    request.checkpoint_bytes = 32 * 1024;

    let control = DownloadControl::default();
    control.pause();
    let paused = download_segmented(&request, &control).expect("pause transfer");
    match paused {
        SegmentedOutcome::Paused {
            downloaded_bytes,
            total_bytes,
            journal_path,
        } => {
            assert_eq!(downloaded_bytes, 0);
            assert_eq!(total_bytes, data.len() as u64);
            assert_eq!(journal_path, resume_journal_path(&destination));
        }
        other => panic!("expected paused outcome, got {other:?}"),
    }
    assert!(partial_path(&destination).exists());
    assert!(resume_journal_path(&destination).with_extension("job.a").exists()
        || resume_journal_path(&destination).with_extension("job.b").exists());

    control.resume();
    let completed = download_segmented(&request, &control).expect("resume transfer");
    let result = match completed {
        SegmentedOutcome::Completed(result) => result,
        other => panic!("expected completed outcome, got {other:?}"),
    };
    assert_eq!(result.downloaded_bytes, data.len() as u64);
    assert_eq!(fs::read(&destination).expect("read completed file"), data);
    assert!(!partial_path(&destination).exists());
    assert!(!resume_journal_path(&destination).with_extension("job.a").exists());
    assert!(!resume_journal_path(&destination).with_extension("job.b").exists());
    cleanup(&destination);
}

#[test]
fn refuses_resume_when_remote_validator_changes() {
    let data = test_data(512 * 1024 + 19);
    let server = RangeServer::start(data);
    let destination = unique_path("validator-change.bin");
    let mut request = SegmentedDownloadRequest::new("n2-validator", server.url(), &destination);
    request.requested_segments = 2;
    request.minimum_segment_size = 128 * 1024;

    let control = DownloadControl::default();
    control.pause();
    assert!(matches!(
        download_segmented(&request, &control).expect("create paused transfer"),
        SegmentedOutcome::Paused { .. }
    ));

    server.set_etag("\"subutai-n2-v2\"");
    control.resume();
    let error = download_segmented(&request, &control).expect_err("changed ETag must fail");
    assert!(matches!(error, TransferError::RemoteChanged(_)));
    assert!(partial_path(&destination).exists());
    cleanup(&destination);
    cleanup(&partial_path(&destination));
    cleanup_store(&resume_journal_path(&destination));
}

fn handle_request(stream: &mut TcpStream, data: &[u8], etag: &Mutex<String>) {
    let request = read_request(stream);
    let mut lines = request.split("\r\n");
    let request_line = lines.next().expect("request line");
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().expect("method");
    let path = request_parts.next().expect("path");
    assert_eq!(path, "/file.bin");
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
    let etag = etag.lock().expect("etag lock").clone();
    let common = [
        ("Accept-Ranges", "bytes".to_string()),
        ("ETag", etag.clone()),
        ("Last-Modified", "Sun, 02 Aug 2026 10:00:00 GMT".to_string()),
        ("Connection", "close".to_string()),
    ];

    if method == "HEAD" {
        let mut response_headers = common.to_vec();
        response_headers.push(("Content-Length", data.len().to_string()));
        write_response(stream, "200 OK", &response_headers, &[]);
        return;
    }

    assert_eq!(method, "GET");
    let range = header("range").expect("Range header");
    let if_range_matches = header("if-range").is_none_or(|value| {
        value == etag || value == "Sun, 02 Aug 2026 10:00:00 GMT"
    });
    if !if_range_matches {
        let mut response_headers = common.to_vec();
        response_headers.push(("Content-Length", data.len().to_string()));
        write_response(stream, "200 OK", &response_headers, data);
        return;
    }

    let (start, end) = parse_range(range, data.len());
    let body = &data[start..=end];
    let mut response_headers = common.to_vec();
    response_headers.push(("Content-Length", body.len().to_string()));
    response_headers.push((
        "Content-Range",
        format!("bytes {start}-{end}/{}", data.len()),
    ));
    write_response(stream, "206 Partial Content", &response_headers, body);
}

fn parse_range(value: &str, total: usize) -> (usize, usize) {
    let value = value.strip_prefix("bytes=").expect("bytes range");
    let (start, end) = value.split_once('-').expect("range bounds");
    let start = start.parse::<usize>().expect("range start");
    let end = end.parse::<usize>().expect("range end");
    assert!(start <= end);
    assert!(end < total);
    (start, end)
}

fn read_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("read timeout");
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream.read(&mut buffer).expect("read request");
        assert!(read > 0, "client closed before request headers completed");
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        assert!(bytes.len() < 64 * 1024, "request headers are too large");
    }
    String::from_utf8(bytes).expect("UTF-8 request")
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    headers: &[(&str, String)],
    body: &[u8],
) {
    write!(stream, "HTTP/1.1 {status}\r\n").expect("status");
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n").expect("header");
    }
    write!(stream, "\r\n").expect("header end");
    stream.write_all(body).expect("response body");
    stream.flush().expect("flush response");
}

fn test_data(length: usize) -> Vec<u8> {
    (0..length)
        .map(|index| ((index * 31 + 17) % 251) as u8)
        .collect()
}

fn unique_path(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "subutai-n2-{}-{nonce}-{name}",
        std::process::id()
    ))
}

fn cleanup(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!("cleanup {} failed: {error}", path.display()),
    }
}

fn cleanup_store(base: &Path) {
    let mut a = base.as_os_str().to_os_string();
    a.push(".a");
    cleanup(Path::new(&a));
    let mut b = base.as_os_str().to_os_string();
    b.push(".b");
    cleanup(Path::new(&b));
}

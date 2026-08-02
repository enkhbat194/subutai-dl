#![cfg(windows)]

use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use subutai_native_engine::{
    DownloadControl, SegmentedDownloadRequest, SegmentedOutcome, download_segmented,
    download_segmented_with_progress, partial_path, resume_journal_path,
};

struct NoRangeServer {
    url: String,
    stop: Arc<AtomicBool>,
    range_requests: Arc<AtomicUsize>,
    streaming_gets: Arc<AtomicUsize>,
    accept_handle: Option<thread::JoinHandle<()>>,
    connection_handles: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
}

impl NoRangeServer {
    fn start(data: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind no-range server");
        listener
            .set_nonblocking(true)
            .expect("set no-range listener nonblocking");
        let address = listener.local_addr().expect("no-range address");
        let data = Arc::new(data);
        let stop = Arc::new(AtomicBool::new(false));
        let range_requests = Arc::new(AtomicUsize::new(0));
        let streaming_gets = Arc::new(AtomicUsize::new(0));
        let connection_handles = Arc::new(Mutex::new(Vec::new()));

        let accept_data = Arc::clone(&data);
        let accept_stop = Arc::clone(&stop);
        let accept_ranges = Arc::clone(&range_requests);
        let accept_streaming = Arc::clone(&streaming_gets);
        let accept_connections = Arc::clone(&connection_handles);
        let accept_handle = thread::spawn(move || {
            while !accept_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let connection_data = Arc::clone(&accept_data);
                        let connection_ranges = Arc::clone(&accept_ranges);
                        let connection_streaming = Arc::clone(&accept_streaming);
                        let handle = thread::spawn(move || {
                            let _ = handle_request(
                                stream,
                                &connection_data,
                                &connection_ranges,
                                &connection_streaming,
                            );
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
            range_requests,
            streaming_gets,
            accept_handle: Some(accept_handle),
            connection_handles,
        }
    }
}

impl Drop for NoRangeServer {
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
fn no_range_server_pauses_then_restarts_from_zero_without_mixing_bytes() {
    let data = test_data(2 * 1024 * 1024 + 37);
    let server = NoRangeServer::start(data.clone());
    let directory = unique_directory();
    fs::create_dir_all(&directory).expect("create no-range directory");
    let destination = directory.join("no-range.bin");
    let mut request = SegmentedDownloadRequest::new("no-range-restart", &server.url, &destination);
    request.requested_segments = 8;
    request.minimum_segment_size = 256 * 1024;
    request.checkpoint_bytes = 64 * 1024;
    request.transport.retry_max_attempts = 4;
    request.transport.retry_base_delay = Duration::from_millis(10);

    let first_control = DownloadControl::default();
    let pause_control = first_control.clone();
    let first = download_segmented_with_progress(&request, &first_control, |progress| {
        if progress.downloaded_bytes >= 256 * 1024 {
            pause_control.pause();
        }
    })
    .expect("pause no-range fallback");

    let paused_bytes = match first {
        SegmentedOutcome::Paused {
            downloaded_bytes, ..
        } => downloaded_bytes,
        other => panic!("expected paused fallback, received {other:?}"),
    };
    assert!(paused_bytes >= 256 * 1024);
    assert!(paused_bytes < data.len() as u64);
    let partial = partial_path(&destination);
    assert!(partial.exists());
    assert!(journal_slots(&destination).iter().any(|path| path.exists()));

    // Prove the next no-range run does not trust or append to old bytes.
    let mut corrupted = OpenOptions::new()
        .write(true)
        .open(&partial)
        .expect("open paused partial");
    corrupted.seek(SeekFrom::Start(0)).expect("seek partial");
    corrupted.write_all(&[0xff]).expect("corrupt partial");
    corrupted.sync_all().expect("sync corrupt partial");

    let second_control = DownloadControl::default();
    let completed =
        download_segmented(&request, &second_control).expect("restart no-range fallback");
    let result = match completed {
        SegmentedOutcome::Completed(result) => result,
        other => panic!("expected completed fallback, received {other:?}"),
    };

    assert_eq!(result.downloaded_bytes, data.len() as u64);
    assert_eq!(fs::read(&destination).expect("read final fallback"), data);
    assert!(!partial.exists());
    assert!(
        journal_slots(&destination)
            .iter()
            .all(|path| !path.exists())
    );
    assert!(server.range_requests.load(Ordering::Acquire) >= 2);
    assert!(server.streaming_gets.load(Ordering::Acquire) >= 2);

    fs::remove_dir_all(directory).expect("cleanup no-range directory");
}

fn handle_request(
    mut stream: TcpStream,
    data: &[u8],
    range_requests: &AtomicUsize,
    streaming_gets: &AtomicUsize,
) -> std::io::Result<()> {
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
        return write_headers(&mut stream, "404 Not Found", 0);
    }

    let has_range = lines.any(|line| {
        line.split_once(':')
            .is_some_and(|(name, _)| name.eq_ignore_ascii_case("range"))
    });
    if has_range {
        range_requests.fetch_add(1, Ordering::AcqRel);
    } else if method == "GET" {
        streaming_gets.fetch_add(1, Ordering::AcqRel);
    }

    write_headers(&mut stream, "200 OK", data.len())?;
    if method == "HEAD" {
        return Ok(());
    }
    if method != "GET" {
        return Ok(());
    }

    for chunk in data.chunks(32 * 1024) {
        match stream.write_all(chunk) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::ConnectionAborted
                ) =>
            {
                return Ok(());
            }
            Err(error) => return Err(error),
        }
        stream.flush()?;
        thread::sleep(Duration::from_millis(2));
    }
    Ok(())
}

fn write_headers(
    stream: &mut TcpStream,
    status: &str,
    content_length: usize,
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Length: {content_length}\r\nETag: \"subutai-no-range\"\r\nLast-Modified: Sun, 02 Aug 2026 15:00:00 GMT\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()
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
        .map(|index| ((index.wrapping_mul(37).wrapping_add(11)) % 251) as u8)
        .collect()
}

fn unique_directory() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!("subutai-no-range-{}-{nonce}", std::process::id()))
}

#![cfg(windows)]

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use subutai_native_engine::{DownloadRequest, download_file, partial_path, probe_url};

struct TestServer {
    base_url: String,
    worker: Option<thread::JoinHandle<()>>,
}

impl TestServer {
    fn spawn(expected_connections: usize) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test address");
        let base_url = format!("http://{address}");
        let redirect_target = format!("{base_url}/file");
        let worker = thread::spawn(move || {
            for _ in 0..expected_connections {
                let (mut stream, _) = listener.accept().expect("accept test request");
                let request = read_request(&mut stream);
                let first_line = request.lines().next().expect("request line");
                let mut parts = first_line.split_whitespace();
                let method = parts.next().expect("method");
                let path = parts.next().expect("path");

                match (method, path) {
                    ("HEAD", "/redirect") => write_response(
                        &mut stream,
                        "302 Found",
                        &[
                            ("Location", redirect_target.as_str()),
                            ("Content-Length", "0"),
                        ],
                        b"",
                    ),
                    ("HEAD", "/file") => write_response(
                        &mut stream,
                        "200 OK",
                        &[
                            ("Content-Length", "4096"),
                            ("Accept-Ranges", "bytes"),
                            ("ETag", "\"subutai-n1\""),
                            ("Last-Modified", "Sun, 02 Aug 2026 10:00:00 GMT"),
                            ("Content-Type", "application/octet-stream"),
                            (
                                "Content-Disposition",
                                "attachment; filename*=UTF-8''Subutai%20N1.bin",
                            ),
                        ],
                        b"",
                    ),
                    ("GET", "/payload") => {
                        let payload = b"subutai-native-transfer-payload";
                        let length = payload.len().to_string();
                        write_response(
                            &mut stream,
                            "200 OK",
                            &[
                                ("Content-Length", length.as_str()),
                                ("Content-Type", "application/octet-stream"),
                            ],
                            payload,
                        );
                    }
                    _ => write_response(
                        &mut stream,
                        "404 Not Found",
                        &[("Content-Length", "0")],
                        b"",
                    ),
                }
            }
        });

        Self {
            base_url,
            worker: Some(worker),
        }
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() {
            worker.join().expect("test server thread");
        }
    }
}

#[test]
fn probe_follows_redirect_and_reads_metadata() {
    let server = TestServer::spawn(2);
    let probe = probe_url(&format!("{}/redirect", server.base_url), &[]).expect("probe");

    assert_eq!(probe.status_code, 200);
    assert_eq!(probe.content_length, Some(4096));
    assert!(probe.accepts_byte_ranges);
    assert_eq!(probe.etag.as_deref(), Some("\"subutai-n1\""));
    assert_eq!(probe.suggested_filename.as_deref(), Some("Subutai N1.bin"));
    assert!(probe.final_url.ends_with("/file"));
}

#[test]
fn downloads_to_partial_then_atomically_finishes_with_sha256() {
    let server = TestServer::spawn(1);
    let directory = unique_directory();
    fs::create_dir_all(&directory).expect("create test directory");
    let destination = directory.join("payload.bin");
    let request = DownloadRequest::new(format!("{}/payload", server.base_url), &destination);

    let result = download_file(&request).expect("download");

    assert_eq!(
        fs::read(&destination).expect("downloaded bytes"),
        b"subutai-native-transfer-payload"
    );
    assert_eq!(result.downloaded_bytes, 31);
    assert_eq!(
        result.sha256,
        "9c6d04c3842930583522cfc4457f050331e9e6f97a30ef196153a37aeb89c98e"
    );
    assert!(!partial_path(&destination).exists());

    fs::remove_dir_all(directory).expect("cleanup test directory");
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1024];
    while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut buffer).expect("read request");
        assert!(read > 0, "client closed before request headers completed");
        bytes.extend_from_slice(&buffer[..read]);
        assert!(
            bytes.len() < 64 * 1024,
            "test request headers are too large"
        );
    }
    String::from_utf8(bytes).expect("UTF-8 test request")
}

fn write_response(stream: &mut TcpStream, status: &str, headers: &[(&str, &str)], body: &[u8]) {
    write!(stream, "HTTP/1.1 {status}\r\n").expect("status");
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n").expect("header");
    }
    write!(stream, "Connection: close\r\n\r\n").expect("header end");
    stream.write_all(body).expect("response body");
    stream.flush().expect("flush response");
}

fn unique_directory() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "subutai-native-n1-test-{}-{nonce}",
        std::process::id()
    ))
}

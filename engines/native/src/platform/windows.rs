#![allow(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]

use std::ffi::c_void;
use std::mem::size_of;
use std::path::Path;
use std::ptr::{null, null_mut};
use std::slice;

use crate::platform::ResponseReader;
use crate::transfer::{probe_from_headers, HttpProbe, RequestHeader, TransferError};

const WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY: u32 = 4;
const WINHTTP_FLAG_SECURE: u32 = 0x0080_0000;
const WINHTTP_ADDREQ_FLAG_ADD: u32 = 0x2000_0000;
const WINHTTP_ADDREQ_FLAG_REPLACE: u32 = 0x8000_0000;
const WINHTTP_QUERY_RAW_HEADERS_CRLF: u32 = 22;
const WINHTTP_OPTION_URL: u32 = 34;
const WINHTTP_OPTION_REDIRECT_POLICY: u32 = 88;
const WINHTTP_OPTION_MAX_HTTP_AUTOMATIC_REDIRECTS: u32 = 89;
const WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP: u32 = 1;
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
const INTERNET_SCHEME_HTTP: i32 = 1;
const INTERNET_SCHEME_HTTPS: i32 = 2;
const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

#[repr(C)]
struct UrlComponents {
    struct_size: u32,
    scheme: *mut u16,
    scheme_length: u32,
    scheme_kind: i32,
    host: *mut u16,
    host_length: u32,
    port: u16,
    username: *mut u16,
    username_length: u32,
    password: *mut u16,
    password_length: u32,
    path: *mut u16,
    path_length: u32,
    extra: *mut u16,
    extra_length: u32,
}

#[link(name = "winhttp")]
unsafe extern "system" {
    fn WinHttpOpen(
        user_agent: *const u16,
        access_type: u32,
        proxy_name: *const u16,
        proxy_bypass: *const u16,
        flags: u32,
    ) -> *mut c_void;
    fn WinHttpConnect(
        session: *mut c_void,
        server_name: *const u16,
        server_port: u16,
        reserved: u32,
    ) -> *mut c_void;
    fn WinHttpOpenRequest(
        connection: *mut c_void,
        verb: *const u16,
        object_name: *const u16,
        version: *const u16,
        referrer: *const u16,
        accept_types: *const *const u16,
        flags: u32,
    ) -> *mut c_void;
    fn WinHttpAddRequestHeaders(
        request: *mut c_void,
        headers: *const u16,
        headers_length: u32,
        modifiers: u32,
    ) -> i32;
    fn WinHttpSendRequest(
        request: *mut c_void,
        headers: *const u16,
        headers_length: u32,
        optional: *const c_void,
        optional_length: u32,
        total_length: u32,
        context: usize,
    ) -> i32;
    fn WinHttpReceiveResponse(request: *mut c_void, reserved: *mut c_void) -> i32;
    fn WinHttpReadData(
        request: *mut c_void,
        buffer: *mut c_void,
        bytes_to_read: u32,
        bytes_read: *mut u32,
    ) -> i32;
    fn WinHttpQueryHeaders(
        request: *mut c_void,
        info_level: u32,
        name: *const u16,
        buffer: *mut c_void,
        buffer_length: *mut u32,
        index: *mut u32,
    ) -> i32;
    fn WinHttpQueryOption(
        handle: *mut c_void,
        option: u32,
        buffer: *mut c_void,
        buffer_length: *mut u32,
    ) -> i32;
    fn WinHttpSetOption(
        handle: *mut c_void,
        option: u32,
        buffer: *const c_void,
        buffer_length: u32,
    ) -> i32;
    fn WinHttpSetTimeouts(
        handle: *mut c_void,
        resolve_timeout: i32,
        connect_timeout: i32,
        send_timeout: i32,
        receive_timeout: i32,
    ) -> i32;
    fn WinHttpCrackUrl(
        url: *const u16,
        url_length: u32,
        flags: u32,
        components: *mut UrlComponents,
    ) -> i32;
    fn WinHttpCloseHandle(handle: *mut c_void) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetLastError() -> u32;
    fn GetDiskFreeSpaceExW(
        directory_name: *const u16,
        free_bytes_available: *mut u64,
        total_bytes: *mut u64,
        total_free_bytes: *mut u64,
    ) -> i32;
    fn MoveFileExW(existing: *const u16, new_name: *const u16, flags: u32) -> i32;
}

#[derive(Debug)]
struct InternetHandle(*mut c_void);

impl InternetHandle {
    fn new(value: *mut c_void, operation: &'static str) -> Result<Self, TransferError> {
        if value.is_null() {
            Err(last_error(operation))
        } else {
            Ok(Self(value))
        }
    }
}

impl Drop for InternetHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                WinHttpCloseHandle(self.0);
            }
        }
    }
}

#[derive(Debug)]
struct ParsedUrl {
    host: String,
    port: u16,
    object: String,
    secure: bool,
}

pub(crate) struct WindowsResponse {
    request: InternetHandle,
    _connection: InternetHandle,
    _session: InternetHandle,
    metadata: HttpProbe,
}

impl ResponseReader for WindowsResponse {
    fn metadata(&self) -> &HttpProbe {
        &self.metadata
    }

    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, TransferError> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let requested = u32::try_from(buffer.len())
            .map_err(|_| TransferError::Protocol("read buffer is too large".into()))?;
        let mut read = 0_u32;
        let succeeded = unsafe {
            WinHttpReadData(
                self.request.0,
                buffer.as_mut_ptr().cast(),
                requested,
                &mut read,
            )
        };
        check(succeeded, "WinHttpReadData")?;
        Ok(read as usize)
    }
}

pub(crate) fn open_response(
    method: &str,
    requested_url: &str,
    headers: &[RequestHeader],
) -> Result<WindowsResponse, TransferError> {
    let parsed = crack_url(requested_url)?;
    let user_agent = wide("Subutai/0.1 NativeEngine/0.1");
    let session = InternetHandle::new(
        unsafe {
            WinHttpOpen(
                user_agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                null(),
                null(),
                0,
            )
        },
        "WinHttpOpen",
    )?;

    check(
        unsafe { WinHttpSetTimeouts(session.0, 30_000, 30_000, 30_000, 60_000) },
        "WinHttpSetTimeouts",
    )?;
    set_u32_option(
        session.0,
        WINHTTP_OPTION_REDIRECT_POLICY,
        WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP,
    )?;
    set_u32_option(session.0, WINHTTP_OPTION_MAX_HTTP_AUTOMATIC_REDIRECTS, 10)?;

    let host = wide(&parsed.host);
    let connection = InternetHandle::new(
        unsafe { WinHttpConnect(session.0, host.as_ptr(), parsed.port, 0) },
        "WinHttpConnect",
    )?;

    let verb = wide(&method.to_ascii_uppercase());
    let object = wide(&parsed.object);
    let request = InternetHandle::new(
        unsafe {
            WinHttpOpenRequest(
                connection.0,
                verb.as_ptr(),
                object.as_ptr(),
                null(),
                null(),
                null(),
                if parsed.secure { WINHTTP_FLAG_SECURE } else { 0 },
            )
        },
        "WinHttpOpenRequest",
    )?;

    for header in headers {
        let line = wide(&format!("{}: {}", header.name, header.value));
        check(
            unsafe {
                WinHttpAddRequestHeaders(
                    request.0,
                    line.as_ptr(),
                    u32::MAX,
                    WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE,
                )
            },
            "WinHttpAddRequestHeaders",
        )?;
    }

    check(
        unsafe { WinHttpSendRequest(request.0, null(), 0, null(), 0, 0, 0) },
        "WinHttpSendRequest",
    )?;
    check(
        unsafe { WinHttpReceiveResponse(request.0, null_mut()) },
        "WinHttpReceiveResponse",
    )?;

    let raw_headers = query_raw_headers(request.0)?;
    let (status, parsed_headers) = parse_raw_headers(&raw_headers)?;
    let final_url = query_option_string(request.0, WINHTTP_OPTION_URL)?;
    let metadata = probe_from_headers(requested_url, final_url, status, &parsed_headers);

    Ok(WindowsResponse {
        request,
        _connection: connection,
        _session: session,
        metadata,
    })
}

pub(crate) fn available_disk_space(path: &Path) -> Result<u64, TransferError> {
    let path = wide_os(path);
    let mut available = 0_u64;
    let mut total = 0_u64;
    let mut free = 0_u64;
    check(
        unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut available,
                &mut total,
                &mut free,
            )
        },
        "GetDiskFreeSpaceExW",
    )?;
    Ok(available)
}

pub(crate) fn atomic_move(source: &Path, destination: &Path) -> Result<(), TransferError> {
    let source = wide_os(source);
    let destination = wide_os(destination);
    check(
        unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), MOVEFILE_WRITE_THROUGH) },
        "MoveFileExW",
    )
}

fn crack_url(value: &str) -> Result<ParsedUrl, TransferError> {
    if value.contains(['\r', '\n', '\0']) {
        return Err(TransferError::InvalidUrl(value.into()));
    }
    let encoded = wide(value);
    let mut components = UrlComponents {
        struct_size: size_of::<UrlComponents>() as u32,
        scheme: null_mut(),
        scheme_length: 1,
        scheme_kind: 0,
        host: null_mut(),
        host_length: 1,
        port: 0,
        username: null_mut(),
        username_length: 1,
        password: null_mut(),
        password_length: 1,
        path: null_mut(),
        path_length: 1,
        extra: null_mut(),
        extra_length: 1,
    };
    check(
        unsafe { WinHttpCrackUrl(encoded.as_ptr(), 0, 0, &mut components) },
        "WinHttpCrackUrl",
    )?;

    if components.username_length != 0 || components.password_length != 0 {
        return Err(TransferError::InvalidUrl(
            "credentials inside URLs are not accepted".into(),
        ));
    }
    let secure = match components.scheme_kind {
        INTERNET_SCHEME_HTTP => false,
        INTERNET_SCHEME_HTTPS => true,
        _ => return Err(TransferError::InvalidUrl(value.into())),
    };
    let host = pointer_string(components.host, components.host_length)?;
    if host.trim().is_empty() {
        return Err(TransferError::InvalidUrl(value.into()));
    }
    let path = pointer_string(components.path, components.path_length)?;
    let extra = pointer_string(components.extra, components.extra_length)?;
    let extra = extra.split('#').next().unwrap_or_default();
    let mut object = if path.is_empty() { "/".to_string() } else { path };
    object.push_str(extra);

    Ok(ParsedUrl {
        host,
        port: components.port,
        object,
        secure,
    })
}

fn query_raw_headers(request: *mut c_void) -> Result<String, TransferError> {
    let mut bytes = 0_u32;
    let first = unsafe {
        WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_RAW_HEADERS_CRLF,
            null(),
            null_mut(),
            &mut bytes,
            null_mut(),
        )
    };
    if first == 0 {
        let code = unsafe { GetLastError() };
        if code != ERROR_INSUFFICIENT_BUFFER {
            return Err(TransferError::Windows {
                operation: "WinHttpQueryHeaders(size)",
                code,
            });
        }
    }
    let mut buffer = vec![0_u16; (bytes as usize).div_ceil(2).max(1)];
    check(
        unsafe {
            WinHttpQueryHeaders(
                request,
                WINHTTP_QUERY_RAW_HEADERS_CRLF,
                null(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
                null_mut(),
            )
        },
        "WinHttpQueryHeaders",
    )?;
    Ok(wide_buffer_to_string(&buffer))
}

fn query_option_string(handle: *mut c_void, option: u32) -> Result<String, TransferError> {
    let mut bytes = 0_u32;
    let first = unsafe { WinHttpQueryOption(handle, option, null_mut(), &mut bytes) };
    if first == 0 {
        let code = unsafe { GetLastError() };
        if code != ERROR_INSUFFICIENT_BUFFER {
            return Err(TransferError::Windows {
                operation: "WinHttpQueryOption(size)",
                code,
            });
        }
    }
    let mut buffer = vec![0_u16; (bytes as usize).div_ceil(2).max(1)];
    check(
        unsafe { WinHttpQueryOption(handle, option, buffer.as_mut_ptr().cast(), &mut bytes) },
        "WinHttpQueryOption",
    )?;
    Ok(wide_buffer_to_string(&buffer))
}

fn set_u32_option(
    handle: *mut c_void,
    option: u32,
    value: u32,
) -> Result<(), TransferError> {
    check(
        unsafe {
            WinHttpSetOption(
                handle,
                option,
                (&value as *const u32).cast(),
                size_of::<u32>() as u32,
            )
        },
        "WinHttpSetOption",
    )
}

fn parse_raw_headers(value: &str) -> Result<(u16, Vec<(String, String)>), TransferError> {
    let mut lines = value.split("\r\n").filter(|line| !line.is_empty());
    let status_line = lines
        .next()
        .ok_or_else(|| TransferError::Protocol("response has no status line".into()))?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| TransferError::Protocol(format!("invalid status line: {status_line}")))?;
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .collect();
    Ok((status, headers))
}

fn pointer_string(pointer: *mut u16, length: u32) -> Result<String, TransferError> {
    if pointer.is_null() || length == 0 {
        return Ok(String::new());
    }
    let data = unsafe { slice::from_raw_parts(pointer, length as usize) };
    String::from_utf16(data)
        .map_err(|_| TransferError::Protocol("WinHTTP returned invalid UTF-16".into()))
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_os(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn wide_buffer_to_string(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|value| *value == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

fn check(value: i32, operation: &'static str) -> Result<(), TransferError> {
    if value == 0 {
        Err(last_error(operation))
    } else {
        Ok(())
    }
}

fn last_error(operation: &'static str) -> TransferError {
    TransferError::Windows {
        operation,
        code: unsafe { GetLastError() },
    }
}

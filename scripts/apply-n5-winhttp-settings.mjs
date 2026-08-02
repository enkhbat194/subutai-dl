import { readFileSync, writeFileSync } from 'node:fs';

const path = 'engines/native/src/platform/windows.rs';
let source = readFileSync(path, 'utf8');

function replaceOnce(before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`windows.rs: expected source block was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error('windows.rs: expected source block is not unique');
  }
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
  `use crate::platform::ResponseReader;
use crate::transfer::{HttpProbe, RequestHeader, TransferError, probe_from_headers};`,
  `use crate::platform::ResponseReader;
use crate::transfer::{HttpProbe, RequestHeader, TransferError, probe_from_headers};
use crate::{ProxyMode, TransportSettings};`,
);

replaceOnce(
  `const WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY: u32 = 4;`,
  `const WINHTTP_ACCESS_TYPE_NO_PROXY: u32 = 1;
const WINHTTP_ACCESS_TYPE_NAMED_PROXY: u32 = 3;
const WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY: u32 = 4;`,
);

replaceOnce(
  `const WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP: u32 = 1;
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;`,
  `const WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP: u32 = 1;
const WINHTTP_AUTH_TARGET_PROXY: u32 = 1;
const WINHTTP_AUTH_SCHEME_BASIC: u32 = 0x0000_0001;
const WINHTTP_AUTH_SCHEME_NTLM: u32 = 0x0000_0002;
const WINHTTP_AUTH_SCHEME_DIGEST: u32 = 0x0000_0008;
const WINHTTP_AUTH_SCHEME_NEGOTIATE: u32 = 0x0000_0010;
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;`,
);

replaceOnce(
  `    fn WinHttpSetTimeouts(
        handle: *mut c_void,
        resolve_timeout: i32,
        connect_timeout: i32,
        send_timeout: i32,
        receive_timeout: i32,
    ) -> i32;
    fn WinHttpCrackUrl(`,
  `    fn WinHttpSetTimeouts(
        handle: *mut c_void,
        resolve_timeout: i32,
        connect_timeout: i32,
        send_timeout: i32,
        receive_timeout: i32,
    ) -> i32;
    fn WinHttpQueryAuthSchemes(
        request: *mut c_void,
        supported_schemes: *mut u32,
        first_scheme: *mut u32,
        auth_target: *mut u32,
    ) -> i32;
    fn WinHttpSetCredentials(
        request: *mut c_void,
        auth_target: u32,
        auth_scheme: u32,
        username: *const u16,
        password: *const u16,
        auth_params: *mut c_void,
    ) -> i32;
    fn WinHttpCrackUrl(`,
);

replaceOnce(
  `pub(crate) fn open_response(
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
    )?;`,
  `pub(crate) fn open_response(
    method: &str,
    requested_url: &str,
    headers: &[RequestHeader],
    settings: &TransportSettings,
) -> Result<WindowsResponse, TransferError> {
    settings.validate().map_err(TransferError::Protocol)?;
    let parsed = crack_url(requested_url)?;
    let user_agent = wide("Subutai/0.1 NativeEngine/0.1");
    let (access_type, proxy_name) = proxy_configuration(settings)?;
    let proxy_pointer = proxy_name.as_ref().map_or(null(), |value| value.as_ptr());
    let session = InternetHandle::new(
        unsafe { WinHttpOpen(user_agent.as_ptr(), access_type, proxy_pointer, null(), 0) },
        "WinHttpOpen",
    )?;

    let connect_timeout = timeout_milliseconds(settings.connect_timeout);
    let transfer_timeout = timeout_milliseconds(settings.transfer_timeout);
    check(
        unsafe {
            WinHttpSetTimeouts(
                session.0,
                connect_timeout,
                connect_timeout,
                transfer_timeout,
                transfer_timeout,
            )
        },
        "WinHttpSetTimeouts",
    )?;`,
);

replaceOnce(
  `    check(
        unsafe { WinHttpSendRequest(request.0, null(), 0, null(), 0, 0, 0) },
        "WinHttpSendRequest",
    )?;
    check(
        unsafe { WinHttpReceiveResponse(request.0, null_mut()) },
        "WinHttpReceiveResponse",
    )?;

    let raw_headers = query_raw_headers(request.0)?;
    let (status, parsed_headers) = parse_raw_headers(&raw_headers)?;
    let final_url = query_option_string(request.0, WINHTTP_OPTION_URL)?;`,
  `    send_and_receive(request.0)?;

    let mut raw_headers = query_raw_headers(request.0)?;
    let (mut status, mut parsed_headers) = parse_raw_headers(&raw_headers)?;
    if status == 407 && !settings.proxy_username.is_empty() {
        set_proxy_credentials(
            request.0,
            &settings.proxy_username,
            &settings.proxy_password,
        )?;
        send_and_receive(request.0)?;
        raw_headers = query_raw_headers(request.0)?;
        (status, parsed_headers) = parse_raw_headers(&raw_headers)?;
    }
    let final_url = query_option_string(request.0, WINHTTP_OPTION_URL)?;`,
);

replaceOnce(
  `pub(crate) fn available_disk_space(path: &Path) -> Result<u64, TransferError> {`,
  `fn proxy_configuration(
    settings: &TransportSettings,
) -> Result<(u32, Option<Vec<u16>>), TransferError> {
    match settings.proxy_mode {
        ProxyMode::Off => Ok((WINHTTP_ACCESS_TYPE_NO_PROXY, None)),
        ProxyMode::System => Ok((WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, None)),
        ProxyMode::Manual => {
            let parsed = crack_url(&settings.proxy_url)?;
            if parsed.secure {
                return Err(TransferError::InvalidUrl(
                    "manual proxy endpoint must use HTTP".into(),
                ));
            }
            Ok((
                WINHTTP_ACCESS_TYPE_NAMED_PROXY,
                Some(wide(&format!("{}:{}", parsed.host, parsed.port))),
            ))
        }
    }
}

fn timeout_milliseconds(value: std::time::Duration) -> i32 {
    value.as_millis().min(i32::MAX as u128) as i32
}

fn send_and_receive(request: *mut c_void) -> Result<(), TransferError> {
    check(
        unsafe { WinHttpSendRequest(request, null(), 0, null(), 0, 0, 0) },
        "WinHttpSendRequest",
    )?;
    check(
        unsafe { WinHttpReceiveResponse(request, null_mut()) },
        "WinHttpReceiveResponse",
    )
}

fn set_proxy_credentials(
    request: *mut c_void,
    username: &str,
    password: &str,
) -> Result<(), TransferError> {
    let mut supported = 0_u32;
    let mut first = 0_u32;
    let mut target = 0_u32;
    check(
        unsafe { WinHttpQueryAuthSchemes(request, &mut supported, &mut first, &mut target) },
        "WinHttpQueryAuthSchemes",
    )?;
    if target != WINHTTP_AUTH_TARGET_PROXY {
        return Err(TransferError::Protocol(
            "authentication challenge did not target the configured proxy".into(),
        ));
    }
    let scheme = [
        WINHTTP_AUTH_SCHEME_NEGOTIATE,
        WINHTTP_AUTH_SCHEME_NTLM,
        WINHTTP_AUTH_SCHEME_DIGEST,
        WINHTTP_AUTH_SCHEME_BASIC,
    ]
    .into_iter()
    .find(|scheme| supported & scheme != 0)
    .or_else(|| (first != 0).then_some(first))
    .ok_or_else(|| TransferError::Protocol("proxy offered no supported authentication scheme".into()))?;
    let username = wide(username);
    let password = wide(password);
    check(
        unsafe {
            WinHttpSetCredentials(
                request,
                WINHTTP_AUTH_TARGET_PROXY,
                scheme,
                username.as_ptr(),
                password.as_ptr(),
                null_mut(),
            )
        },
        "WinHttpSetCredentials",
    )
}

pub(crate) fn available_disk_space(path: &Path) -> Result<u64, TransferError> {`,
);

writeFileSync(path, source);
console.log('N5 WinHTTP proxy, authentication and timeout migration applied.');

# Subutai Native Engine IPC Protocol

Status: **N0 protocol baseline**  
Protocol version: **1**

## Purpose

This protocol connects the Subutai desktop process to the Subutai Native Engine without exposing engine implementation details to the renderer or public UI.

The N0 transport is a byte stream over inherited pipes. The same frame format may later be carried over Windows named pipes without changing message semantics.

## Frame layout

All integer fields are unsigned little-endian values.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | Body length, excluding this prefix |
| 4 | 8 | Magic: `SUBIPC01` |
| 12 | 2 | Protocol version |
| 14 | 1 | Message kind |
| 15 | 1 | Flags; must be zero in version 1 |
| 16 | 8 | Request ID |
| 24 | 4 | Payload length |
| 28 | N | Opaque payload bytes |
| 28+N | 8 | FNV-1a 64-bit integrity checksum over the body before the checksum |

The body length includes the magic, version, kind, flags, request ID, payload length, payload and checksum.

## Limits

- Maximum payload: 8 MiB.
- Maximum decoder buffer: payload limit plus 1 MiB framing allowance.
- Frames with non-zero flags are rejected in protocol version 1.
- Unknown message kinds and unsupported protocol versions are rejected.
- A stream ending with a partial frame is an error, not a successful shutdown.
- Payloads are treated as untrusted input and must be validated again by the typed message layer.

## Message kinds

| Value | Name | Direction | Purpose |
|---:|---|---|---|
| 1 | Hello | Desktop → Engine | Start protocol negotiation |
| 2 | HelloAck | Engine → Desktop | Confirm compatible protocol |
| 3 | ProbeRequest | Desktop → Engine | Request URL metadata |
| 4 | ProbeResult | Engine → Desktop | Return metadata and capability result |
| 5 | StartRequest | Desktop → Engine | Start or restore a job |
| 6 | PauseRequest | Desktop → Engine | Persist and pause a job |
| 7 | ResumeRequest | Desktop → Engine | Resume a paused job |
| 8 | CancelRequest | Desktop → Engine | Cancel a job safely |
| 9 | StatusRequest | Desktop → Engine | Request current state |
| 10 | StatusEvent | Engine → Desktop | Emit progress/state transition |
| 11 | Error | Either | Return a structured failure |
| 12 | Shutdown | Desktop → Engine | Request clean engine shutdown |

## Request IDs

- The desktop assigns a non-zero request ID to commands that require a response.
- Responses reuse the same request ID.
- Unsolicited status events may use request ID zero and identify the job in their typed payload.
- A request ID is unique among currently outstanding requests on one connection.

## Compatibility rules

1. Version 1 readers reject unknown versions rather than guessing their layout.
2. New optional behavior is introduced through a future negotiated capability payload, not by silently reusing reserved fields.
3. Message kind numbers are never reassigned.
4. Payload schemas are versioned independently once typed payload encoding is introduced.
5. Desktop and engine must complete `Hello` / `HelloAck` before job commands are accepted.

## Integrity and security

The frame checksum detects accidental corruption and parser desynchronization. It is not authentication or encryption.

The engine accepts IPC only from the parent/authorized local Subutai process. Secrets, cookies and authorization headers must never be logged. Future named-pipe transport must use Windows access control restricted to the current user and the Subutai process boundary.

## N0 acceptance tests

- deterministic encode/decode round trip;
- partial pipe reads;
- multiple frames in one read;
- payload limit enforcement;
- unsupported flags/version/kind rejection;
- corruption detection;
- incomplete-stream rejection.

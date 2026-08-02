use subutai_native_engine::ipc::{decode_frame, IpcFrame, IpcMessageKind};
use subutai_native_engine::{decode_manifest, encode_manifest, plan_ranges, JobManifest};

fn sample_manifest_bytes() -> Vec<u8> {
    let manifest = JobManifest::new(
        "malformed-input-test",
        "https://example.test/archive.bin",
        r"C:\Downloads\archive.bin.subutai.part",
        Some(1024 * 1024),
        plan_ranges(1024 * 1024, 8, 1).expect("range plan"),
    )
    .expect("manifest");
    encode_manifest(&manifest).expect("encode manifest")
}

fn sample_ipc_bytes() -> Vec<u8> {
    IpcFrame::new(
        42,
        IpcMessageKind::StartRequest,
        b"job=malformed-input-test".to_vec(),
    )
    .expect("frame")
    .encode()
    .expect("encode frame")
}

#[test]
fn every_truncated_manifest_is_rejected() {
    let encoded = sample_manifest_bytes();
    for end in 0..encoded.len() {
        assert!(
            decode_manifest(&encoded[..end]).is_err(),
            "manifest truncation at {end} bytes was accepted"
        );
    }
}

#[test]
fn every_single_byte_manifest_corruption_is_rejected() {
    let encoded = sample_manifest_bytes();
    for index in 0..encoded.len() {
        let mut corrupted = encoded.clone();
        corrupted[index] ^= 0x01;
        assert!(
            decode_manifest(&corrupted).is_err(),
            "manifest corruption at byte {index} was accepted"
        );
    }
}

#[test]
fn every_truncated_ipc_frame_is_rejected() {
    let encoded = sample_ipc_bytes();
    for end in 0..encoded.len() {
        assert!(
            decode_frame(&encoded[..end]).is_err(),
            "IPC truncation at {end} bytes was accepted"
        );
    }
}

#[test]
fn every_single_byte_ipc_corruption_is_rejected() {
    let encoded = sample_ipc_bytes();
    for index in 0..encoded.len() {
        let mut corrupted = encoded.clone();
        corrupted[index] ^= 0x01;
        assert!(
            decode_frame(&corrupted).is_err(),
            "IPC corruption at byte {index} was accepted"
        );
    }
}

#[test]
fn deterministic_arbitrary_inputs_never_panic() {
    let mut state = 0x6a09_e667_f3bc_c909_u64;

    for length in 0..512_usize {
        let mut bytes = vec![0_u8; length];
        for byte in &mut bytes {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            *byte = (state >> 32) as u8;
        }

        let _ = decode_manifest(&bytes);
        let _ = decode_frame(&bytes);
    }
}

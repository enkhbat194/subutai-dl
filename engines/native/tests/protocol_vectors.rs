use subutai_native_engine::ipc::{IpcFrame, IpcMessageKind, decode_frame};
use subutai_native_engine::{JobManifest, decode_manifest, encode_manifest, plan_ranges};

fn decode_hex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0, "hex length must be even");
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).expect("ASCII hex");
            u8::from_str_radix(text, 16).expect("valid hex")
        })
        .collect()
}

#[test]
fn journal_v1_golden_vector_is_stable() {
    let manifest = JobManifest::new(
        "j",
        "https://e.test/f",
        r"C:\f.part",
        Some(1),
        plan_ranges(1, 1, 1).expect("range plan"),
    )
    .expect("manifest");

    let expected = decode_hex(
        "53554255544149310100010000006a1000000068747470733a2f2f652e746573742f6609000000433a5c662e706172740101000000000000000000000100000000000000000000000100000000000000000000000000000000e52af9715c10688c",
    );
    let encoded = encode_manifest(&manifest).expect("encode");

    assert_eq!(encoded, expected);
    assert_eq!(decode_manifest(&expected).expect("decode"), manifest);
}

#[test]
fn ipc_v1_golden_vector_is_stable() {
    let frame = IpcFrame::new(7, IpcMessageKind::Hello, b"x".to_vec()).expect("frame");
    let expected =
        decode_hex("21000000535542495043303101000100070000000000000001000000788cae7364c54768fe");
    let encoded = frame.encode().expect("encode");

    assert_eq!(encoded, expected);
    assert_eq!(decode_frame(&expected).expect("decode"), frame);
}

#[test]
fn range_planner_covers_deterministic_size_matrix() {
    let sizes = [1_u64, 2, 3, 7, 31, 1024, 1025, 65_535, 1_048_576, 1_048_577];
    let requested_counts = [1_u32, 2, 3, 4, 8, 16, 32];
    let minimum_sizes = [1_u64, 2, 4096, 1_048_576];

    for total in sizes {
        for requested in requested_counts {
            for minimum in minimum_sizes {
                let segments = plan_ranges(total, requested, minimum).expect("range plan");
                assert!(!segments.is_empty());
                assert_eq!(segments.first().map(|segment| segment.start), Some(0));
                assert_eq!(
                    segments.last().map(|segment| segment.end_exclusive),
                    Some(total),
                );

                let mut cursor = 0_u64;
                for segment in &segments {
                    assert_eq!(segment.start, cursor);
                    assert!(segment.end_exclusive > segment.start);
                    assert_eq!(segment.completed_bytes, 0);
                    cursor = segment.end_exclusive;
                }
                assert_eq!(cursor, total);
            }
        }
    }
}

#[test]
fn journal_round_trip_covers_segment_count_matrix() {
    for segment_count in [1_u32, 2, 3, 4, 8, 16, 32, 64] {
        let total = 64_u64 * 1024 * 1024 + u64::from(segment_count);
        let manifest = JobManifest::new(
            format!("job-{segment_count}"),
            "https://example.test/archive.bin",
            r"C:\Downloads\archive.bin.subutai.part",
            Some(total),
            plan_ranges(total, segment_count, 1).expect("range plan"),
        )
        .expect("manifest");

        let encoded = encode_manifest(&manifest).expect("encode");
        assert_eq!(decode_manifest(&encoded).expect("decode"), manifest);
    }
}

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use subutai_native_engine::{
    DownloadRequest, ENGINE_NAME, ENGINE_VERSION, JobManifest, JournalStore, SegmentState,
    decode_manifest, download_file_with_progress, encode_manifest, plan_ranges, probe_url,
};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Subutai engine error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("version") | Some("--version") | Some("-V") => {
            println!("{ENGINE_NAME} {ENGINE_VERSION}");
            Ok(())
        }
        Some("plan") => run_plan(args),
        Some("probe") => run_probe(args),
        Some("download") => run_download(args),
        Some("self-test") => {
            if args.next().is_some() {
                return Err("usage: subutai-engine self-test".into());
            }
            run_self_test()
        }
        Some(command) => Err(format!("unknown command: {command}\n{}", usage())),
        None => {
            println!("{ENGINE_NAME} {ENGINE_VERSION}");
            println!("{}", usage());
            Ok(())
        }
    }
}

fn run_plan(mut args: impl Iterator<Item = String>) -> Result<(), String> {
    let total_size = parse_u64(args.next(), "total bytes")?;
    let segments = parse_u32(args.next(), "segment count")?;
    let minimum_segment_size = match args.next() {
        Some(value) => value
            .parse::<u64>()
            .map_err(|_| format!("invalid minimum segment size: {value}"))?,
        None => 1024 * 1024,
    };
    if args.next().is_some() {
        return Err(
            "usage: subutai-engine plan <total-bytes> <segments> [minimum-segment-bytes]".into(),
        );
    }

    let ranges = plan_ranges(total_size, segments, minimum_segment_size)
        .map_err(|error| error.to_string())?;
    for (index, range) in ranges.iter().enumerate() {
        println!(
            "segment={index} start={} end_exclusive={} length={}",
            range.start,
            range.end_exclusive,
            range.len(),
        );
    }
    Ok(())
}

fn run_probe(mut args: impl Iterator<Item = String>) -> Result<(), String> {
    let url = args
        .next()
        .ok_or_else(|| "usage: subutai-engine probe <http-or-https-url>".to_string())?;
    if args.next().is_some() {
        return Err("usage: subutai-engine probe <http-or-https-url>".into());
    }

    let probe = probe_url(&url, &[]).map_err(|error| error.to_string())?;
    println!("requested_url={}", probe.requested_url);
    println!("final_url={}", probe.final_url);
    println!("status={}", probe.status_code);
    println!("content_length={}", optional_u64(probe.content_length));
    println!("accepts_byte_ranges={}", probe.accepts_byte_ranges);
    println!("etag={}", optional_text(probe.etag.as_deref()));
    println!(
        "last_modified={}",
        optional_text(probe.last_modified.as_deref())
    );
    println!(
        "content_type={}",
        optional_text(probe.content_type.as_deref())
    );
    println!(
        "suggested_filename={}",
        optional_text(probe.suggested_filename.as_deref())
    );
    Ok(())
}

fn run_download(mut args: impl Iterator<Item = String>) -> Result<(), String> {
    let url = args.next().ok_or_else(|| {
        "usage: subutai-engine download <http-or-https-url> <destination>".to_string()
    })?;
    let destination = args.next().map(PathBuf::from).ok_or_else(|| {
        "usage: subutai-engine download <http-or-https-url> <destination>".to_string()
    })?;
    if args.next().is_some() {
        return Err("usage: subutai-engine download <http-or-https-url> <destination>".into());
    }

    let request = DownloadRequest::new(url, &destination);
    let mut last_reported = 0_u64;
    let result = download_file_with_progress(&request, |progress| {
        let reached_end = progress.total_bytes == Some(progress.downloaded_bytes);
        if progress.downloaded_bytes.saturating_sub(last_reported) >= 1024 * 1024 || reached_end {
            last_reported = progress.downloaded_bytes;
            eprintln!(
                "downloaded={} total={} speed_bytes_per_second={} elapsed_ms={}",
                progress.downloaded_bytes,
                optional_u64(progress.total_bytes),
                progress.bytes_per_second,
                progress.elapsed.as_millis(),
            );
        }
    })
    .map_err(|error| error.to_string())?;

    println!("result=PASS");
    println!("destination={}", result.destination.display());
    println!("final_url={}", result.final_url);
    println!("downloaded_bytes={}", result.downloaded_bytes);
    println!("sha256={}", result.sha256);
    println!("elapsed_ms={}", result.elapsed.as_millis());
    Ok(())
}

fn run_self_test() -> Result<(), String> {
    let total_size = 32 * 1024 * 1024;
    let ranges = plan_ranges(total_size, 8, 1024 * 1024).map_err(|error| error.to_string())?;
    let mut manifest = JobManifest::new(
        "self-test",
        "https://example.test/subutai.bin",
        r"C:\Downloads\subutai.bin.subutai.part",
        Some(total_size),
        ranges,
    )
    .map_err(|error| error.to_string())?;

    let encoded = encode_manifest(&manifest).map_err(|error| error.to_string())?;
    let decoded = decode_manifest(&encoded).map_err(|error| error.to_string())?;
    if decoded != manifest {
        return Err("journal memory round-trip mismatch".into());
    }

    let first_length = manifest
        .segments
        .first()
        .map(|segment| segment.len())
        .ok_or_else(|| "self-test range plan is empty".to_string())?;
    manifest
        .set_segment_progress(0, first_length, SegmentState::Completed)
        .map_err(|error| error.to_string())?;

    let path = self_test_store_path()?;
    let store = JournalStore::new(&path);
    let disk_result = (|| -> Result<(u64, u64), String> {
        let generation_one = store.save(&decoded).map_err(|error| error.to_string())?;
        let generation_two = store.save(&manifest).map_err(|error| error.to_string())?;
        let recovered = store.load().map_err(|error| error.to_string())?;
        if recovered.generation != generation_two || recovered.manifest != manifest {
            return Err("durable journal verification mismatch".into());
        }
        Ok((generation_one, generation_two))
    })();
    let cleanup_result = store.remove().map_err(|error| error.to_string());
    let (generation_one, generation_two) = disk_result?;
    cleanup_result?;

    println!(
        "result=PASS engine={} version={} journal_bytes={} segments={} generations={}->{}",
        ENGINE_NAME,
        ENGINE_VERSION,
        encoded.len(),
        decoded.segments.len(),
        generation_one,
        generation_two,
    );
    Ok(())
}

fn self_test_store_path() -> Result<PathBuf, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock error: {error}"))?
        .as_nanos();
    Ok(env::temp_dir().join(format!(
        "subutai-native-self-test-{}-{nonce}.job",
        std::process::id()
    )))
}

fn parse_u64(value: Option<String>, label: &str) -> Result<u64, String> {
    let value = value.ok_or_else(|| format!("missing {label}"))?;
    value
        .parse::<u64>()
        .map_err(|_| format!("invalid {label}: {value}"))
}

fn parse_u32(value: Option<String>, label: &str) -> Result<u32, String> {
    let value = value.ok_or_else(|| format!("missing {label}"))?;
    value
        .parse::<u32>()
        .map_err(|_| format!("invalid {label}: {value}"))
}

fn optional_u64(value: Option<u64>) -> String {
    value.map_or_else(|| "unknown".into(), |value| value.to_string())
}

fn optional_text(value: Option<&str>) -> &str {
    value.unwrap_or("unknown")
}

fn usage() -> &'static str {
    "usage: subutai-engine <version|plan|probe|download|self-test>"
}

#[path = "core_impl.rs"]
mod core_impl;

pub use core_impl::{
    ENGINE_NAME, ENGINE_VERSION, JOURNAL_SCHEMA_VERSION, JobManifest, JobState, JournalError,
    JournalSnapshot, PlanError, Segment, SegmentState, StoreError, decode_manifest,
    encode_manifest, is_supported_http_url,
};

pub fn plan_ranges(
    total_size: u64,
    requested_segments: u32,
    minimum_segment_size: u64,
) -> Result<Vec<Segment>, PlanError> {
    if total_size == 0 {
        return Err(PlanError::EmptyFile);
    }
    if requested_segments == 0 {
        return Err(PlanError::ZeroSegments);
    }
    if minimum_segment_size == 0 {
        return Err(PlanError::ZeroMinimumSegmentSize);
    }

    let complete_groups = total_size / minimum_segment_size;
    let maximum_useful_segments = complete_groups
        .checked_add(if total_size % minimum_segment_size == 0 {
            0
        } else {
            1
        })
        .ok_or(PlanError::ArithmeticOverflow)?;
    let segment_count = u64::from(requested_segments)
        .min(maximum_useful_segments)
        .max(1);
    let base_length = total_size / segment_count;
    let remainder = total_size % segment_count;
    let capacity = usize::try_from(segment_count).map_err(|_| PlanError::ArithmeticOverflow)?;
    let mut ranges = Vec::with_capacity(capacity);
    let mut cursor = 0_u64;

    for index in 0..segment_count {
        let extra = if index < remainder { 1 } else { 0 };
        let length = base_length
            .checked_add(extra)
            .ok_or(PlanError::ArithmeticOverflow)?;
        let end_exclusive = cursor
            .checked_add(length)
            .ok_or(PlanError::ArithmeticOverflow)?;
        ranges.push(Segment {
            start: cursor,
            end_exclusive,
            completed_bytes: 0,
            state: SegmentState::Pending,
        });
        cursor = end_exclusive;
    }

    debug_assert_eq!(cursor, total_size);
    Ok(ranges)
}

#[derive(Debug, Clone)]
pub struct JournalStore {
    inner: core_impl::JournalStore,
}

impl JournalStore {
    pub fn new(base_path: impl Into<std::path::PathBuf>) -> Self {
        Self {
            inner: core_impl::JournalStore::new(base_path),
        }
    }

    pub fn save(&self, manifest: &JobManifest) -> Result<u64, StoreError> {
        match self.inner.load() {
            Ok(_) | Err(StoreError::NoSnapshot) => self.inner.save(manifest),
            Err(error) => Err(error),
        }
    }

    pub fn load(&self) -> Result<JournalSnapshot, StoreError> {
        self.inner.load()
    }

    pub fn remove(&self) -> Result<(), StoreError> {
        self.inner.remove()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
        let mut value: OsString = path.as_os_str().to_os_string();
        value.push(suffix);
        PathBuf::from(value)
    }

    fn unique_store_path() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "subutai-native-strict-journal-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn range_planner_handles_maximum_file_size_without_overflow() {
        let ranges = plan_ranges(u64::MAX, 32, u64::MAX).expect("range plan");
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].start, 0);
        assert_eq!(ranges[0].end_exclusive, u64::MAX);
    }

    #[test]
    fn refuses_to_overwrite_when_all_snapshots_are_corrupt() {
        let path = unique_store_path();
        let store = JournalStore::new(&path);
        let mut manifest = JobManifest::new(
            "strict-recovery",
            "https://example.test/archive.bin",
            r"C:\Downloads\archive.bin.subutai.part",
            Some(4096),
            plan_ranges(4096, 2, 1).expect("range plan"),
        )
        .expect("manifest");

        assert_eq!(store.save(&manifest).expect("generation one"), 1);
        manifest
            .set_segment_progress(0, 128, SegmentState::Active)
            .expect("progress");
        assert_eq!(store.save(&manifest).expect("generation two"), 2);

        let slot_a = append_suffix(&path, ".a");
        let slot_b = append_suffix(&path, ".b");
        for slot in [&slot_a, &slot_b] {
            let mut bytes = fs::read(slot).expect("read slot");
            let middle = bytes.len() / 2;
            bytes[middle] ^= 0x40;
            fs::write(slot, bytes).expect("corrupt slot");
        }

        let before_a = fs::read(&slot_a).expect("snapshot a");
        let before_b = fs::read(&slot_b).expect("snapshot b");
        assert!(matches!(store.load(), Err(StoreError::NoValidSnapshot(_))));
        assert!(matches!(
            store.save(&manifest),
            Err(StoreError::NoValidSnapshot(_))
        ));
        assert_eq!(fs::read(&slot_a).expect("snapshot a after"), before_a);
        assert_eq!(fs::read(&slot_b).expect("snapshot b after"), before_b);

        store.remove().expect("cleanup");
    }
}

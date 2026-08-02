#[path = "core_impl.rs"]
mod core_impl;

pub use core_impl::{
    decode_manifest, encode_manifest, is_supported_http_url, plan_ranges, JobManifest, JobState,
    JournalError, JournalSnapshot, PlanError, Segment, SegmentState, StoreError, ENGINE_NAME,
    ENGINE_VERSION, JOURNAL_SCHEMA_VERSION,
};

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
        assert!(matches!(
            store.load(),
            Err(StoreError::NoValidSnapshot(_))
        ));
        assert!(matches!(
            store.save(&manifest),
            Err(StoreError::NoValidSnapshot(_))
        ));
        assert_eq!(fs::read(&slot_a).expect("snapshot a after"), before_a);
        assert_eq!(fs::read(&slot_b).expect("snapshot b after"), before_b);

        store.remove().expect("cleanup");
    }
}

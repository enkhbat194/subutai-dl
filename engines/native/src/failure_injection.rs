use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

const DISABLED: u64 = u64::MAX;

#[derive(Debug, Clone, Default)]
pub struct FailureInjection {
    inner: Arc<FailureInjectionInner>,
}

#[derive(Debug)]
struct FailureInjectionInner {
    available_disk_space: AtomicU64,
    fail_write_after_bytes: AtomicU64,
    observed_write_bytes: AtomicU64,
    write_failures: AtomicU64,
    fail_next_sync: AtomicBool,
    sync_failures: AtomicU64,
    fail_atomic_move: AtomicBool,
    atomic_move_failures: AtomicU64,
}

impl Default for FailureInjectionInner {
    fn default() -> Self {
        Self {
            available_disk_space: AtomicU64::new(DISABLED),
            fail_write_after_bytes: AtomicU64::new(DISABLED),
            observed_write_bytes: AtomicU64::new(0),
            write_failures: AtomicU64::new(0),
            fail_next_sync: AtomicBool::new(false),
            sync_failures: AtomicU64::new(0),
            fail_atomic_move: AtomicBool::new(false),
            atomic_move_failures: AtomicU64::new(0),
        }
    }
}

impl FailureInjection {
    pub fn set_available_disk_space(&self, bytes: u64) {
        self.inner
            .available_disk_space
            .store(bytes, Ordering::Release);
    }

    pub fn fail_writes_after(&self, bytes: u64) {
        self.inner
            .fail_write_after_bytes
            .store(bytes, Ordering::Release);
        self.inner.observed_write_bytes.store(0, Ordering::Release);
    }

    pub fn fail_next_sync(&self) {
        self.inner.fail_next_sync.store(true, Ordering::Release);
    }

    pub fn fail_atomic_move(&self) {
        self.inner.fail_atomic_move.store(true, Ordering::Release);
    }

    pub fn write_failures(&self) -> u64 {
        self.inner.write_failures.load(Ordering::Acquire)
    }

    pub fn sync_failures(&self) -> u64 {
        self.inner.sync_failures.load(Ordering::Acquire)
    }

    pub fn atomic_move_failures(&self) -> u64 {
        self.inner.atomic_move_failures.load(Ordering::Acquire)
    }

    pub(crate) fn available_disk_space(&self) -> Option<u64> {
        let value = self.inner.available_disk_space.load(Ordering::Acquire);
        (value != DISABLED).then_some(value)
    }

    pub(crate) fn before_write(&self, bytes: usize) -> io::Result<()> {
        let threshold = self.inner.fail_write_after_bytes.load(Ordering::Acquire);
        if threshold == DISABLED {
            return Ok(());
        }
        let bytes = bytes as u64;
        let previous = self
            .inner
            .observed_write_bytes
            .fetch_add(bytes, Ordering::AcqRel);
        if previous.saturating_add(bytes) > threshold {
            self.inner.write_failures.fetch_add(1, Ordering::AcqRel);
            return Err(injected_error("partial file write"));
        }
        Ok(())
    }

    pub(crate) fn before_sync(&self) -> io::Result<()> {
        if self.inner.fail_next_sync.swap(false, Ordering::AcqRel) {
            self.inner.sync_failures.fetch_add(1, Ordering::AcqRel);
            return Err(injected_error("partial file sync"));
        }
        Ok(())
    }

    pub(crate) fn before_atomic_move(&self) -> io::Result<()> {
        if self.inner.fail_atomic_move.load(Ordering::Acquire) {
            self.inner
                .atomic_move_failures
                .fetch_add(1, Ordering::AcqRel);
            return Err(injected_error("atomic destination move"));
        }
        Ok(())
    }
}

fn injected_error(point: &str) -> io::Error {
    io::Error::other(format!("Subutai injected {point} failure"))
}

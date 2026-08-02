use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdaptivePolicy {
    pub minimum_connections: usize,
    pub target_chunk_bytes: u64,
    pub chunks_per_connection: usize,
    pub slow_window: Duration,
    pub slow_bytes_per_second: u64,
    pub max_replacements: u32,
    pub retry_backoff: Duration,
}

impl Default for AdaptivePolicy {
    fn default() -> Self {
        Self {
            minimum_connections: 2,
            target_chunk_bytes: 4 * 1024 * 1024,
            chunks_per_connection: 4,
            slow_window: Duration::from_secs(2),
            slow_bytes_per_second: 128 * 1024,
            max_replacements: 3,
            retry_backoff: Duration::from_millis(250),
        }
    }
}

impl AdaptivePolicy {
    pub(crate) fn validate(&self, maximum_connections: usize) -> Result<(), String> {
        if maximum_connections == 0 {
            return Err("maximum connection count must be greater than zero".into());
        }
        if self.minimum_connections == 0 {
            return Err("minimum connection count must be greater than zero".into());
        }
        if self.minimum_connections > maximum_connections {
            return Err("minimum connection count cannot exceed the maximum".into());
        }
        if self.target_chunk_bytes == 0 {
            return Err("target chunk size must be greater than zero".into());
        }
        if self.chunks_per_connection == 0 {
            return Err("chunks per connection must be greater than zero".into());
        }
        if self.slow_window.is_zero() {
            return Err("slow-worker observation window must be greater than zero".into());
        }
        if self.slow_bytes_per_second == 0 {
            return Err("slow-worker threshold must be greater than zero".into());
        }
        Ok(())
    }

    pub(crate) fn planned_chunk_count(
        &self,
        total_size: u64,
        maximum_connections: usize,
        minimum_chunk_bytes: u64,
    ) -> Result<u32, String> {
        self.validate(maximum_connections)?;
        if total_size == 0 {
            return Err("cannot plan chunks for an empty file".into());
        }
        if minimum_chunk_bytes == 0 {
            return Err("minimum chunk size must be greater than zero".into());
        }

        let target = self.target_chunk_bytes.max(minimum_chunk_bytes);
        let size_driven = total_size.div_ceil(target).max(1);
        let maximum_chunks = maximum_connections
            .checked_mul(self.chunks_per_connection)
            .ok_or_else(|| "adaptive chunk limit overflowed".to_string())?;
        let maximum_chunks = u64::try_from(maximum_chunks)
            .map_err(|_| "adaptive chunk limit conversion failed".to_string())?
            .max(1);
        let chunks = size_driven.min(maximum_chunks).max(1);
        u32::try_from(chunks).map_err(|_| "adaptive chunk count exceeds u32".to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AdaptiveSnapshot {
    pub active_connections: usize,
    pub connection_limit: usize,
    pub peak_connections: usize,
    pub replacement_count: u64,
    pub retry_count: u64,
}

#[derive(Debug)]
struct GateState {
    active_connections: usize,
    connection_limit: usize,
    peak_connections: usize,
    replacement_count: u64,
    retry_count: u64,
}

#[derive(Debug)]
pub(crate) struct AdaptiveGate {
    policy: AdaptivePolicy,
    maximum_connections: usize,
    state: Mutex<GateState>,
    changed: Condvar,
}

impl AdaptiveGate {
    pub(crate) fn new(
        policy: AdaptivePolicy,
        maximum_connections: usize,
        unfinished_chunks: usize,
    ) -> Self {
        let maximum_connections = maximum_connections.max(1).min(unfinished_chunks.max(1));
        let connection_limit = policy.minimum_connections.max(1).min(maximum_connections);
        Self {
            policy,
            maximum_connections,
            state: Mutex::new(GateState {
                active_connections: 0,
                connection_limit,
                peak_connections: 0,
                replacement_count: 0,
                retry_count: 0,
            }),
            changed: Condvar::new(),
        }
    }

    pub(crate) fn acquire(&self) -> AdaptivePermit<'_> {
        let mut state = self.lock_state();
        while state.active_connections >= state.connection_limit {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        state.active_connections += 1;
        state.peak_connections = state.peak_connections.max(state.active_connections);
        drop(state);
        AdaptivePermit { gate: self }
    }

    pub(crate) fn record_healthy(&self) {
        let mut state = self.lock_state();
        if state.connection_limit < self.maximum_connections {
            state.connection_limit += 1;
            self.changed.notify_all();
        }
    }

    pub(crate) fn record_replacement(&self) {
        let mut state = self.lock_state();
        state.replacement_count = state.replacement_count.saturating_add(1);
        self.reduce_limit(&mut state);
    }

    pub(crate) fn record_retry(&self) {
        let mut state = self.lock_state();
        state.retry_count = state.retry_count.saturating_add(1);
        self.reduce_limit(&mut state);
    }

    pub(crate) fn should_replace(&self, bytes: u64, elapsed: Duration) -> bool {
        if elapsed < self.policy.slow_window {
            return false;
        }
        let nanos = elapsed.as_nanos().max(1);
        let rate = ((u128::from(bytes) * 1_000_000_000) / nanos).min(u128::from(u64::MAX)) as u64;
        rate < self.policy.slow_bytes_per_second
    }

    pub(crate) fn backoff(&self, attempt: u32) -> Duration {
        self.policy
            .retry_backoff
            .checked_mul(attempt.max(1))
            .unwrap_or(Duration::MAX)
    }

    pub(crate) fn snapshot(&self) -> AdaptiveSnapshot {
        let state = self.lock_state();
        AdaptiveSnapshot {
            active_connections: state.active_connections,
            connection_limit: state.connection_limit,
            peak_connections: state.peak_connections,
            replacement_count: state.replacement_count,
            retry_count: state.retry_count,
        }
    }

    fn reduce_limit(&self, state: &mut GateState) {
        let minimum = self
            .policy
            .minimum_connections
            .max(1)
            .min(self.maximum_connections);
        if state.connection_limit > minimum {
            state.connection_limit -= 1;
        }
        self.changed.notify_all();
    }

    fn release(&self) {
        let mut state = self.lock_state();
        state.active_connections = state.active_connections.saturating_sub(1);
        self.changed.notify_all();
    }

    fn lock_state(&self) -> MutexGuard<'_, GateState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Debug)]
pub(crate) struct AdaptivePermit<'a> {
    gate: &'a AdaptiveGate,
}

impl Drop for AdaptivePermit<'_> {
    fn drop(&mut self) {
        self.gate.release();
    }
}

#[cfg(test)]
mod tests {
    use super::{AdaptiveGate, AdaptivePolicy};
    use std::time::Duration;

    #[test]
    fn plans_more_chunks_than_connections_for_large_files() {
        let policy = AdaptivePolicy {
            minimum_connections: 1,
            target_chunk_bytes: 1024 * 1024,
            chunks_per_connection: 4,
            ..AdaptivePolicy::default()
        };
        let chunks = policy
            .planned_chunk_count(32 * 1024 * 1024, 4, 256 * 1024)
            .expect("adaptive chunk plan");
        assert_eq!(chunks, 16);
    }

    #[test]
    fn gate_ramps_up_and_backs_off() {
        let policy = AdaptivePolicy {
            minimum_connections: 1,
            slow_window: Duration::from_millis(100),
            slow_bytes_per_second: 1024,
            ..AdaptivePolicy::default()
        };
        let gate = AdaptiveGate::new(policy, 4, 16);
        assert_eq!(gate.snapshot().connection_limit, 1);
        gate.record_healthy();
        gate.record_healthy();
        assert_eq!(gate.snapshot().connection_limit, 3);
        gate.record_replacement();
        assert_eq!(gate.snapshot().connection_limit, 2);
        assert_eq!(gate.snapshot().replacement_count, 1);
        assert!(gate.should_replace(10, Duration::from_secs(1)));
    }
}

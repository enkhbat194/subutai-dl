use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ProxyMode {
    Off = 0,
    System = 1,
    Manual = 2,
}

impl TryFrom<u8> for ProxyMode {
    type Error = String;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Off),
            1 => Ok(Self::System),
            2 => Ok(Self::Manual),
            other => Err(format!("invalid proxy mode {other}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportSettings {
    pub proxy_mode: ProxyMode,
    pub proxy_url: String,
    pub proxy_username: String,
    pub proxy_password: String,
    pub speed_limit_bytes_per_second: u64,
    pub retry_max_attempts: u32,
    pub retry_base_delay: Duration,
    pub connect_timeout: Duration,
    pub transfer_timeout: Duration,
}

impl Default for TransportSettings {
    fn default() -> Self {
        Self {
            proxy_mode: ProxyMode::Off,
            proxy_url: String::new(),
            proxy_username: String::new(),
            proxy_password: String::new(),
            speed_limit_bytes_per_second: 0,
            retry_max_attempts: 10,
            retry_base_delay: Duration::from_secs(2),
            connect_timeout: Duration::from_secs(20),
            transfer_timeout: Duration::from_secs(60),
        }
    }
}

impl TransportSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.proxy_mode == ProxyMode::Manual && self.proxy_url.trim().is_empty() {
            return Err("manual proxy mode requires a proxy URL".into());
        }
        for (label, value) in [
            ("proxy URL", self.proxy_url.as_str()),
            ("proxy username", self.proxy_username.as_str()),
            ("proxy password", self.proxy_password.as_str()),
        ] {
            if value.contains(['\r', '\n', '\0']) {
                return Err(format!("{label} contains a forbidden character"));
            }
        }
        if self.retry_max_attempts == 0 || self.retry_max_attempts > 100 {
            return Err("retry attempt count must be between 1 and 100".into());
        }
        if self.connect_timeout.is_zero() || self.transfer_timeout.is_zero() {
            return Err("connect and transfer timeouts must be greater than zero".into());
        }
        Ok(())
    }

    pub(crate) fn retry_delay(&self, attempt: u32) -> Duration {
        self.retry_base_delay
            .checked_mul(attempt.max(1))
            .unwrap_or(Duration::MAX)
    }
}

#[derive(Debug)]
pub(crate) struct SharedRateLimiter {
    bytes_per_second: u64,
    next_slot: Mutex<Instant>,
}

impl SharedRateLimiter {
    pub(crate) fn new(bytes_per_second: u64) -> Option<Arc<Self>> {
        (bytes_per_second > 0).then(|| {
            Arc::new(Self {
                bytes_per_second,
                next_slot: Mutex::new(Instant::now()),
            })
        })
    }

    pub(crate) fn throttle(&self, bytes: usize) {
        if bytes == 0 || self.bytes_per_second == 0 {
            return;
        }
        let nanos = ((bytes as u128) * 1_000_000_000_u128)
            .div_ceil(u128::from(self.bytes_per_second))
            .min(u128::from(u64::MAX)) as u64;
        let duration = Duration::from_nanos(nanos);
        let delay = {
            let mut next_slot = self
                .next_slot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let now = Instant::now();
            let scheduled = (*next_slot).max(now);
            *next_slot = scheduled.checked_add(duration).unwrap_or(scheduled);
            scheduled.saturating_duration_since(now)
        };
        if !delay.is_zero() {
            thread::sleep(delay);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_settings_reject_invalid_manual_proxy_and_attempts() {
        let mut settings = TransportSettings {
            proxy_mode: ProxyMode::Manual,
            ..TransportSettings::default()
        };
        assert!(settings.validate().is_err());
        settings.proxy_url = "http://127.0.0.1:8080".into();
        settings.retry_max_attempts = 0;
        assert!(settings.validate().is_err());
        settings.retry_max_attempts = 5;
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn retry_delay_uses_bounded_linear_backoff() {
        let settings = TransportSettings {
            retry_base_delay: Duration::from_millis(250),
            ..TransportSettings::default()
        };
        assert_eq!(settings.retry_delay(3), Duration::from_millis(750));
    }
}

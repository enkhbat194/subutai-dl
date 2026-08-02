import { readFileSync, writeFileSync } from 'node:fs';

function update(path, transform) {
  const original = readFileSync(path, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const next = transform(original.replace(/\r\n/gu, '\n'));
  writeFileSync(path, next.replace(/\n/gu, newline));
}

function replaceOnce(source, path, before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${path}: expected source block was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${path}: expected source block is not unique`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

update('engines/native/Cargo.toml', (source) => replaceOnce(
  source,
  'engines/native/Cargo.toml',
  `publish = false\n\n[lib]`,
  `publish = false\n\n[features]\ndefault = []\nfailure-injection = []\n\n[lib]`,
));

update('engines/native/src/lib.rs', (initial) => {
  const path = 'engines/native/src/lib.rs';
  let source = replaceOnce(
    initial,
    path,
    `mod direct_download;\npub mod ipc;`,
    `mod direct_download;\n#[cfg(feature = "failure-injection")]\nmod failure_injection;\npub mod ipc;`,
  );
  source = replaceOnce(
    source,
    path,
    `pub use direct_download::{download_segmented, download_segmented_with_progress};\npub use resumable::{`,
    `pub use direct_download::{download_segmented, download_segmented_with_progress};\n#[cfg(feature = "failure-injection")]\npub use failure_injection::FailureInjection;\npub use resumable::{`,
  );
  return source;
});

update('engines/native/src/resumable.rs', (initial) => {
  const path = 'engines/native/src/resumable.rs';
  let source = initial;
  source = replaceOnce(
    source,
    path,
    `    pub adaptive: AdaptivePolicy,\n    pub transport: TransportSettings,\n}`,
    `    pub adaptive: AdaptivePolicy,\n    pub transport: TransportSettings,\n    #[cfg(feature = "failure-injection")]\n    pub failure_injection: crate::FailureInjection,\n}`,
  );
  source = replaceOnce(
    source,
    path,
    `            adaptive: AdaptivePolicy::default(),\n            transport: TransportSettings::default(),\n        }\n    }\n}`,
    `            adaptive: AdaptivePolicy::default(),\n            transport: TransportSettings::default(),\n            #[cfg(feature = "failure-injection")]\n            failure_injection: crate::FailureInjection::default(),\n        }\n    }\n\n    pub(crate) fn available_disk_space(&self, parent: &Path) -> Result<u64, TransferError> {\n        #[cfg(feature = "failure-injection")]\n        if let Some(bytes) = self.failure_injection.available_disk_space() {\n            return Ok(bytes);\n        }\n        platform::available_disk_space(parent)\n    }\n\n    pub(crate) fn before_write(&self, bytes: usize) -> Result<(), TransferError> {\n        #[cfg(feature = "failure-injection")]\n        self.failure_injection.before_write(bytes)?;\n        #[cfg(not(feature = "failure-injection"))]\n        let _ = bytes;\n        Ok(())\n    }\n\n    pub(crate) fn before_sync(&self) -> Result<(), TransferError> {\n        #[cfg(feature = "failure-injection")]\n        self.failure_injection.before_sync()?;\n        Ok(())\n    }\n\n    pub(crate) fn before_atomic_move(&self) -> Result<(), TransferError> {\n        #[cfg(feature = "failure-injection")]\n        self.failure_injection.before_atomic_move()?;\n        Ok(())\n    }\n}`,
  );
  source = source.replace(
    `    let available = platform::available_disk_space(parent)?;`,
    `    let available = request.available_disk_space(parent)?;`,
  );
  source = source.replace(
    `        file.write_all(&buffer[..read])?;`,
    `        request.before_write(read)?;\n        file.write_all(&buffer[..read])?;`,
  );
  source = source.replace(
    `    file.sync_all()?;\n    checkpoint_segment(index, completed, SegmentState::Completed, manifest, store)?;`,
    `    request.before_sync()?;\n    file.sync_all()?;\n    checkpoint_segment(index, completed, SegmentState::Completed, manifest, store)?;`,
  );
  source = source.replace(
    `    let sha256 = hash_file(partial)?;\n    platform::atomic_move(partial, &request.destination)?;`,
    `    let sha256 = hash_file(partial)?;\n    request.before_atomic_move()?;\n    platform::atomic_move(partial, &request.destination)?;`,
  );
  source = source.replace(
    `    if source == partial {\n        platform::atomic_move(partial, &request.destination)?;\n    }`,
    `    if source == partial {\n        request.before_atomic_move()?;\n        platform::atomic_move(partial, &request.destination)?;\n    }`,
  );
  source = replaceOnce(
    source,
    path,
    `        TransferError::Windows { .. }\n        | TransferError::Io(_)\n        | TransferError::SizeMismatch { .. } => true,`,
    `        TransferError::Windows { .. } | TransferError::SizeMismatch { .. } => true,`,
  );
  return source;
});

update('engines/native/src/streaming_fallback.rs', (initial) => {
  const path = 'engines/native/src/streaming_fallback.rs';
  let source = initial.replace(
    `    let available = platform::available_disk_space(&parent)?;`,
    `    let available = request.available_disk_space(&parent)?;`,
  );
  source = source.replace(
    `        file.write_all(&buffer[..read])?;`,
    `        request.before_write(read)?;\n        file.write_all(&buffer[..read])?;`,
  );
  source = source.replace(
    `    file.sync_all()?;\n    store\n        .save(manifest)`,
    `    request.before_sync()?;\n    file.sync_all()?;\n    store\n        .save(manifest)`,
  );
  source = source.replace(
    `    let sha256 = hash_file(partial)?;\n    platform::atomic_move(partial, &request.destination)?;`,
    `    let sha256 = hash_file(partial)?;\n    request.before_atomic_move()?;\n    platform::atomic_move(partial, &request.destination)?;`,
  );
  source = replaceOnce(
    source,
    path,
    `        TransferError::Windows { .. }\n        | TransferError::Io(_)\n        | TransferError::SizeMismatch { .. } => true,`,
    `        TransferError::Windows { .. } | TransferError::SizeMismatch { .. } => true,`,
  );
  return source;
});

update('package.json', (source) => source
  .replace(
    `cargo clippy --manifest-path engines/native/Cargo.toml --all-targets -- -D warnings`,
    `cargo clippy --manifest-path engines/native/Cargo.toml --all-targets --features failure-injection -- -D warnings`,
  )
  .replace(
    `cargo test --manifest-path engines/native/Cargo.toml --all-targets`,
    `cargo test --manifest-path engines/native/Cargo.toml --all-targets --features failure-injection`,
  ));

console.log('N5 failure-injection migration applied.');

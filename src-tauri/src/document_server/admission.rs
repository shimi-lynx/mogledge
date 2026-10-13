//! Bounds server-owned document reads and response allocations, not WebView heaps.
use axum::body::{Body, Bytes};
use serde::Serialize;
use std::{
    collections::HashMap,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::sync::{Notify, Semaphore};

pub const MAX_RETAINED_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_REQUESTS: usize = 32;
pub const MAX_REQUESTS_PER_TOKEN: usize = 16;
// Per-grant reservations leave at least 96 MiB available to other grants.
pub const MAX_BYTES_PER_TOKEN: usize = 160 * 1024 * 1024;
pub const MAX_READS: usize = 8;
pub const MAX_MEDIA_REQUESTS: usize = 4;
pub const MAX_MEDIA_REQUESTS_PER_TOKEN: usize = 2;
pub const MAX_MEDIA_WINDOW_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_WAITERS: usize = 64;
pub const WAIT_TIMEOUT: Duration = Duration::from_secs(2);
// Admission reserves only scratch/fixed injection strings. Guarded metadata
// supplies an initial capacity hint; every allocation/copy reserves extra bytes.
pub const READ_RESERVATION_BYTES: usize = 1024 * 1024;

#[derive(Default)]
struct Usage {
    requests: usize,
    reads: usize,
    media_requests: usize,
    media_reads: usize,
    reserved_bytes: usize,
    response_bytes: usize,
    peak_reads: usize,
    peak_media_reads: usize,
    peak_requests: usize,
    peak_waiting: usize,
    peak_reserved_bytes: usize,
    peak_response_bytes: usize,
    rejected: u64,
    timed_out: u64,
    failed_reads: u64,
    revoked: u64,
    worker_failures: u64,
    tokens: HashMap<String, TokenUsage>,
}

#[derive(Default)]
struct TokenUsage {
    requests: usize,
    media_requests: usize,
    bytes: usize,
}

/// Process/Core lifetime counters; never contains document data, tokens or paths.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    version: u8,
    elapsed_ms: u128,
    max_requests: usize,
    max_requests_per_token: usize,
    max_bytes_per_token: usize,
    max_reads: usize,
    max_media_requests: usize,
    max_media_requests_per_token: usize,
    max_media_window_bytes: usize,
    max_waiters: usize,
    max_retained_bytes: usize,
    read_reservation_bytes: usize,
    wait_timeout_ms: u128,
    requests: usize,
    reads: usize,
    media_requests: usize,
    media_reads: usize,
    waiting: usize,
    reserved_bytes: usize,
    response_bytes: usize,
    peak_reads: usize,
    peak_media_reads: usize,
    peak_requests: usize,
    peak_waiting: usize,
    peak_reserved_bytes: usize,
    peak_response_bytes: usize,
    rejected: u64,
    timed_out: u64,
    failed_reads: u64,
    revoked: u64,
    worker_failures: u64,
}

pub struct Admission {
    usage: Mutex<Usage>,
    waiters: Semaphore,
    changed: Notify,
    started: Instant,
}

impl Default for Admission {
    fn default() -> Self {
        Self {
            usage: Mutex::new(Usage::default()),
            waiters: Semaphore::new(MAX_WAITERS),
            changed: Notify::new(),
            started: Instant::now(),
        }
    }
}

impl Admission {
    pub fn report(&self) -> Report {
        let usage = self.usage.lock().unwrap();
        Report {
            version: 1,
            elapsed_ms: self.started.elapsed().as_millis(),
            max_requests: MAX_REQUESTS,
            max_requests_per_token: MAX_REQUESTS_PER_TOKEN,
            max_bytes_per_token: MAX_BYTES_PER_TOKEN,
            max_reads: MAX_READS,
            max_media_requests: MAX_MEDIA_REQUESTS,
            max_media_requests_per_token: MAX_MEDIA_REQUESTS_PER_TOKEN,
            max_media_window_bytes: MAX_MEDIA_WINDOW_BYTES,
            max_waiters: MAX_WAITERS,
            max_retained_bytes: MAX_RETAINED_BYTES,
            read_reservation_bytes: READ_RESERVATION_BYTES,
            wait_timeout_ms: WAIT_TIMEOUT.as_millis(),
            requests: usage.requests,
            reads: usage.reads,
            media_requests: usage.media_requests,
            media_reads: usage.media_reads,
            waiting: MAX_WAITERS - self.waiters.available_permits(),
            reserved_bytes: usage.reserved_bytes,
            response_bytes: usage.response_bytes,
            peak_reads: usage.peak_reads,
            peak_media_reads: usage.peak_media_reads,
            peak_requests: usage.peak_requests,
            peak_waiting: usage.peak_waiting,
            peak_reserved_bytes: usage.peak_reserved_bytes,
            peak_response_bytes: usage.peak_response_bytes,
            rejected: usage.rejected,
            timed_out: usage.timed_out,
            failed_reads: usage.failed_reads,
            revoked: usage.revoked,
            worker_failures: usage.worker_failures,
        }
    }

    pub fn try_read(self: &Arc<Self>, token: &str) -> Option<ReadPermit> {
        let mut usage = self.usage.lock().unwrap();
        if usage.requests >= MAX_REQUESTS
            || usage.reads >= MAX_READS
            || usage.tokens.get(token).is_some_and(|token| {
                token.requests >= MAX_REQUESTS_PER_TOKEN
                    || token.bytes + READ_RESERVATION_BYTES > MAX_BYTES_PER_TOKEN
            })
            || usage.reserved_bytes + READ_RESERVATION_BYTES > MAX_RETAINED_BYTES
        {
            return None;
        }
        usage.requests += 1;
        usage.reads += 1;
        usage.reserved_bytes += READ_RESERVATION_BYTES;
        let token_usage = usage.tokens.entry(token.to_owned()).or_default();
        token_usage.requests += 1;
        token_usage.bytes += READ_RESERVATION_BYTES;
        usage.peak_reads = usage.peak_reads.max(usage.reads);
        usage.peak_requests = usage.peak_requests.max(usage.requests);
        usage.peak_reserved_bytes = usage.peak_reserved_bytes.max(usage.reserved_bytes);
        Some(ReadPermit {
            owner: self.clone(),
            token: token.to_owned(),
            bytes: READ_RESERVATION_BYTES,
            reading: true,
            media: false,
        })
    }

    // Media slots remain occupied until all transport slices are released.
    // They never occupy a document read slot or queue behind those readers.
    pub fn try_media_read(self: &Arc<Self>, token: &str) -> Option<ReadPermit> {
        let mut usage = self.usage.lock().unwrap();
        if usage.requests >= MAX_REQUESTS
            || usage.media_requests >= MAX_MEDIA_REQUESTS
            || usage.tokens.get(token).is_some_and(|token| {
                token.requests >= MAX_REQUESTS_PER_TOKEN
                    || token.media_requests >= MAX_MEDIA_REQUESTS_PER_TOKEN
                    || token.bytes + MAX_MEDIA_WINDOW_BYTES > MAX_BYTES_PER_TOKEN
            })
            || usage.reserved_bytes + MAX_MEDIA_WINDOW_BYTES > MAX_RETAINED_BYTES
        {
            usage.rejected += 1;
            return None;
        }
        usage.requests += 1;
        usage.media_requests += 1;
        usage.media_reads += 1;
        usage.reserved_bytes += MAX_MEDIA_WINDOW_BYTES;
        let token_usage = usage.tokens.entry(token.to_owned()).or_default();
        token_usage.requests += 1;
        token_usage.media_requests += 1;
        token_usage.bytes += MAX_MEDIA_WINDOW_BYTES;
        usage.peak_media_reads = usage.peak_media_reads.max(usage.media_reads);
        usage.peak_requests = usage.peak_requests.max(usage.requests);
        usage.peak_reserved_bytes = usage.peak_reserved_bytes.max(usage.reserved_bytes);
        Some(ReadPermit {
            owner: self.clone(),
            token: token.to_owned(),
            bytes: MAX_MEDIA_WINDOW_BYTES,
            reading: true,
            media: true,
        })
    }

    pub async fn read(self: &Arc<Self>, token: &str) -> Option<ReadPermit> {
        if let Some(permit) = self.try_read(token) {
            return Some(permit);
        }
        let Ok(_waiting) = self.waiters.try_acquire() else {
            self.reject();
            return None;
        };
        {
            let mut usage = self.usage.lock().unwrap();
            usage.peak_waiting = usage
                .peak_waiting
                .max(MAX_WAITERS - self.waiters.available_permits());
        }
        // Waiters own no read bytes, blocking worker, lifecycle lock or gate.
        // Register before checking capacity to avoid a missed release wake-up.
        let result = tokio::time::timeout(WAIT_TIMEOUT, async {
            loop {
                let changed = self.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if let Some(permit) = self.try_read(token) {
                    return permit;
                }
                changed.await;
            }
        })
        .await;
        match result {
            Ok(permit) => Some(permit),
            Err(_) => {
                self.reject();
                self.usage.lock().unwrap().timed_out += 1;
                None
            }
        }
    }

    pub fn reject(&self) {
        self.usage.lock().unwrap().rejected += 1;
    }
    pub fn failed_read(&self) {
        self.usage.lock().unwrap().failed_reads += 1;
    }
    pub fn revoked(&self) {
        self.usage.lock().unwrap().revoked += 1;
    }
    pub fn worker_failure(&self) {
        self.usage.lock().unwrap().worker_failures += 1;
    }
}

pub struct ReadPermit {
    owner: Arc<Admission>,
    token: String,
    bytes: usize,
    reading: bool,
    media: bool,
}

impl ReadPermit {
    pub fn reserve_capacity(&mut self, capacity: usize) -> Result<(), crate::knowledge::ReadError> {
        if self.media {
            if capacity > MAX_MEDIA_WINDOW_BYTES {
                return Err(crate::knowledge::ReadError::ResourceBusy);
            }
            self.reserve_bytes(capacity)
        } else {
            self.reserve_bytes(READ_RESERVATION_BYTES + capacity)
        }
    }

    fn reserve_bytes(&mut self, bytes: usize) -> Result<(), crate::knowledge::ReadError> {
        let mut usage = self.owner.usage.lock().unwrap();
        let token_bytes = usage.tokens.get(&self.token).unwrap().bytes;
        if bytes > self.bytes {
            let additional = bytes - self.bytes;
            if additional > MAX_RETAINED_BYTES - usage.reserved_bytes
                || additional > MAX_BYTES_PER_TOKEN - token_bytes
            {
                usage.rejected += 1;
                return Err(crate::knowledge::ReadError::ResourceBusy);
            }
            usage.reserved_bytes += additional;
            usage.tokens.get_mut(&self.token).unwrap().bytes += additional;
            usage.peak_reserved_bytes = usage.peak_reserved_bytes.max(usage.reserved_bytes);
        } else {
            usage.reserved_bytes -= self.bytes - bytes;
            usage.tokens.get_mut(&self.token).unwrap().bytes -= self.bytes - bytes;
        }
        let released = bytes < self.bytes;
        self.bytes = bytes;
        drop(usage);
        if released {
            self.owner.changed.notify_waiters();
        }
        Ok(())
    }

    pub fn response(mut self, bytes: Vec<u8>) -> Bytes {
        let capacity = bytes.capacity();
        assert!(capacity <= self.bytes);
        {
            let mut usage = self.owner.usage.lock().unwrap();
            if self.media {
                usage.media_reads -= 1;
            } else {
                usage.reads -= 1;
            }
            usage.reserved_bytes -= self.bytes - capacity;
            usage.response_bytes += capacity;
            usage.peak_response_bytes = usage.peak_response_bytes.max(usage.response_bytes);
            usage.tokens.get_mut(&self.token).unwrap().bytes -= self.bytes - capacity;
        }
        self.bytes = capacity;
        self.reading = false;
        self.owner.changed.notify_waiters();
        // Bytes::from_owner keeps the Vec and permit alive in every transport
        // slice/clone, even after the handler and the original Body are dropped.
        Bytes::from_owner(AdmittedBytes {
            bytes,
            _permit: self,
        })
    }
}

impl Drop for ReadPermit {
    fn drop(&mut self) {
        {
            let mut usage = self.owner.usage.lock().unwrap();
            usage.requests -= 1;
            usage.reserved_bytes -= self.bytes;
            if self.media {
                usage.media_requests -= 1;
            }
            if self.reading {
                if self.media {
                    usage.media_reads -= 1;
                } else {
                    usage.reads -= 1;
                }
            } else {
                usage.response_bytes -= self.bytes;
            }
            let token = usage.tokens.get_mut(&self.token).unwrap();
            token.requests -= 1;
            if self.media {
                token.media_requests -= 1;
            }
            token.bytes -= self.bytes;
            if token.requests == 0 {
                usage.tokens.remove(&self.token);
            }
        }
        self.owner.changed.notify_waiters();
    }
}

struct AdmittedBytes {
    // Field order drops the allocation before returning its memory reservation.
    bytes: Vec<u8>,
    _permit: ReadPermit,
}
impl AsRef<[u8]> for AdmittedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

pub fn body(bytes: Bytes) -> Body {
    Body::new(ResponseChunks(bytes))
}
struct ResponseChunks(Bytes);
impl http_body::Body for ResponseChunks {
    type Data = Bytes;
    type Error = std::convert::Infallible;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
        if self.0.is_empty() {
            return Poll::Ready(None);
        }
        let length = self.0.len().min(64 * 1024);
        let chunk = self.0.split_to(length);
        if self.0.is_empty() {
            self.0 = Bytes::new();
        }
        Poll::Ready(Some(Ok(http_body::Frame::data(chunk))))
    }
    fn is_end_stream(&self) -> bool {
        self.0.is_empty()
    }
    fn size_hint(&self) -> http_body::SizeHint {
        http_body::SizeHint::with_exact(self.0.len() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    #[test]
    fn media_global_token_and_shared_byte_limits_survive_response_retention() {
        let budget = Arc::new(Admission::default());
        let responses: Vec<_> = ["one", "one", "two", "two"]
            .into_iter()
            .map(|token| {
                budget
                    .try_media_read(token)
                    .unwrap()
                    .response(vec![7; MAX_MEDIA_WINDOW_BYTES])
            })
            .collect();
        assert!(budget.try_media_read("one").is_none());
        assert!(budget.try_media_read("three").is_none());
        assert!(budget.try_read("one").is_some());
        assert_eq!(budget.report().media_requests, MAX_MEDIA_REQUESTS);
        assert_eq!(budget.report().media_reads, 0);
        drop(responses);
        assert_eq!(budget.report().reserved_bytes, 0);
        let mut first = budget.try_read("one").unwrap();
        let mut second = budget.try_read("two").unwrap();
        first
            .reserve_capacity(MAX_BYTES_PER_TOKEN - READ_RESERVATION_BYTES)
            .unwrap();
        second
            .reserve_capacity(MAX_RETAINED_BYTES - MAX_BYTES_PER_TOKEN - READ_RESERVATION_BYTES)
            .unwrap();
        assert!(budget.try_media_read("three").is_none());
        second.reserve_capacity(0).unwrap();
        assert!(budget.try_media_read("three").is_some());
        assert!(budget.try_media_read("one").is_none());
        drop(first);
        drop(second);
        assert_eq!(budget.report().requests, 0);
    }

    #[test]
    fn read_and_copy_reservations_are_bounded_and_reusable() {
        let budget = Arc::new(Admission::default());
        let permits: Vec<_> = (0..MAX_READS)
            .map(|index| budget.try_read(&format!("token-{index}")).unwrap())
            .collect();
        assert!(budget.try_read("two").is_none());
        assert!(budget.report().peak_reserved_bytes <= MAX_RETAINED_BYTES);
        drop(permits);
        assert!(budget.try_read("two").is_some());
        assert_eq!(budget.report().requests, 0);
        assert_eq!(budget.report().reserved_bytes, 0);
    }

    #[test]
    fn incremental_reservations_enforce_global_and_token_bytes_without_waiting() {
        let budget = Arc::new(Admission::default());
        let mut first = budget.try_read("one").unwrap();
        let mut second = budget.try_read("two").unwrap();
        first
            .reserve_capacity(MAX_BYTES_PER_TOKEN - READ_RESERVATION_BYTES)
            .unwrap();
        assert_eq!(
            first.reserve_capacity(MAX_BYTES_PER_TOKEN),
            Err(crate::knowledge::ReadError::ResourceBusy)
        );
        second
            .reserve_capacity(MAX_RETAINED_BYTES - MAX_BYTES_PER_TOKEN - READ_RESERVATION_BYTES)
            .unwrap();
        assert_eq!(budget.report().reserved_bytes, MAX_RETAINED_BYTES);
        assert_eq!(
            second.reserve_capacity(MAX_RETAINED_BYTES - MAX_BYTES_PER_TOKEN),
            Err(crate::knowledge::ReadError::ResourceBusy)
        );
        assert!(budget.try_read("three").is_none());
        first.reserve_capacity(0).unwrap();
        assert!(budget.try_read("three").is_some());
        drop(first);
        drop(second);
        assert_eq!(budget.report().reserved_bytes, 0);
        assert_eq!(budget.report().requests, 0);
    }

    #[tokio::test]
    async fn slices_keep_the_allocation_charged_after_body_and_handler_drop() {
        let budget = Arc::new(Admission::default());
        let mut bytes = Vec::with_capacity(128 * 1024);
        bytes.resize(128 * 1024, 7);
        let bytes = budget.try_read("one").unwrap().response(bytes);
        let mut response = body(bytes);
        let first = response
            .frame()
            .await
            .unwrap()
            .unwrap()
            .into_data()
            .unwrap();
        let last = response
            .frame()
            .await
            .unwrap()
            .unwrap()
            .into_data()
            .unwrap();
        assert!(response.frame().await.is_none());
        drop(response);
        assert_eq!(budget.report().reads, 0);
        assert_eq!(budget.report().response_bytes, 128 * 1024);
        let clone = first.slice(..1);
        drop(first);
        drop(last);
        assert_eq!(budget.report().requests, 1);
        drop(clone);
        assert_eq!(budget.report().requests, 0);
        assert_eq!(budget.report().reserved_bytes, 0);
    }

    #[test]
    fn per_token_limit_preserves_slots_for_another_view() {
        let budget = Arc::new(Admission::default());
        let bodies: Vec<_> = (0..MAX_REQUESTS_PER_TOKEN)
            .map(|_| budget.try_read("one").unwrap().response(vec![1]))
            .collect();
        assert!(budget.try_read("one").is_none());
        assert!(budget.try_read("two").is_some());
        let others: Vec<_> = (0..MAX_REQUESTS - MAX_REQUESTS_PER_TOKEN)
            .map(|_| budget.try_read("two").unwrap().response(vec![2]))
            .collect();
        assert!(budget.try_read("three").is_none());
        drop(bodies);
        drop(others);
        assert!(budget.usage.lock().unwrap().tokens.is_empty());
        assert_eq!(budget.report().requests, 0);
    }

    #[test]
    fn one_tokens_large_responses_cannot_occupy_the_global_memory_budget() {
        let budget = Arc::new(Admission::default());
        let bodies: Vec<_> = (0..4)
            .map(|_| {
                let mut data = Vec::with_capacity(crate::knowledge::MAX_SOURCE_BYTES);
                data.push(1);
                {
                    let mut permit = budget.try_read("one").unwrap();
                    permit.reserve_capacity(data.capacity()).unwrap();
                    permit.response(data)
                }
            })
            .collect();
        let mut permit = budget.try_read("one").unwrap();
        assert_eq!(
            permit.reserve_capacity(crate::knowledge::MAX_SOURCE_BYTES),
            Err(crate::knowledge::ReadError::ResourceBusy)
        );
        assert!(budget.try_read("two").is_some());
        drop(permit);
        drop(bodies);
        assert_eq!(budget.report().reserved_bytes, 0);
    }

    #[tokio::test]
    async fn wait_queue_is_bounded_cancellation_safe_and_recovers() {
        let budget = Arc::new(Admission::default());
        let held: Vec<_> = (0..MAX_READS)
            .map(|index| budget.try_read(&format!("token-{index}")).unwrap())
            .collect();
        let mut waiting = Vec::new();
        for _ in 0..MAX_WAITERS {
            let budget = budget.clone();
            waiting.push(tokio::spawn(async move { budget.read("two").await }));
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while budget.report().waiting != MAX_WAITERS {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(budget.read("three").await.is_none());
        assert_eq!(budget.report().rejected, 1);
        for worker in waiting {
            worker.abort();
            assert!(matches!(worker.await, Err(error) if error.is_cancelled()));
        }
        assert_eq!(budget.report().waiting, 0);
        drop(held);
        assert!(budget.read("two").await.is_some());
        assert_eq!(budget.report().requests, 0);
    }

    #[tokio::test]
    async fn queued_timeout_returns_its_waiter_slot() {
        let budget = Arc::new(Admission::default());
        let _held: Vec<_> = (0..MAX_READS)
            .map(|index| budget.try_read(&format!("token-{index}")).unwrap())
            .collect();
        assert!(budget.read("two").await.is_none());
        assert_eq!(budget.report().waiting, 0);
        assert_eq!(budget.report().rejected, 1);
    }

    #[tokio::test]
    async fn cancelled_caller_does_not_release_a_running_blocking_worker() {
        let budget = Arc::new(Admission::default());
        let permit = budget.try_read("one").unwrap();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (finish, finish_rx) = std::sync::mpsc::channel();
        let (done, done_rx) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || {
                started.send(()).unwrap();
                finish_rx.recv().unwrap();
                let bytes = permit.response(vec![1]);
                drop(bytes);
                done.send(()).unwrap();
            })
            .await
            .unwrap();
        });
        started_rx.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert_eq!(budget.report().reads, 1);
        assert_eq!(budget.report().reserved_bytes, READ_RESERVATION_BYTES);
        finish.send(()).unwrap();
        done_rx.await.unwrap();
        assert_eq!(budget.report().requests, 0);
    }

    #[test]
    fn report_is_versioned_and_contains_no_grants_or_paths() {
        let budget = Arc::new(Admission::default());
        let _permit = budget.try_read("private-grant").unwrap();
        let json = serde_json::to_string(&budget.report()).unwrap();
        assert!(json.contains("\"version\":1"));
        assert!(!json.contains("private-grant"));
        assert!(!json.contains("tokens"));
        assert!(!json.contains("path"));
    }
}

//! Resource budgets scale with the existing file, never impose a storage quota.
use std::{
    cell::RefCell,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

thread_local! { static CANCELLATION: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) }; }

pub(crate) fn with_cancellation<T>(flag: Arc<AtomicBool>, operation: impl FnOnce() -> T) -> T {
    struct Restore(Option<Arc<AtomicBool>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CANCELLATION.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let previous = CANCELLATION.with(|slot| slot.replace(Some(flag)));
    let _restore = Restore(previous);
    operation()
}

pub(crate) fn cancellation() -> Option<Arc<AtomicBool>> {
    CANCELLATION.with(|slot| slot.borrow().clone())
}

pub(crate) fn deadline(bytes: u64) -> Instant {
    // Constant memory; allow a conservative 4 MiB/s plus setup. A large valid
    // DB gets more time instead of becoming permanently ineligible to migrate.
    Instant::now() + Duration::from_secs(30 + bytes / (4 * 1024 * 1024))
}
pub(crate) fn cancelled() -> bool {
    cancellation().is_some_and(|flag| flag.load(Ordering::Acquire))
}

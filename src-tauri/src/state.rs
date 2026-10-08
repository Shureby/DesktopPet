use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Mutex, MutexGuard};

use desktoppet_core::backup::Snapshot;
use desktoppet_core::Store;

use crate::storefront::Storefront;

pub struct AppState {
    store: Mutex<Store>,
    /// Whether the pet window currently lets clicks pass through.
    pub ignore_cursor: AtomicBool,
    /// The user hid the pet (tray or menu). It may still come out briefly for a reminder.
    pub pet_hidden: AtomicBool,
    /// The hidden pet is out for a reminder ("peek"); `end_peek` sends it back.
    pub peeking: AtomicBool,
    /// The pet window listens for reminders. Until then nothing due is taken (the scheduler
    /// waits), so what's due right at startup isn't sent before anyone can show it.
    pub pet_ready: AtomicBool,
    /// End-to-end tests: count as a mouse move on the next presence check (e2e_present).
    pub e2e_present: AtomicBool,
    /// The backup opened in Settings → Backup, until it's restored or another is opened.
    pub opened_backup: Mutex<Option<Snapshot>>,
    pub storefront: Box<dyn Storefront>,
}

impl AppState {
    pub fn new(store: Store, storefront: Box<dyn Storefront>) -> Self {
        Self {
            store: Mutex::new(store),
            ignore_cursor: AtomicBool::new(false),
            pet_hidden: AtomicBool::new(false),
            peeking: AtomicBool::new(false),
            pet_ready: AtomicBool::new(false),
            e2e_present: AtomicBool::new(false),
            opened_backup: Mutex::new(None),
            storefront,
        }
    }

    pub fn store(&self) -> MutexGuard<'_, Store> {
        // A panic while holding the lock leaves SQLite consistent, so recover the guard.
        self.store.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The app's clock: the computer's, plus the test clock's shift (always 0 outside test
/// builds and end-to-end tests, see `shift_clock`).
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis() + CLOCK_SHIFT.load(Ordering::Relaxed)
}

/// How far the test clock is set ahead (ms).
static CLOCK_SHIFT: AtomicI64 = AtomicI64::new(0);

/// Whether the clock can be set ahead: a test build (feature `testbuild`, "ePet Test") or a
/// debug build started for the end-to-end tests.
pub fn test_clock_enabled() -> bool {
    cfg!(feature = "testbuild") || crate::commands::e2e_enabled()
}

pub fn clock_shift() -> i64 {
    CLOCK_SHIFT.load(Ordering::Relaxed)
}

/// Sets the test clock `ms` further ahead (negative: back, never before the real time);
/// returns the new shift. Lasts until ePet quits.
pub fn shift_clock(ms: i64) -> i64 {
    let next = (clock_shift() + ms).max(0);
    CLOCK_SHIFT.store(next, Ordering::Relaxed);
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_test_clock_moves_ahead_and_back_but_not_before_now() {
        let real = chrono::Utc::now().timestamp_millis();
        assert_eq!(shift_clock(86_400_000), 86_400_000);
        assert!(now_ms() >= real + 86_400_000);
        assert_eq!(shift_clock(-3_600_000), 82_800_000);
        assert_eq!(shift_clock(-86_400_000), 0);
        assert!(now_ms() - chrono::Utc::now().timestamp_millis() < 1000);
    }
}

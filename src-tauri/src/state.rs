use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, MutexGuard};

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
    pub storefront: Box<dyn Storefront>,
}

impl AppState {
    pub fn new(store: Store, storefront: Box<dyn Storefront>) -> Self {
        Self {
            store: Mutex::new(store),
            ignore_cursor: AtomicBool::new(false),
            pet_hidden: AtomicBool::new(false),
            peeking: AtomicBool::new(false),
            storefront,
        }
    }

    pub fn store(&self) -> MutexGuard<'_, Store> {
        // A panic while holding the lock leaves SQLite consistent, so recover the guard.
        self.store.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

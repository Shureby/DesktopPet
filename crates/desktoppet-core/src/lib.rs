//! Platform-independent core of the desktop pet.
//!
//! Everything here is plain Rust + SQLite so it can be unit tested without a
//! GUI. The Tauri app (`src-tauri`) wraps it in commands and a timer loop.

pub mod backup;
pub mod model;
pub mod pomodoro;
pub mod schedule;
pub mod store;

pub use model::*;
pub use store::{Store, StoreError};

//! Storefront integrations. Feature code only talks to the `Storefront` trait,
//! so Steam, Epic and the direct (website) build share everything else.

mod direct;
#[cfg(feature = "epic")]
mod epic;
#[cfg(feature = "steam")]
mod steam;

pub trait Storefront: Send + Sync {
    fn name(&self) -> &'static str;
    /// Mirrors an achievement to the store (it is always recorded locally too).
    fn unlock_achievement(&self, id: &str);
    /// Whether a DLC (e.g. a character pack) is owned.
    #[allow(dead_code)] // Used once paid character packs ship.
    fn owns_dlc(&self, dlc: &str) -> bool;
    /// Pumps SDK callbacks; called about once a second.
    fn run_callbacks(&self) {}
}

/// Picks the storefront for this build, falling back to the direct build if the
/// store client is unavailable (e.g. Steam not running during development).
pub fn init() -> Box<dyn Storefront> {
    #[cfg(feature = "steam")]
    match steam::Steam::init() {
        Ok(s) => return Box::new(s),
        Err(e) => log::warn!("Steam unavailable, continuing without it: {e}"),
    }
    #[cfg(feature = "epic")]
    return Box::new(epic::Epic::init());
    #[allow(unreachable_code)]
    Box::new(direct::Direct)
}

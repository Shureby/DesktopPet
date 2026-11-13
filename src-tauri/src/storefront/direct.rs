use super::Storefront;

/// Website build (ezyappco.com): achievements are local only; DLC comes from license keys later.
pub struct Direct;

impl Storefront for Direct {
    fn name(&self) -> &'static str {
        "direct"
    }

    fn unlock_achievement(&self, _id: &str) {}

    fn owns_dlc(&self, _dlc: &str) -> bool {
        false
    }
}

use super::Storefront;

/// Epic Games Store build.
///
/// TODO(epic): wire up the EOS SDK (Auth + Achievements + Ecom) once the
/// product is registered in the Epic Developer Portal. Until then this behaves
/// like the direct build so the flavour compiles and runs.
pub struct Epic;

impl Epic {
    pub fn init() -> Self {
        log::info!("Epic storefront: EOS integration pending, running with local achievements");
        Self
    }
}

impl Storefront for Epic {
    fn name(&self) -> &'static str {
        "epic"
    }

    fn unlock_achievement(&self, _id: &str) {}

    fn owns_dlc(&self, _dlc: &str) -> bool {
        false
    }
}

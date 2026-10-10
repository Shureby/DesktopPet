use steamworks::{AppId, Client};

use super::Storefront;

/// Steam build. Needs the Steam client running and, in development, a
/// `steam_appid.txt` next to the executable (480 = Valve's Spacewar test app).
pub struct Steam {
    client: Client,
}

impl Steam {
    pub fn init() -> Result<Self, String> {
        Client::init().map(|client| Self { client }).map_err(|e| e.to_string())
    }
}

impl Storefront for Steam {
    fn name(&self) -> &'static str {
        "steam"
    }

    fn unlock_achievement(&self, id: &str) {
        let stats = self.client.user_stats();
        // Achievement API names are configured in Steamworks to match our ids.
        if stats.achievement(id).set().is_ok() {
            let _ = stats.store_stats();
        }
    }

    fn owns_dlc(&self, dlc: &str) -> bool {
        dlc.parse::<u32>().is_ok_and(|id| self.client.apps().is_dlc_installed(AppId(id)))
    }

    fn run_callbacks(&self) {
        self.client.run_callbacks();
    }
}

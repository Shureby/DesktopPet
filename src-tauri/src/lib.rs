//! Desktop pet app shell: windows, tray, commands and the reminder loop.
//! Platform-independent logic lives in `crates/desktoppet-core`.

mod app_windows;
mod avoid;
mod backup;
mod commands;
mod desktop;
mod locale;
mod post;
mod scheduler;
mod state;
mod storefront;
mod tray;

use desktoppet_core::Store;
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::app_windows::{GameEvent, GAME};
use crate::state::AppState;

pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch (e.g. from Steam) opens the panel instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app_windows::open_panel(app, None);
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir.join("desktoppet.db"))?;
            let storefront = storefront::init();
            log::info!("storefront: {}", storefront.name());
            app.manage(AppState::new(store, storefront));
            app.manage(post::Post::new(app.handle().clone()));

            // A desktop pet lives in the tray, not the Dock.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            app_windows::create_pet(app.handle())?;
            tray::create(app.handle())?;
            scheduler::spawn(app.handle().clone());
            avoid::spawn(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == GAME && matches!(event, WindowEvent::Destroyed) {
                let _ = window.app_handle().emit("game", GameEvent { state: "ended", game: "" });
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_settings,
            commands::list_todos,
            commands::add_todo,
            commands::update_todo,
            commands::delete_todo,
            commands::clear_done_todos,
            commands::list_alarms,
            commands::add_alarm,
            commands::update_alarm,
            commands::set_alarm_enabled,
            commands::skip_alarm_once,
            commands::unskip_alarm,
            commands::snooze_alarm,
            commands::delete_alarm,
            commands::list_anniversaries,
            commands::add_anniversary,
            commands::update_anniversary,
            commands::delete_anniversary,
            commands::preview_celebration,
            commands::show_celebration,
            commands::close_celebration,
            commands::clear_finished_alarms,
            commands::dismiss_alarm,
            commands::mark_alarm_missed,
            commands::acknowledge_missed,
            commands::record_unseen,
            commands::list_unseen,
            commands::clear_unseen,
            commands::end_peek,
            commands::pet_ready,
            commands::e2e_enabled,
            locale::system_locale,
            commands::e2e_tray,
            commands::e2e_close,
            commands::e2e_resize,
            commands::e2e_present,
            commands::test_clock,
            commands::shift_clock,
            commands::pomodoro_start,
            commands::pomodoro_skip,
            commands::pomodoro_stop,
            commands::pomodoro_status,
            commands::pomodoro_stats,
            commands::record_score,
            commands::top_scores,
            commands::unlock_achievement,
            commands::storefront_name,
            commands::desktop_snapshot,
            commands::pet_frame,
            commands::set_pet_visible,
            commands::list_user_characters,
            commands::load_mood,
            commands::save_mood,
            commands::open_user_characters_folder,
            commands::copy_character,
            commands::reload_characters,
            commands::open_panel,
            commands::open_game,
            commands::close_game,
            avoid::avoid_status,
            avoid::pretend_busy,
            avoid::avoid_hide,
            avoid::avoid_show,
            avoid::avoid_stay,
            scheduler::peek_for_held,
            backup::backup_export,
            backup::backup_open,
            backup::backup_restore,
            backup::backup_list_auto,
            post::post_configure,
            post::post_status,
            post::post_devices,
            post::post_refresh,
            post::post_add_device,
            post::post_tailnet,
            post::post_verify,
            post::post_verify_ask,
            post::post_pending_offer,
            post::post_stop_receiving,
            post::post_history,
            post::post_clear_history,
            post::post_open_received,
            post::post_window_shown,
            post::post_attention,
            post::post_send,
            post::post_cancel_send,
            post::post_answer,
            post::post_pick,
            post::post_pick_save_dir,
            post::post_open,
            post::post_peek,
            post::open_post_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the desktop pet");
}

//! The system's language and country (docs/INTERACTIONS.md, "Language and region"), for the
//! "Auto" language and region; and the few texts the app itself shows before or outside the
//! web windows (the first tray menu, file dialogs), in the interface's language.

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::state::AppState;

#[derive(Serialize, Clone, Debug, Default)]
pub struct SystemLocale {
    /// BCP 47 tags, preferred first ("zh-Hant-TW", "en-US").
    pub languages: Vec<String>,
    /// ISO 3166 country ("SG"); none if the system doesn't say.
    pub country: Option<String>,
}

#[tauri::command]
pub fn system_locale() -> SystemLocale {
    system()
}

#[cfg(windows)]
fn system() -> SystemLocale {
    use windows::Win32::Globalization::{GetUserDefaultGeoName, GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
    let mut languages = Vec::new();
    unsafe {
        let (mut count, mut len) = (0u32, 0u32);
        if GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, None, &mut len).is_ok() && len > 0 {
            let mut buf = vec![0u16; len as usize];
            if GetUserPreferredUILanguages(
                MUI_LANGUAGE_NAME,
                &mut count,
                Some(windows::core::PWSTR(buf.as_mut_ptr())),
                &mut len,
            )
            .is_ok()
            {
                // Null-separated, ending in two nulls.
                languages = buf.split(|&c| c == 0).filter(|s| !s.is_empty()).map(String::from_utf16_lossy).collect();
            }
        }
    }
    let country = unsafe {
        let mut buf = [0u16; 16];
        let n = GetUserDefaultGeoName(&mut buf);
        (n > 1).then(|| String::from_utf16_lossy(&buf[..(n as usize - 1)]))
    };
    SystemLocale { languages, country: country.filter(|c| c.len() == 2) }
}

#[cfg(target_os = "macos")]
fn system() -> SystemLocale {
    use core_foundation::array::CFArray;
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    use core_foundation_sys::locale::{
        kCFLocaleCountryCode, CFLocaleCopyCurrent, CFLocaleCopyPreferredLanguages, CFLocaleGetValue,
    };
    unsafe {
        let preferred = CFLocaleCopyPreferredLanguages();
        let languages = if preferred.is_null() {
            Vec::new()
        } else {
            CFArray::<CFString>::wrap_under_create_rule(preferred).iter().map(|s| s.to_string()).collect()
        };
        let current = CFLocaleCopyCurrent();
        let country = if current.is_null() {
            None
        } else {
            let value = CFLocaleGetValue(current, kCFLocaleCountryCode) as CFStringRef;
            let c = (!value.is_null()).then(|| CFString::wrap_under_get_rule(value).to_string());
            core_foundation_sys::base::CFRelease(current as _);
            c
        };
        SystemLocale { languages, country }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn system() -> SystemLocale {
    // Development on Linux: LANG=zh_TW.UTF-8.
    let lang = std::env::var("LANG").unwrap_or_default();
    let tag = lang.split('.').next().unwrap_or("").replace('_', "-");
    let country = tag.split('-').nth(1).map(str::to_string);
    SystemLocale { languages: if tag.is_empty() { vec![] } else { vec![tag] }, country }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    En,
    ZhCn,
    ZhTw,
}

/// The same rule as languageOf in src/i18n/index.ts.
fn lang_of(tag: &str) -> Lang {
    let tag = tag.replace('_', "-").to_lowercase();
    let parts: Vec<&str> = tag.split('-').collect();
    if parts.first() != Some(&"zh") {
        return Lang::En;
    }
    if parts.iter().any(|p| matches!(*p, "hant" | "tw" | "hk" | "mo")) {
        Lang::ZhTw
    } else {
        Lang::ZhCn
    }
}

/// The interface's language: the one in the settings, or the system's.
pub fn ui_lang<R: Runtime>(app: &AppHandle<R>) -> Lang {
    let chosen = app
        .try_state::<AppState>()
        .and_then(|s| s.store().settings().ok())
        .and_then(|s| s.pointer("/locale/language").and_then(|v| v.as_str()).map(str::to_string));
    match chosen.as_deref() {
        Some("en") => Lang::En,
        Some("zh-CN") => Lang::ZhCn,
        Some("zh-TW") => Lang::ZhTw,
        _ => system().languages.first().map(|t| lang_of(t)).unwrap_or(Lang::En),
    }
}

/// A text the app shows itself, in `lang` (the English is the key, as in src/i18n).
pub fn tr(lang: Lang, en: &'static str) -> &'static str {
    let (cn, tw) = match en {
        "Show pet" => ("显示宠物", "顯示寵物"),
        "Open panel…" => ("打开面板…", "開啟面板…"),
        "Quit" => ("退出", "結束"),
        "Export ePet backup" => ("导出 ePet 备份", "匯出 ePet 備份"),
        "Restore ePet backup" => ("从备份恢复 ePet", "從備份還原 ePet"),
        "ePet backup" => ("ePet 备份", "ePet 備份"),
        _ => (en, en),
    };
    match lang {
        Lang::En => en,
        Lang::ZhCn => cn,
        Lang::ZhTw => tw,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_as_the_interface_reads_them() {
        assert_eq!(lang_of("zh-Hant-TW"), Lang::ZhTw);
        assert_eq!(lang_of("zh-HK"), Lang::ZhTw);
        assert_eq!(lang_of("zh_TW"), Lang::ZhTw);
        assert_eq!(lang_of("zh-Hans-CN"), Lang::ZhCn);
        assert_eq!(lang_of("zh-SG"), Lang::ZhCn);
        assert_eq!(lang_of("zh"), Lang::ZhCn);
        assert_eq!(lang_of("en-SG"), Lang::En);
        assert_eq!(lang_of(""), Lang::En);
        assert_eq!(tr(Lang::ZhTw, "Quit"), "結束");
        assert_eq!(tr(Lang::ZhCn, "Something new"), "Something new");
    }
}

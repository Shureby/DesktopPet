//! The Tailscale network (docs/INTERACTIONS.md, "Pet Post"): if Tailscale is installed,
//! its devices are asked whether they run LocalSend or ePet. Only what the installed
//! Tailscale client tells (`tailscale status --json`); ePet never changes its settings,
//! signs in or starts it. Tailscale doesn't carry multicast, so this is how they're found.

use std::path::PathBuf;
use std::time::Duration;

use desktoppet_core::post::{parse_tailnet, Tailnet};

/// Where the Tailscale command-line program is, if installed.
fn program() -> Option<PathBuf> {
    let mut places: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(dir) = std::env::var_os(var) {
                places.push(PathBuf::from(dir).join("Tailscale").join("tailscale.exe"));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        // The app (from the App Store or the website) is also its command-line program.
        places.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale".into());
        places.push("/opt/homebrew/bin/tailscale".into());
        places.push("/usr/local/bin/tailscale".into());
    }
    #[cfg(target_os = "linux")]
    {
        places.push("/usr/bin/tailscale".into());
        places.push("/usr/local/bin/tailscale".into());
    }
    let name = if cfg!(windows) { "tailscale.exe" } else { "tailscale" };
    if let Some(path) = std::env::var_os("PATH") {
        places.extend(std::env::split_paths(&path).map(|d| d.join(name)));
    }
    places.into_iter().find(|p| p.is_file())
}

/// What the Tailscale client says now ("missing" if there's none).
pub async fn status() -> Tailnet {
    // The end-to-end tests pretend: a file with what `tailscale status --json` would say,
    // or "missing".
    if crate::commands::e2e_enabled() {
        if let Some(path) = std::env::var_os("EPET_TAILSCALE_STATUS") {
            if path == "missing" {
                return missing();
            }
            return match std::fs::read_to_string(&path) {
                Ok(json) => parse_tailnet(&json),
                Err(_) => missing(),
            };
        }
    }
    let Some(program) = program() else { return missing() };
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(["status", "--json"]).kill_on_drop(true).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        // No console window flashing up.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match tokio::time::timeout(Duration::from_secs(5), cmd.output()).await {
        Ok(Ok(out)) => {
            let text = String::from_utf8_lossy(&out.stdout);
            let mut t = parse_tailnet(&text);
            if t.state == "error" && !out.status.success() {
                // Installed, but its service isn't running.
                t.state = "stopped".into();
            }
            t
        }
        _ => Tailnet { state: "error".into(), ..Default::default() },
    }
}

fn missing() -> Tailnet {
    Tailnet { state: "missing".into(), ..Default::default() }
}

//! Hardware readings for the pet's hover card and its alerts (docs/INTERACTIONS.md,
//! "Hardware"): CPU, memory, GPU, disk, network and battery, read only when asked.
//!
//! No drivers: what the system tells any program. Windows has no CPU temperature or fan
//! speed without a kernel driver, so those come from HWiNFO or LibreHardwareMonitor when
//! one of them runs; otherwise they're simply not there. An item the computer can't read
//! is left out of the reading (the UI says "can't read this on this computer").

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
#[cfg(not(windows))]
use sysinfo::Components;
use sysinfo::{CpuRefreshKind, Disks, MemoryRefreshKind, Networks, RefreshKind, System};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

/// What can be read. The UI asks only for what it shows (or watches for an alert).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Item {
    Cpu,
    CpuFreq,
    CpuTemp,
    Fan,
    Memory,
    Gpu,
    GpuTemp,
    Vram,
    Disk,
    Network,
    Battery,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Used {
    pub used: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpace {
    pub free: u64,
    pub total: u64,
    /// The system disk's name as the user knows it ("C:" on Windows, "/" elsewhere).
    pub name: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Speed {
    /// Bytes per second.
    pub down: f64,
    pub up: f64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    pub percent: f64,
    /// On the charger (charging or full).
    pub plugged: bool,
}

/// One reading: an item is missing when this computer can't read it.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    /// Percent, all cores.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f64>,
    /// MHz, now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_freq: Option<f64>,
    /// °C, the hottest CPU sensor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_temp: Option<f64>,
    /// RPM, the fastest fan.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fan: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<Used>,
    /// Percent, the busiest GPU.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_temp: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vram: Option<Used>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk: Option<DiskSpace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<Speed>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery: Option<Battery>,
}

/// Temperatures and fans from one place (a sensor tool, the SMC…).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct Thermal {
    pub cpu: Option<f64>,
    pub gpu: Option<f64>,
    pub fan: Option<f64>,
}

/// CPU usage and network speed are differences between two looks: one older than this
/// is taken again, a moment apart, so the first reading is right too.
const STALE: Duration = Duration::from_secs(3);
const SETTLE: Duration = Duration::from_millis(250);

struct Sampler {
    sys: System,
    networks: Networks,
    disks: Disks,
    #[cfg(not(windows))]
    components: Components,
    cpu_at: Option<Instant>,
    net_at: Option<Instant>,
    #[cfg(windows)]
    win: windows::Win,
}

// The Windows counters are handles used from one thread at a time (behind the mutex).
unsafe impl Send for Sampler {}

impl Sampler {
    fn new() -> Self {
        Sampler {
            sys: System::new_with_specifics(RefreshKind::nothing()),
            networks: Networks::new(),
            disks: Disks::new(),
            #[cfg(not(windows))]
            components: Components::new(),
            cpu_at: None,
            net_at: None,
            #[cfg(windows)]
            win: windows::Win::new(),
        }
    }

    fn read(&mut self, items: &[Item]) -> Reading {
        let has = |i: Item| items.contains(&i);
        let mut r = Reading::default();
        let now = Instant::now();
        let wants_cpu = has(Item::Cpu) || has(Item::CpuFreq);
        let cpu_stale = wants_cpu && self.cpu_at.is_none_or(|t| now - t > STALE);
        let net_stale = has(Item::Network) && self.net_at.is_none_or(|t| now - t > STALE);
        // A first look, then one more a moment later (both at once when both are stale).
        if cpu_stale || net_stale {
            if cpu_stale {
                self.sys.refresh_cpu_specifics(CpuRefreshKind::nothing().with_cpu_usage().with_frequency());
                #[cfg(windows)]
                self.win.prime();
            }
            if net_stale {
                self.networks.refresh(true);
                self.net_at = Some(Instant::now());
            }
            std::thread::sleep(SETTLE.max(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL));
        }
        if wants_cpu {
            self.sys.refresh_cpu_specifics(CpuRefreshKind::nothing().with_cpu_usage().with_frequency());
            self.cpu_at = Some(Instant::now());
            if has(Item::Cpu) {
                r.cpu = Some(f64::from(self.sys.global_cpu_usage()).clamp(0.0, 100.0));
            }
            if has(Item::CpuFreq) {
                r.cpu_freq = self.cpu_freq();
            }
        }
        if has(Item::Memory) {
            self.sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
            let total = self.sys.total_memory();
            if total > 0 {
                r.memory = Some(Used { used: self.sys.used_memory().min(total), total });
            }
        }
        if has(Item::Network) {
            let since = self.net_at.map(|t| t.elapsed()).unwrap_or(SETTLE);
            self.networks.refresh(true);
            self.net_at = Some(Instant::now());
            let secs = since.as_secs_f64().max(0.05);
            let (mut down, mut up) = (0u64, 0u64);
            for (name, data) in self.networks.iter() {
                let lower = name.to_ascii_lowercase();
                if lower == "lo" || lower.starts_with("lo0") || lower.contains("loopback") {
                    continue;
                }
                down += data.received();
                up += data.transmitted();
            }
            r.network = Some(Speed { down: down as f64 / secs, up: up as f64 / secs });
        }
        if has(Item::Disk) {
            r.disk = self.system_disk();
        }
        if has(Item::Battery) {
            r.battery = battery();
        }
        let thermal_wanted = has(Item::CpuTemp) || has(Item::GpuTemp) || has(Item::Fan);
        let gpu_wanted = has(Item::Gpu) || has(Item::Vram) || has(Item::GpuTemp);
        let mut thermal = Thermal::default();
        if thermal_wanted {
            thermal = self.thermal();
        }
        if has(Item::CpuTemp) {
            r.cpu_temp = thermal.cpu.filter(|t| plausible_temp(*t));
        }
        if has(Item::Fan) {
            r.fan = thermal.fan.filter(|f| *f >= 0.0);
        }
        if gpu_wanted {
            let g = self.gpu(has(Item::Gpu), has(Item::Vram), has(Item::GpuTemp));
            r.gpu = g.usage.map(|u| u.clamp(0.0, 100.0));
            r.vram = g.vram;
            r.gpu_temp = g.temp.or(thermal.gpu).filter(|t| plausible_temp(*t));
        }
        r
    }

    fn cpu_freq(&mut self) -> Option<f64> {
        let cpus = self.sys.cpus();
        if cpus.is_empty() {
            return None;
        }
        #[cfg(windows)]
        {
            // What Windows reports is the base clock; the performance counter says how far
            // above or below it the cores run now (as Task Manager shows "Speed").
            let base = cpus.iter().map(|c| c.frequency()).max().unwrap_or(0) as f64;
            if base <= 0.0 {
                return None;
            }
            self.win.performance().map(|p| base * p / 100.0)
        }
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            // Apple silicon doesn't say (no public way): left out.
            None
        }
        #[cfg(not(any(windows, all(target_os = "macos", target_arch = "aarch64"))))]
        {
            let sum: u64 = cpus.iter().map(|c| c.frequency()).sum();
            let avg = sum as f64 / cpus.len() as f64;
            (avg > 0.0).then_some(avg)
        }
    }

    fn system_disk(&mut self) -> Option<DiskSpace> {
        self.disks.refresh(true);
        #[cfg(windows)]
        let root = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        #[cfg(not(windows))]
        let root = String::from("/");
        let disk = self.disks.list().iter().find(|d| {
            let m = d.mount_point().to_string_lossy();
            #[cfg(windows)]
            return m.trim_end_matches('\\').eq_ignore_ascii_case(&root);
            #[cfg(not(windows))]
            return m == root || (cfg!(target_os = "macos") && m == "/System/Volumes/Data");
        })?;
        (disk.total_space() > 0).then(|| DiskSpace {
            free: disk.available_space(),
            total: disk.total_space(),
            name: root,
        })
    }

    fn thermal(&mut self) -> Thermal {
        #[cfg(windows)]
        {
            self.win.thermal()
        }
        #[cfg(not(windows))]
        {
            self.components.refresh(true);
            let mut t = Thermal::default();
            for c in self.components.list() {
                let Some(temp) = c.temperature().map(f64::from) else { continue };
                if !plausible_temp(temp) {
                    continue;
                }
                match sensor_kind(c.label()) {
                    Some(Sensor::Cpu) => t.cpu = Some(t.cpu.map_or(temp, |v| v.max(temp))),
                    Some(Sensor::Gpu) => t.gpu = Some(t.gpu.map_or(temp, |v| v.max(temp))),
                    None => {}
                }
            }
            #[cfg(target_os = "macos")]
            {
                t.fan = macos::fan_rpm();
            }
            t
        }
    }

    fn gpu(&mut self, usage: bool, vram: bool, temp: bool) -> Gpu {
        #[cfg(windows)]
        {
            self.win.gpu(usage, vram, temp)
        }
        #[cfg(target_os = "macos")]
        {
            let _ = (vram, temp);
            Gpu { usage: if usage { macos::gpu_usage() } else { None }, ..Gpu::default() }
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (usage, vram, temp);
            Gpu::default()
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct Gpu {
    pub usage: Option<f64>,
    pub vram: Option<Used>,
    pub temp: Option<f64>,
}

/// A sensor reading that can be a real temperature (not 0, not an unset 255 or −273).
fn plausible_temp(t: f64) -> bool {
    (5.0..=125.0).contains(&t)
}

#[cfg(not(windows))]
#[derive(Debug, PartialEq)]
enum Sensor {
    Cpu,
    Gpu,
}

/// Which part a temperature sensor belongs to, by its name (macOS, Linux).
#[cfg(not(windows))]
fn sensor_kind(label: &str) -> Option<Sensor> {
    let l = label.to_ascii_lowercase();
    if l.contains("gpu") || l.contains("amdgpu") || l.contains("nouveau") {
        return Some(Sensor::Gpu);
    }
    // Intel ("Package id 0", "Core 0"), AMD (Tctl/Tdie), Apple silicon (PMU tdie/tdev, pACC/eACC).
    const CPU: [&str; 9] = ["cpu", "package", "core ", "tctl", "tdie", "tdev", "pacc", "eacc", "k10temp"];
    CPU.iter().any(|k| l.contains(k)).then_some(Sensor::Cpu)
}

fn battery() -> Option<Battery> {
    let manager = starship_battery::Manager::new().ok()?;
    let b = manager.batteries().ok()?.flatten().next()?;
    let percent = f64::from(b.state_of_charge().value) * 100.0;
    let plugged = !matches!(b.state(), starship_battery::State::Discharging);
    Some(Battery { percent: percent.clamp(0.0, 100.0), plugged })
}

static SAMPLER: Mutex<Option<Sampler>> = Mutex::new(None);

/// One reading of `items` (missing ones can't be read here). Blocks up to ~¼ s when CPU
/// usage or network speed haven't been looked at lately.
pub fn read(items: &[Item]) -> Reading {
    let mut guard = SAMPLER.lock().unwrap_or_else(|e| e.into_inner());
    guard.get_or_insert_with(Sampler::new).read(items)
}

/// Reads hardware for the hover card and the alerts. Takes ~¼ s the first time.
#[tauri::command]
pub async fn hw_read(items: Vec<Item>) -> Result<Reading, String> {
    tauri::async_runtime::spawn_blocking(move || read(&items)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_is_asked_and_nothing_else() {
        let r = read(&[Item::Memory, Item::Cpu]);
        let m = r.memory.expect("memory");
        assert!(m.total > 0 && m.used <= m.total);
        let cpu = r.cpu.expect("cpu");
        assert!((0.0..=100.0).contains(&cpu));
        assert!(r.network.is_none() && r.disk.is_none() && r.battery.is_none());
        let n = read(&[Item::Network]).network.expect("network");
        assert!(n.down >= 0.0 && n.up >= 0.0);
    }

    #[test]
    #[cfg(not(windows))]
    fn sorts_sensors_by_name() {
        assert_eq!(sensor_kind("coretemp Package id 0"), Some(Sensor::Cpu));
        assert_eq!(sensor_kind("k10temp Tctl"), Some(Sensor::Cpu));
        assert_eq!(sensor_kind("PMU tdie3"), Some(Sensor::Cpu));
        assert_eq!(sensor_kind("GPU MTR Temp Sensor1"), Some(Sensor::Gpu));
        assert_eq!(sensor_kind("amdgpu edge"), Some(Sensor::Gpu));
        assert_eq!(sensor_kind("NAND CH0 temp"), None);
        assert!(!plausible_temp(0.0) && !plausible_temp(255.0) && plausible_temp(48.5));
    }

    #[test]
    fn leaves_out_what_it_cannot_read() {
        let json = serde_json::to_value(Reading { cpu: Some(12.0), ..Reading::default() }).unwrap();
        assert_eq!(json, serde_json::json!({ "cpu": 12.0 }));
    }
}

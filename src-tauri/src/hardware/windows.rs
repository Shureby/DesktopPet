//! Windows: performance counters (CPU speed, GPU load and memory, as Task Manager shows
//! them), the graphics driver (GPU temperature, WDDM 2.4+) and, for CPU temperature and
//! fans, HWiNFO's shared memory or LibreHardwareMonitor's WMI sensors when either runs.

use super::{Gpu, Thermal, Used};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use windows::core::{w, BSTR, PCWSTR};
use windows::Wdk::Graphics::Direct3D::{
    D3DKMTCloseAdapter, D3DKMTEnumAdapters2, D3DKMTQueryAdapterInfo, D3DKMT_ADAPTERINFO, D3DKMT_ADAPTER_PERFDATA,
    D3DKMT_CLOSEADAPTER, D3DKMT_ENUMADAPTERS2, D3DKMT_QUERYADAPTERINFO, KMTQAITYPE_ADAPTERPERFDATA,
};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoSetProxyBlanket, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, EOAC_NONE,
    RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
};
use windows::Win32::System::Memory::{MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhGetFormattedCounterValue, PDH_FMT_COUNTERVALUE, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER,
    PDH_HQUERY, PDH_MORE_DATA,
};
use windows::Win32::System::Rpc::{RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE};
use windows::Win32::System::Wmi::{
    IWbemLocator, WbemLocator, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY, WBEM_INFINITE,
};

/// How long "LibreHardwareMonitor isn't there" is believed before asking WMI again.
const LHM_RETRY: Duration = Duration::from_secs(60);

pub struct Win {
    query: Option<PDH_HQUERY>,
    perf: Option<PDH_HCOUNTER>,
    engine: Option<PDH_HCOUNTER>,
    adapter_mem: Option<PDH_HCOUNTER>,
    vram_total: Option<u64>,
    lhm_missing_at: Option<Instant>,
    com: bool,
}

impl Win {
    pub fn new() -> Win {
        let mut win = Win {
            query: None,
            perf: None,
            engine: None,
            adapter_mem: None,
            vram_total: None,
            lhm_missing_at: None,
            com: false,
        };
        unsafe {
            let mut q = PDH_HQUERY::default();
            if windows::Win32::System::Performance::PdhOpenQueryW(PCWSTR::null(), 0, &mut q) == 0 {
                win.query = Some(q);
                win.perf = win.counter(w!("\\Processor Information(_Total)\\% Processor Performance"));
                win.engine = win.counter(w!("\\GPU Engine(*)\\Utilization Percentage"));
                win.adapter_mem = win.counter(w!("\\GPU Adapter Memory(*)\\Dedicated Usage"));
                let _ = PdhCollectQueryData(q);
            }
        }
        win
    }

    fn counter(&self, path: PCWSTR) -> Option<PDH_HCOUNTER> {
        let q = self.query?;
        let mut c = PDH_HCOUNTER::default();
        (unsafe { PdhAddEnglishCounterW(q, path, 0, &mut c) } == 0).then_some(c)
    }

    /// The first of two looks (rates need two).
    pub fn prime(&mut self) {
        if let Some(q) = self.query {
            unsafe { PdhCollectQueryData(q) };
        }
    }

    fn collect(&self) {
        if let Some(q) = self.query {
            unsafe { PdhCollectQueryData(q) };
        }
    }

    /// "% Processor Performance": the cores' speed now against their base clock.
    pub fn performance(&mut self) -> Option<f64> {
        let c = self.perf?;
        self.collect();
        let mut v = PDH_FMT_COUNTERVALUE::default();
        let ok = unsafe { PdhGetFormattedCounterValue(c, PDH_FMT_DOUBLE, None, &mut v) } == 0;
        let p = unsafe { v.Anonymous.doubleValue };
        (ok && p.is_finite() && p > 0.0).then_some(p)
    }

    fn values(&self, c: PDH_HCOUNTER) -> Vec<(String, f64)> {
        unsafe {
            let mut size = 0u32;
            let mut count = 0u32;
            if PdhGetFormattedCounterArrayW(c, PDH_FMT_DOUBLE, &mut size, &mut count, None) != PDH_MORE_DATA
                || size == 0
            {
                return Vec::new();
            }
            let mut buf = vec![0u8; size as usize];
            let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(c, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) != 0 {
                return Vec::new();
            }
            std::slice::from_raw_parts(items, count as usize)
                .iter()
                .filter(|i| i.FmtValue.CStatus == 0)
                .map(|i| (i.szName.to_string().unwrap_or_default(), i.FmtValue.Anonymous.doubleValue))
                .collect()
        }
    }

    pub fn gpu(&mut self, usage: bool, vram: bool, temp: bool) -> Gpu {
        let mut g = Gpu::default();
        if usage || vram {
            self.collect();
        }
        if usage {
            if let Some(c) = self.engine {
                // Task Manager's figure: per adapter and engine type, the busiest.
                let mut sums: HashMap<String, f64> = HashMap::new();
                for (name, v) in self.values(c) {
                    let luid = name.split("_phys").next().and_then(|n| n.split("luid_").nth(1)).unwrap_or("");
                    let engine = name.rsplit("engtype_").next().unwrap_or("");
                    *sums.entry(format!("{luid}|{engine}")).or_default() += v;
                }
                g.usage = if sums.is_empty() { None } else { Some(sums.values().copied().fold(0.0, f64::max)) };
            }
        }
        if vram {
            let used = self.adapter_mem.map(|c| self.values(c).into_iter().map(|(_, v)| v).fold(0.0, f64::max));
            if self.vram_total.is_none() {
                self.vram_total = dedicated_memory();
            }
            if let (Some(used), Some(total)) = (used, self.vram_total) {
                g.vram = Some(Used { used: (used.max(0.0) as u64).min(total), total });
            }
        }
        if temp {
            g.temp = driver_gpu_temp();
        }
        g
    }

    pub fn thermal(&mut self) -> Thermal {
        if let Some(t) = hwinfo() {
            return t;
        }
        if self.lhm_missing_at.is_some_and(|t| t.elapsed() < LHM_RETRY) {
            return Thermal::default();
        }
        if !self.com {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            self.com = true;
        }
        match librehardwaremonitor() {
            Some(t) => {
                self.lhm_missing_at = None;
                t
            }
            None => {
                self.lhm_missing_at = Some(Instant::now());
                Thermal::default()
            }
        }
    }
}

impl Drop for Win {
    fn drop(&mut self) {
        if let Some(q) = self.query {
            unsafe { PdhCloseQuery(q) };
        }
    }
}

/// The largest dedicated video memory of a real (not software) adapter.
fn dedicated_memory() -> Option<u64> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let mut best = 0u64;
        let mut i = 0;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            i += 1;
            if let Ok(desc) = adapter.GetDesc1() {
                if desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) == 0 {
                    best = best.max(desc.DedicatedVideoMemory as u64);
                }
            }
        }
        (best > 0).then_some(best)
    }
}

/// The hottest GPU the driver reports on (Task Manager's "GPU temperature").
fn driver_gpu_temp() -> Option<f64> {
    unsafe {
        let mut e = D3DKMT_ENUMADAPTERS2::default();
        if D3DKMTEnumAdapters2(&mut e).is_err() || e.NumAdapters == 0 {
            return None;
        }
        let mut adapters = vec![D3DKMT_ADAPTERINFO::default(); e.NumAdapters as usize];
        e.pAdapters = adapters.as_mut_ptr();
        if D3DKMTEnumAdapters2(&mut e).is_err() {
            return None;
        }
        let mut best: Option<f64> = None;
        for a in adapters.iter().take(e.NumAdapters as usize) {
            let mut perf = D3DKMT_ADAPTER_PERFDATA::default();
            let mut q = D3DKMT_QUERYADAPTERINFO {
                hAdapter: a.hAdapter,
                Type: KMTQAITYPE_ADAPTERPERFDATA,
                pPrivateDriverData: &mut perf as *mut _ as *mut _,
                PrivateDriverDataSize: std::mem::size_of::<D3DKMT_ADAPTER_PERFDATA>() as u32,
            };
            // Deci-degrees; 0 when the adapter doesn't say.
            if D3DKMTQueryAdapterInfo(&mut q).is_ok() && perf.Temperature > 0 {
                let t = f64::from(perf.Temperature) / 10.0;
                best = Some(best.map_or(t, |b| b.max(t)));
            }
            let _ = D3DKMTCloseAdapter(&D3DKMT_CLOSEADAPTER { hAdapter: a.hAdapter });
        }
        best
    }
}

// --- HWiNFO ----------------------------------------------------------------------------

const HWINFO_SIGNATURE: u32 = u32::from_le_bytes(*b"HWiS");

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn f64_at(b: &[u8], at: usize) -> Option<f64> {
    Some(f64::from_le_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

fn text_at(b: &[u8], at: usize, len: usize) -> String {
    let raw = b.get(at..at + len).unwrap_or(&[]);
    let end = raw.iter().position(|c| *c == 0).unwrap_or(raw.len());
    String::from_utf8_lossy(&raw[..end]).into_owned()
}

/// CPU and GPU temperatures and the fastest fan from HWiNFO's shared memory
/// ("Shared Memory Support" ticked in its settings).
fn hwinfo() -> Option<Thermal> {
    unsafe {
        let map = OpenFileMappingW(FILE_MAP_READ.0, false, w!("Global\\HWiNFO_SENS_SM2")).ok()?;
        let view = MapViewOfFile(map, FILE_MAP_READ, 0, 0, 0);
        let result = if view.Value.is_null() {
            None
        } else {
            let base = view.Value as *const u8;
            let header = std::slice::from_raw_parts(base, 44);
            let parsed = (|| {
                if u32_at(header, 0)? != HWINFO_SIGNATURE {
                    return None;
                }
                let (sensor_off, sensor_size, sensors) =
                    (u32_at(header, 20)?, u32_at(header, 24)?, u32_at(header, 28)?);
                let (reading_off, reading_size, readings) =
                    (u32_at(header, 32)?, u32_at(header, 36)?, u32_at(header, 40)?);
                let len = (reading_off + reading_size * readings).max(sensor_off + sensor_size * sensors) as usize;
                let all = std::slice::from_raw_parts(base, len);
                let sensor_names: Vec<String> =
                    (0..sensors).map(|i| text_at(all, (sensor_off + i * sensor_size) as usize + 8, 128)).collect();
                let mut rows = Vec::new();
                for i in 0..readings {
                    let at = (reading_off + i * reading_size) as usize;
                    let kind = u32_at(all, at)?;
                    let sensor = u32_at(all, at + 4)? as usize;
                    let label = text_at(all, at + 12, 128);
                    let value = f64_at(all, at + 284)?;
                    rows.push(SensorRow {
                        kind,
                        sensor: sensor_names.get(sensor).cloned().unwrap_or_default(),
                        label,
                        value,
                    });
                }
                Some(thermal_from(&rows))
            })();
            let _ = UnmapViewOfFile(view);
            parsed
        };
        let _ = CloseHandle(map);
        result
    }
}

/// One reading from a sensor tool: `kind` 1 is a temperature, 3 a fan (HWiNFO's numbers).
struct SensorRow {
    kind: u32,
    sensor: String,
    label: String,
    value: f64,
}

/// The CPU (package, Tctl/Tdie, hottest core), the GPU, the fastest fan.
fn thermal_from(rows: &[SensorRow]) -> Thermal {
    let mut t = Thermal::default();
    let max = |a: Option<f64>, v: f64| Some(a.map_or(v, |a: f64| a.max(v)));
    for r in rows {
        let label = r.label.to_ascii_lowercase();
        let sensor = r.sensor.to_ascii_lowercase();
        match r.kind {
            1 if (5.0..=125.0).contains(&r.value) => {
                let gpu = label.starts_with("gpu") || sensor.contains("gpu");
                let cpu = !gpu
                    && (label.contains("cpu package")
                        || label.contains("tctl")
                        || label.contains("tdie")
                        || label == "core max"
                        || label.starts_with("cpu (")
                        || (sensor.contains("cpu") && label.contains("package")));
                if cpu {
                    t.cpu = max(t.cpu, r.value);
                } else if gpu
                    && (label.contains("gpu temperature")
                        || label == "gpu core"
                        || label.contains("hot spot")
                        || label == "gpu")
                {
                    t.gpu = max(t.gpu, r.value);
                }
            }
            3 if r.value > 0.0 && r.value < 20_000.0 => t.fan = max(t.fan, r.value),
            _ => {}
        }
    }
    t
}

// --- LibreHardwareMonitor ---------------------------------------------------------------

/// Its sensors, through the WMI namespace it publishes while running.
fn librehardwaremonitor() -> Option<Thermal> {
    unsafe {
        let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER).ok()?;
        let services = locator
            .ConnectServer(
                &BSTR::from("root\\LibreHardwareMonitor"),
                &BSTR::new(),
                &BSTR::new(),
                &BSTR::new(),
                0,
                &BSTR::new(),
                None,
            )
            .ok()?;
        let _ = CoSetProxyBlanket(
            &services,
            RPC_C_AUTHN_WINNT,
            RPC_C_AUTHZ_NONE,
            PCWSTR::null(),
            RPC_C_AUTHN_LEVEL_CALL,
            RPC_C_IMP_LEVEL_IMPERSONATE,
            None,
            EOAC_NONE,
        );
        let rows = services
            .ExecQuery(
                &BSTR::from("WQL"),
                &BSTR::from("SELECT Name, Identifier, SensorType, Value FROM Sensor WHERE SensorType='Temperature' OR SensorType='Fan'"),
                WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY,
                None,
            )
            .ok()?;
        let mut out = Vec::new();
        loop {
            let mut objs = [None];
            let mut got = 0u32;
            if rows.Next(WBEM_INFINITE, &mut objs, &mut got).is_err() || got == 0 {
                break;
            }
            let Some(obj) = objs[0].take() else { break };
            let get = |name: PCWSTR| {
                let mut v = windows::Win32::System::Variant::VARIANT::default();
                obj.Get(name, 0, &mut v, None, None).ok().map(|_| v)
            };
            let text = |name: PCWSTR| get(name).map(|v| v.to_string()).unwrap_or_default();
            let Some(value) = get(w!("Value")).and_then(|v| f64::try_from(&v).ok()) else { continue };
            let kind = if text(w!("SensorType")) == "Fan" { 3 } else { 1 };
            // "/amdcpu/0/temperature/2", "/gpu-nvidia/0/temperature/0", "/lpc/nct6798d/fan/1".
            let id = text(w!("Identifier"));
            let sensor = id.split('/').nth(1).unwrap_or("").to_string();
            let mut label = text(w!("Name"));
            if sensor.contains("cpu")
                && (label.contains("Package") || label.contains("Tctl") || label.contains("Core Max"))
            {
                label = format!("cpu package {label}");
            } else if sensor.starts_with("gpu") && label.contains("GPU Core") {
                label = "gpu core".into();
            }
            out.push(SensorRow { kind, sensor, label, value });
        }
        Some(thermal_from(&out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_cpu_the_gpu_and_the_fastest_fan() {
        let row = |kind, sensor: &str, label: &str, value| SensorRow {
            kind,
            sensor: sensor.into(),
            label: label.into(),
            value,
        };
        let t = thermal_from(&[
            row(1, "CPU [#0]: AMD Ryzen 7 5800X: Enhanced", "CPU (Tctl/Tdie)", 61.5),
            row(1, "CPU [#0]: AMD Ryzen 7 5800X", "Core0 (CCD1)", 58.0),
            row(1, "GPU [#0]: NVIDIA GeForce RTX 3070", "GPU Temperature", 47.0),
            row(1, "S.M.A.R.T.: Samsung SSD", "Drive Temperature", 39.0),
            row(3, "ASUS ROG STRIX B550-F (Nuvoton NCT6798D)", "CPU", 1180.0),
            row(3, "ASUS ROG STRIX B550-F (Nuvoton NCT6798D)", "Chassis1", 860.0),
        ]);
        assert_eq!(t.cpu, Some(61.5));
        assert_eq!(t.gpu, Some(47.0));
        assert_eq!(t.fan, Some(1180.0));
    }
}

//! macOS: fan speed from the SMC and GPU load from the graphics driver's statistics,
//! both through IOKit (no privileges needed). Temperatures come from sysinfo.

use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation_sys::base::{kCFAllocatorDefault, CFAllocatorRef, CFTypeRef};
use core_foundation_sys::dictionary::CFMutableDictionaryRef;
use core_foundation_sys::string::CFStringRef;
use std::ffi::{c_char, c_void};

type KernReturn = i32;
type MachPort = u32;
type IoObject = MachPort;
type IoConnect = MachPort;

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOServiceMatching(name: *const c_char) -> CFMutableDictionaryRef;
    fn IOServiceGetMatchingService(main_port: MachPort, matching: CFMutableDictionaryRef) -> IoObject;
    fn IOServiceGetMatchingServices(
        main_port: MachPort,
        matching: CFMutableDictionaryRef,
        existing: *mut IoObject,
    ) -> KernReturn;
    fn IOIteratorNext(iterator: IoObject) -> IoObject;
    fn IOObjectRelease(object: IoObject) -> KernReturn;
    fn IOServiceOpen(service: IoObject, owning_task: MachPort, kind: u32, connect: *mut IoConnect) -> KernReturn;
    fn IOServiceClose(connect: IoConnect) -> KernReturn;
    fn IOConnectCallStructMethod(
        connect: IoConnect,
        selector: u32,
        input: *const c_void,
        input_size: usize,
        output: *mut c_void,
        output_size: *mut usize,
    ) -> KernReturn;
    fn IORegistryEntryCreateCFProperty(
        entry: IoObject,
        key: CFStringRef,
        allocator: CFAllocatorRef,
        options: u32,
    ) -> CFTypeRef;
}

extern "C" {
    static mach_task_self_: MachPort;
}

// --- The SMC ------------------------------------------------------------------------

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct SmcVersion {
    major: u8,
    minor: u8,
    build: u8,
    reserved: u8,
    release: u16,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct SmcPLimit {
    version: u16,
    length: u16,
    cpu: u32,
    gpu: u32,
    mem: u32,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct SmcKeyInfo {
    data_size: u32,
    data_type: u32,
    data_attributes: u8,
}

/// `SMCKeyData_t`, as the SMC user client expects it (80 bytes).
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct SmcKeyData {
    key: u32,
    vers: SmcVersion,
    p_limit: SmcPLimit,
    key_info: SmcKeyInfo,
    result: u8,
    status: u8,
    data8: u8,
    data32: u32,
    bytes: [u8; 32],
}

const KERNEL_INDEX_SMC: u32 = 2;
const SMC_READ_BYTES: u8 = 5;
const SMC_READ_KEYINFO: u8 = 9;

fn four_cc(s: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*s)
}

struct Smc(IoConnect);

impl Smc {
    fn open() -> Option<Smc> {
        unsafe {
            let service = IOServiceGetMatchingService(0, IOServiceMatching(c"AppleSMC".as_ptr()));
            if service == 0 {
                return None;
            }
            let mut conn: IoConnect = 0;
            let ok = IOServiceOpen(service, mach_task_self_, 0, &mut conn);
            IOObjectRelease(service);
            (ok == 0 && conn != 0).then_some(Smc(conn))
        }
    }

    fn call(&self, input: &SmcKeyData) -> Option<SmcKeyData> {
        let mut output = SmcKeyData::default();
        let mut size = std::mem::size_of::<SmcKeyData>();
        let ok = unsafe {
            IOConnectCallStructMethod(
                self.0,
                KERNEL_INDEX_SMC,
                input as *const _ as *const c_void,
                std::mem::size_of::<SmcKeyData>(),
                &mut output as *mut _ as *mut c_void,
                &mut size,
            )
        };
        (ok == 0 && output.result == 0).then_some(output)
    }

    /// A key's value and its type (`fpe2`, `flt `, `ui8 `…).
    fn read(&self, key: &[u8; 4]) -> Option<([u8; 32], u32, u32)> {
        let info = self.call(&SmcKeyData { key: four_cc(key), data8: SMC_READ_KEYINFO, ..Default::default() })?;
        let size = info.key_info.data_size;
        let out = self.call(&SmcKeyData {
            key: four_cc(key),
            key_info: SmcKeyInfo { data_size: size, ..Default::default() },
            data8: SMC_READ_BYTES,
            ..Default::default()
        })?;
        Some((out.bytes, info.key_info.data_type, size))
    }

    fn number(&self, key: &[u8; 4]) -> Option<f64> {
        let (b, kind, size) = self.read(key)?;
        match &kind.to_be_bytes() {
            b"ui8 " => Some(f64::from(b[0])),
            b"ui16" => Some(f64::from(u16::from_be_bytes([b[0], b[1]]))),
            b"fpe2" => Some(f64::from((u16::from(b[0]) << 6) + (u16::from(b[1]) >> 2))),
            b"flt " if size == 4 => Some(f64::from(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))),
            _ => None,
        }
    }
}

impl Drop for Smc {
    fn drop(&mut self) {
        unsafe { IOServiceClose(self.0) };
    }
}

/// The fastest fan, RPM; None on a Mac without fans (or that doesn't say).
pub fn fan_rpm() -> Option<f64> {
    let smc = Smc::open()?;
    let count = smc.number(b"FNum")? as u8;
    (0..count.min(8))
        .filter_map(|i| smc.number(&[b'F', b'0' + i, b'A', b'c']))
        .filter(|rpm| rpm.is_finite() && *rpm >= 0.0)
        .reduce(f64::max)
}

// --- The GPU ------------------------------------------------------------------------

/// "Device Utilization %" of the busiest graphics processor.
pub fn gpu_usage() -> Option<f64> {
    let mut best: Option<f64> = None;
    unsafe {
        let mut iter: IoObject = 0;
        if IOServiceGetMatchingServices(0, IOServiceMatching(c"IOAccelerator".as_ptr()), &mut iter) != 0 {
            return None;
        }
        let key = CFString::from_static_string("PerformanceStatistics");
        loop {
            let entry = IOIteratorNext(iter);
            if entry == 0 {
                break;
            }
            let raw = IORegistryEntryCreateCFProperty(entry, key.as_concrete_TypeRef(), kCFAllocatorDefault, 0);
            if !raw.is_null() {
                let stats: CFDictionary<CFString, CFType> = CFDictionary::wrap_under_create_rule(raw as _);
                if let Some(v) = stats.find(CFString::from_static_string("Device Utilization %")) {
                    if let Some(n) = v.downcast::<CFNumber>().and_then(|n| n.to_f64()) {
                        best = Some(best.map_or(n, |b| b.max(n)));
                    }
                }
            }
            IOObjectRelease(entry);
        }
        IOObjectRelease(iter);
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_smc_record_is_the_size_the_kernel_expects() {
        assert_eq!(std::mem::size_of::<SmcKeyData>(), 80);
    }
}

//! Pairing two ePets with a one-time code (docs/INTERACTIONS.md, "Pairing ePets").
//!
//! One ePet (B) shows a 6-digit code; on the other (A) you type it. They run SPAKE2
//! (RustCrypto `spake2`, Ed25519) with the code as the password and both certificates'
//! fingerprints as the identities, over the HTTPS connection they already have. The code
//! never crosses the network: a man in the middle gets one guess, and since his
//! certificates differ from the real ones, even the right code gives him different keys.
//! Each side then proves it got the same key (an HMAC of a fixed label), B first.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use spake2::{Ed25519Group, Identity, Password, Spake2};

/// How long a code shown on B can be typed on A (ms).
pub const CODE_MS: i64 = 2 * 60_000;
/// Wrong codes from one device before its pairing requests are refused for a while.
pub const MAX_FAILURES: usize = 3;
/// ...for this long (ms).
pub const FAILURE_WINDOW_MS: i64 = 10 * 60_000;

/// A fresh code: 6 digits, uniform, from the system's random source.
pub fn new_code() -> String {
    loop {
        let mut b = [0u8; 4];
        getrandom::getrandom(&mut b).expect("system randomness");
        let n = u32::from_le_bytes(b);
        // Uniform: no bias toward low codes from the modulo.
        if n < u32::MAX - u32::MAX % 1_000_000 {
            return format!("{:06}", n % 1_000_000);
        }
    }
}

/// The code as typed: digits only ("482 913" → "482913"); None unless exactly 6.
pub fn normalize_code(typed: &str) -> Option<String> {
    let digits: String = typed.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    (digits.len() == 6 && digits.chars().all(|c| c.is_ascii_digit())).then_some(digits)
}

fn ids(a_fingerprint: &str, b_fingerprint: &str) -> (Identity, Identity) {
    (
        Identity::new(a_fingerprint.to_ascii_uppercase().as_bytes()),
        Identity::new(b_fingerprint.to_ascii_uppercase().as_bytes()),
    )
}

fn confirm(key: &[u8], label: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    mac.update(label);
    mac.finalize().into_bytes().to_vec()
}

const CONFIRM_A: &[u8] = b"ePet pairing: A has the key";
const CONFIRM_B: &[u8] = b"ePet pairing: B has the key";

fn same(a: &[u8], b: &[u8]) -> bool {
    // Constant time (the length isn't secret).
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A's side, between sending its message and getting B's.
pub struct Asker {
    state: Spake2<Ed25519Group>,
}

/// A starts: returns its message for B.
pub fn ask(code: &str, a_fingerprint: &str, b_fingerprint: &str) -> (Asker, Vec<u8>) {
    let (id_a, id_b) = ids(a_fingerprint, b_fingerprint);
    let (state, msg) = Spake2::<Ed25519Group>::start_a(&Password::new(code.as_bytes()), &id_a, &id_b);
    (Asker { state }, msg)
}

impl Asker {
    /// B answered with its message and its proof: A's proof for B if B has the same key;
    /// None when it doesn't (a wrong code, or someone in between).
    pub fn finish(self, b_msg: &[u8], b_confirm: &[u8]) -> Option<Vec<u8>> {
        let key = self.state.finish(b_msg).ok()?;
        same(&confirm(&key, CONFIRM_B), b_confirm).then(|| confirm(&key, CONFIRM_A))
    }
}

/// B's side, after answering A: waits for A's proof.
pub struct Shower {
    key: Vec<u8>,
}

/// B answers A's message with its own, and its proof. None if A's message is malformed.
pub fn answer(
    code: &str,
    a_fingerprint: &str,
    b_fingerprint: &str,
    a_msg: &[u8],
) -> Option<(Shower, Vec<u8>, Vec<u8>)> {
    let (id_a, id_b) = ids(a_fingerprint, b_fingerprint);
    let (state, msg) = Spake2::<Ed25519Group>::start_b(&Password::new(code.as_bytes()), &id_a, &id_b);
    let key = state.finish(a_msg).ok()?;
    let proof = confirm(&key, CONFIRM_B);
    Some((Shower { key }, msg, proof))
}

impl Shower {
    /// A's proof: true if A has the same key (so the code was right and nobody is between).
    pub fn check(&self, a_confirm: &[u8]) -> bool {
        same(&confirm(&self.key, CONFIRM_A), a_confirm)
    }
}

/// Wrong codes from one device: the times (ms) of recent ones.
#[derive(Debug, Default)]
pub struct Failures(std::collections::HashMap<String, Vec<i64>>);

impl Failures {
    pub fn add(&mut self, fingerprint: &str, now: i64) {
        self.0.entry(fingerprint.to_ascii_uppercase()).or_default().push(now);
    }

    pub fn clear(&mut self, fingerprint: &str) {
        self.0.remove(&fingerprint.to_ascii_uppercase());
    }

    /// Too many wrong codes lately: its requests are refused until the window passes.
    pub fn locked(&mut self, fingerprint: &str, now: i64) -> bool {
        let Some(times) = self.0.get_mut(&fingerprint.to_ascii_uppercase()) else {
            return false;
        };
        times.retain(|t| now - t < FAILURE_WINDOW_MS);
        times.len() >= MAX_FAILURES
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "AAAA1111";
    const B: &str = "BBBB2222";

    fn run(code_a: &str, code_b: &str, a_fp_at_b: &str, b_fp_at_a: &str) -> (bool, bool) {
        let (asker, a_msg) = ask(code_a, A, b_fp_at_a);
        let (shower, b_msg, b_proof) = answer(code_b, a_fp_at_b, B, &a_msg).unwrap();
        match asker.finish(&b_msg, &b_proof) {
            Some(a_proof) => (true, shower.check(&a_proof)),
            None => (false, shower.check(&[0u8; 32])),
        }
    }

    #[test]
    fn the_right_code_pairs_both_sides() {
        assert_eq!(run("482913", "482913", A, B), (true, true));
        // Fingerprints in either case are the same identity.
        assert_eq!(run("482913", "482913", &A.to_lowercase(), B), (true, true));
    }

    #[test]
    fn a_wrong_code_fails_both_sides() {
        assert_eq!(run("482914", "482913", A, B), (false, false));
    }

    #[test]
    fn someone_in_between_fails_even_with_the_right_code() {
        // B sees the man in the middle's certificate, not A's; A sees his, not B's.
        assert_eq!(run("482913", "482913", "EEEE9999", B), (false, false));
        assert_eq!(run("482913", "482913", A, "EEEE9999"), (false, false));
    }

    #[test]
    fn codes_are_six_digits_and_typing_is_forgiving() {
        for _ in 0..200 {
            let c = new_code();
            assert_eq!(c.len(), 6);
            assert!(c.chars().all(|d| d.is_ascii_digit()));
        }
        assert_eq!(normalize_code("482 913").as_deref(), Some("482913"));
        assert_eq!(normalize_code("482-913").as_deref(), Some("482913"));
        assert_eq!(normalize_code("48291"), None);
        assert_eq!(normalize_code("48291a"), None);
    }

    #[test]
    fn three_wrong_codes_lock_a_device_for_ten_minutes() {
        let mut f = Failures::default();
        for t in [0, 1000, 2000] {
            assert!(!f.locked(A, t));
            f.add(A, t);
        }
        assert!(f.locked(A, 3000));
        assert!(!f.locked(B, 3000));
        assert!(!f.locked(A, FAILURE_WINDOW_MS + 1000));
        f.add(A, 0);
        f.clear(A);
        assert!(!f.locked(A, 1));
    }

    #[test]
    fn a_malformed_message_is_refused() {
        assert!(answer("482913", A, B, b"nonsense").is_none());
    }
}

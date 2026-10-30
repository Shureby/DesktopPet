// SPAKE2 over Ed25519 as RustCrypto's `spake2` 0.4 (and python-spake2) do it, for the mock
// ePet (localsend-peer.mjs) to pair with the app (desktoppet_core::pair). Tests only.
import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

const Point = ed25519.Point;
const L = Point.CURVE().n;
const M = Point.fromHex(
  "15cfd18e385952982b6a8f8c7854963b58e34388c8e6dae891db756481a02312",
);
const N = Point.fromHex(
  "f04f2e7eb734b2a8f8b472eaf9c3c632576ac64aea650b496a8a20ff00e583c3",
);

const sha = (b) => createHash("sha256").update(b).digest();
const big = (bytes) =>
  BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));

function pwScalar(pw) {
  const okm = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(pw),
      Buffer.alloc(0),
      Buffer.from("SPAKE2 pw"),
      48,
    ),
  );
  return big(okm) % L;
}

function randomScalar() {
  return (big(randomBytes(64)) % (L - 1n)) + 1n;
}

function transcript(pw, idA, idB, x, y, k) {
  return sha(
    Buffer.concat([
      sha(Buffer.from(pw)),
      sha(Buffer.from(idA)),
      sha(Buffer.from(idB)),
      x,
      y,
      k,
    ]),
  );
}

/** One side: `side` "A" or "B". Returns its message, and finish(other) → the key. */
export function spake2(side, pw, idA, idB) {
  const w = pwScalar(pw);
  const s = randomScalar();
  const own = Point.BASE.multiply(s).add((side === "A" ? M : N).multiply(w));
  const ownBytes = Buffer.from(own.toBytes());
  const msg = Buffer.concat([
    Buffer.from([side === "A" ? 0x41 : 0x42]),
    ownBytes,
  ]);
  const finish = (other) => {
    if (other.length !== 33 || other[0] !== (side === "A" ? 0x42 : 0x41))
      throw new Error("bad message");
    const otherBytes = other.subarray(1);
    const k = Point.fromHex(Buffer.from(otherBytes).toString("hex"))
      .add((side === "A" ? N : M).multiply(w).negate())
      .multiply(s);
    const kb = Buffer.from(k.toBytes());
    return side === "A"
      ? transcript(pw, idA, idB, ownBytes, otherBytes, kb)
      : transcript(pw, idA, idB, otherBytes, ownBytes, kb);
  };
  return { msg, finish };
}

export const CONFIRM_A = "ePet pairing: A has the key";
export const CONFIRM_B = "ePet pairing: B has the key";
export const proof = (key, label) =>
  createHmac("sha256", key).update(label).digest();

# Third-party components

Open-source libraries ePet ships with that are worth naming, with their licences. The full
list (with every transitive dependency) comes from `cargo metadata` and
`npm ls --omit=dev`; all are under permissive licences (MIT, Apache-2.0, BSD, ISC, Zlib).

## Pet Post (since 0.44.0)

Pet Post speaks the LocalSend protocol v2, as described at
https://github.com/localsend/protocol. The implementation is ePet's own; no LocalSend code is
included (Verify's icon alphabet aside: see below). "LocalSend" is named only to say what Pet
Post works with.

| Crate | Licence | What for |
|-------|---------|----------|
| tokio | MIT | Network tasks |
| hyper, hyper-util, http-body-util | MIT | HTTP server and client |
| bytes | MIT | Byte buffers |
| futures-util | MIT OR Apache-2.0 | Streaming file uploads |
| rustls, tokio-rustls | Apache-2.0 OR ISC OR MIT / MIT OR Apache-2.0 | TLS |
| ring | Apache-2.0 AND ISC | Cryptography for TLS and certificates |
| rcgen | MIT OR Apache-2.0 | The device's self-signed certificate |
| rustls-webpki, rustls-pki-types | ISC / MIT OR Apache-2.0 | Certificate types |
| sha2 | MIT OR Apache-2.0 | Fingerprints and checksums |
| socket2 | MIT OR Apache-2.0 | Multicast discovery |
| if-addrs | MIT OR BSD-3-Clause | This computer's network addresses |

## Pet Post's Verify (since 0.45.0)

Verify shows what LocalSend's Verify shows, so the two screens can be compared. For that,
two things are taken as they are, both under the Apache License 2.0
(https://www.apache.org/licenses/LICENSE-2.0):

| What | From | Where in ePet |
|------|------|---------------|
| The icon alphabet: the names of 260 icons and their order, and how a fingerprint becomes 16 of them | LocalSend, https://github.com/localsend/localsend (`app/lib/util/fingerprint_alphabet.dart`, `app/lib/pages/verify_page.dart`), © the LocalSend contributors | `scripts/verify-icons.py`, `crates/desktoppet-core/src/post.rs` (`verify_code`) |
| The icons' shapes | Material Icons, https://github.com/google/material-design-icons (`font/MaterialIcons-Regular.ttf`), © Google | `src/features/post/verifyIcons.ts` (made by `scripts/verify-icons.py`) |

Tailscale is not included: when installed, ePet only runs its command-line program to read
its status (`tailscale status --json`). "Tailscale" is a trademark of Tailscale Inc.; ePet
names it only to say what it works with.

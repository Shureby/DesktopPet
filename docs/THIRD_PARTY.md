# Third-party components

Open-source libraries ePet ships with that are worth naming, with their licences. The full
list (with every transitive dependency) comes from `cargo metadata` and
`npm ls --omit=dev`; all are under permissive licences (MIT, Apache-2.0, BSD, ISC, Zlib).

## Pet Post (since 0.44.0)

Pet Post speaks the LocalSend protocol v2, as described at
https://github.com/localsend/protocol. The implementation is ePet's own; no LocalSend code is
included. "LocalSend" is named only to say what Pet Post works with.

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

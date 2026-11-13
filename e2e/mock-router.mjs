/**
 * A pretend router for the router door (src-tauri/src/post/door.rs): NAT-PMP (RFC 6886)
 * on a UDP port of 127.0.0.1, which the app asks instead of its gateway when
 * `EPET_POST_ROUTER=127.0.0.1:<port>` (e2e builds only). Silent, it's a router that
 * answers none of UPnP, NAT-PMP or PCP.
 */
import dgram from "node:dgram";

export class Router {
  /** "silent" | "natpmp". */
  mode = "silent";
  /** Its outside address. */
  outside = "192.168.31.178";
  /** The outside port it gives. */
  gives = 40000;
  /** Doors asked for: { internal, lifetime } (lifetime 0: closed). */
  asks = [];

  constructor(port) {
    this.port = port;
  }

  async start() {
    this.udp = dgram.createSocket("udp4");
    this.udp.on("message", (m, from) => this.handle(m, from));
    await new Promise((r) => this.udp.bind(this.port, "127.0.0.1", r));
  }

  stop() {
    this.udp?.close();
    this.udp = null;
  }

  handle(m, from) {
    if (this.mode !== "natpmp" || m.length < 2 || m[0] !== 0) return;
    const epoch = Buffer.from([0, 0, 0, 1]);
    let reply;
    if (m[1] === 0) {
      reply = Buffer.concat([
        Buffer.from([0, 128, 0, 0]),
        epoch,
        Buffer.from(this.outside.split(".").map(Number)),
      ]);
    } else if (m[1] === 2 && m.length >= 12) {
      const internal = m.readUInt16BE(4);
      const lifetime = m.readUInt32BE(8);
      this.asks.push({ internal, lifetime });
      const r = Buffer.alloc(16);
      r.set([0, 130, 0, 0]);
      epoch.copy(r, 4);
      r.writeUInt16BE(internal, 8);
      r.writeUInt16BE(lifetime ? this.gives : 0, 10);
      r.writeUInt32BE(lifetime, 12);
      reply = r;
    } else return;
    this.udp.send(reply, from.port, from.address);
  }
}

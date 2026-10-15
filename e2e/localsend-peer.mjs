/**
 * A pretend LocalSend device for the Pet Post tests (e2e/post.test.mjs): the LocalSend
 * protocol v2 (https://github.com/localsend/protocol) written from its description, over
 * HTTPS with its own certificate (made with openssl), like the LocalSend apps.
 */
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import dgram from "node:dgram";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = "/api/localsend/v2";
export const GROUP = "224.0.0.167";
export const LOCALSEND_PORT = 53317;

/** A self-signed certificate and key (PEM) and its fingerprint (SHA-256 of the DER, upper-case hex). */
function makeCertificate() {
  const dir = mkdtempSync(join(tmpdir(), "epet-peer-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const r = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "3650", "-subj", "/CN=Mock Phone", "-keyout", key, "-out", cert],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr || r.error}`);
  const pem = readFileSync(cert, "utf8");
  const fingerprint = createHash("sha256").update(new X509Certificate(pem).raw).digest("hex").toUpperCase();
  return { key: readFileSync(key, "utf8"), cert: pem, fingerprint };
}

export class Peer {
  /** What it was sent: prepare-upload bodies, and each file's data by name. */
  offers = [];
  files = new Map();
  /** register requests it got (who introduced themselves). */
  registered = [];
  /** How it answers prepare-upload: "accept" | "decline". */
  answer = "accept";

  constructor(alias = "Mock Phone", port = 53318) {
    this.alias = alias;
    this.port = port;
    this.tls = makeCertificate();
    this.fingerprint = this.tls.fingerprint;
  }

  info(withAddress = true) {
    const base = { alias: this.alias, version: "2.1", deviceModel: "Mock", deviceType: "mobile", fingerprint: this.fingerprint, download: false };
    return withAddress ? { ...base, port: this.port, protocol: "https" } : base;
  }

  /** Listens (HTTPS) as a LocalSend device does. */
  async start() {
    this.sessions = new Map();
    this.server = https.createServer({ key: this.tls.key, cert: this.tls.cert }, (req, res) => this.handle(req, res));
    await new Promise((r) => this.server.listen(this.port, "0.0.0.0", r));
  }

  async stop() {
    this.server?.close();
    this.udp?.close();
  }

  async handle(req, res) {
    const url = new URL(req.url, "https://x");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const json = (code, value) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    switch (url.pathname) {
      case `${API}/register`:
        this.registered.push({ ...JSON.parse(body.toString()), from: req.socket.remoteAddress });
        return json(200, this.info(false));
      case `${API}/prepare-upload`: {
        const offer = JSON.parse(body.toString());
        this.offers.push(offer);
        if (this.answer === "decline") return json(403);
        const files = Object.keys(offer.files);
        const text = files.length === 1 && offer.files[files[0]].preview;
        if (text && offer.files[files[0]].fileType.startsWith("text/")) {
          this.texts = [...(this.texts ?? []), text];
          return json(204);
        }
        const sessionId = `s${Date.now()}`;
        const tokens = Object.fromEntries(files.map((id) => [id, `t-${id}`]));
        this.sessions.set(sessionId, offer);
        return json(200, { sessionId, files: tokens });
      }
      case `${API}/upload`: {
        const offer = this.sessions.get(url.searchParams.get("sessionId"));
        const id = url.searchParams.get("fileId");
        if (!offer || url.searchParams.get("token") !== `t-${id}`) return json(403);
        this.files.set(offer.files[id].fileName, body);
        return json(200);
      }
      case `${API}/cancel`:
        return json(200);
      default:
        return json(404);
    }
  }

  /** A request to the app (HTTPS, showing its certificate); checks the app's certificate is `expect` (if given). */
  request(port, path, body, expect) {
    return new Promise((resolve, reject) => {
      const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body ?? {});
      const req = https.request(
        { host: "127.0.0.1", port, path, method: "POST", key: this.tls.key, cert: this.tls.cert, rejectUnauthorized: false, agent: false },
        (res) => {
          // (Read now: the socket is let go once the response is over.)
          const cert = res.socket?.getPeerCertificate?.();
          const fp = cert?.raw ? createHash("sha256").update(cert.raw).digest("hex").toUpperCase() : null;
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            if (expect && fp !== expect) return reject(new Error(`certificate ${fp}, expected ${expect}`));
            const text = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, fingerprint: fp });
          });
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  }

  register(port = LOCALSEND_PORT) {
    return this.request(port, `${API}/register`, this.info());
  }

  /** Offers files ({ name: Buffer|string }); resolves when the app answers. */
  prepare(files, { pin, port = LOCALSEND_PORT } = {}) {
    const entries = Object.entries(files).map(([name, data], i) => {
      const buf = Buffer.from(data);
      return [`f${i}`, { id: `f${i}`, fileName: name, size: buf.length, fileType: "application/octet-stream", buf }];
    });
    this.outgoing = Object.fromEntries(entries.map(([id, f]) => [id, f.buf]));
    const body = { info: this.info(), files: Object.fromEntries(entries.map(([id, { buf: _, ...f }]) => [id, f])) };
    return this.request(port, `${API}/prepare-upload${pin ? `?pin=${pin}` : ""}`, body);
  }

  /** Uploads every file the app accepted (`answer`: prepare's reply body). */
  async upload(answer, port = LOCALSEND_PORT) {
    const codes = [];
    for (const [id, token] of Object.entries(answer.files)) {
      const q = `sessionId=${answer.sessionId}&fileId=${id}&token=${token}`;
      codes.push((await this.request(port, `${API}/upload?${q}`, this.outgoing[id])).status);
    }
    return codes;
  }

  sendText(text, port = LOCALSEND_PORT) {
    const body = {
      info: this.info(),
      files: { m: { id: "m", fileName: "m.txt", size: Buffer.byteLength(text), fileType: "text/plain", preview: text } },
    };
    return this.request(port, `${API}/prepare-upload`, body);
  }

  /** Announces itself on the multicast group (as a LocalSend app does when it starts). */
  async announce() {
    if (!this.udp) {
      this.udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
      await new Promise((r) => this.udp.bind(0, r));
      this.udp.setMulticastLoopback(true);
    }
    const msg = Buffer.from(JSON.stringify({ ...this.info(), announce: true }));
    for (const wait of [0, 300, 1000]) {
      await new Promise((r) => setTimeout(r, wait));
      this.udp.send(msg, LOCALSEND_PORT, GROUP);
    }
  }
}

/**
 * The Wi-Fi duel's handshake codes (`?duel=wifi`, wifi-link.ts): a WebRTC
 * offer or answer squeezed into a short base64url string, small enough for a
 * link's fragment and a QR code a phone camera reads from another phone's
 * screen. Pure: no DOM, no RTCPeerConnection.
 *
 * Only what varies between sessions crosses: the ICE username fragment and
 * password, the DTLS certificate's SHA-256 fingerprint, the DTLS role, and
 * the UDP candidates (type, address, port). The rest of the description is
 * the same for every data-channel-only session, so the receiver rebuilds it
 * from a template (rebuildSdp): one bundled `m=application` section, mid 0,
 * SCTP port 5000.
 *
 * Layout (then base64url, no padding):
 *
 *   byte 0         version (high nibble, 1) · kind (bit 0: 0 offer, 1 answer)
 *                  · setup (bits 1–2: 0 actpass, 1 active, 2 passive)
 *   ufrag          length byte, then ASCII
 *   pwd            length byte, then ASCII
 *   fingerprint    32 bytes (sha-256)
 *   candidates     count byte, then each:
 *                    byte: type (bits 6–7: host, srflx, prflx, relay)
 *                          · address kind (bits 4–5: IPv4, IPv6, mDNS UUID, text)
 *                    address: 4 bytes, 16 bytes, 16 bytes (the UUID of
 *                          "<uuid>.local"), or a length byte and ASCII
 *                    port: 2 bytes, big-endian
 *
 * Where the spec is silent:
 *  - TCP candidates and those of component 2 are left out (a data channel
 *    bundles on one UDP component), as are any past MAX_CANDIDATES;
 *  - each rebuilt candidate gets its own foundation and a priority by its
 *    type (host over srflx over prflx over relay, then in the order sent):
 *    the peer only needs them to rank the pairs;
 *  - a description with no sha-256 fingerprint can't be coded: every browser
 *    that runs the game offers one.
 */

export type SignalKind = "offer" | "answer";
export type DtlsSetup = "actpass" | "active" | "passive";
export type CandidateType = "host" | "srflx" | "prflx" | "relay";

export interface SignalCandidate {
  type: CandidateType;
  address: string;
  port: number;
}

/** What crosses: everything that varies between sessions. */
export interface Signal {
  kind: SignalKind;
  ufrag: string;
  pwd: string;
  /** The sha-256 fingerprint's 32 bytes. */
  fingerprint: Uint8Array;
  setup: DtlsSetup;
  candidates: SignalCandidate[];
}

const VERSION = 1;
export const MAX_CANDIDATES = 8;
const TYPES: readonly CandidateType[] = ["host", "srflx", "prflx", "relay"];
const SETUPS: readonly DtlsSetup[] = ["actpass", "active", "passive"];
/** RFC 8445's type preferences, as browsers use them. */
const TYPE_PREF: Record<CandidateType, number> = { host: 126, prflx: 110, srflx: 100, relay: 0 };
const MDNS = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export class SignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalError";
  }
}

/** The parts of an SDP offer or answer that vary between sessions. */
export function parseSdp(sdp: string, kind: SignalKind): Signal {
  let ufrag: string | null = null;
  let pwd: string | null = null;
  let fingerprint: Uint8Array | null = null;
  let setup: DtlsSetup | null = null;
  const candidates: SignalCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("a=ice-ufrag:")) ufrag ??= line.slice(12);
    else if (line.startsWith("a=ice-pwd:")) pwd ??= line.slice(10);
    else if (line.startsWith("a=setup:")) {
      const s = line.slice(8) as DtlsSetup;
      if (SETUPS.includes(s)) setup ??= s;
    } else if (line.toLowerCase().startsWith("a=fingerprint:sha-256 ")) fingerprint ??= hexBytes(line.slice(22));
    else if (line.startsWith("a=candidate:")) {
      const c = parseCandidate(line.slice(2));
      const k = c && `${c.type} ${c.address} ${c.port}`;
      if (c && k && !seen.has(k) && candidates.length < MAX_CANDIDATES) {
        seen.add(k);
        candidates.push(c);
      }
    }
  }
  if (!ufrag || !pwd) throw new SignalError("no ICE credentials in the description");
  if (!fingerprint) throw new SignalError("no sha-256 fingerprint in the description");
  return { kind, ufrag, pwd, fingerprint, setup: setup ?? (kind === "offer" ? "actpass" : "active"), candidates };
}

/** One `candidate:` attribute (no `a=`), or null: not UDP component 1, or not understood. */
export function parseCandidate(attr: string): SignalCandidate | null {
  const f = attr.replace(/^candidate:/, "").split(/\s+/);
  // foundation component transport priority address port "typ" type …
  if (f.length < 8 || f[1] !== "1" || f[2]!.toLowerCase() !== "udp" || f[6] !== "typ") return null;
  const type = f[7] as CandidateType;
  const port = Number(f[5]);
  if (!TYPES.includes(type) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { type, address: f[4]!, port };
}

function hexBytes(s: string): Uint8Array | null {
  const parts = s.trim().split(":");
  if (parts.length !== 32 || parts.some((p) => !/^[0-9a-f]{2}$/i.test(p))) return null;
  return Uint8Array.from(parts, (p) => parseInt(p, 16));
}

// -------------------------------------------------------------- bytes ---

class Writer {
  private readonly out: number[] = [];
  byte(b: number): void {
    this.out.push(b & 0xff);
  }
  bytes(b: ArrayLike<number>): void {
    for (let i = 0; i < b.length; i++) this.byte(b[i]!);
  }
  text(s: string): void {
    if (s.length > 255 || !/^[\x21-\x7e]*$/.test(s)) throw new SignalError(`can't code "${s}"`);
    this.byte(s.length);
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  done(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

class Reader {
  private i = 0;
  constructor(private readonly b: Uint8Array) {}
  byte(): number {
    if (this.i >= this.b.length) throw new SignalError("the code is cut short");
    return this.b[this.i++]!;
  }
  bytes(n: number): Uint8Array {
    if (this.i + n > this.b.length) throw new SignalError("the code is cut short");
    const out = this.b.slice(this.i, this.i + n);
    this.i += n;
    return out;
  }
  text(): string {
    return String.fromCharCode(...this.bytes(this.byte()));
  }
  get rest(): number {
    return this.b.length - this.i;
  }
}

function writeAddress(w: Writer, address: string): number {
  const v4 = IPV4.exec(address);
  if (v4 && v4.slice(1).every((x) => Number(x) <= 255)) {
    w.bytes(v4.slice(1).map(Number));
    return 0;
  }
  const v6 = ipv6Bytes(address);
  if (v6) {
    w.bytes(v6);
    return 1;
  }
  const m = MDNS.exec(address);
  if (m) {
    w.bytes(m.slice(1).join("").match(/../g)!.map((h) => parseInt(h, 16)));
    return 2;
  }
  w.text(address);
  return 3;
}

function readAddress(r: Reader, kind: number): string {
  if (kind === 0) return Array.from(r.bytes(4)).join(".");
  if (kind === 1) return ipv6Text(r.bytes(16));
  if (kind === 2) {
    const h = Array.from(r.bytes(16), (b) => b.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
  }
  return r.text();
}

/** An IPv6 address's 16 bytes (null: not one, or one with a zone). */
export function ipv6Bytes(s: string): Uint8Array | null {
  if (!s.includes(":") || !/^[0-9a-f:]+$/i.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const words = (h: string) => (h === "" ? [] : h.split(":"));
  const head = words(halves[0]!);
  const tail = halves.length === 2 ? words(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (all.some((x) => !/^[0-9a-f]{1,4}$/i.test(x))) return null;
  const out = new Uint8Array(16);
  all.forEach((x, i) => {
    const n = parseInt(x, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
}

function ipv6Text(b: Uint8Array): string {
  const w: string[] = [];
  for (let i = 0; i < 16; i += 2) w.push(((b[i]! << 8) | b[i + 1]!).toString(16));
  return w.join(":");
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toBase64Url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((b.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) s += B64[(n >> (18 - 6 * j)) & 63];
  }
  return s;
}

export function fromBase64Url(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new SignalError("that isn't a Battle Drones code");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// --------------------------------------------------------------- codes ---

export function encodeSignal(s: Signal): string {
  const w = new Writer();
  w.byte((VERSION << 4) | (SETUPS.indexOf(s.setup) << 1) | (s.kind === "answer" ? 1 : 0));
  w.text(s.ufrag);
  w.text(s.pwd);
  if (s.fingerprint.length !== 32) throw new SignalError("the fingerprint must be 32 bytes");
  w.bytes(s.fingerprint);
  const cands = s.candidates.slice(0, MAX_CANDIDATES);
  w.byte(cands.length);
  for (const c of cands) {
    // (the address goes first into a scratch writer: its kind is in the byte before it)
    const a = new Writer();
    const kind = writeAddress(a, c.address);
    w.byte((TYPES.indexOf(c.type) << 6) | (kind << 4));
    w.bytes(a.done());
    w.byte(c.port >> 8);
    w.byte(c.port);
  }
  return toBase64Url(w.done());
}

export function decodeSignal(code: string): Signal {
  const r = new Reader(fromBase64Url(code.trim()));
  const head = r.byte();
  if (head >> 4 !== VERSION) throw new SignalError("that code is from another version of the game");
  const setup = SETUPS[(head >> 1) & 3];
  if (!setup) throw new SignalError("that isn't a Battle Drones code");
  const kind: SignalKind = head & 1 ? "answer" : "offer";
  const ufrag = r.text();
  const pwd = r.text();
  const fingerprint = r.bytes(32);
  const n = r.byte();
  const candidates: SignalCandidate[] = [];
  for (let i = 0; i < n; i++) {
    const b = r.byte();
    const address = readAddress(r, (b >> 4) & 3);
    const port = (r.byte() << 8) | r.byte();
    candidates.push({ type: TYPES[b >> 6]!, address, port });
  }
  if (r.rest !== 0) throw new SignalError("that isn't a Battle Drones code");
  return { kind, ufrag, pwd, fingerprint, setup, candidates };
}

/** The SDP a browser takes for this signal: the data-channel template around what crossed. */
export function rebuildSdp(s: Signal): string {
  const fp = Array.from(s.fingerprint, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(":");
  const lines = [
    "v=0",
    "o=- 1 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    ...s.candidates.map((c, i) => `a=${candidateLine(c, i)}`),
    "a=end-of-candidates",
    `a=ice-ufrag:${s.ufrag}`,
    `a=ice-pwd:${s.pwd}`,
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${s.setup}`,
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144"
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/** A `candidate:` attribute for the i-th candidate sent (RFC 8445 priority: type, then order). */
export function candidateLine(c: SignalCandidate, i: number): string {
  const priority = TYPE_PREF[c.type] * 2 ** 24 + (65535 - i) * 2 ** 8 + 255;
  const rel = c.type === "host" ? "" : " raddr 0.0.0.0 rport 0";
  return `candidate:${i + 1} 1 udp ${priority} ${c.address} ${c.port} typ ${c.type}${rel}`;
}

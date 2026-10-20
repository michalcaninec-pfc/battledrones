/**
 * The Wi-Fi duel's link (`?duel=wifi`): one WebRTC data channel between the
 * two phones, set up with no signalling server. The host's invite and the
 * guest's reply are codes (wifi-code.ts) that cross by hand: a QR code, a
 * shared link, or a paste. The only server either phone talks to is
 * Cloudflare's public STUN, for a server-reflexive candidate; on one Wi-Fi
 * the host candidates (mDNS names) are what connect.
 *
 *   host:  const h = await WifiLink.host()      h.code: the invite
 *          await h.accept(replyCode)            (the guest's reply)
 *   guest: const g = await WifiLink.join(code)  g.code: the reply
 *   both:  await link.opened, then link.transport() for the lobby
 *
 * The channel carries the relay's packets (relay-transport.ts) unchanged:
 * RelayTransport runs the packet clock, the key rotation and the session CRC
 * as it does for the smoke's harness, and this link stands in for the
 * harness's page functions. The channel is unordered with no retransmits,
 * as the air is: the lockstep repeats what wasn't acknowledged, and a late
 * packet is worth less than the next one.
 *
 * Where the spec is silent:
 *  - gathering stops when the browser says it is complete, or GATHER_MS
 *    after it began with at least one candidate, or at GATHER_MAX_MS
 *    whatever it has: a STUN server that doesn't answer must not hold the
 *    code up, and on one Wi-Fi the host candidates are enough;
 *  - the channel is negotiated (id 0, both ends make it), so it opens with
 *    no in-band setup;
 *  - a channel that closes, or ICE that fails, is the link's end: state
 *    "closed" or "failed". There is no ICE restart (it would need a new
 *    pair of codes).
 */
import type { BandRole } from "../link/transport";
import { RelayTransport, type RelayWindow } from "./relay-transport";
import { decodeSignal, encodeSignal, parseCandidate, parseSdp, rebuildSdp, SignalError, type Signal, type SignalKind } from "./wifi-code";

/** Cloudflare's free STUN service. */
export const STUN_URL = "stun:stun.cloudflare.com:3478";
/** Gathering stops this long after it began, once there is a candidate … */
export const GATHER_MS = 1500;
/** … and at this long whatever it has. */
export const GATHER_MAX_MS = 4000;

export type WifiState =
  /** Gathering candidates for this phone's code. */
  | "gathering"
  /** The code is ready: waiting for the friend's (the host), or for the friend to connect (the guest). */
  | "waiting"
  /** Both descriptions are in: ICE and DTLS are connecting. */
  | "connecting"
  | "open"
  | "failed"
  | "closed";

export class WifiLink {
  /** The offerer hosts, the answerer joins: the lobby pairs in this role at once. */
  readonly role: BandRole;
  /** This phone's code: the invite (host) or the reply (guest). */
  code = "";
  state: WifiState = "gathering";
  /** Called on every state change. */
  onState: ((s: WifiState) => void) | null = null;
  /** Resolves when the channel opens; rejects when the link fails or closes first. */
  readonly opened: Promise<void>;
  /** The page functions RelayTransport sends and receives through. */
  readonly win: RelayWindow = {};
  private readonly pc: RTCPeerConnection;
  private readonly dc: RTCDataChannel;
  private readonly extra: string[] = [];
  private settle: { ok: () => void; fail: (e: Error) => void } | null = null;

  private constructor(role: BandRole) {
    this.role = role;
    this.pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URL }] });
    this.dc = this.pc.createDataChannel("duel", { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    this.opened = new Promise<void>((ok, fail) => (this.settle = { ok, fail }));
    // (nobody may be waiting yet: a failure is still read through state)
    this.opened.catch(() => undefined);
    this.pc.addEventListener("icecandidate", (e) => {
      if (e.candidate?.candidate) this.extra.push(e.candidate.candidate);
    });
    this.pc.addEventListener("connectionstatechange", () => {
      if (this.pc.connectionState === "failed") this.end("failed", "The phones couldn't reach each other");
    });
    this.dc.addEventListener("open", () => {
      this.set("open");
      this.settle?.ok();
      this.settle = null;
    });
    this.dc.addEventListener("close", () => this.end(this.state === "open" ? "closed" : "failed", "The Wi-Fi link closed"));
    this.dc.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      const sp = e.data.indexOf(" ");
      if (sp > 0) this.win.__duelIn?.(e.data.slice(sp + 1), Number(e.data.slice(0, sp)));
    });
    this.win.__duelOut = (base64, nbits) => {
      if (this.dc.readyState === "open") this.dc.send(`${nbits} ${base64}`);
    };
  }

  /** A host's link: its invite code, once gathered. */
  static async host(): Promise<WifiLink> {
    const link = new WifiLink("host");
    try {
      await link.pc.setLocalDescription(await link.pc.createOffer());
      await link.gathered("offer");
    } catch (e) {
      link.close();
      throw e;
    }
    return link;
  }

  /** A guest's link from the host's invite: its reply code, once gathered. */
  static async join(invite: string): Promise<WifiLink> {
    const sig = decodeSignal(invite);
    if (sig.kind !== "offer") throw new SignalError("That's a reply code: it goes into the host's phone");
    const link = new WifiLink("guest");
    try {
      await link.pc.setRemoteDescription({ type: "offer", sdp: rebuildSdp(sig) });
      await link.pc.setLocalDescription(await link.pc.createAnswer());
      await link.gathered("answer");
    } catch (e) {
      link.close();
      throw e;
    }
    return link;
  }

  /** The host takes the guest's reply. */
  async accept(reply: string): Promise<void> {
    if (this.role !== "host" || this.state !== "waiting") return;
    const sig = decodeSignal(reply);
    if (sig.kind !== "answer") throw new SignalError("That's an invite code: it goes into the other phone");
    this.set("connecting");
    try {
      await this.pc.setRemoteDescription({ type: "answer", sdp: rebuildSdp(sig) });
    } catch (e) {
      this.set("waiting");
      throw e;
    }
  }

  /** A transport over the channel for the lobby (each pairing gets its own; the lobby closes the old one). */
  transport(): RelayTransport {
    return new RelayTransport({ role: this.role, win: this.win });
  }

  close(): void {
    if (this.state === "closed") return;
    this.end("closed", "The Wi-Fi link closed");
    this.dc.close();
    this.pc.close();
  }

  private set(s: WifiState): void {
    if (this.state === s) return;
    this.state = s;
    this.onState?.(s);
  }

  private end(s: "failed" | "closed", why: string): void {
    if (this.state === "closed" || this.state === "failed") return;
    this.set(s);
    this.settle?.fail(new Error(why));
    this.settle = null;
  }

  /** Wait for the candidates (see the header), then code the local description. */
  private async gathered(kind: SignalKind): Promise<void> {
    const pc = this.pc;
    const t0 = performance.now();
    await new Promise<void>((done) => {
      const check = () => {
        const t = performance.now() - t0;
        const any = this.extra.length > 0 || /a=candidate:/.test(pc.localDescription?.sdp ?? "");
        if (pc.iceGatheringState === "complete" || (any && t >= GATHER_MS) || t >= GATHER_MAX_MS) {
          clearInterval(timer);
          pc.removeEventListener("icegatheringstatechange", check);
          done();
        }
      };
      const timer = setInterval(check, 100);
      pc.addEventListener("icegatheringstatechange", check);
      check();
    });
    const desc = pc.localDescription;
    if (!desc) throw new Error("No local description");
    const sig: Signal = parseSdp(desc.sdp, kind);
    // (candidates the description doesn't carry yet, from the events)
    for (const line of this.extra) {
      const c = parseCandidate(line);
      if (c && !sig.candidates.some((x) => x.type === c.type && x.address === c.address && x.port === c.port)) sig.candidates.push(c);
    }
    this.code = encodeSignal(sig);
    this.set("waiting");
  }
}

/**
 * ?duel=wifi's handshake codes (src/versus/wifi-code.ts) and the paste and
 * link helpers around them (wifi-sheet.ts, src/ui/wifi-reply.ts). The link
 * itself needs a browser: tools/wifi-smoke.mjs.
 */
import { describe, expect, it } from "vitest";
import { codeFrom, WIFI_INVITE_HASH, WIFI_REPLY_HASH } from "../src/ui/wifi-reply";
import { decodeSignal, encodeSignal, fromBase64Url, ipv6Bytes, parseCandidate, parseSdp, rebuildSdp, SignalError, toBase64Url } from "../src/versus/wifi-code";
import { pastedCode, wifiUrl } from "../src/versus/wifi-sheet";

/** A Chromium data-channel offer after gathering (an mDNS host candidate, a srflx, a TCP one, IPv6). */
const CHROME_OFFER = [
  "v=0",
  "o=- 5265740177188305635 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=candidate:1790597388 1 udp 2113937151 8f6cb2d0-9cbc-4f50-aa7f-59c621e4d931.local 44259 typ host generation 0 network-cost 999",
  "a=candidate:842163049 1 udp 1677729535 203.0.113.7 61022 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999",
  "a=candidate:2 1 udp 2113939711 2001:db8::1:42 50000 typ host generation 0",
  "a=candidate:3 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active generation 0",
  "a=candidate:4 2 udp 2113937150 192.168.1.20 44260 typ host",
  "a=ice-ufrag:1DLM",
  "a=ice-pwd:iMmpMYwjywbOQB5Wn2XLP3+b",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 A4:9F:27:EF:D0:14:4E:D0:93:EB:D1:A8:CE:D5:B7:FC:C3:73:FD:24:42:B5:C2:F6:59:97:00:BC:0B:9D:F2:50",
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
  ""
].join("\r\n");

describe("wifi codes", () => {
  it("keep what varies and drop the rest", () => {
    const s = parseSdp(CHROME_OFFER, "offer");
    expect(s.ufrag).toBe("1DLM");
    expect(s.pwd).toBe("iMmpMYwjywbOQB5Wn2XLP3+b");
    expect(s.setup).toBe("actpass");
    expect(s.fingerprint.length).toBe(32);
    expect(s.fingerprint[0]).toBe(0xa4);
    // (TCP and component 2 are left out)
    expect(s.candidates).toEqual([
      { type: "host", address: "8f6cb2d0-9cbc-4f50-aa7f-59c621e4d931.local", port: 44259 },
      { type: "srflx", address: "203.0.113.7", port: 61022 },
      { type: "host", address: "2001:db8::1:42", port: 50000 }
    ]);
  });

  it("round-trip, and stay short enough for a QR code", () => {
    const s = parseSdp(CHROME_OFFER, "offer");
    const code = encodeSignal(s);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code.length).toBeLessThan(160);
    const back = decodeSignal(code);
    expect(back.kind).toBe("offer");
    expect(back.ufrag).toBe(s.ufrag);
    expect(back.pwd).toBe(s.pwd);
    expect(Array.from(back.fingerprint)).toEqual(Array.from(s.fingerprint));
    expect(back.candidates.map((c) => [c.type, c.port])).toEqual(s.candidates.map((c) => [c.type, c.port]));
    expect(back.candidates[0]!.address).toBe(s.candidates[0]!.address);
    expect(back.candidates[1]!.address).toBe("203.0.113.7");
    expect(Array.from(ipv6Bytes(back.candidates[2]!.address)!)).toEqual(Array.from(ipv6Bytes("2001:db8::1:42")!));
  });

  it("carry an answer's kind and DTLS role", () => {
    const answer = CHROME_OFFER.replace("a=setup:actpass", "a=setup:active");
    const back = decodeSignal(encodeSignal(parseSdp(answer, "answer")));
    expect(back.kind).toBe("answer");
    expect(back.setup).toBe("active");
  });

  it("rebuild a description the browser can parse back to the same signal", () => {
    const s = decodeSignal(encodeSignal(parseSdp(CHROME_OFFER, "offer")));
    const sdp = rebuildSdp(s);
    expect(sdp).toContain("m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n");
    expect(sdp).toContain("a=fingerprint:sha-256 A4:9F:27:EF:");
    expect(sdp).toContain("a=setup:actpass\r\n");
    const again = parseSdp(sdp, "offer");
    expect(again.candidates).toEqual(s.candidates);
    expect(again.ufrag).toBe(s.ufrag);
    // (host before srflx in priority)
    const prio = (type: string) => Number(sdp.split("\r\n").find((l) => l.includes(`typ ${type}`))!.split(" ")[3]);
    expect(prio("host")).toBeGreaterThan(prio("srflx"));
  });

  it("refuse what isn't a code", () => {
    expect(() => decodeSignal("hello world")).toThrow(SignalError);
    expect(() => decodeSignal(toBase64Url(Uint8Array.of(0x20, 1, 65)))).toThrow(SignalError);
    const code = encodeSignal(parseSdp(CHROME_OFFER, "offer"));
    expect(() => decodeSignal(code.slice(0, -6))).toThrow(SignalError);
    expect(() => parseSdp("v=0\r\n", "offer")).toThrow(SignalError);
  });

  it("base64url and IPv6 helpers", () => {
    for (let n = 0; n < 8; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 0xff);
      expect(Array.from(fromBase64Url(toBase64Url(b)))).toEqual(Array.from(b));
    }
    expect(ipv6Bytes("::1")![15]).toBe(1);
    expect(ipv6Bytes("1:2:3:4:5:6:7:8")![15]).toBe(8);
    expect(ipv6Bytes("fe80::1%en0")).toBeNull();
    expect(ipv6Bytes("1.2.3.4")).toBeNull();
    expect(parseCandidate("candidate:1 1 UDP 1 10.0.0.2 5000 typ host")).toEqual({ type: "host", address: "10.0.0.2", port: 5000 });
  });
});

describe("wifi links", () => {
  it("put the code in the fragment, and take it back from a paste", () => {
    const loc = { origin: "https://simonw.github.io", pathname: "/battledrones/" };
    const code = encodeSignal(parseSdp(CHROME_OFFER, "offer"));
    const invite = wifiUrl(loc, WIFI_INVITE_HASH, code);
    expect(invite).toBe(`https://simonw.github.io/battledrones/?duel=wifi#wifi=${code}`);
    expect(pastedCode(invite)).toBe(code);
    expect(pastedCode(` ${wifiUrl(loc, WIFI_REPLY_HASH, code)}\n`)).toBe(code);
    expect(pastedCode(code)).toBe(code);
    expect(pastedCode("nope")).toBeNull();
    expect(codeFrom(`#wifi-reply=${code}`, WIFI_REPLY_HASH)).toBe(code);
    expect(codeFrom(`#wifi-reply=${code}`, WIFI_INVITE_HASH)).toBeNull();
  });
});

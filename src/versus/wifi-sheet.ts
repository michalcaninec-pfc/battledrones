/**
 * The Wi-Fi duel's handshake sheet (`?duel=wifi`): before the lobby, the two
 * phones swap codes by hand and open a WebRTC data channel (wifi-link.ts).
 * Then the lobby pairs over it in the role the handshake gave, as on a relay
 * seat: the phone that made the invite hosts.
 *
 *   host:  Host → the invite as a QR code and a link to share → the guest's
 *          reply, scanned with the camera (a new tab hands it over:
 *          src/ui/wifi-reply.ts) or pasted → connecting → the lobby
 *   guest: the invite link (main.ts's Join tap, `#wifi=<code>`) or a pasted
 *          invite → the reply as a QR code and a link → connecting → the lobby
 *
 * Where the spec is silent:
 *  - the invite and reply links are this page's address with `?duel=wifi`
 *    and the code in the fragment; the fragment is cleared once read, so a
 *    rematch's reload doesn't take the old invite again;
 *  - a rematch keeps its role: its host makes a new invite, its guest
 *    waits for one (pasted, or the link opened: that tab joins afresh);
 *  - a link that hasn't opened CONNECT_MS after both codes are in has
 *    failed (the phones can't reach each other): Try again starts over.
 */
import qrcode from "qrcode-generator";
import type { BandRole } from "../link/transport";
import { WIFI_CHANNEL, WIFI_INVITE_HASH, WIFI_REPLY_HASH, WIFI_REPLY_KEY, WIFI_REPLY_TTL_MS, codeFrom, type WifiMessage } from "../ui/wifi-reply";
import { WifiLink, type WifiState } from "./wifi-link";

/** Both codes in and no channel this long after: failed. */
export const CONNECT_MS = 20_000;

export interface WifiSheetOptions {
  /** Where the sheet goes (the menu). */
  host: HTMLElement;
  /** A rematch's role (null: Host, or Join by the invite). */
  role: BandRole | null;
  /** Rematch: the title says so. */
  rematch: boolean;
  /** The channel is open: the lobby takes the link. */
  onOpen(link: WifiLink): void;
  /** Cancelled before it opened. */
  onClose(): void;
}

type Step =
  | { s: "choose" }
  | { s: "making"; role: BandRole }
  | { s: "host-wait"; link: WifiLink }
  | { s: "guest-wait"; link: WifiLink }
  | { s: "connecting"; link: WifiLink }
  | { s: "error"; message: string };

const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** This page's address with `?duel=wifi` and `fragment` + `code`. */
export function wifiUrl(loc: Pick<Location, "origin" | "pathname">, fragment: string, code: string): string {
  return `${loc.origin}${loc.pathname}?duel=wifi${fragment}${code}`;
}

/** The code a paste holds: a whole invite or reply link, or the bare code. */
export function pastedCode(text: string): string | null {
  const t = text.trim();
  const at = t.indexOf("#");
  if (at >= 0) return codeFrom(t.slice(at), WIFI_INVITE_HASH) ?? codeFrom(t.slice(at), WIFI_REPLY_HASH);
  return /^[A-Za-z0-9_-]{20,}$/.test(t) ? t : null;
}

function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

/** The invite in this page's fragment, read once (the fragment is cleared). */
function takeInvite(): string | null {
  const code = codeFrom(location.hash, WIFI_INVITE_HASH);
  if (location.hash.startsWith(WIFI_INVITE_HASH)) history.replaceState(null, "", `${location.pathname}${location.search}`);
  return code;
}

export function showWifiSheet(o: WifiSheetOptions): void {
  const invite = o.role === "host" ? null : takeInvite();
  let step: Step = { s: "choose" };
  let gen = 0;
  let done = false;
  let connectTimer = 0;
  let bc: BroadcastChannel | null = null;
  /** The reply the host took (the reply tab hears "got" for it, by whichever way it came). */
  let taken: string | null = null;

  o.host.querySelector(".duel-wrap")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap duel-wrap";
  wrap.innerHTML = `<div class="sheet duelsheet wifisheet" role="dialog" aria-label="Duel a friend over Wi-Fi">
      <h2>📶 ${o.rematch ? "Rematch" : "Duel a friend"}</h2>
      <p class="duel-practice">Wi-Fi link (WebRTC): both phones on the same network</p>
      <div class="duel-body"></div>
      <div class="sh-actions duel-actions"></div>
    </div>`;
  o.host.appendChild(wrap);
  const body = wrap.querySelector<HTMLElement>(".duel-body")!;
  const actions = wrap.querySelector<HTMLElement>(".duel-actions")!;

  const linkOf = (st: Step): WifiLink | null => ("link" in st ? st.link : null);
  const go = (next: Step) => {
    const was = linkOf(step);
    step = next;
    if (was && was !== linkOf(next)) was.close();
    clearTimeout(connectTimer);
    if (next.s === "connecting") connectTimer = window.setTimeout(() => fail("The phones couldn't reach each other."), CONNECT_MS);
    render();
  };
  const fail = (message: string) => {
    if (!done) go({ s: "error", message });
  };
  const finish = () => {
    done = true;
    clearTimeout(connectTimer);
    bc?.close();
    window.removeEventListener("storage", onStorage);
    document.removeEventListener("visibilitychange", checkStored);
    wrap.remove();
  };

  const watch = (link: WifiLink) => {
    const g = gen;
    link.onState = (s: WifiState) => {
      if (g !== gen || done) return;
      if (s === "connecting" && step.s !== "connecting") go({ s: "connecting", link });
      if (s === "failed") fail("The phones couldn't reach each other.");
    };
    link.opened.then(
      () => {
        if (g !== gen || done) return;
        finish();
        o.onOpen(link);
      },
      () => undefined
    );
  };

  const startHost = async () => {
    const g = ++gen;
    go({ s: "making", role: "host" });
    try {
      const link = await WifiLink.host();
      if (g !== gen || done) return link.close();
      watch(link);
      go({ s: "host-wait", link });
      checkStored();
    } catch (e) {
      if (g === gen) fail(e instanceof Error ? e.message : String(e));
    }
  };
  const startGuest = async (code: string) => {
    const g = ++gen;
    go({ s: "making", role: "guest" });
    try {
      const link = await WifiLink.join(code);
      if (g !== gen || done) return link.close();
      watch(link);
      go({ s: "guest-wait", link });
    } catch (e) {
      if (g === gen) fail(e instanceof Error ? e.message : String(e));
    }
  };
  /** The host takes a reply (pasted, or handed over by the reply tab). */
  const takeReply = (code: string): boolean => {
    if (code === taken) return true;
    if (step.s !== "host-wait") return false;
    const link = step.link;
    taken = code;
    bc?.postMessage({ t: "got", code } satisfies WifiMessage);
    link.accept(code).catch((e: unknown) => {
      if (taken === code) taken = null;
      if (linkOf(step) === link) {
        go({ s: "host-wait", link });
        note(e instanceof Error ? e.message : String(e));
      }
    });
    return true;
  };

  // the reply tab's hand-over (src/ui/wifi-reply.ts)
  try {
    bc = new BroadcastChannel(WIFI_CHANNEL);
    bc.onmessage = (e: MessageEvent<WifiMessage>) => {
      if (e.data?.t !== "reply" || !takeReply(e.data.code)) return;
      clearStored();
      // (again: the reply may have come through localStorage first, before this tab's "got" could be heard)
      bc?.postMessage({ t: "got", code: e.data.code } satisfies WifiMessage);
    };
  } catch {
    /* none: localStorage alone */
  }
  const clearStored = () => {
    try {
      localStorage.removeItem(WIFI_REPLY_KEY);
    } catch {
      /* ignore */
    }
  };
  function checkStored(): void {
    if (step.s !== "host-wait" || document.visibilityState === "hidden") return;
    try {
      const o = JSON.parse(localStorage.getItem(WIFI_REPLY_KEY) ?? "null") as { code?: unknown; at?: unknown } | null;
      if (o && typeof o.code === "string" && typeof o.at === "number" && Date.now() - o.at < WIFI_REPLY_TTL_MS && takeReply(o.code)) clearStored();
    } catch {
      /* ignore */
    }
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === WIFI_REPLY_KEY) checkStored();
  };
  window.addEventListener("storage", onStorage);
  document.addEventListener("visibilitychange", checkStored);
  // (a reply left over from an earlier duel is not this one's)
  clearStored();

  const note = (text: string) => {
    const el = body.querySelector<HTMLElement>(".wifi-note");
    if (el) el.textContent = text;
  };

  const shareRow = (url: string, what: string) => `
      <div class="wifi-qr" aria-label="QR code of the ${what} link">${qrSvg(url)}</div>
      <div class="wifi-share">
        ${typeof navigator.share === "function" ? `<button class="cta" data-act="share">Share ${what} link</button>` : ""}
        <button class="cta alt" data-act="copy">Copy link</button>
      </div>
      <input class="wifi-url" readonly value="${esc(url)}" aria-label="The ${what} link" />`;

  const cancelBtn = `<button class="cta alt" data-act="cancel">Cancel</button>`;
  function render(): void {
    if (done) return;
    let html = "";
    let acts = cancelBtn;
    switch (step.s) {
      case "choose":
        html = o.role === "guest"
          ? `<p class="sh-sub">Your friend's phone is making a new invite. Scan its QR code with your camera, or paste it here:</p>${pasteBox("join", "Invite link or code", "Join")}`
          : `<p class="sh-sub">Both phones must be on the same Wi-Fi. One phone hosts and shows a QR code; the other scans it with the camera.</p>
             <div class="duel-roles"><button class="duel-role" data-act="host"><b>📡 Host</b><small>Make an invite</small></button></div>
             <p class="sh-note">Joining? Scan your friend's QR code with your camera, or paste their invite here:</p>
             ${pasteBox("join", "Invite link or code", "Join")}`;
        break;
      case "making":
        html = `<p class="duel-status">${step.role === "host" ? "Making your invite…" : "Making your reply…"}</p>`;
        break;
      case "host-wait":
        html = `<p class="sh-sub"><b>1.</b> Your friend scans this with their phone's camera, or opens the link you send them.</p>
          ${shareRow(wifiUrl(location, WIFI_INVITE_HASH, step.link.code), "invite")}
          <p class="sh-sub"><b>2.</b> Their phone then shows a reply QR code: scan it with this phone's camera, or paste their reply here:</p>
          ${pasteBox("reply", "Reply link or code", "Connect")}`;
        break;
      case "guest-wait":
        html = `<p class="sh-sub">Now show this reply to your friend: they scan it with their camera, or you send them the link.</p>
          ${shareRow(wifiUrl(location, WIFI_REPLY_HASH, step.link.code), "reply")}
          <p class="duel-status">Waiting for your friend's phone…</p>`;
        break;
      case "connecting":
        html = `<p class="duel-status">Connecting…</p>`;
        break;
      case "error":
        html = `<p class="duel-err">${esc(step.message)}</p>
          <p class="sh-note">Check that both phones are on the same Wi-Fi (guest and hotel networks often keep devices apart), then try again with a new invite.</p>`;
        acts = `${cancelBtn}<button class="cta" data-act="retry">Try again</button>`;
        break;
    }
    body.innerHTML = html;
    actions.innerHTML = acts;
  }
  const pasteBox = (act: string, placeholder: string, label: string) => `
      <div class="wifi-paste"><input data-in="${act}" placeholder="${placeholder}" autocomplete="off" autocapitalize="off" spellcheck="false" /><button class="cta" data-act="${act}">${label}</button></div>
      <p class="sh-note wifi-note"></p>`;

  const copy = (text: string) => {
    const input = body.querySelector<HTMLInputElement>(".wifi-url");
    input?.select();
    const fallback = () => {
      if (!document.execCommand("copy")) note("Copy the link above by hand.");
      else note("Copied.");
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => note("Copied."), fallback);
    else fallback();
  };

  wrap.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el || !wrap.contains(el) || done) return;
    const url = body.querySelector<HTMLInputElement>(".wifi-url")?.value ?? "";
    const pasted = () => pastedCode(body.querySelector<HTMLInputElement>(`[data-in="${el.dataset.act}"]`)?.value ?? "");
    switch (el.dataset.act) {
      case "host":
        return void startHost();
      case "join": {
        const code = pasted();
        if (code) return void startGuest(code);
        return note("That isn't an invite link or code.");
      }
      case "reply": {
        const code = pasted();
        if (!code) return note("That isn't a reply link or code.");
        return void takeReply(code);
      }
      case "share":
        navigator.share({ title: "Battle Drones duel", text: "Join my Battle Drones duel (same Wi-Fi):", url }).catch(() => undefined);
        return;
      case "copy":
        return copy(url);
      case "retry":
        gen++;
        if (o.role === "host") return void startHost();
        return go({ s: "choose" });
      case "cancel":
        gen++;
        linkOf(step)?.close();
        finish();
        return o.onClose();
    }
  });

  if (invite) void startGuest(invite);
  else if (o.role === "host") void startHost();
  else render();
}

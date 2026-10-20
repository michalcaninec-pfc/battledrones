/**
 * The Wi-Fi duel's reply hand-off (`?duel=wifi`, src/versus/wifi-sheet.ts).
 * The guest's phone shows its reply as a QR code of a link; the host scans
 * it with the camera, which opens the link in a new tab of the host's
 * browser, not in the game's tab. This page is that tab: it boots no game,
 * hands the reply to the game's tab (a BroadcastChannel, and localStorage
 * for a tab the browser froze in the background, which reads it when it
 * shows again), and says to switch back. A game tab that takes the reply
 * answers, and the page says it was delivered; with none (another browser
 * opened the link) it shows the code to copy and paste instead.
 *
 * Plain game code: src/versus imports these names, never the other way.
 */

/** The reply link's fragment: `#wifi-reply=<code>`. */
export const WIFI_REPLY_HASH = "#wifi-reply=";
/** The invite link's fragment: `#wifi=<code>`. */
export const WIFI_INVITE_HASH = "#wifi=";
/** The channel the reply crosses on: { t: "reply", code } out, { t: "got", code } back. */
export const WIFI_CHANNEL = "battledrones.wifi";
/** localStorage: { code, at } for a game tab that wasn't running when the reply came. */
export const WIFI_REPLY_KEY = "battledrones.wifireply";
/** A stored reply older than this is stale. */
export const WIFI_REPLY_TTL_MS = 10 * 60_000;
/** How long the page waits for a game tab to say it took the reply. */
const ACK_MS = 1500;

export type WifiMessage = { t: "reply"; code: string } | { t: "got"; code: string };

/** The code in a fragment that starts with `prefix` (null: none). */
export function codeFrom(hash: string, prefix: string): string | null {
  if (!hash.startsWith(prefix)) return null;
  const code = hash.slice(prefix.length).trim();
  return /^[A-Za-z0-9_-]+$/.test(code) ? code : null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** This page is a reply link: hand it off and say so. Returns false when it isn't one (boot as usual). */
export function showWifiReplyPage(host: HTMLElement): boolean {
  const code = codeFrom(location.hash, WIFI_REPLY_HASH);
  if (!code) return false;
  try {
    localStorage.setItem(WIFI_REPLY_KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    /* blocked: the channel alone */
  }
  const screen = document.createElement("div");
  screen.className = "screen";
  screen.innerHTML = `<div class="loadbox wifi-reply">
      <h2>📶 Wi-Fi duel</h2>
      <p class="wr-status">Passing your friend's reply to your game…</p>
    </div>`;
  host.appendChild(screen);
  const status = screen.querySelector<HTMLElement>(".wr-status")!;
  let bc: BroadcastChannel | null = null;
  let got = false;
  try {
    bc = new BroadcastChannel(WIFI_CHANNEL);
    bc.onmessage = (e: MessageEvent<WifiMessage>) => {
      if (e.data?.t !== "got" || e.data.code !== code || got) return;
      got = true;
      status.innerHTML = `<b>Delivered ✓</b><br />Switch back to the tab with your Battle Drones game: it's connecting.`;
    };
    bc.postMessage({ t: "reply", code } satisfies WifiMessage);
  } catch {
    /* no BroadcastChannel: localStorage alone */
  }
  setTimeout(() => {
    if (got) return;
    status.innerHTML = `Switch back to the tab with your Battle Drones game.<br /><br />
      <small>If it doesn't connect, copy this reply and paste it into the game:</small>`;
    const box = document.createElement("div");
    box.className = "wr-copy";
    box.innerHTML = `<input readonly value="${esc(code)}" aria-label="Reply code" /><button class="cta">Copy</button>`;
    status.after(box);
    const input = box.querySelector("input")!;
    box.querySelector("button")!.addEventListener("click", () => {
      input.select();
      void navigator.clipboard?.writeText(code).catch(() => document.execCommand("copy"));
    });
  }, ACK_MS);
  return true;
}

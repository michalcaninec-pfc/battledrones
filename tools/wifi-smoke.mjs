// Wi-Fi duel smoke (?duel=wifi, src/versus/wifi-sheet.ts): two pages of the
// built app, one browser context each (two phones: no shared storage), set
// up a real WebRTC data channel with the handshake codes only, then play in
// lockstep over it.
//
//   1. The host, on the plain menu (no ?duel), taps "Duel a friend (Wi-Fi)",
//      Cancels (the address loses ?duel=wifi again), taps it again, then
//      Host, and reads its invite link off the sheet (what the QR code holds).
//   2. The guest opens the invite link (as the camera would), taps "Join your
//      friend's duel", and reads its reply link.
//   3. After --hold ms (the host taking its time to scan), the reply reaches
//      the host: by default as the camera would bring it, a new tab of the
//      host's browser opening the reply link (src/ui/wifi-reply.ts hands it
//      over and says "Delivered"); with --paste, pasted into the sheet.
//   4. Both lobbies pair over the channel (host blue, guest red), each taps
//      an opener card, the match loads, and both pages are stepped undrawn
//      to tick --ticks: the hash trails must agree at every tick.
//
// Fails on any console error. Prints "WIFI SMOKE OK".
// Usage: node tools/wifi-smoke.mjs [--hold=3000] [--ticks=150] [--paste] [url]
// (serves dist/: run `npm run build` first)
//
// Where the spec is silent:
//  - the pages' own animation frames are slowed (the smoke steps the scene
//    itself, as tools/duel-smoke.mjs does), and the scenes stop drawing once
//    both matches are up;
//  - Chromium hides local addresses behind mDNS names; both contexts are in
//    one browser, which resolves its own names, so the host candidates
//    connect as two phones on one Wi-Fi would. Cloudflare's STUN may not
//    answer from here: gathering stops on its own deadline (wifi-link.ts).
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml"
};
const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.slice(name.length + 3)) : def;
};
const HOLD = opt("hold", 3000);
const TICKS = opt("ticks", 150);
const paste = args.includes("--paste");
const urlArg = args.find((a) => !a.startsWith("--"));
const RAF_MS = 4000;

const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const check = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  log(`ok: ${what}`);
};

let server = null;
if (!urlArg) {
  if (!existsSync(join(ROOT, "index.html"))) throw new Error("no dist/: run `npm run build` first");
  server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, p);
    if (!existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(8898, r));
}
const base = new URL(urlArg ?? "http://localhost:8898/");

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]
});
const SETTINGS = {
  host: { mapId: "riverlands", difficulty: "normal", mode: "skirmish", mutators: [] },
  guest: { mapId: "frostbite", difficulty: "normal", mode: "skirmish", mutators: [] }
};
const errors = [];
const watch = (name, page) => {
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${String(e)}`));
};
const phones = {};
for (const name of ["host", "guest"]) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true });
  await context.addInitScript((ms) => {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), ms);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
  }, RAF_MS);
  await context.addInitScript((s) => {
    try {
      localStorage.setItem("battledrones.settings", s);
    } catch {
      /* ignore */
    }
  }, JSON.stringify(SETTINGS[name]));
  const page = await context.newPage();
  watch(name, page);
  phones[name] = { name, context, page, trail: new Map(), seen: -1 };
}
const { host, guest } = phones;
const both = (fn) => Promise.all([fn(host), fn(guest)]);
/** A link off a sheet, pointed at this server (the build's own origin is localhost already). */
const linkOf = async (p) => {
  await p.page.waitForSelector(".wifisheet .wifi-url", { timeout: 20000 });
  return p.page.locator(".wifisheet .wifi-url").inputValue();
};

try {
  // 1. the host's invite
  await host.page.goto(base.href);
  await host.page.waitForSelector("#play-wifi:not([disabled])", { timeout: 30000 });
  check(await host.page.locator("#play-wifi").isVisible(), "the menu has a Wi-Fi duel button");
  await host.page.locator("#play-wifi").tap();
  await host.page.waitForSelector(".wifisheet", { timeout: 10000 });
  check((await host.page.evaluate(() => location.search)) === "?duel=wifi", "the Wi-Fi tap puts ?duel=wifi in the address");
  await host.page.locator(".wifisheet [data-act=cancel]").tap();
  await host.page.waitForSelector(".wifisheet", { state: "detached", timeout: 10000 });
  check((await host.page.evaluate(() => location.search)) === "", "Cancel takes it out again");
  await host.page.waitForSelector("#play-wifi:not([disabled])", { timeout: 10000 });
  await host.page.locator("#play-wifi").tap();
  await host.page.locator(".wifisheet [data-act=host]").tap();
  const invite = await linkOf(host);
  check(/\?duel=wifi#wifi=[A-Za-z0-9_-]+$/.test(invite), `the invite link: ${invite.length} characters`);
  check((await host.page.locator(".wifisheet .wifi-qr svg").count()) === 1, "the invite has a QR code");

  // 2. the guest opens it and replies
  await guest.page.goto(invite);
  await guest.page.waitForSelector("#duel-join:not([disabled])", { timeout: 30000 });
  await guest.page.locator("#duel-join").tap();
  const reply = await linkOf(guest);
  check(/\?duel=wifi#wifi-reply=[A-Za-z0-9_-]+$/.test(reply), `the reply link: ${reply.length} characters`);
  check(!(await guest.page.evaluate(() => location.hash)), "the guest's page let go of the invite fragment");

  // 3. the reply reaches the host
  log(`holding the reply ${HOLD} ms`);
  await new Promise((r) => setTimeout(r, HOLD));
  if (paste) {
    await host.page.locator(".wifisheet [data-in=reply]").fill(reply);
    await host.page.locator(".wifisheet [data-act=reply]").tap();
  } else {
    const tab = await host.context.newPage();
    watch("host's reply tab", tab);
    await tab.goto(reply);
    await tab.waitForFunction(() => document.querySelector(".wr-status")?.innerText.includes("Delivered"), null, { timeout: 10000 });
    check((await tab.locator("#play-duel").count()) === 0, "the reply tab boots no game, and says Delivered");
    await tab.close();
  }

  // 4. pair, pick, play
  await both((p) => p.page.waitForSelector(".duel-cards .op-card", { timeout: 45000 }));
  check(true, "both lobbies paired over the data channel");
  await both((p) => p.page.locator(".duel-cards .op-card").first().tap());
  await both((p) => p.page.waitForFunction(() => window.__bd?.scene && window.__duel?.state === "match", null, { timeout: 90000 }));
  await both((p) => p.page.evaluate(() => cancelAnimationFrame(window.__bd.scene.raf)));
  const sides = await both((p) => p.page.evaluate(() => window.__bd.player));
  check(sides[0] === "blue" && sides[1] === "red", "the host plays blue and the guest red");
  const maps = await both((p) => p.page.evaluate(() => window.__bd.world.mapId));
  check(maps[0] === "riverlands" && maps[1] === "riverlands", "both play the host's map");

  const deadline = Date.now() + 180_000;
  let ticks = [0, 0];
  while (Math.min(...ticks) < TICKS) {
    if (Date.now() > deadline) throw new Error(`FAILED: the match crawled (ticks ${ticks})`);
    ticks = await both((p) =>
      p.page.evaluate((from) => {
        for (let i = 0; i < 2; i++) window.__bd.scene.step(100, 1, false);
        return { tick: window.__duel.tick, trails: window.__duel.trails(from) };
      }, p.seen + 1).then((r) => {
        for (const [tick, trail] of r.trails) {
          p.trail.set(tick, trail);
          p.seen = Math.max(p.seen, tick);
        }
        return r.tick;
      })
    );
  }
  let compared = 0;
  for (const [tick, trail] of host.trail) {
    const other = guest.trail.get(tick);
    if (other === undefined) continue;
    if (other !== trail) throw new Error(`FAILED: the trails differ at tick ${tick}`);
    compared++;
  }
  check(compared >= TICKS - 5, `the hash trails agree at all ${compared} ticks both stepped (to tick ${Math.min(...ticks)})`);
  check(errors.length === 0, `no console errors${errors.length ? `:\n${errors.join("\n")}` : ""}`);
  console.log("WIFI SMOKE OK");
} finally {
  await browser.close();
  server?.close();
}

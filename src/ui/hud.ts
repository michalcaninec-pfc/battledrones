import { BUILDINGS, ECONOMY, OBJECTIVES, POWERS, TICK_RATE, UNITS } from "../sim/balance";
import { buildingBlocker, unitBlocker } from "../sim/economy";
import { Vis } from "../sim/fog";
import type { BuildingKind, Faction, UnitKind, World } from "../sim/types";
import { sfx } from "../game/audio";
import { mapAssetBase } from "../game/assets";
import type { Controller } from "../game/controller";
import { PLAYER } from "../game/controller";
import { onAnnounce, type Announcement } from "../game/announce";
import { radioCue } from "../game/announcer";
import { mountAudioToggles } from "./audio-panel";
import { createSurvivalHud } from "./survival";
import { NAMED_RANK, heroLine, killsLabel, stars } from "../game/heroes";
import { showReport } from "./report";
import { markBanned, pauseRulesHtml } from "./career";
import { rematchToken } from "../game/mode";
import { createOpsHud } from "./ops";
import { mountHudLayout } from "./layout";
import { HINTS, HintQueue, type HintOffer } from "../game/hints";
import { fullscreen } from "./fullscreen";

export interface HudApi {
  world: World;
  ctrl: Controller;
  /** The ground the camera sees (tiles; a trapezoid under the tilted view), outlined on the minimap. */
  viewQuad(): { x: number; y: number }[];
  centerCamera(wx: number, wy: number): void;
  zoomBy(factor: number): void;
  matchSeconds(): number;
  /** Spectator mode: the two AI strategy names, else null. */
  strategies: { blue: string; red: string } | null;
  enemy: { strategy: string; difficulty: string };
  /** Extra info-card line for a build option (the counter advisor). */
  cardNote?(kind: UnitKind | BuildingKind): string | null;
  /** Battlefield wrecks the player knows about (tiles), drawn as gold minimap dots. */
  wrecks?: () => { x: number; y: number }[];
  /** While a calldown is armed: the "Tap map: …" chip and its cancel (powers). */
  targetChip?: () => { label: string; cancel(): void } | null;
  /** Calldown reticles in flight (tiles), drawn as rings on the minimap. */
  calldowns?: () => { x: number; y: number; r: number; enemy: boolean }[];
  /** A big moment owns the screen (opener cards, the finale): no new hints, the hint clock stops. */
  busy?: () => boolean;
  /** Extra minimap marks (map objectives), drawn over the unit blips; k = minimap px per tile. */
  minimapOverlay?: (ctx: CanvasRenderingContext2D, k: number) => void;
}

export interface Hud {
  /** Every frame; `dtMs` is the frame's real time (drives hint pacing). */
  update(dtMs?: number): void;
  showEnd(winner: Faction): void;
  alert(msg: string, x: number, y: number): void;
  /** A small radio caption for an announcer line (tap jumps to x, y). */
  radio(msg: string, tone: string, x?: number, y?: number): void;
  /** A minimap ping; "inbound" is a bigger amber pulse for an approaching raid. */
  ping(x: number, y: number, kind?: "hit" | "inbound"): void;
  /** A 💡 tip in the ticker right now (feedback to a tap), shown for `ms`; tapping it jumps to (x, y). */
  hint(msg: string, ms?: number, x?: number, y?: number): void;
  /**
   * A one-time onboarding hint, paced through the hint queue (src/game/hints.ts):
   * at most one every 12 s, most important first, never over a banner or the
   * opener cards. Re-offering a waiting id is a no-op.
   */
  offerHint(h: HintOffer): void;
  /** Is a banner whose key starts with `prefix` showing or waiting? */
  bannerUp(prefix: string): boolean;
  /** A small toast (veteran promoted / lost…); tapping it jumps to (x, y). */
  notice(msg: string, tone: "good" | "bad" | "info", x: number, y: number): void;
  /** A plain short toast (e.g. why a calldown can't fire). */
  notify(msg: string, tone?: "bad" | "good"): void;
  togglePause(): void;
  destroy(): void;
}

type Tab = "build" | "ground" | "air";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "build", label: "Base", icon: "🏗" },
  { id: "ground", label: "Vehicles", icon: "⛓" },
  { id: "air", label: "Aircraft", icon: "✈" }
];

const BUILDABLE: BuildingKind[] = ["fab-plant", "airpad", "tech-lab", "depot", "turret", "sam-site", "radar"];
const GROUND: UnitKind[] = ["harvester", "stinger", "flak-crawler", "mortar", "titan", "lancer"];
const AIR: UnitKind[] = ["scout", "wasp", "raptor", "hornet", "mender"];

/** Counter hints for the info card, distilled from the duel matrix (tools/balance.ts). */
const MATCHUPS: Partial<Record<UnitKind | BuildingKind, { strong: string; weak: string }>> = {
  harvester: { strong: "—", weak: "Everything. Guard it." },
  scout: { strong: "Spotting through the fog", weak: "Flak, Raptors, SAMs" },
  stinger: { strong: "Flak, Mortars, Lancers, Harvesters", weak: "Wasps, Titans, Hornets" },
  "flak-crawler": { strong: "All aircraft", weak: "Any ground unit" },
  mortar: { strong: "Buildings, clumped armies", weak: "Stingers up close, aircraft" },
  titan: { strong: "Stingers, Flak, Mortars", weak: "Lancers, Wasps, Hornets" },
  lancer: { strong: "Titans, Flak, Raptors; crosses water", weak: "Stinger swarms, Hornets" },
  wasp: { strong: "Stingers, Titans, Mortars", weak: "Flak, Raptors, Lancers" },
  raptor: { strong: "Wasps, Hornets, Scouts", weak: "Flak, Lancers, SAMs" },
  hornet: { strong: "Bases, Titans, clumps", weak: "Flak, Raptors, SAMs" },
  mender: { strong: "Keeps your army alive", weak: "Anything that shoots air" },
  turret: { strong: "Raids by ground or air", weak: "Mortars, Hornets" },
  "sam-site": { strong: "Aircraft at long range", weak: "Any ground unit" }
};

/** Compact labels for the narrow build buttons. */
const SHORT: Partial<Record<UnitKind | BuildingKind, string>> = {
  "fab-plant": "Fab", "tech-lab": "Tech", "sam-site": "SAM", "flak-crawler": "Flak", harvester: "Harvester"
};

const MINIMAP_PX = 256;

const icon = (kind: string) => `assets/icons/${kind}.webp`;

export function createHud(api: HudApi): Hud {
  const root = document.getElementById("hud")!;
  root.innerHTML = `
    <div class="topbar">
      <div class="res" id="res"><span class="gear">⚙</span><span id="scrap">0</span><span class="rate" id="rate"></span></div>
      <div class="clock" id="clock">0:00</div>
      <div id="versus" class="versus" hidden></div>
      <div class="wavepill" id="wavepill" hidden></div>
      <div class="opspill" id="opspill" hidden></div>
    </div>
    <div class="tl">
      <button id="btn-menu" class="round" title="Pause (P)">❚❚</button>
      <button id="btn-mute" class="round" title="Mute all (sound settings in the pause menu)">🔊</button>
    </div>
    <div id="toasts" class="toasts"></div>
    <div id="banner" class="banner" hidden></div>
    <div class="minimap-wrap"><canvas id="minimap"></canvas></div>
    <div class="zoombtns">
      <button id="zoom-in" class="zb" title="Zoom in (+)">＋</button>
      <button id="zoom-out" class="zb" title="Zoom out (−)">−</button>
    </div>
    <div class="dock">
      <div class="ctx">
        <div class="selpanel" id="selpanel" hidden></div>
        <div class="chips" id="chips"></div>
      </div>
      <div class="buildbar">
        <div class="tabs" id="tabs"></div>
        <div class="grid" id="grid"></div>
      </div>
    </div>
    <div id="card" class="card" hidden></div>
    <div id="pause" class="screen" hidden></div>
    <div id="endscreen" class="screen" hidden></div>
  `;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const scrapEl = $("#scrap");
  const rateEl = $("#rate");
  const clockEl = $("#clock");
  const chipsEl = $("#chips");
  const selEl = $("#selpanel");
  const tabsEl = $("#tabs");
  const gridEl = $("#grid");
  const cardEl = $("#card");
  const pauseEl = $("#pause");
  const endEl = $("#endscreen");
  const toastsEl = $("#toasts");
  const bannerEl = $("#banner");
  const minimap = $<HTMLCanvasElement>("#minimap");
  minimap.width = MINIMAP_PX;
  minimap.height = MINIMAP_PX;
  const mctx = minimap.getContext("2d")!;
  const thumb = new Image();
  thumb.src = `${mapAssetBase(api.world.mapId)}/thumb.webp`;
  // the ticker and banner sit under whatever the top band really occupies (src/ui/layout.ts)
  const layout = mountHudLayout(root);

  // keep HUD touches from reaching the game canvas
  const shield = (el: HTMLElement) => el.addEventListener("pointerdown", (e) => e.stopPropagation());
  [root.querySelector(".dock"), root.querySelector(".tl"), root.querySelector(".zoombtns"), cardEl, toastsEl, bannerEl]
    .forEach((el) => el && shield(el as HTMLElement));

  const w = api.world;
  const f = () => w.factions[PLAYER];
  // Last Stand: wave pill, call-wave chip, minimap arrow, end screen
  const surv = w.survival
    ? createSurvivalHud($("#wavepill"), w, { ctrl: api.ctrl, spectator: api.ctrl.spectator, centerCamera: api.centerCamera })
    : null;
  /** Reload straight into another match ("1", "spectate", "daily", "op:<id>"). */
  const relaunch = (token: string) => {
    try {
      sessionStorage.setItem("battledrones.rematch", token);
    } catch {
      /* ignore */
    }
    fullscreen.reload();
  };
  // Ops: goal pill under the clock, objectives card, end-screen stars (ui/ops.ts)
  const ops = w.ops ? createOpsHud($("#opspill"), root, w, { rematch: relaunch }) : null;

  // ---------------------------------------------------------- build bar ---
  let tab: Tab = "build";
  const buttons = new Map<string, HTMLButtonElement>();
  /** Cached child elements of each build button (no per-frame DOM queries). */
  const parts = new Map<string, { prog: HTMLElement; lock: HTMLElement; badge: HTMLElement }>();

  for (const t of TABS) {
    const b = document.createElement("button");
    b.className = "tab";
    b.dataset.tab = t.id;
    b.innerHTML = `<span class="ti">${t.icon}</span><span class="tl2">${t.label}</span><span class="tbadge" hidden></span>`;
    b.addEventListener("click", () => {
      sfx.play("click", 0.5);
      tab = t.id;
      renderGrid();
    });
    tabsEl.appendChild(b);
  }

  const makeButton = (key: string, kind: string, cost: number, name: string, onTap: () => void, onInfo: () => void) => {
    const b = document.createElement("button");
    b.className = "bb";
    b.dataset.key = key;
    b.innerHTML = `
      <img class="ic" src="${icon(kind)}" alt="" draggable="false" />
      <span class="nm">${name}</span>
      <span class="cost">${cost}</span>
      <span class="badge" hidden></span>
      <span class="prog" hidden></span>
      <span class="lock" hidden>🔒</span>`;
    // long-press (touch) or right-click (mouse) opens the info card
    let timer = 0;
    let longFired = false;
    b.addEventListener("pointerdown", (e) => {
      longFired = false;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        longFired = true;
        if (navigator.vibrate) navigator.vibrate(8);
        onInfo();
      }, 420);
      if (e.button === 2) {
        window.clearTimeout(timer);
        onInfo();
        longFired = true;
      }
    });
    const clear = () => window.clearTimeout(timer);
    b.addEventListener("pointerup", clear);
    b.addEventListener("pointerleave", clear);
    b.addEventListener("pointercancel", clear);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      if (longFired) return;
      onTap();
    });
    buttons.set(key, b);
    parts.set(key, {
      prog: b.querySelector<HTMLElement>(".prog")!,
      lock: b.querySelector<HTMLElement>(".lock")!,
      badge: b.querySelector<HTMLElement>(".badge")!
    });
    return b;
  };

  const unitProducers = (kind: UnitKind) =>
    [...w.buildings.values()].filter((b) => b.faction === PLAYER && b.kind === UNITS[kind].builtAt);

  for (const kind of BUILDABLE)
    makeButton(`b:${kind}`, kind, BUILDINGS[kind].cost, SHORT[kind] ?? BUILDINGS[kind].name, () => {
      const p = f().pending;
      if (p?.kind === kind && p.ready) {
        api.ctrl.placing = kind;
        api.ctrl.clearSelection();
        sfx.play("click");
        return;
      }
      if (p) {
        toast(p.kind === kind ? "Under construction…" : "Already constructing a building");
        return;
      }
      const why = buildingBlocker(w, PLAYER, kind);
      if (why) return toast(why);
      if (f().scrap < BUILDINGS[kind].cost) {
        radioCue("no-scrap");
        return toast("Not enough scrap");
      }
      api.ctrl.enqueue({ type: "startBuilding", faction: PLAYER, building: kind });
      sfx.play("click");
    }, () => showCard(kind));

  for (const kind of [...GROUND, ...AIR])
    makeButton(`u:${kind}`, kind, UNITS[kind].cost, SHORT[kind] ?? UNITS[kind].name, () => {
      const why = unitBlocker(w, PLAYER, kind);
      if (why) return toast(why);
      if (f().scrap < UNITS[kind].cost) {
        radioCue("no-scrap");
        return toast("Not enough scrap");
      }
      const candidates = unitProducers(kind).filter((b) => b.queue.length < ECONOMY.maxQueue);
      if (candidates.length === 0) return toast("Production queue full");
      candidates.sort((a, b) => a.queue.length - b.queue.length);
      api.ctrl.enqueue({ type: "produce", faction: PLAYER, buildingId: candidates[0]!.id, unit: kind });
      sfx.play("click");
    }, () => showCard(kind));

  function renderGrid(): void {
    gridEl.innerHTML = "";
    const keys =
      tab === "build" ? BUILDABLE.map((k) => `b:${k}`) : (tab === "ground" ? GROUND : AIR).map((k) => `u:${k}`);
    for (const k of keys) gridEl.appendChild(buttons.get(k)!);
    for (const el of tabsEl.children) (el as HTMLElement).classList.toggle("on", (el as HTMLElement).dataset.tab === tab);
    cardEl.hidden = true;
  }
  renderGrid();

  // ------------------------------------------------------------ info card ---
  function showCard(kind: UnitKind | BuildingKind): void {
    const isUnit = kind in UNITS;
    const s = isUnit ? UNITS[kind as UnitKind] : BUILDINGS[kind as BuildingKind];
    const m = MATCHUPS[kind];
    const rows: string[] = [];
    rows.push(`<tr><td>Cost</td><td>${s.cost}</td><td>HP</td><td>${s.hp}</td></tr>`);
    if (s.dps > 0) {
      const tgt = s.targets === "both" ? "Air + Ground" : s.targets === "air" ? "Air" : "Ground";
      rows.push(`<tr><td>DPS</td><td>${s.dps}</td><td>Range</td><td>${s.range}</td></tr>`);
      rows.push(`<tr><td>Hits</td><td colspan="3">${tgt}${s.splash ? " · splash" : ""}${s.minRange ? ` · min range ${s.minRange}` : ""}</td></tr>`);
    }
    if (isUnit) {
      const u = UNITS[kind as UnitKind];
      rows.push(`<tr><td>Speed</td><td>${u.speed}</td><td>Armor</td><td>${u.armor}</td></tr>`);
      if (u.heal) rows.push(`<tr><td>Repair</td><td colspan="3">${u.heal} HP/s</td></tr>`);
      rows.push(`<tr><td>Built at</td><td colspan="3">${BUILDINGS[u.builtAt].name}${u.requires ? ` + ${BUILDINGS[u.requires].name}` : ""}</td></tr>`);
    }
    const note = api.cardNote?.(kind) ?? null;
    const queuedHere = isUnit
      ? unitProducers(kind as UnitKind).reduce((n, b) => n + b.queue.filter((q) => q.kind === kind).length, 0)
      : 0;
    cardEl.innerHTML = `
      <div class="ch"><img src="${icon(kind)}" alt="" /><div><b>${s.name}</b><p>${s.role}</p></div>
      <button class="x" id="card-x">✕</button></div>
      <table>${rows.join("")}</table>
      ${m ? `<p class="good">▲ ${m.strong}</p><p class="bad">▼ ${m.weak}</p>` : ""}
      ${note ? `<p class="ctr">⚔ ${note}</p>` : ""}
      ${queuedHere > 0 ? `<button class="cta small" id="card-cancel">Cancel one (${queuedHere} queued)</button>` : ""}
      ${!isUnit && f().pending?.kind === kind ? `<button class="cta small warn" id="card-cancel-b">Cancel construction</button>` : ""}`;
    cardEl.hidden = false;
    layout.refresh(true); // (portrait: kept under the band at its real height)
    cardEl.querySelector("#card-x")!.addEventListener("click", () => (cardEl.hidden = true));
    cardEl.querySelector("#card-cancel")?.addEventListener("click", () => {
      const b = unitProducers(kind as UnitKind).find((p) => p.queue.some((q) => q.kind === kind));
      if (b) api.ctrl.enqueue({ type: "cancelProduce", faction: PLAYER, buildingId: b.id, unit: kind as UnitKind });
      cardEl.hidden = true;
    });
    cardEl.querySelector("#card-cancel-b")?.addEventListener("click", () => {
      api.ctrl.enqueue({ type: "cancelBuilding", faction: PLAYER });
      api.ctrl.placing = null;
      cardEl.hidden = true;
    });
  }

  // --------------------------------------------------------------- chips ---
  type Chip = { id: string; label: string; cls?: string; on: () => void; active?: boolean };
  let lastChipKey = "";
  let lastChipShape = "";
  /** The class each chip was last given (so a refused tap's "nope" shake survives a label tick). */
  let chipCls: string[] = [];
  const chipClass = (c: Chip) => `chip ${c.cls ?? ""} ${c.active ? "active" : ""}`;
  function renderChips(list: Chip[]): void {
    const key = list.map((c) => c.id + (c.active ? "*" : "") + (c.cls ?? "") + c.label).join("|");
    if (key === lastChipKey) return;
    lastChipKey = key;
    // same chips, only a label or style ticked (the call-wave bonus, ✓ Place
    // turning ⚠ Blocked): update in place so a tap in progress isn't lost to a rebuilt button
    const shape = list.map((c) => c.id + (c.active ? "*" : "")).join("|");
    if (shape === lastChipShape && chipsEl.children.length === list.length) {
      list.forEach((c, i) => {
        const el = chipsEl.children[i] as HTMLElement;
        if (el.textContent !== c.label) el.textContent = c.label;
        const cls = chipClass(c);
        if (chipCls[i] !== cls) el.className = chipCls[i] = cls;
      });
      return;
    }
    lastChipShape = shape;
    chipCls = list.map(chipClass);
    chipsEl.innerHTML = "";
    for (const c of list) {
      const b = document.createElement("button");
      b.className = chipClass(c);
      b.dataset.id = c.id;
      b.textContent = c.label;
      b.addEventListener("click", () => {
        sfx.play("click", 0.5);
        c.on();
      });
      chipsEl.appendChild(b);
    }
  }

  // ------------------------------------------------------ selection panel ---
  let lastSelKey = "";
  /** A building's HP line and its head queue item's progress bar, updated in place between rebuilds. */
  let selHpEl: HTMLElement | null = null;
  let selHeadEl: HTMLElement | null = null;
  function renderSelection(): void {
    const ctrl = api.ctrl;
    let html = "";
    let key = "";
    let live: { hp: string; head: string } | null = null;
    if (ctrl.selectedBuilding !== null) {
      const b = w.buildings.get(ctrl.selectedBuilding);
      if (b) {
        const st = BUILDINGS[b.kind];
        const q = b.queue.map(
          (it, i) =>
            `<button class="qi" data-i="${i}" data-kind="${it.kind}"><img src="${icon(it.kind)}" alt=""/><span class="qp" style="height:0%"></span></button>`
        );
        // rebuilt only when the queue itself changes: HP and progress tick in
        // place below, so a tap on a queue button (cancel) isn't lost to a rebuild
        key = `b${b.id}:${b.queue.map((x) => x.kind).join(",")}`;
        const head = b.queue[0];
        const k = head ? 1 - head.remaining / (UNITS[head.kind].buildTime * TICK_RATE) : 0;
        live = { hp: `${Math.ceil(b.hp)} / ${st.hp}`, head: `${Math.round(k * 100)}%` };
        // producers say how to set a rally point here (it used to be a chip; the row needs the room)
        const rally = b.kind === "hq" || b.kind === "fab-plant" || b.kind === "airpad";
        html = `<img class="pi" src="${icon(b.kind)}" alt=""/><div class="pt"><b>${st.name}</b>
          <span class="hp">${Math.ceil(b.hp)} / ${st.hp}</span>
          ${b.queue.length ? `<div class="queue">${q.join("")}</div>` : `<span class="hint">${rally && !ctrl.spectator ? "Tap the map to set a rally point" : st.role}</span>`}</div>`;
      }
    } else if (ctrl.selectedUnits.size > 0) {
      const counts = new Map<UnitKind, number>();
      for (const id of ctrl.selectedUnits) {
        const u = w.units.get(id);
        if (u) counts.set(u.kind, (counts.get(u.kind) ?? 0) + 1);
      }
      key = `u:${[...counts].map(([k, n]) => k + n).join(",")}`;
      if (ctrl.selectedUnits.size === 1) {
        const u = w.units.get([...ctrl.selectedUnits][0]!);
        if (u) {
          key += `:${Math.round(u.hp)}:${u.rank}:${u.kills}`;
          const st = UNITS[u.kind];
          // veterans earn a callsign: "★★ Viper · Lancer · 9 kills"
          const title =
            u.rank >= NAMED_RANK
              ? heroLine(w, u).replace(/^(★+)/, '<span class="rank">$1</span>')
              : `${st.name}${u.rank ? ` <span class="rank">${stars(u.rank)}</span>` : ""}${u.kills ? ` · ${killsLabel(u.kills)}` : ""}`;
          html = `<img class="pi" src="${icon(u.kind)}" alt=""/><div class="pt"><b class="${u.rank >= NAMED_RANK ? "hero" : ""}">${title}</b>
            <span class="hp">${Math.ceil(u.hp)} / ${st.hp}</span><span class="hint">${st.role}</span></div>`;
        }
      } else {
        html = `<div class="group">${[...counts]
          .map(([k, n]) => `<span class="gi"><img src="${icon(k)}" alt=""/><b>${n}</b></span>`)
          .join("")}</div>`;
      }
    }
    if (key !== lastSelKey) {
      lastSelKey = key;
      selEl.hidden = html === "";
      selEl.innerHTML = html;
      selHpEl = live ? selEl.querySelector<HTMLElement>(".hp") : null;
      selHeadEl = live ? selEl.querySelector<HTMLElement>(".qi .qp") : null;
      selEl.querySelectorAll<HTMLButtonElement>(".qi").forEach((el) =>
        el.addEventListener("click", () => {
          if (ctrl.selectedBuilding === null) return;
          ctrl.enqueue({
            type: "cancelProduce", faction: PLAYER, buildingId: ctrl.selectedBuilding, unit: el.dataset.kind as UnitKind
          });
          sfx.play("sell", 0.5);
        })
      );
    }
    if (live) {
      if (selHpEl && selHpEl.textContent !== live.hp) selHpEl.textContent = live.hp;
      if (selHeadEl && selHeadEl.style.height !== live.head) selHeadEl.style.height = live.head;
    }
  }
  shield(selEl);

  // ------------------------------------------------------------- toasts ---
  function toast(msg: string, onTap?: () => void, cls = "", ms = 2200): void {
    const t = document.createElement("div");
    t.className = `toast ${cls}`;
    const tx = document.createElement("span");
    tx.className = "tx";
    tx.textContent = msg;
    t.appendChild(tx);
    if (onTap) t.addEventListener("click", onTap);
    // nothing to tap: let touches fall through to the battlefield underneath
    else t.classList.add("passive");
    toastsEl.appendChild(t);
    // the ticker keeps two lines at most: the newest pushes the oldest out (a
    // waiting reader's 💡 hint outlives a burst of alerts)
    while (toastsEl.children.length > 2) {
      const kids = [...toastsEl.children].filter((c) => c !== t);
      const old = kids.find((c) => c.classList.contains("out")) ?? kids.find((c) => !c.classList.contains("hint")) ?? kids[0];
      old?.remove();
    }
    setTimeout(() => t.classList.add("out"), ms);
    setTimeout(() => t.remove(), ms + 500);
  }

  // ------------------------------------------------------------ banners ---
  // Big centre-top callouts for announce(): one at a time, the more
  // important line pre-empts, others wait in a short queue.
  let bannerCur: Announcement | null = null;
  let bannerTimer = 0;
  const bannerQueue: Announcement[] = [];
  const prio = (a: Announcement) => a.priority ?? 2;
  function showBanner(a: Announcement): void {
    bannerCur = a;
    bannerEl.className = `banner ${a.tone ?? "info"}`;
    bannerEl.innerHTML = `<b></b>${a.sub ? "<span></span>" : ""}`;
    bannerEl.querySelector("b")!.textContent = a.text;
    if (a.sub) bannerEl.querySelector("span")!.textContent = a.sub;
    bannerEl.hidden = false;
    layout.refresh(true); // centre it under the band at its real width
    // restart the entrance animation
    void bannerEl.offsetWidth;
    bannerEl.classList.add("in");
    layout.refresh(true); // (landscape: the ticker steps under it)
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => {
      bannerEl.classList.remove("in");
      bannerEl.classList.add("out");
      bannerTimer = window.setTimeout(() => {
        bannerEl.hidden = true;
        bannerCur = null;
        const next = bannerQueue.shift();
        if (next) showBanner(next);
        else layout.refresh(true);
      }, 260);
    }, prio(a) <= 1 ? 3000 : 2200);
  }
  bannerEl.addEventListener("click", () => {
    if (bannerCur?.x !== undefined && bannerCur.y !== undefined) api.centerCamera(bannerCur.x, bannerCur.y);
  });
  const offAnnounce = onAnnounce((a) => {
    if (bannerCur?.key === a.key || bannerQueue.some((q) => q.key === a.key)) return; // no stutter
    if (!bannerCur) return showBanner(a);
    if (prio(a) < prio(bannerCur)) return showBanner(a);
    bannerQueue.push(a);
    bannerQueue.sort((p, q) => prio(p) - prio(q));
    if (bannerQueue.length > 3) bannerQueue.pop();
  });

  // ---------------------------------------------------- first-run hints ---
  const TUTORIAL_KEY = "battledrones.tutorial";
  let hintStage = 99;
  try {
    hintStage = localStorage.getItem(TUTORIAL_KEY) === "done" ? 99 : 0;
  } catch {
    /* storage blocked: skip the hints */
  }
  if (api.ctrl.spectator || w.ops) hintStage = 99; // ops brief the player themselves
  // every one-time hint is paced through one queue (src/game/hints.ts)
  const hints = new HintQueue();
  const mine = (k: string) => [...w.buildings.values()].some((b) => b.faction === PLAYER && b.kind === k);
  const hasFactory = () => mine("fab-plant") || mine("airpad");
  const armySize = () => [...w.units.values()].filter((u) => u.faction === PLAYER && u.kind !== "harvester").length;
  /** The tutorial's next stage, offered to the queue once its moment comes; the stage moves on when it is shown. */
  function tutorial(): void {
    if (hintStage >= 99 || hints.has(`tut-${hintStage}`)) return;
    const stage = hintStage;
    const secs = api.matchSeconds();
    let msg: string | null = null;
    let next = stage;
    let still = () => true;
    if (stage === 0 && secs > 4) {
      // quick-start openers hand out a factory (and maybe an army) up front
      const factory = hasFactory();
      const army = armySize() > 0;
      still = () => hasFactory() === factory && armySize() > 0 === army;
      if (factory) {
        msg = army
          ? "Your harvesters mine on their own. Tap a unit (or ⚔ Select army), then tap the map to send it."
          : "Your harvesters mine on their own. Train tanks in Vehicles, then tap a unit and tap the map to send it.";
        next = 2;
      } else {
        msg = "Your harvester mines scrap by itself. Open Base and tap Fab to build a factory.";
        next = 1;
      }
    } else if (stage === 1 && mine("fab-plant")) {
      msg = "Train tanks in Vehicles. Tap a unit, then tap the map to send it.";
      next = 2;
    } else if (stage === 2 && armySize() >= 3 && secs > 30) {
      msg = "Long-press any build button to see what it counters. ⚔ Select army grabs everyone.";
      next = 3;
    } else if (stage === 3 && secs > 150) {
      msg = "Build a Tech Lab to unlock Titans, Lancers, Mortars and Hornets.";
      next = 99;
    }
    if (!msg) return;
    hints.offer({
      id: `tut-${stage}`,
      msg,
      priority: HINTS.priority.tutorial,
      ttlS: 600,
      valid: () => hintStage === stage && still(),
      onShow: () => {
        hintStage = next;
        if (next < 99) return;
        try {
          localStorage.setItem(TUTORIAL_KEY, "done");
        } catch {
          /* ignore */
        }
      }
    });
  }

  const pings: { x: number; y: number; t: number; kind?: "hit" | "inbound" }[] = [];
  let lastReady: BuildingKind | null = null;

  // --------------------------------------------------------- top buttons ---
  const muteBtn = $<HTMLButtonElement>("#btn-mute");
  const syncMute = () => (muteBtn.textContent = sfx.muted ? "🔇" : "🔊");
  syncMute();
  // one-tap master mute; the per-bus switches live in the pause menu
  const offMute = sfx.onChange(syncMute);
  let offToggles: (() => void) | null = null;
  muteBtn.addEventListener("click", () => sfx.setMuted(!sfx.muted));
  $("#btn-menu").addEventListener("click", () => togglePause());

  for (const [id, factor] of [
    ["zoom-in", 1.45],
    ["zoom-out", 1 / 1.45]
  ] as const)
    $(`#${id}`).addEventListener("click", () => api.zoomBy(factor));

  if (api.ctrl.spectator) {
    root.classList.add("spectator");
    const versus = $("#versus");
    versus.hidden = false;
    versus.innerHTML = `<span class="vs-blue"></span><span class="vs-red"></span>`;
    versus.querySelector(".vs-blue")!.textContent = api.strategies?.blue ?? "Blue";
    versus.querySelector(".vs-red")!.textContent = api.strategies?.red ?? "Red";
    versus.title = `${api.strategies?.blue} vs ${api.strategies?.red}`;
  }

  function togglePause(): void {
    if (!endEl.hidden || w.winner) return; // over (the finale is playing): nothing to pause
    api.ctrl.paused = !api.ctrl.paused;
    pauseEl.hidden = !api.ctrl.paused;
    offToggles?.();
    offToggles = null;
    if (!api.ctrl.paused) return;
    pauseEl.innerHTML = `
      <div class="panel">
        <h1>PAUSED</h1>
        <p class="time">${ops ? ops.pauseLine() : surv ? surv.pauseLine() : api.strategies ? "AI vs AI" : `vs ${api.enemy.strategy} AI · ${api.enemy.difficulty}`}</p>
        ${ops ? ops.pauseHtml() : ""}
        ${pauseRulesHtml(w)}
        <button class="cta" id="p-resume">▶ Resume</button>
        <div id="p-sound"></div>
        <button class="cta alt" id="p-help">How to play</button>
        <button class="cta alt" id="p-fog">${api.ctrl.showFog ? "Reveal map (debug)" : "Restore fog of war"}</button>
        <button class="cta alt" id="p-quit">Quit to menu</button>
        <div id="p-helptext" class="help" hidden>${HELP_HTML}</div>
      </div>`;
    shield(pauseEl);
    offToggles = mountAudioToggles(pauseEl.querySelector<HTMLElement>("#p-sound")!);
    pauseEl.querySelector("#p-resume")!.addEventListener("click", togglePause);
    pauseEl.querySelector("#p-help")!.addEventListener("click", () => {
      const h = pauseEl.querySelector<HTMLElement>("#p-helptext")!;
      h.hidden = !h.hidden;
    });
    pauseEl.querySelector("#p-fog")!.addEventListener("click", () => {
      api.ctrl.showFog = !api.ctrl.showFog;
      togglePause();
    });
    pauseEl.querySelector("#p-quit")!.addEventListener("click", () => fullscreen.reload());
  }

  // ------------------------------------------------------------- minimap ---
  const miniMove = (e: PointerEvent) => {
    const r = minimap.getBoundingClientRect();
    api.centerCamera(((e.clientX - r.left) / r.width) * w.width, ((e.clientY - r.top) / r.height) * w.height);
  };
  let miniDown = false;
  minimap.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    miniDown = true;
    minimap.setPointerCapture(e.pointerId);
    miniMove(e);
  });
  minimap.addEventListener("pointermove", (e) => miniDown && miniMove(e));
  minimap.addEventListener("pointerup", () => (miniDown = false));

  let lastMinimapAt = 0;
  let lastScrap = -1;
  let lastClock = "";
  const incomeWindow: { t: number; v: number }[] = [];

  let lastFrame = performance.now();
  function update(dtMs?: number): void {
    const nowMs = performance.now();
    const dt = dtMs ?? Math.min(250, nowMs - lastFrame);
    lastFrame = nowMs;
    layout.refresh();
    // one-time hints: one at a time, never over a banner or the opener cards, paused time doesn't count
    const busy = api.busy?.() ?? false;
    const quiet = busy || api.ctrl.paused || !!w.winner || bannerCur !== null || bannerQueue.length > 0;
    const shown = hints.update(busy || api.ctrl.paused ? 0 : dt / 1000, quiet);
    if (shown) {
      const { x, y } = shown;
      toast(`💡 ${shown.msg}`, x !== undefined && y !== undefined ? () => api.centerCamera(x, y) : undefined, "hint", shown.ms ?? HINTS.showMs);
    }
    const fs = f();
    const scrap = Math.floor(fs.scrap);
    if (scrap !== lastScrap) {
      lastScrap = scrap;
      scrapEl.textContent = String(scrap);
    }
    const secs = api.matchSeconds();
    const clock = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
    if (clock !== lastClock) {
      lastClock = clock;
      clockEl.textContent = clock;
      // income over the last 60 s of harvesting and salvage
      const os = w.objectives.stats[PLAYER];
      const earned = fs.stats.scrapHarvested + fs.stats.scrapSalvaged + os.uplinkScrap + os.crateScrap;
      incomeWindow.push({ t: secs, v: earned });
      while (incomeWindow.length > 1 && secs - incomeWindow[0]!.t > 60) incomeWindow.shift();
      const first = incomeWindow[0]!;
      const span = Math.max(10, secs - first.t);
      const rate = ((earned - first.v) / span) * 60;
      rateEl.textContent = secs > 10 ? `+${Math.round(rate)}/m` : "";
    }
    surv?.update();
    ops?.update();

    const ctrl = api.ctrl;
    tutorial();
    // chips
    const chips: Chip[] = [];
    // phones narrower than this get short chip labels so the squad chips fit on one row
    const narrow = window.innerWidth < 400;
    const armed = api.targetChip?.();
    if (armed) {
      // a calldown is armed: tap the map to fire it (src/ui/powers.ts)
      chips.push({ id: "target", label: armed.label, cls: "info", on: () => {} });
      chips.push({ id: "untarget", label: "✕", cls: "warn", on: () => armed.cancel() });
    } else if (ctrl.placing) {
      // the ghost's spot: build it here, or why not (src/game/placement-view.ts)
      const why = ctrl.placementProblem();
      chips.push({
        id: "place", label: why ? `⚠ ${why}` : `✓ Place ${BUILDINGS[ctrl.placing].name}`,
        cls: why ? "place bad" : "place go", on: () => ctrl.commitPlacement()
      });
      chips.push({ id: "cancel", label: "✕", cls: "warn", on: () => (ctrl.placing = null) });
    } else if (ctrl.selectedUnits.size > 0 && !ctrl.spectator) {
      chips.push({ id: "stop", label: "■ Stop", on: () => ctrl.stopSelected() });
      chips.push({
        id: "move", label: narrow ? "➜ Move" : "➜ Move only", active: ctrl.forceMove,
        on: () => (ctrl.forceMove = !ctrl.forceMove)
      });
      chips.push({ id: "clear", label: "✕", on: () => ctrl.clearSelection() });
    } else if (ctrl.selectedBuilding !== null && !ctrl.spectator) {
      const b = w.buildings.get(ctrl.selectedBuilding);
      if (b && b.kind !== "hq") {
        const refund = Math.floor(BUILDINGS[b.kind].cost * ECONOMY.sellRefund * (b.hp / BUILDINGS[b.kind].hp));
        chips.push({ id: "sell", label: `$ Sell +${refund}`, cls: "warn", on: () => ctrl.sellSelected() });
      }
      chips.push({ id: "clear", label: "✕", on: () => ctrl.clearSelection() });
    } else if (!ctrl.spectator) {
      const army = [...w.units.values()].filter((u) => u.faction === PLAYER && u.kind !== "harvester").length;
      // units with no orders, when that's not simply everyone
      const idle = army > 0 ? ctrl.idleArmy() : [];
      const showIdle = idle.length > 0 && idle.length < army;
      // Last Stand: bring the next wave in early
      const call = surv?.chip();
      if (army)
        chips.push({ id: "army", label: narrow && (showIdle || call) ? "⚔ Army" : "⚔ Select army", on: () => ctrl.selectArmy() });
      if (showIdle)
        chips.push({ id: "idle", label: `💤 Idle ${idle.length}`, cls: "idle", on: () => ctrl.selectUnits(ctrl.idleArmy()) });
      if (call) chips.push(call);
    }
    renderChips(chips);
    renderSelection();

    // building buttons
    const p = fs.pending;
    if (p?.ready && lastReady !== p.kind && !ctrl.spectator) {
      lastReady = p.kind;
      sfx.play("ready");
      toast(`${BUILDINGS[p.kind].name} ready — tap here to place it`, () => {
        ctrl.placing = p.kind;
      }, "good");
      if (tab !== "build") {
        tab = "build";
        renderGrid();
      }
    }
    if (!p) lastReady = null;
    for (const kind of BUILDABLE) {
      const el = buttons.get(`b:${kind}`)!;
      const { prog, lock } = parts.get(`b:${kind}`)!;
      const pendingThis = p?.kind === kind;
      const blocked = buildingBlocker(w, PLAYER, kind);
      el.classList.toggle("locked", !!blocked);
      el.classList.toggle("poor", !pendingThis && fs.scrap < BUILDINGS[kind].cost);
      el.classList.toggle("busy", !!p && !pendingThis);
      el.classList.toggle("ready", !!(pendingThis && p.ready));
      el.classList.toggle("placing", ctrl.placing === kind);
      lock.hidden = !blocked;
      markBanned(lock, w, kind); // mutators: ⛔ instead of 🔒
      if (pendingThis && !p.ready) {
        prog.hidden = false;
        const total = BUILDINGS[kind].buildTime * TICK_RATE;
        prog.style.height = `${(1 - p.remaining / total) * 100}%`;
      } else prog.hidden = true;
    }
    // unit buttons
    let groundQ = 0;
    let airQ = 0;
    for (const kind of [...GROUND, ...AIR]) {
      const el = buttons.get(`u:${kind}`)!;
      const { prog, lock, badge } = parts.get(`u:${kind}`)!;
      const producers = unitProducers(kind);
      let queued = 0;
      let headProg = -1;
      for (const b of producers)
        b.queue.forEach((q, i) => {
          if (q.kind !== kind) return;
          queued++;
          if (i === 0) headProg = Math.max(headProg, 1 - q.remaining / (UNITS[kind].buildTime * TICK_RATE));
        });
      if (UNITS[kind].domain === "air") airQ += queued;
      else groundQ += queued;
      const blocked = unitBlocker(w, PLAYER, kind);
      el.classList.toggle("locked", !!blocked);
      el.classList.toggle("poor", fs.scrap < UNITS[kind].cost);
      lock.hidden = !blocked;
      markBanned(lock, w, kind); // mutators: ⛔ instead of 🔒
      badge.hidden = queued === 0;
      if (badge.textContent !== String(queued)) badge.textContent = String(queued);
      prog.hidden = headProg < 0;
      if (headProg >= 0) prog.style.height = `${headProg * 100}%`;
    }
    for (const el of tabsEl.children) {
      const t = (el as HTMLElement).dataset.tab as Tab;
      const n = t === "ground" ? groundQ : t === "air" ? airQ : p ? 1 : 0;
      const badge = el.querySelector<HTMLElement>(".tbadge")!;
      badge.hidden = n === 0 || t === tab;
      badge.textContent = t === "build" ? (p?.ready ? "!" : "•") : String(n);
      badge.classList.toggle("hot", t === "build" && !!p?.ready);
    }

    const now = performance.now();
    if (now - lastMinimapAt > 250) {
      lastMinimapAt = now;
      drawMinimap();
    }
  }

  function drawMinimap(): void {
    const S = MINIMAP_PX;
    const k = S / w.width;
    const fogOn = api.ctrl.showFog;
    const vis = w.fog[PLAYER].vis;
    mctx.clearRect(0, 0, S, S);
    if (thumb.complete && thumb.naturalWidth > 0) mctx.drawImage(thumb, 0, 0, S, S);
    else {
      mctx.fillStyle = "#26301f";
      mctx.fillRect(0, 0, S, S);
    }
    if (fogOn) {
      for (let ty = 0; ty < w.height; ty++)
        for (let tx = 0; tx < w.width; tx++) {
          const v = vis[ty * w.width + tx];
          if (v === Vis.Visible) continue;
          mctx.fillStyle = v === Vis.Unexplored ? "rgba(5,7,12,0.96)" : "rgba(5,7,12,0.5)";
          mctx.fillRect(tx * k, ty * k, k + 0.5, k + 0.5);
        }
    }
    // resource fields that still hold anything
    mctx.fillStyle = "rgba(255,214,110,0.55)";
    for (let i = 0; i < w.terrain.length; i++) {
      if (w.scrap[i]! <= 0) continue;
      const tx = i % w.width;
      const ty = (i - tx) / w.width;
      if (fogOn && vis[i] === Vis.Unexplored) continue;
      mctx.fillRect(tx * k + k * 0.25, ty * k + k * 0.25, k * 0.5, k * 0.5);
    }
    // wrecks worth salvaging (fog-respecting: the renderer only lists ones we've seen)
    mctx.fillStyle = "#ffd66e";
    for (const r of api.wrecks?.() ?? []) mctx.fillRect(r.x * k - 2, r.y * k - 2, 4, 4);
    const enemyBuildings = fogOn
      ? [...w.fog[PLAYER].known.values()]
      : [...w.buildings.values()].filter((b) => b.faction !== PLAYER);
    mctx.fillStyle = "#ff4a3a";
    for (const kb of enemyBuildings) {
      const size = BUILDINGS[kb.kind].size;
      mctx.fillRect(kb.tx * k, kb.ty * k, size * k, size * k);
    }
    mctx.fillStyle = "#3d8bff";
    for (const b of w.buildings.values()) {
      if (b.faction !== PLAYER) continue;
      const size = BUILDINGS[b.kind].size;
      mctx.fillRect(b.tx * k, b.ty * k, size * k, size * k);
    }
    for (const u of w.units.values()) {
      const ty = Math.floor(u.y);
      const tx = Math.floor(u.x);
      if (u.faction === PLAYER) mctx.fillStyle = "#9fd0ff";
      else {
        if (fogOn && vis[ty * w.width + tx] !== Vis.Visible) continue;
        mctx.fillStyle = "#ffb0a0";
      }
      mctx.fillRect(u.x * k - 2, u.y * k - 2, 4, 4);
    }
    api.minimapOverlay?.(mctx, k); // Uplinks and supply crates (render/objectives.ts)
    // calldown reticles in flight (public: shown through the fog)
    for (const c of api.calldowns?.() ?? []) {
      mctx.strokeStyle = c.enemy ? "#ff3b30" : "#ffd23f";
      mctx.lineWidth = 2;
      mctx.beginPath();
      mctx.arc(c.x * k, c.y * k, Math.max(4, c.r * k), 0, Math.PI * 2);
      mctx.stroke();
    }
    // alert pings
    const now = api.matchSeconds();
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i]!;
      const age = now - p.t;
      if (age > 3) {
        pings.splice(i, 1);
        continue;
      }
      if (p.kind === "inbound") {
        // a raid on its way: two amber rings, bigger and slower
        for (const off of [0, 0.6]) {
          const a = Math.max(0, age - off);
          mctx.strokeStyle = `rgba(255,190,70,${Math.max(0, 1 - a / 3)})`;
          mctx.lineWidth = 3;
          mctx.beginPath();
          mctx.arc(p.x * k, p.y * k, 6 + a * 14, 0, Math.PI * 2);
          mctx.stroke();
        }
        continue;
      }
      mctx.strokeStyle = `rgba(255,80,60,${1 - age / 3})`;
      mctx.lineWidth = 2;
      mctx.beginPath();
      mctx.arc(p.x * k, p.y * k, 4 + age * 8, 0, Math.PI * 2);
      mctx.stroke();
    }
    surv?.drawMinimap(mctx, k, performance.now());
    const quad = api.viewQuad();
    mctx.strokeStyle = "rgba(255,255,255,0.85)";
    mctx.lineWidth = 1.5;
    mctx.beginPath();
    quad.forEach((p, i) => (i === 0 ? mctx.moveTo(p.x * k, p.y * k) : mctx.lineTo(p.x * k, p.y * k)));
    mctx.closePath();
    mctx.stroke();
  }

  function showEnd(winner: Faction): void {
    const rematch = () => relaunch(rematchToken());
    if (surv && !ops) {
      surv.showEnd(endEl, winner, Math.round(api.matchSeconds()), rematch, () => fullscreen.reload());
      shield(endEl);
      return;
    }
    // the after-action report (src/ui/report.ts)
    showReport(endEl, {
      world: w,
      winner,
      pov: PLAYER,
      spectator: api.ctrl.spectator,
      secs: Math.round(api.matchSeconds()),
      strategies: api.strategies,
      enemy: api.enemy,
      onRematch: rematch,
      onMenu: () => fullscreen.reload(),
      ...(ops?.reportOpts() ?? {})
    });
    shield(endEl);
  }

  return {
    update,
    showEnd,
    alert(msg, x, y) {
      toast(`⚠ ${msg}`, () => api.centerCamera(x, y), "bad");
    },
    radio(msg, tone, x, y) {
      const jump = x !== undefined && y !== undefined ? () => api.centerCamera(x, y) : undefined;
      toast(`${msg}${jump ? " ›" : ""}`, jump, `radio ${tone}`, 2400);
    },
    ping(x, y, kind) {
      if (pings.length < 12 || kind === "inbound") pings.push({ x, y, t: api.matchSeconds(), kind });
    },
    hint(msg, ms = 7000, x, y) {
      toast(`💡 ${msg}`, x !== undefined && y !== undefined ? () => api.centerCamera(x, y) : undefined, "hint", ms);
    },
    offerHint(h) {
      if (!api.ctrl.spectator) hints.offer(h);
    },
    bannerUp(prefix) {
      return !!bannerCur?.key.startsWith(prefix) || bannerQueue.some((a) => a.key.startsWith(prefix));
    },
    notice(msg, tone, x, y) {
      toast(msg, () => api.centerCamera(x, y), tone === "info" ? "" : tone, 3600);
    },
    notify(msg, tone) {
      toast(msg, undefined, tone ?? "", tone === "bad" ? 2200 : 4200);
    },
    togglePause,
    destroy() {
      offAnnounce();
      offMute();
      layout.destroy();
      offToggles?.();
      window.clearTimeout(bannerTimer);
      root.innerHTML = "";
    }
  };
}

export const HELP_HTML = `
  <h3>Goal</h3><p>Destroy the enemy HQ. Protect yours.</p>
  <h3>Openers</h3><p>Every skirmish starts with a pick: <b>Blitz</b> (Fab Plant + 3 Stingers), <b>Industry</b> (Fab Plant, a third harvester, +200 scrap) or <b>Air Wing</b> (Airpad + 3 Wasps). The enemy picks one too.</p>
  <h3>Commander powers</h3><p>The ⚡ meter on the right fills slowly, and faster when you lose units. Spend it on <b>Barrage</b> (3 shells), <b>EMP</b> (freezes enemies for 4 s) or <b>Drop Pod</b> (3 units land where you can see): tap the button, then the map. At 6:00 the <b>Sky Hammer</b> comes online for both sides, an orbital strike every ${POWERS.hammer.cooldown / 60} minutes. Every strike shows a warning circle first: red ones are the enemy's, so move out!</p>
  <h3>Objectives</h3><p>📡 <b>Uplinks</b> sit in the contested middle of every map: park units in the ring to fill its bar (aircraft count half, harvesters not at all; with both sides inside it freezes). Holding one pays ${OBJECTIVES.uplink.income} scrap/s, lights up the fog around it and charges your ⚡ meter. 📦 <b>Supply drops</b> land in pairs from 1:30, every 75 s, announced 10 s ahead to both sides: the first unit to reach a crate takes it (scrap, Veterans, Field Repair, ⚡ charge, or a rare free Lancer). Unclaimed crates burn out after 45 s.</p>
  <h3>Last Stand</h3><p>No enemy base: hold out against endless waves. The top bar shows the next wave's theme (Air Raid, Armour Column, Artillery, Mixed; a Boss every 5th) and the minimap arrow where it will enter. Clearing a wave pays scrap; with the field clear, <b>Call wave</b> brings the next one early for a bonus.</p>
  <h3>Ops</h3><p>A short campaign of handcrafted missions with a twist — hold a bridge, deliver scrap under air raids, decapitate a base with a strike group, fight with no income. Each has a goal pill under the clock (tap it for the objectives) and three stars: complete it, plus two harder conditions. The first three are open; every op you complete opens the next.</p>
  <h3>Career, Daily Op and mutators</h3><p>Wins, Last Stand waves and medals earn XP toward ten ranks; each map and difficulty has three stars (win, win under 8:00, win without losing a building). The <b>Daily Op</b> is one seeded match a day, the same for everyone, and keeps a win streak. <b>Mutators</b> twist a skirmish's rules for both sides (no stars). Tap your rank on the menu for medals and records.</p>
  <h3>Economy</h3><p>Harvesters mine scrap piles and glowing crystals (worth more) and haul them to your HQ or a Depot. More harvesters, more scrap. Destroyed units leave glinting <b>wrecks</b> worth 30% of their cost (a Last Stand wave's only 5%) for a minute: roll any ground unit over one to salvage it.</p>
  <h3>Building</h3><p>Open <b>Base</b> and tap a structure to construct it. When it's ready, tap it again: a ghost appears on a free spot near your base. Tap the map (or drag the ghost) to move it, then tap the ghost or <b>✓ Place</b> to build. With a mouse, just click the spot. Build buttons marked ⚔ counter enemies you've seen; a tab marked <b>idle</b> has a factory doing nothing.</p>
  <h3>Army</h3><p>Tap a unit to select it, drag-hold (long-press) to box-select, double-tap to grab all of that type on screen. With a mouse, Shift+click adds a unit to the selection or takes it out. Tap the ground to attack-move, tap an enemy to attack. <b>Move only</b> retreats without stopping to fight. <b>💤 Idle</b> grabs units with no orders.</p>
  <h3>Squads</h3><p>Hold a squad chip (<b>1</b>, <b>2</b>, <b>3</b>) to save the selected units into it. Tap it to select them again, double-tap to fly the camera there. It flashes red when a member is hit. Keys: 1–3 select, Ctrl+1–3 (or Shift+1–3) save.</p>
  <h3>Counters</h3><p>Stingers beat Flak · Flak beats aircraft · Wasps beat tanks · Raptors hunt aircraft · Titans crush ground armies · Mortars and Hornets smash bases. Long-press any build button for details.</p>
  <h3>Terrain</h3><p>Roads are fast, mud and woods are slow, woods give cover. Water blocks tanks — Lancers hover across, aircraft fly over everything.</p>
  <h3>Camera</h3><p>Drag to pan, pinch to zoom, tap the minimap to jump. Pulsing arrows at the screen edge point at fights you can't see (red: you're being hit) — tap one to fly there, or tap ⚡ to cycle through them.</p>
  <h3>Speed</h3><p>Tap the <b>1×</b> chip by the clock for 1.5× or 2×; hold the clock to fast-forward at 3×.</p>`;


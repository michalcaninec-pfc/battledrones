import { BUILDINGS, ECONOMY, GOLIATH, INFANTRY as INF, LIFELINE, OBJECTIVES, POWERS, TICK_RATE, UNITS } from "../sim/balance";
import { buildingBlocker, queuesOf, unitBlocker } from "../sim/economy";
import { Vis } from "../sim/fog";
import { anchorBlocker, modeProgress, unitCost, weaponReady } from "../sim/goliath";
import { isTransport, squadAlive, squadSize, unitSeenBy } from "../sim/infantry";
import { liftedBy } from "../sim/lift";
import { goliathBase } from "../sim/rules";
import type { BuildingKind, Faction, GoliathWeapon, QueueItem, Unit, UnitKind, World } from "../sim/types";
import { hasBuilding } from "../sim/world";
import { sfx } from "../game/audio";
import { mapAssetBase } from "../game/assets";
import type { Controller } from "../game/controller";
import { PLAYER, isArmyUnit, isProducer, isRooted, pickProducer } from "../game/controller";
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
  /** The end screen: who won, or "draw" (Robot Love), which never reads as a defeat. */
  showEnd(winner: Faction | "draw"): void;
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

type Tab = "build" | "ground" | "infantry" | "air";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "build", label: "Base", icon: "🏗" },
  { id: "ground", label: "Vehicles", icon: "⛓" },
  { id: "infantry", label: "Infantry", icon: "🤖" },
  { id: "air", label: "Aircraft", icon: "✈" }
];

const BUILDABLE: BuildingKind[] = ["fab-plant", "airpad", "assembly-bay", "tech-lab", "depot", "turret", "sam-site", "radar", "gantry"];
const GROUND: UnitKind[] = ["harvester", "stinger", "flak-crawler", "mortar", "mastodon", "lancer", "goliath"];
const INFANTRY: UnitKind[] = ["trooper", "rocket-squad", "sniper"];
const AIR: UnitKind[] = ["scout", "wasp", "raptor", "hornet", "mender", "condor"];
const UNIT_TABS: { tab: Tab; kinds: UnitKind[] }[] = [
  { tab: "ground", kinds: GROUND },
  { tab: "infantry", kinds: INFANTRY },
  { tab: "air", kinds: AIR }
];
const ALL_UNITS = UNIT_TABS.flatMap((t) => t.kinds);
/** The build-bar tab a unit's button sits on. */
const tabOf = (kind: UnitKind): Tab => UNIT_TABS.find((t) => t.kinds.includes(kind))?.tab ?? "ground";

/** Counter hints for the info card, distilled from the duel matrix (tools/balance.ts). */
const MATCHUPS: Partial<Record<UnitKind | BuildingKind, { strong: string; weak: string }>> = {
  harvester: { strong: "—", weak: "Everything. Guard it." },
  scout: { strong: "Spotting through the fog", weak: "Flak, Raptors, SAMs" },
  stinger: { strong: "Flak, Mortars, Lancers, Harvesters", weak: "Wasps, Mastodons, Hornets" },
  "flak-crawler": { strong: "All aircraft", weak: "Any ground unit" },
  mortar: { strong: "Buildings, clumped armies", weak: "Stingers up close, aircraft" },
  mastodon: { strong: "Stingers, Flak, Mortars", weak: "Rocket Squads, Lancers, Wasps" },
  lancer: { strong: "Mastodons, Goliaths, Flak, Raptors; crosses water", weak: "Stinger swarms, Hornets" },
  goliath: { strong: "Ground armies and bases; a walking base itself", weak: "Rocket Squads, Wasps, Lancers, Hornets" },
  wasp: { strong: "Stingers, Mastodons, Goliaths, Mortars", weak: "Flak, Raptors, Lancers" },
  raptor: { strong: "Wasps, Hornets, Scouts", weak: "Flak, Lancers, SAMs" },
  hornet: { strong: "Bases, Mastodons, Goliaths, clumps", weak: "Flak, Raptors, SAMs" },
  mender: { strong: "Keeps your army alive; the only repair a Goliath takes", weak: "Anything that shoots air" },
  trooper: { strong: "Rocket Squads, light raids; shoots air too", weak: "Snipers, Mortars, Hornets, Turrets" },
  "rocket-squad": { strong: "Mastodons, Goliaths, Hornets, heavy armour", weak: "Troopers, Snipers, Mortars" },
  sniper: { strong: "Infantry at long range; hides in woods", weak: "Stingers, Wasps, anything armoured" },
  condor: { strong: "Drops 2 squads anywhere, over water and rock", weak: "Flak, Raptors, SAMs" },
  turret: { strong: "Raids by ground or air, infantry", weak: "Mortars, Hornets" },
  "sam-site": { strong: "Aircraft at long range", weak: "Any ground unit" },
  "assembly-bay": { strong: "Cheap squads that hold woods and Uplinks", weak: "Splash: Mortars, Hornets" },
  gantry: { strong: "Builds Goliaths, the base that walks", weak: "Always in the enemy's sight; Mortars, Hornets" }
};

/** A Goliath's weapon systems in the order damage takes them, with short labels for the selection panel. */
const GOLIATH_STRIP: { k: GoliathWeapon; short: string }[] = [
  { k: "mortars", short: "Mortars" },
  { k: "laser", short: "Laser" },
  { k: "cannons", short: "Cannons" },
  { k: "mg", short: "MG" }
];

/** A Goliath's state for the selection panel: walking, anchoring (with progress), anchored, packing up, or on a lift. */
function goliathMode(u: Unit): string {
  const g = u.goliath!;
  if (g.lift) return g.lift.phase === "hooking" ? "Condors hooking on…" : "⇡ On a lift";
  const pct = `${Math.floor(modeProgress(u) * 20) * 5}%`;
  if (g.mode === "anchoring") return `⚓ Anchoring ${pct}`;
  if (g.mode === "packing") return `⇡ Packing up ${pct}`;
  return g.mode === "anchored" ? "⚓ Anchored" : "Walking";
}

/** One weapon system's state: firing, held (grounded to its machine guns on a lift), rebooting or offline. */
function weaponState(u: Unit, k: GoliathWeapon): "on" | "held" | "boot" | "off" {
  const ws = u.goliath!.weapons[k];
  if (ws.online) return weaponReady(u, k) ? "on" : "held";
  return ws.reboot >= 0 ? "boot" : "off";
}

/** Compact labels for the narrow build buttons. */
const SHORT: Partial<Record<UnitKind | BuildingKind, string>> = {
  "fab-plant": "Fab", "tech-lab": "Tech", "sam-site": "SAM", "flak-crawler": "Flak", harvester: "Harvester",
  "assembly-bay": "Bay", trooper: "Troopers", "rocket-squad": "Rockets", sniper: "Snipers"
};

const MINIMAP_PX = 256;

/** A portrait in a side's paint: the enemy's units and buildings (or either side's, to a spectator) show red. */
const icon = (kind: string, f: Faction = "blue") => `assets/icons/${f === "red" ? "red/" : ""}${kind}.webp`;

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
  /** Cached child elements of each build button (no per-frame DOM queries), and the price its label shows. */
  const parts = new Map<string, { prog: HTMLElement; lock: HTMLElement; badge: HTMLElement; cost: HTMLElement; price: number }>();

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
      badge: b.querySelector<HTMLElement>(".badge")!,
      cost: b.querySelector<HTMLElement>(".cost")!,
      price: cost
    });
    return b;
  };

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

  for (const kind of ALL_UNITS)
    makeButton(`u:${kind}`, kind, unitCost(w, PLAYER, kind), SHORT[kind] ?? UNITS[kind].name, () => {
      const why = unitBlocker(w, PLAYER, kind);
      if (why) return toast(why);
      if (f().scrap < unitCost(w, PLAYER, kind)) {
        radioCue("no-scrap");
        return toast("Not enough scrap");
      }
      // (infantry: a selected anchored Goliath first, else the shortest queue, Bays and Goliaths alike)
      const at = pickProducer(w, kind, api.ctrl.selectedUnits);
      if (!at) return toast(kind === "goliath" ? "Gantry busy" : "Production queue full");
      api.ctrl.enqueue({ type: "produce", faction: PLAYER, buildingId: at.id, unit: kind });
      sfx.play("click");
    }, () => showCard(kind));

  function renderGrid(): void {
    gridEl.innerHTML = "";
    const keys =
      tab === "build" ? BUILDABLE.map((k) => `b:${k}`) : UNIT_TABS.find((t) => t.tab === tab)!.kinds.map((k) => `u:${k}`);
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
    // (a Goliath's price climbs with every one you have: the card shows today's)
    const cost = isUnit ? unitCost(w, PLAYER, kind as UnitKind) : s.cost;
    rows.push(`<tr><td>Cost</td><td>${cost}</td><td>HP</td><td>${s.hp}</td></tr>`);
    /** A Goliath's four weapon systems, in a table of their own after the cost. */
    let weapons = "";
    if (kind === "goliath") {
      rows.push(`<tr><td>Price</td><td colspan="3">+${Math.round(GOLIATH.costStep * 100)}% for each Goliath you have</td></tr>`);
      // four weapon systems instead of one: the longest reach goes first as it is hurt
      weapons = `<table class="gwt"><tr class="gw-head"><td>Weapon</td><td>Range</td><td></td></tr>${GOLIATH_STRIP.map(({ k }) => {
        const ws = GOLIATH.weapons[k];
        const off = ws.lostBelow > 0 ? `offline below ${Math.round(ws.lostBelow * 100)}%` : "always on";
        return `<tr><td>${ws.name}</td><td>${ws.range}</td><td>${off}${ws.targets === "both" ? " · air too" : ""}</td></tr>`;
      }).join("")}</table>`;
    } else if (s.dps > 0) {
      const tgt = s.targets === "both" ? "Air + Ground" : s.targets === "air" ? "Air" : "Ground";
      rows.push(`<tr><td>DPS</td><td>${s.dps}</td><td>Range</td><td>${s.range}</td></tr>`);
      rows.push(`<tr><td>Hits</td><td colspan="3">${tgt}${s.splash ? " · splash" : ""}${s.minRange ? ` · min range ${s.minRange}` : ""}</td></tr>`);
    }
    if (isUnit) {
      const u = UNITS[kind as UnitKind];
      rows.push(`<tr><td>Speed</td><td>${u.speed}</td><td>Armor</td><td>${u.armor}</td></tr>`);
      if (u.heal) rows.push(`<tr><td>Repair</td><td colspan="3">${u.heal} HP/s</td></tr>`);
      // a squad is one unit drawn as several robots; the Condor is a flying bus
      if (u.squad) rows.push(`<tr><td>Squad</td><td colspan="3">${u.squad} robots · firepower drops as they fall</td></tr>`);
      if (u.capacity) rows.push(`<tr><td>Cargo</td><td colspan="3">Carries ${u.capacity} squads · unarmed</td></tr>`);
      if (kind === "goliath") rows.push(`<tr><td>Repair</td><td colspan="3">Menders only</td></tr>`);
      rows.push(`<tr><td>Built at</td><td colspan="3">${BUILDINGS[u.builtAt].name}${u.requires ? ` + ${BUILDINGS[u.requires].name}` : ""}</td></tr>`);
    } else {
      const b = BUILDINGS[kind as BuildingKind];
      // every prerequisite, ticked off as it stands (the Gantry needs all four)
      if (b.requiresAll)
        rows.push(`<tr><td>Needs</td><td colspan="3" class="needs">${b.requiresAll
          .map((k) => (hasBuilding(w, PLAYER, k) ? `<span class="have">✓ ${BUILDINGS[k].name}</span>` : `<span>${BUILDINGS[k].name}</span>`))
          .join(" ")}</td></tr>`);
      if (b.unique) rows.push(`<tr><td>Limit</td><td colspan="3">One per side</td></tr>`);
    }
    const note = api.cardNote?.(kind) ?? null;
    const queuedHere = isUnit
      ? queuesOf(w, PLAYER, kind as UnitKind).reduce((n, p) => n + p.queue.filter((q) => q.kind === kind).length, 0)
      : 0;
    cardEl.innerHTML = `
      <div class="ch"><img src="${icon(kind)}" alt="" /><div><b>${s.name}</b><p>${s.role}</p></div>
      <button class="x" id="card-x">✕</button></div>
      ${weapons ? `<table>${rows.slice(0, 2).join("")}</table>${weapons}<table>${rows.slice(2).join("")}</table>` : `<table>${rows.join("")}</table>`}
      ${m ? `<p class="good">▲ ${m.strong}</p><p class="bad">▼ ${m.weak}</p>` : ""}
      ${note ? `<p class="ctr">⚔ ${note}</p>` : ""}
      ${queuedHere > 0 ? `<button class="cta small" id="card-cancel">Cancel one (${queuedHere} queued)</button>` : ""}
      ${!isUnit && f().pending?.kind === kind ? `<button class="cta small warn" id="card-cancel-b">Cancel construction</button>` : ""}`;
    cardEl.hidden = false;
    layout.refresh(true); // (portrait: kept under the band at its real height)
    cardEl.querySelector("#card-x")!.addEventListener("click", () => (cardEl.hidden = true));
    cardEl.querySelector("#card-cancel")?.addEventListener("click", () => {
      const p = queuesOf(w, PLAYER, kind as UnitKind).find((p) => p.queue.some((q) => q.kind === kind));
      if (p) api.ctrl.enqueue({ type: "cancelProduce", faction: PLAYER, buildingId: p.id, unit: kind as UnitKind });
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
  /** The chips as last rendered: a tap runs the current chip's action (one updated in place may now do something else). */
  let chipList: Chip[] = [];
  function renderChips(list: Chip[]): void {
    chipList = list;
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
    list.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = chipClass(c);
      b.dataset.id = c.id;
      b.textContent = c.label;
      b.addEventListener("click", () => {
        sfx.play("click", 0.5);
        chipList[i]?.on();
      });
      chipsEl.appendChild(b);
    });
  }

  /** Shake chip `id` with a buzz: that tap was refused. */
  function nope(id: string): void {
    sfx.play("deny", 0.6);
    const el = chipsEl.querySelector<HTMLElement>(`.chip[data-id="${id}"]`);
    if (!el) return;
    el.classList.remove("nope");
    void el.offsetWidth;
    el.classList.add("nope");
  }

  /**
   * The selected Goliaths' chip, one id through every state so it updates in
   * place: ⚓ Anchor (or ⚠ why it can't here, which says so and shakes), ⇡ Pack
   * up once anchored, and a progress readout while digging in or packing up
   * (the G key does the same). On a narrow phone the progress is short ("⚓
   * 40%": the panel above says it in full) and a reason wraps onto two lines,
   * so the row stays one row. Null with no Goliath on the ground selected.
   */
  function goliathChip(gs: Unit[], narrow: boolean): Chip | null {
    if (gs.length === 0) return null;
    const ctrl = api.ctrl;
    const walking = gs.filter((g) => g.goliath!.mode === "walking");
    if (walking.length > 0) {
      // (any one that can dig in makes it ⚓ Anchor: those that can, do)
      const why = walking.every((g) => anchorBlocker(w, g)) ? anchorBlocker(w, walking[0]!) : null;
      if (why)
        return { id: "anchor", label: `⚠ ${why}`, cls: "anchor bad", on: () => (ctrl.toggleAnchor(), nope("anchor")) };
      return { id: "anchor", label: "⚓ Anchor", cls: "anchor go", on: () => ctrl.toggleAnchor() };
    }
    if (gs.some((g) => g.goliath!.mode === "anchored"))
      return { id: "anchor", label: "⇡ Pack up", cls: "anchor", on: () => ctrl.toggleAnchor() };
    // digging in or packing up: progress only (the one furthest from done)
    const slow = gs.reduce((a, b) => (modeProgress(b) < modeProgress(a) ? b : a));
    const short = `${slow.goliath!.mode === "packing" ? "⇡" : "⚓"} ${Math.floor(modeProgress(slow) * 20) * 5}%`;
    return { id: "anchor", label: narrow ? short : goliathMode(slow), cls: "info", on: () => {} };
  }

  // ------------------------------------------------------ selection panel ---
  let lastSelKey = "";
  /**
   * What ticks between rebuilds, updated in place: a building's or a
   * Goliath's HP, its head queue item's progress bar, a Goliath digging in
   * or packing up.
   */
  let selHpEl: HTMLElement | null = null;
  let selHeadEl: HTMLElement | null = null;
  let selModeEl: HTMLElement | null = null;
  type Live = { hp: string; head: string; mode?: string };

  /** A producer's queue as cancel buttons (`p`: the building's or anchored Goliath's id, on side `f`). */
  const queueHtml = (p: number, q: readonly QueueItem[], f: Faction) =>
    `<div class="queue">${q
      .map((it) => `<button class="qi" data-p="${p}" data-kind="${it.kind}"><img src="${icon(it.kind, f)}" alt=""/><span class="qp" style="height:0%"></span></button>`)
      .join("")}</div>`;
  /** How far the head of a queue is (a CSS height). */
  const headShare = (q: readonly QueueItem[]) => {
    const head = q[0];
    return `${Math.round((head ? 1 - head.remaining / (UNITS[head.kind].buildTime * TICK_RATE) : 0) * 100)}%`;
  };

  /**
   * One Goliath's panel: its mode (and progress), its weapon systems (firing,
   * held on a lift, rebooting or offline), HP and, ours and anchored, its
   * training queue with cancel buttons. Rebuilt only when that structure
   * changes (HP and progress tick in place), so a tap on the queue isn't lost.
   * The enemy's, or any to a spectator: information only.
   */
  function goliathPanel(u: Unit): { key: string; html: string; live: Live } {
    const g = u.goliath!;
    const st = UNITS[u.kind];
    const own = u.faction === PLAYER && !api.ctrl.spectator;
    const states = GOLIATH_STRIP.map(({ k }) => weaponState(u, k));
    const mode = g.lift ? g.lift.phase : g.mode;
    const key = `g${u.id}:${mode}:${states.join(",")}:${g.queue.map((q) => q.kind).join(",")}:${u.rank}:${u.kills}:${own}`;
    const title = `${st.name}${u.rank ? ` <span class="rank">${stars(u.rank)}</span>` : ""}${u.kills ? ` · ${killsLabel(u.kills)}` : ""}`;
    const said = { on: "firing", held: "held on the lift", boot: "rebooting", off: "offline" };
    const strip = GOLIATH_STRIP.map(
      ({ k, short }, i) => `<span class="gw ${states[i]}" title="${GOLIATH.weapons[k].name}: ${said[states[i]!]}">${short}</span>`
    ).join("");
    // ours, anchored: it trains squads, and under Nomads or Goliath Armada Harvesters too (a queue that
    // stopped when it packed up stays cancellable)
    const train = !own
      ? ""
      : g.queue.length > 0
        ? queueHtml(u.id, g.queue, u.faction)
        : g.mode === "anchored" && !g.lift
          ? `<span class="hint">${goliathBase(w) ? "Trains Harvesters and squads" : "Trains squads"} · tap the map to rally</span>`
          : "";
    const live: Live = { hp: `${Math.ceil(u.hp)} / ${st.hp}`, head: headShare(g.queue), mode: goliathMode(u) };
    // (short landscape screens put the name and the HP line side by side: style.css)
    const html = `<img class="pi" src="${icon(u.kind, u.faction)}" alt=""/><div class="pt"><div class="ghead"><b>${title}</b>
      <span class="gline"><span class="hp">${live.hp}</span><span class="gmode">${live.mode}</span></span></div>
      <span class="gweap">${strip}</span>${train}</div>`;
    return { key, html, live };
  }

  function renderSelection(): void {
    const ctrl = api.ctrl;
    let html = "";
    let key = "";
    let live: Live | null = null;
    if (ctrl.selectedBuilding !== null) {
      const b = w.buildings.get(ctrl.selectedBuilding);
      if (b) {
        const st = BUILDINGS[b.kind];
        // rebuilt only when the queue itself changes: HP and progress tick in
        // place below, so a tap on a queue button (cancel) isn't lost to a rebuild
        key = `b${b.id}:${b.queue.map((x) => x.kind).join(",")}`;
        live = { hp: `${Math.ceil(b.hp)} / ${st.hp}`, head: headShare(b.queue) };
        // producers say how to set a rally point here (it used to be a chip; the row needs the room);
        // an outpost (built in a Goliath's ring) that it doesn't count as base
        const rally = isProducer(b.kind);
        const note = b.outpost
          ? "Outpost: doesn't extend build range"
          : rally && !ctrl.spectator ? "Tap the map to set a rally point" : st.role;
        html = `<img class="pi" src="${icon(b.kind, b.faction)}" alt=""/><div class="pt"><b>${st.name}${b.outpost ? ' <span class="outpost">· Outpost</span>' : ""}</b>
          <span class="hp">${Math.ceil(b.hp)} / ${st.hp}</span>
          ${b.queue.length ? queueHtml(b.id, b.queue, b.faction) : `<span class="hint">${note}</span>`}</div>`;
      }
    } else if (ctrl.selectedUnits.size > 0) {
      const counts = new Map<UnitKind, number>();
      /** Squads riding in the selected Condors, by kind. */
      const aboard = new Map<UnitKind, number>();
      /** Whose they are (a selection is one side's). */
      let side: Faction = PLAYER;
      for (const id of ctrl.selectedUnits) {
        const u = w.units.get(id);
        if (!u) continue;
        side = u.faction;
        counts.set(u.kind, (counts.get(u.kind) ?? 0) + 1);
        for (const p of u.passengers ?? []) aboard.set(p.kind, (aboard.get(p.kind) ?? 0) + 1);
      }
      key = `u:${side}:${[...counts].map(([k, n]) => k + n).join(",")}|${[...aboard].map(([k, n]) => k + n).join(",")}`;
      if (ctrl.selectedUnits.size === 1) {
        const u = w.units.get([...ctrl.selectedUnits][0]!);
        if (u?.goliath) ({ key, html, live } = goliathPanel(u));
        else if (u) {
          // a Condor on a lift shows the Goliath it carries
          const lifting = liftedBy(w, u);
          key += `:${Math.round(u.hp)}:${u.rank}:${u.kills}:${(u.passengers ?? []).map((p) => `${p.id}/${squadAlive(p)}`).join(",")}:${lifting?.goliath!.lift!.phase ?? ""}`;
          const st = UNITS[u.kind];
          // veterans earn a callsign: "★★ Viper · Lancer · 9 kills"
          const title =
            u.rank >= NAMED_RANK
              ? heroLine(w, u).replace(/^(★+)/, '<span class="rank">$1</span>')
              : `${st.name}${u.rank ? ` <span class="rank">${stars(u.rank)}</span>` : ""}${u.kills ? ` · ${killsLabel(u.kills)}` : ""}`;
          // a squad counts its robots still standing ("4/5 robots")
          const n = squadSize(u.kind);
          const robots = n > 1 ? `<span class="robots"> · ${squadAlive(u)}/${n} robots</span>` : "";
          // a Condor shows who is aboard, seat by seat, instead of its role line (or the Goliath it lifts)
          const transport = isTransport(u.kind);
          const empty =
            mine("gantry") || [...w.units.values()].some((o) => o.goliath && o.faction === PLAYER)
              ? `<span class="hint">Empty: tap a squad to load it</span><span class="hint">Select two and tap a Goliath to lift it</span>`
              : `<span class="hint">Empty: tap a squad to load it</span>`;
          const how = u.faction === PLAYER && !ctrl.spectator;
          const hint = lifting
            ? lifting.goliath!.lift!.phase === "hooking"
              ? `<span class="hint">Hooking onto a Goliath</span>`
              : `<span class="hint">Carrying a Goliath</span>${how ? `<span class="hint">Long-press the map to set it down</span>` : ""}`
            : transport
              ? (u.passengers?.length ?? 0) > 0 || ctrl.spectator ? "" : empty
              : `<span class="hint">${st.role}</span>`;
          const hold = lifting
            ? `<div class="cargo"><span class="seat lift" title="Goliath"><img src="${icon("goliath", u.faction)}" alt=""/></span></div>`
            : transport ? cargoHtml(u) : "";
          html = `<img class="pi" src="${icon(u.kind, u.faction)}" alt=""/><div class="pt"><b class="${u.rank >= NAMED_RANK ? "hero" : ""}">${title}</b>
            <span class="hp">${Math.ceil(u.hp)} / ${st.hp}${robots}</span>${hint}</div>${hold}`;
        }
      } else {
        html = `<div class="group">${[...counts]
          .map(([k, n]) => `<span class="gi"><img src="${icon(k, side)}" alt=""/><b>${n}</b></span>`)
          .join("")}${[...aboard]
          .map(([k, n]) => `<span class="gi aboard" title="Aboard a Condor"><img src="${icon(k, side)}" alt=""/><b>${n}</b></span>`)
          .join("")}</div>`;
      }
    }
    if (key !== lastSelKey) {
      lastSelKey = key;
      selEl.hidden = html === "";
      selEl.innerHTML = html;
      selHpEl = live ? selEl.querySelector<HTMLElement>(".hp") : null;
      selHeadEl = live ? selEl.querySelector<HTMLElement>(".qi .qp") : null;
      selModeEl = live?.mode !== undefined ? selEl.querySelector<HTMLElement>(".gmode") : null;
      // (each button names its producer: a building, or an anchored Goliath)
      selEl.querySelectorAll<HTMLButtonElement>(".qi").forEach((el) =>
        el.addEventListener("click", () => {
          if (ctrl.spectator) return;
          ctrl.enqueue({
            type: "cancelProduce", faction: PLAYER, buildingId: Number(el.dataset.p), unit: el.dataset.kind as UnitKind
          });
          sfx.play("sell", 0.5);
        })
      );
    }
    if (live) {
      if (selHpEl && selHpEl.textContent !== live.hp) selHpEl.textContent = live.hp;
      if (selHeadEl && selHeadEl.style.height !== live.head) selHeadEl.style.height = live.head;
      if (selModeEl && live.mode !== undefined && selModeEl.textContent !== live.mode) selModeEl.textContent = live.mode;
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
  const armySize = () => [...w.units.values()].filter(isArmyUnit).length;
  /** Move the tutorial on to stage `next`; at 99 it's done for good. */
  function advance(next: number): void {
    hintStage = next;
    if (next < 99) return;
    try {
      localStorage.setItem(TUTORIAL_KEY, "done");
    } catch {
      /* ignore */
    }
  }
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
      // (one already stands: nothing left to teach)
      if (mine("tech-lab")) return advance(99);
      msg = "Build a Tech Lab to unlock Mastodons, Lancers, Mortars, Hornets and Snipers.";
      still = () => !mine("tech-lab");
      next = 99;
    }
    if (!msg) return;
    hints.offer({
      id: `tut-${stage}`,
      msg,
      priority: HINTS.priority.tutorial,
      ttlS: 600,
      valid: () => hintStage === stage && still(),
      onShow: () => advance(next)
    });
  }

  const pings: { x: number; y: number; t: number; kind?: "hit" | "inbound" }[] = [];
  let lastReady: BuildingKind | null = null;
  /** The anchored Goliaths selected last frame (ids), to open the Infantry tab when one turns up. */
  let lastTrainers = "";

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
      // loaded Condors: drop the squads where they are (a long-press on the map drops them there);
      // a lift in the air: set its Goliath down where it hovers
      const aboard = ctrl.aboardSelected();
      const lifts = ctrl.liftsSelected();
      const setDown = lifts.some((g) => g.goliath!.lift!.phase === "carrying");
      const anchor = goliathChip(ctrl.goliathsSelected(), narrow);
      const unload = aboard > 0 || setDown;
      chips.push({ id: "stop", label: narrow && (unload || anchor) ? "■" : "■ Stop", on: () => ctrl.stopSelected() });
      if (unload)
        chips.push({ id: "unload", label: aboard > 0 ? `⇣ Unload ${aboard}` : "⇣ Set down", cls: "unload", on: () => ctrl.unloadSelected() });
      if (anchor) chips.push(anchor);
      // (unarmed Condors, lifts and anchored Goliaths have no fights to skip: Move only would
      // change nothing; on a phone the Unload or anchor chip takes its place in a mixed
      // selection, so the row stays one row)
      const lifting = new Set(lifts.flatMap((g) => [g.id, ...g.goliath!.lift!.carriers]));
      const marchers = [...ctrl.selectedUnits].some((id) => {
        const u = w.units.get(id);
        return !!u && !isTransport(u.kind) && !lifting.has(id) && !isRooted(u);
      });
      if (marchers && (!narrow || (!unload && !anchor) || ctrl.forceMove))
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
      // (anchored Goliaths stay put: they're neither the army ⚔ grabs nor idle)
      const army = ctrl.armyIds().length;
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
    // an anchored Goliath selected (or one selected finishing digging in): the
    // squads it trains are on the Infantry tab
    const trainers = ctrl.spectator ? "" : ctrl.goliathsSelected().filter((g) => g.goliath!.mode === "anchored").map((g) => g.id).join(",");
    if (trainers !== lastTrainers) {
      if (trainers && !lastTrainers && tab !== "infantry") {
        tab = "infantry";
        renderGrid();
      }
      lastTrainers = trainers;
    }

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
    const tabQ: Record<Tab, number> = { build: 0, ground: 0, infantry: 0, air: 0 };
    for (const kind of ALL_UNITS) {
      const el = buttons.get(`u:${kind}`)!;
      const pt = parts.get(`u:${kind}`)!;
      const { prog, lock, badge } = pt;
      // (Goliaths' training queues count with the Assembly Bays', paused ones too)
      let queued = 0;
      let headProg = -1;
      for (const p of queuesOf(w, PLAYER, kind))
        p.queue.forEach((q, i) => {
          if (q.kind !== kind) return;
          queued++;
          if (i === 0) headProg = Math.max(headProg, 1 - q.remaining / (UNITS[kind].buildTime * TICK_RATE));
        });
      tabQ[tabOf(kind)] += queued;
      const blocked = unitBlocker(w, PLAYER, kind);
      // the live price (a Goliath's climbs with each one you have)
      const cost = unitCost(w, PLAYER, kind);
      if (pt.price !== cost) pt.cost.textContent = String((pt.price = cost));
      el.classList.toggle("locked", !!blocked);
      el.classList.toggle("poor", fs.scrap < cost);
      lock.hidden = !blocked;
      markBanned(lock, w, kind); // mutators: ⛔ instead of 🔒
      badge.hidden = queued === 0;
      if (badge.textContent !== String(queued)) badge.textContent = String(queued);
      prog.hidden = headProg < 0;
      if (headProg >= 0) prog.style.height = `${headProg * 100}%`;
    }
    for (const el of tabsEl.children) {
      const t = (el as HTMLElement).dataset.tab as Tab;
      const n = t === "build" ? (p ? 1 : 0) : tabQ[t];
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
    const goliaths: Unit[] = [];
    for (const u of w.units.values()) {
      if (u.faction === PLAYER) mctx.fillStyle = "#9fd0ff";
      else {
        // (in sight, and not a Sniper Team hidden in the woods; an enemy Goliath can't hide)
        if (fogOn && !unitSeenBy(w, PLAYER, u)) continue;
        mctx.fillStyle = "#ffb0a0";
      }
      if (u.goliath) goliaths.push(u);
      else mctx.fillRect(u.x * k - 2, u.y * k - 2, 4, 4);
    }
    // Goliaths on top: a big outlined diamond (anchored ones ringed with their build ring)
    for (const u of goliaths) {
      const own = u.faction === PLAYER;
      const x = u.x * k;
      const y = u.y * k;
      if (isRooted(u)) {
        mctx.strokeStyle = own ? "rgba(159,208,255,0.6)" : "rgba(255,140,120,0.6)";
        mctx.lineWidth = 1;
        mctx.beginPath();
        mctx.arc(x, y, Math.max(7, (GOLIATH.buildRing + GOLIATH.footprint / 2) * k), 0, Math.PI * 2);
        mctx.stroke();
      }
      // (the minimap shows at under half its canvas size on a phone: a unit blip is ~2 px there, this ~8)
      const r = 9;
      mctx.beginPath();
      mctx.moveTo(x, y - r);
      mctx.lineTo(x + r, y);
      mctx.lineTo(x, y + r);
      mctx.lineTo(x - r, y);
      mctx.closePath();
      mctx.fillStyle = own ? "#cfe8ff" : "#ff7a66";
      mctx.fill();
      mctx.strokeStyle = own ? "#1d4f8f" : "#5a0f08";
      mctx.lineWidth = 2.5;
      mctx.stroke();
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

  function showEnd(winner: Faction | "draw"): void {
    const rematch = () => relaunch(rematchToken());
    // (Last Stand only ends one way; a draw anywhere goes to the report, titled DRAW)
    if (surv && !ops && winner !== "draw") {
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

/** A Condor's seats for the selection panel: a portrait (and robots standing) per squad aboard, dashed empty seats. */
function cargoHtml(c: Unit): string {
  const seats = (c.passengers ?? []).map(
    (p) => `<span class="seat" title="${UNITS[p.kind].name}"><img src="${icon(p.kind, c.faction)}" alt=""/><b>${squadAlive(p)}</b></span>`
  );
  for (let i = seats.length; i < (UNITS[c.kind].capacity ?? 0); i++) seats.push(`<span class="seat empty"></span>`);
  return `<div class="cargo">${seats.join("")}</div>`;
}

export const HELP_HTML = `
  <h3>Goal</h3><p>Destroy the enemy HQ and every Goliath it has. Protect yours: while a Goliath stands you aren't beaten, even with your HQ gone.</p>
  <h3>Openers</h3><p>Every skirmish starts with a pick: <b>Blitz</b> (Fab Plant + 3 Stingers), <b>Industry</b> (Fab Plant, a third harvester, +200 scrap) or <b>Air Wing</b> (Airpad + 3 Wasps). The enemy picks one too.</p>
  <h3>Commander powers</h3><p>The ⚡ meter on the right fills slowly, and faster when you lose units. Spend it on <b>Barrage</b> (3 shells), <b>EMP</b> (freezes enemies for 4 s) or <b>Drop Pod</b> (3 units land where you can see): tap the button, then the map. At 6:00 the <b>Sky Hammer</b> comes online for both sides, an orbital strike every ${POWERS.hammer.cooldown / 60} minutes. Every strike shows a warning circle first: red ones are the enemy's, so move out!</p>
  <h3>Objectives</h3><p>📡 <b>Uplinks</b> sit in the contested middle of every map: park units in the ring to fill its bar (aircraft count half, harvesters not at all; with both sides inside it freezes). Holding one pays ${OBJECTIVES.uplink.income} scrap/s, lights up the fog around it and charges your ⚡ meter. 📦 <b>Supply drops</b> land in pairs from 1:30, every 75 s, announced 10 s ahead to both sides: the first unit to reach a crate takes it (scrap, Veterans, Field Repair, ⚡ charge, or a rare free Lancer). Unclaimed crates burn out after 45 s.</p>
  <h3>Archipelago</h3><p>Every 📡 Uplink sits on an island only a <b>Condor</b> can reach, and only robot infantry count there: aircraft, the Condor itself and vehicles neither take nor contest them. An island Uplink pays only while your troops stand on it (a hollow pip means it's held but empty). Tap your Condor, then tap an island to drop the squads aboard. You start with a Condor and a squad aboard; lose your last Condor and a free one flies in ${LIFELINE.delay} s later from the map edge by your HQ, or your Goliath if the HQ is gone (with a free squad if you're short of infantry). The open sea stops everything but aircraft — hover tanks included — so the two bridges are the only way across by land.</p>
  <h3>Last Stand</h3><p>No enemy base: hold out against endless waves. The top bar shows the next wave's theme (four of Air Raid, Armour Column, Artillery, Mixed and Bot Swarm, then a Boss every 5th) and the minimap arrow where it will enter. Clearing a wave pays scrap; with the field clear, <b>Call wave</b> brings the next one early for a bonus.</p>
  <h3>Ops</h3><p>A short campaign of handcrafted missions with a twist — hold a bridge, deliver scrap under air raids, decapitate a base with a strike group, fight with no income. Each has a goal pill under the clock (tap it for the objectives) and three stars: complete it, plus two harder conditions. The first three are open; every op you complete opens the next.</p>
  <h3>Career, Daily Op and mutators</h3><p>Wins, Last Stand waves and medals earn XP toward ten ranks; each map and difficulty has three stars (win, win under 8:00 — 12:00 on the Archipelago — and win without losing a building). The <b>Daily Op</b> is one seeded match a day, the same for everyone, and keeps a win streak. <b>Mutators</b> twist a skirmish's rules for both sides (no stars). Tap your rank on the menu for medals and records.</p>
  <h3>Economy</h3><p>Harvesters mine scrap piles and glowing crystals (worth more) and haul them to your HQ, a Depot or an anchored Goliath. More harvesters, more scrap. Destroyed units leave glinting <b>wrecks</b> worth 30% of their cost (a Last Stand wave's only 5%) for a minute: roll any ground unit over one to salvage it.</p>
  <h3>Building</h3><p>Open <b>Base</b> and tap a structure to construct it. When it's ready, tap it again: a ghost appears on a free spot near your base. Tap the map (or drag the ghost) to move it, then tap the ghost or <b>✓ Place</b> to build. With a mouse, just click the spot. Build buttons marked ⚔ counter enemies you've seen; a tab marked <b>idle</b> has a factory doing nothing.</p>
  <h3>Army</h3><p>Tap a unit to select it, drag-hold (long-press) to box-select, double-tap to grab all of that type on screen. With a mouse, Shift+click adds a unit to the selection or takes it out. Tap the ground to attack-move, tap an enemy to attack. <b>Move only</b> retreats without stopping to fight. <b>💤 Idle</b> grabs units with no orders.</p>
  <h3>Squads</h3><p>Hold a squad chip (<b>1</b>, <b>2</b>, <b>3</b>) to save the selected units into it. Tap it to select them again, double-tap to fly the camera there. It flashes red when a member is hit. Keys: 1–3 select, Ctrl+1–3 (or Shift+1–3) save.</p>
  <h3>Infantry</h3><p>You start every battle with a <b>Trooper Squad</b> by your HQ. The <b>Assembly Bay</b> trains more: <b>Troopers</b> (cheap rifles that hit air too), <b>Rocket Squads</b> (kill Mastodons and Hornets) and, with a Tech Lab, <b>Sniper Teams</b> (delete other infantry, and stay hidden in woods unless they fire or you come within ${INF.concealRadius} tiles). A squad is one unit of several robots: they fall as it takes damage, and it shoots weaker with each one lost. Squads walk through woods and rough ground at full speed, take half damage in woods and capture Uplinks twice as fast, but Mastodons crush them.</p>
  <h3>Condor</h3><p>The Airpad's dropship carries two squads over water, rock and anything else. Select squads and tap the Condor (or select the Condor and tap a squad) to load them; then <b>long-press</b> the map to fly there and drop them, or tap <b>⇣ Unload</b> (key U) to drop them where it is. Shot down over land, its squads bail out hurt; over water or rock they go down with it.</p>
  <h3>Gantry and Goliath</h3><p>With a Fab Plant, an Airpad, a Tech Lab and an Assembly Bay standing you can build the <b>Gantry</b> (one per side, and the enemy always sees it). It builds the <b>Goliath</b>: a giant walking mech and a base on legs. Each one costs ${Math.round(GOLIATH.costStep * 100)}% more for every Goliath you already have. Select it and tap <b>⚓ Anchor</b> (key G) to dig in where it stands (${GOLIATH.anchorTime} s): anchored, harvesters unload at it, it trains squads (Infantry tab, no Assembly Bay needed; tap the map to set their rally point) and you can build within ${GOLIATH.buildRing} tiles of it, even far from base. Those <b>outposts</b> keep working after it leaves, but never extend your build range. <b>⇡ Pack up</b> (G again, ${GOLIATH.packTime} s) before it can walk. It fires mortars, an eye laser, arm cannons and machine guns, and loses them as it is hurt: mortars below ${Math.round(GOLIATH.weapons.mortars.lostBelow * 100)}%, the laser below ${Math.round(GOLIATH.weapons.laser.lostBelow * 100)}%, the cannons below ${Math.round(GOLIATH.weapons.cannons.lostBelow * 100)}% (the machine guns never). Only <b>Menders</b> repair it, and brought back up its weapons reboot. The enemy can always see it.</p>
  <h3>Lift</h3><p>Two empty Condors can carry a walking Goliath: select both and tap it to hook on, then <b>long-press</b> where to set it down (a tap flies it there and hovers; <b>⇣ Set down</b> or U puts it down where it is). In the air it fires only its machine guns, and if either Condor is shot down it falls: hurt over land, lost over water, sea, lava or rock.</p>
  <h3>Counters</h3><p>Stingers beat Flak · Flak beats aircraft · Wasps beat tanks · Raptors hunt aircraft · Mastodons crush ground armies · Mortars and Hornets smash bases and squads · Rocket Squads beat Mastodons · Snipers beat infantry · Rocket Squads, Wasps, Lancers and Hornets bring down Goliaths. Long-press any build button for details.</p>
  <h3>Terrain</h3><p>Roads are fast, mud and woods are slow, woods give cover. Water blocks tanks — Lancers hover across, aircraft fly over everything; the open sea round the Archipelago's islands stops Lancers too. Infantry walk through woods and mud at full speed but can't cross water or rock.</p>
  <h3>Camera</h3><p>Drag to pan, pinch to zoom, tap the minimap to jump. Pulsing arrows at the screen edge point at fights you can't see (red: you're being hit) — tap one to fly there, or tap ⚡ to cycle through them.</p>
  <h3>Speed</h3><p>Tap the <b>1×</b> chip by the clock for 1.5× or 2×; hold the clock to fast-forward at 3×.</p>`;


import { BUILDINGS, TICK_RATE, UNITS } from "./balance";
import { createAiState, type AiState, type Difficulty, type Strategy, type StrategyName } from "./ai/commander";
import { nearestReachableResource } from "./economy";
import { setupSurvival, wavesSurvived, type SurvivalOptions } from "./modes/survival";
import { NO_GROUND_COMBAT, makeRules, type MutatorId } from "./rules";
import type { BuildingKind, Faction, FxEvent, UnitKind, World } from "./types";
import { carrierOf } from "./transport";
import { buildingCenter, hqOf, inBounds, moveClassOf, passable, spawnBuilding, spawnUnit } from "./world";

/**
 * Ops: a short campaign of handcrafted scenarios on the existing maps, each
 * with a twist objective and a three-star rating. An op is data — a map, an
 * enemy (an AI commander with a fixed personality, the Last Stand wave
 * director, or nobody), rules (per-side bans, a frozen economy, mutators),
 * a setup function that pre-places buildings and units, primary goals and
 * two star conditions.
 *
 * Goals are pure functions of the world, evaluated once per second by
 * tickOps() (called from step() only when World.ops is set). Meeting every
 * primary goal — or destroying the enemy HQ, as ever — wins the op; failing
 * one loses it. Either way tickOps sets World.winner, so the normal end flow
 * (finale, report, career) runs unchanged. Deterministic: no Math.random.
 */

// ------------------------------------------------------------------ goals ---

export type Goal =
  /** Destroy the enemy HQ. */
  | { type: "destroyHq" }
  /** Destroy `count` enemy units or buildings of a kind. */
  | { type: "destroy"; kind: UnitKind | BuildingKind; count: number }
  /** Keep the HQ standing until the clock reaches `secs`. */
  | { type: "survive"; secs: number }
  /** Last Stand ops: survive `count` waves. */
  | { type: "waves"; count: number }
  /** Harvest (deliver to a drop-off) this much scrap. */
  | { type: "deliver"; scrap: number }
  /** Keep at least `min` of a tagged group (from setup) or of an own kind alive. */
  | { type: "protect"; tag?: string; kind?: UnitKind | BuildingKind; min: number; label: string; short?: string }
  /** Finish before the clock reaches `secs`. */
  | { type: "within"; secs: number }
  /** Lose at most `n` units (of `kind`, or buildings when `buildings`). */
  | { type: "maxLosses"; n: number; kind?: UnitKind; buildings?: boolean };

/** done = achieved · ok = holding (a condition not yet broken) · pending = not there yet · failed = broken. */
export type GoalState = "done" | "ok" | "pending" | "failed";

export interface GoalEval {
  state: GoalState;
  /** Compact label and value for the HUD pill ("Hold", "2:41"). */
  label: string;
  value: string;
  /** 0..1 toward an achievement goal (or what's left of a timer). */
  progress: number;
}

/** Goals that must be achieved (the rest are conditions that must not break). */
const ACHIEVE = new Set<Goal["type"]>(["destroyHq", "destroy", "survive", "waves", "deliver"]);
export const isAchieveGoal = (g: Goal): boolean => ACHIEVE.has(g.type);

// --------------------------------------------------------------- op defs ---

export interface OpAi {
  strategy: StrategyName;
  difficulty: Difficulty;
  /** Personality overrides (e.g. a commander that never attacks). */
  tweak?: Partial<Strategy>;
}

export interface OpRules {
  mutators?: MutatorId[];
  /** Kinds the player (blue) may not build. */
  playerBans?: { units?: UnitKind[]; buildings?: BuildingKind[] };
  /** Player income multiplier (0 = frozen economy: no harvesting, no HQ trickle). */
  playerIncome?: number;
  /** Enemy income multiplier (a commander that digs in rather than out-grows you). */
  enemyIncome?: number;
  /** false: no commander calldowns for either side (a fixed strike group or budget is the puzzle). */
  calldowns?: false;
}

export interface OpDef {
  id: string;
  title: string;
  icon: string;
  /** One line for the menu card. */
  tagline: string;
  /** The briefing. */
  brief: string;
  /** A hint for the briefing (and the end screen after a failure). */
  tip: string;
  map: string;
  /** The opposition: an AI commander, the Last Stand wave director, or nobody. */
  ai: OpAi | "survival" | null;
  survival?: SurvivalOptions;
  rules?: OpRules;
  /** Player starting scrap (default: the classic 600). */
  scrap?: number;
  /** Pre-place buildings and units, tag what the goals protect. */
  setup?(w: World, o: OpSetup): void;
  /** Where the camera opens (tiles; default: the player's HQ). */
  focus?: { x: number; y: number };
  /** Primary goals: achieve every achievement goal without breaking a condition. */
  goals: Goal[];
  /** ★★ and ★★★ conditions, checked when the op is won (★ = completing it). */
  stars: [Goal, Goal];
}

export interface OpResult {
  won: boolean;
  /** "Held for 4:00", "Out of time", "Our HQ has fallen"… */
  reason: string;
  /** Star bitmask: 1 = completed, 2 = ★★ condition, 4 = ★★★ condition. */
  stars: number;
  secs: number;
  /** Where the camera should look for the ending (tiles). */
  x: number;
  y: number;
  /** Ended by an objective (not an HQ kill): the finale skips the HQ blasts. */
  byGoal: boolean;
}

export interface OpsState {
  id: string;
  player: Faction;
  enemy: Faction;
  /** Entity ids a setup tagged (e.g. "bridge" turrets), and how many there were. */
  tags: Record<string, number[]>;
  /** Enemy units/buildings destroyed by kind, and our own losses by kind. */
  killed: Partial<Record<UnitKind | BuildingKind, number>>;
  lost: Partial<Record<UnitKind | BuildingKind, number>>;
  /** Star conditions already broken (bits 2 and 4), for "star lost" notices. */
  starsLost: number;
  /** Where the last tagged entity died (camera target if the op fails on it). */
  lastTagDeath: { x: number; y: number } | null;
  result: OpResult | null;
}

/** Setup helpers handed to OpDef.setup (positions in tiles). */
export interface OpSetup {
  building(faction: Faction, kind: BuildingKind, tx: number, ty: number, tag?: string): number;
  /** `n` units in a loose block around (x, y); returns their ids. */
  units(faction: Faction, kind: UnitKind, n: number, x: number, y: number, tag?: string): number[];
  /** Remove every unit of a kind (e.g. the starting harvester). */
  removeUnits(faction: Faction, kind: UnitKind): void;
}

const ALL_UNITS = Object.keys(UNITS) as UnitKind[];
const ALL_BUILDINGS = (Object.keys(BUILDINGS) as BuildingKind[]).filter((k) => k !== "hq");
/** An enemy commander that defends but never raids or assaults. */
const DEFENSIVE: Partial<Strategy> = { assaultValue: Infinity, harassGroup: Infinity };

export const OPS: OpDef[] = [
  {
    id: "bridgehead",
    title: "Bridgehead",
    icon: "🌉",
    tagline: "Hold the river crossing against a Rush",
    brief:
      "We hold the west end of the Riverlands bridge: two turrets, a Depot on the crystal field and a Stinger squad. Red's Rush commander wants that crossing. Hold it for 4:00.",
    tip: "Stingers and Turrets shred Rush's light tanks. Build a Fab Plant early and send reinforcements up the road to the bridge.",
    map: "riverlands",
    // bigger waves than a stock Rush: it masses ~1,200 scrap of tanks before each push
    // (and the four harvesters this op was tuned against: skirmish Rush now keeps five)
    ai: { strategy: "rush", difficulty: "hard", tweak: { assaultValue: 2200, harvesters: 4 } },
    focus: { x: 21, y: 34 },
    setup(w, o) {
      o.building("blue", "depot", 20, 31);
      o.building("blue", "turret", 22, 30, "bridge");
      o.building("blue", "turret", 26, 32, "bridge");
      o.units("blue", "stinger", 3, 23.5, 33.5);
      o.units("blue", "flak-crawler", 1, 21.5, 34.5);
      o.units("blue", "harvester", 1, 21.5, 29.5);
      // Rush arrives early and keeps coming: two factories and a first wave
      o.building("red", "fab-plant", 50, 10);
      o.units("red", "stinger", 6, 44, 10);
      w.factions.red.scrap = 1200;
    },
    goals: [
      { type: "survive", secs: 240 },
      { type: "protect", tag: "bridge", min: 1, label: "Keep a bridge turret standing", short: "Turrets" }
    ],
    stars: [
      { type: "maxLosses", n: 6 },
      { type: "protect", tag: "bridge", min: 2, label: "Both bridge turrets standing", short: "Turrets" }
    ]
  },
  {
    id: "harvest-moon",
    title: "Harvest Moon",
    icon: "🌙",
    tagline: "Deliver 10,000 scrap under Air Swarm raids",
    brief:
      "The refinery needs 10,000 scrap before the convoy leaves at 5:00. Red's Air Swarm hunts harvesters with Wasps from the first minute. Keep the haul coming.",
    tip: "Flak Crawlers and Turrets by the field keep Wasps off your harvesters. More harvesters, more scrap — but only if they live.",
    map: "dune-sea",
    ai: { strategy: "airswarm", difficulty: "hard" },
    setup(_w, o) {
      o.units("blue", "harvester", 1, 9.5, 46.5);
      o.building("blue", "turret", 10, 41);
      o.units("red", "wasp", 3, 46, 12);
    },
    goals: [
      { type: "deliver", scrap: 10000 },
      { type: "within", secs: 300 }
    ],
    stars: [
      { type: "maxLosses", n: 1, kind: "harvester" },
      { type: "within", secs: 240 }
    ]
  },
  {
    id: "decapitation",
    title: "Decapitation",
    icon: "🎯",
    tagline: "A strike group, no factories, 3:00",
    brief:
      "No base, no reinforcements: two Mastodons, three Stingers, two Hornets, two Raptors and a Mender, with a Trooper Squad guarding the HQ. Red's HQ sits behind two SAM sites, three turrets, Flak and a fighter screen. Take it down within 3:00.",
    tip: "Move as one group — whatever arrives alone dies alone. Stingers kill the Flak, Raptors the fighters, Hornets flatten SAM sites; then everything on the HQ.",
    map: "proving-grounds",
    ai: { strategy: "balanced", difficulty: "easy", tweak: DEFENSIVE },
    focus: { x: 10, y: 39 },
    // (no calldowns: a Drop Pod or Barrage would make the fixed strike group moot, and Red's pods would reinforce it)
    rules: { playerBans: { units: ALL_UNITS, buildings: ALL_BUILDINGS }, playerIncome: 0, calldowns: false },
    scrap: 0,
    setup(w, o) {
      o.removeUnits("blue", "harvester");
      o.units("blue", "mastodon", 2, 10, 36);
      o.units("blue", "stinger", 3, 10, 37.8);
      o.units("blue", "hornet", 2, 10, 39.6);
      o.units("blue", "raptor", 2, 10, 41.4);
      o.units("blue", "mender", 1, 10, 43.2);
      o.building("red", "fab-plant", 37, 2);
      o.building("red", "airpad", 44, 10);
      o.building("red", "sam-site", 39, 9);
      o.building("red", "sam-site", 45, 4);
      o.building("red", "turret", 40, 8);
      o.building("red", "turret", 44, 8);
      o.building("red", "turret", 38, 7);
      o.units("red", "flak-crawler", 2, 42, 10.5);
      o.units("red", "raptor", 3, 38, 4);
      w.factions.red.scrap = 400;
    },
    goals: [{ type: "destroyHq" }, { type: "within", secs: 180 }],
    stars: [
      { type: "maxLosses", n: 4 },
      { type: "within", secs: 120 }
    ]
  },
  {
    id: "frozen-assets",
    title: "Frozen Assets",
    icon: "❄",
    tagline: "3,000 scrap, no income: spend it wisely",
    brief:
      "Our harvesters are frozen solid: the factories stand, but there's 3,000 scrap in the bank and not a crate more — no mining, no HQ salvage. Red's Boom commander is building an economy. Strike before it pays off: destroy their HQ within 6:00.",
    tip: "Every unit counts. Hit their harvesters to stall the Boom, keep your army together, and don't waste scrap on defences you won't need.",
    map: "frostbite",
    ai: { strategy: "boom", difficulty: "normal" },
    // (no calldowns: free Drop Pod crews would break the fixed budget)
    rules: { playerBans: { units: ["harvester"] }, playerIncome: 0, calldowns: false },
    scrap: 3000,
    setup(_w, o) {
      o.removeUnits("blue", "harvester");
      o.building("blue", "fab-plant", 8, 39);
      o.building("blue", "airpad", 4, 36);
      o.building("blue", "tech-lab", 8, 43);
    },
    goals: [{ type: "destroyHq" }, { type: "within", secs: 360 }],
    stars: [
      { type: "destroy", kind: "harvester", count: 4 },
      { type: "within", secs: 240 }
    ]
  },
  {
    id: "sky-pirates",
    title: "Sky Pirates",
    icon: "🏴‍☠️",
    tagline: "Air only: sink their HQ before 7:00",
    brief:
      "Fab Plants and the Condor are off-limits: this is an air raid. Red is digging in behind SAM sites you haven't seen yet, and every Wasp you show it teaches it to build more Flak. Scout first, then sink their HQ before 7:00.",
    tip: "A Scout finds the SAM sites. Raptors beat their fighters, Hornets flatten SAMs and the HQ. Don't feed bombers into anti-air one at a time.",
    map: "ashlands",
    // a commander that digs in (never attacks) on half income: the clock is the enemy
    ai: { strategy: "balanced", difficulty: "easy", tweak: DEFENSIVE },
    // (ground units are banned too, so a Drop Pod lands Wasps and a Raptor: it stays an air raid;
    // the starting Trooper Squad stays home — no Condor to fly it — and no more infantry can be raised)
    rules: { playerBans: { units: NO_GROUND_COMBAT, buildings: ["fab-plant", "assembly-bay"] }, enemyIncome: 0.5 },
    scrap: 800,
    setup(_w, o) {
      o.building("blue", "airpad", 9, 54);
      o.building("blue", "tech-lab", 4, 51);
      o.units("blue", "harvester", 1, 9.5, 57.5);
      o.building("red", "sam-site", 52, 10);
      o.building("red", "sam-site", 59, 12);
      o.building("red", "turret", 55, 10);
    },
    goals: [{ type: "destroyHq" }, { type: "within", secs: 420 }],
    stars: [
      { type: "maxLosses", n: 12 },
      { type: "within", secs: 270 }
    ]
  },
  {
    id: "glass-jaw",
    title: "Glass Jaw",
    icon: "💥",
    tagline: "Double damage, double speed, 6:00",
    brief:
      "Glass Cannons and Rapid Fab for both sides: every weapon hits twice as hard and everything builds in half the time. Red's Rush commander loves it. Destroy their HQ within 6:00.",
    tip: "Fights end in seconds: never trade one at a time. Turrets hit twice as hard too — a couple buy you time to mass an army.",
    map: "dune-sea",
    // (the four harvesters this op was tuned against: skirmish Rush now keeps five)
    ai: { strategy: "rush", difficulty: "normal", tweak: { harvesters: 4 } },
    rules: { mutators: ["glass", "rapidfab"] },
    goals: [{ type: "destroyHq" }, { type: "within", secs: 360 }],
    stars: [
      { type: "maxLosses", n: 0, buildings: true },
      { type: "within", secs: 240 }
    ]
  },
  {
    id: "iron-tide",
    title: "Iron Tide",
    icon: "🛡",
    tagline: "Survive Ironclad on Hard for 6:00",
    brief:
      "Ironclad on Hard: Mastodons, Lancers and Mortars rolling around the frozen sea, with a bigger economy than yours. You have a Fab Plant and a Tech Lab. Hold out for 6:00.",
    tip: "Lancers burn through Mastodons and Wasps strike them from the air. Mortars outrange your Turrets — hunt them with Stingers.",
    map: "frostbite",
    ai: { strategy: "ironclad", difficulty: "hard" },
    setup(_w, o) {
      o.building("blue", "fab-plant", 8, 39);
      o.building("blue", "tech-lab", 4, 36);
      o.units("blue", "harvester", 1, 8.5, 42.5);
    },
    goals: [{ type: "survive", secs: 360 }],
    stars: [
      { type: "destroy", kind: "mastodon", count: 2 },
      { type: "maxLosses", n: 1, buildings: true }
    ]
  },
  {
    id: "last-light",
    title: "Last Light",
    icon: "🕯",
    tagline: "Last Stand: survive 10 fast waves",
    brief:
      "The last base on the river. Waves come every 40 seconds from the map edges, growing every time, with a boss every fifth. You start dug in. Survive 10 waves.",
    tip: "The top bar names the next wave's theme: build its counter before it lands. Calling a wave early on a clear field pays scrap — and saves time.",
    map: "riverlands",
    ai: "survival",
    survival: { difficulty: "easy", firstWave: 45, interval: 40 },
    scrap: 1200,
    setup(_w, o) {
      o.building("blue", "fab-plant", 4, 44);
      o.building("blue", "airpad", 9, 45);
      o.building("blue", "turret", 10, 49);
      o.building("blue", "turret", 8, 43);
      o.units("blue", "harvester", 2, 9.5, 51.5);
    },
    goals: [{ type: "waves", count: 10 }],
    stars: [
      { type: "maxLosses", n: 2, buildings: true },
      { type: "within", secs: 420 }
    ]
  }
];

export const opById = (id: string): OpDef | null => OPS.find((o) => o.id === id) ?? null;
export const opIndex = (id: string): number => OPS.findIndex((o) => o.id === id);
/** The op after this one (null at the end of the campaign). */
export const nextOp = (id: string): OpDef | null => OPS[opIndex(id) + 1] ?? null;
/** How many ops are open: the first three, plus one more per op completed. */
export const OPS_OPEN_AT_START = 3;
export const opsUnlocked = (completed: number): number => Math.min(OPS.length, OPS_OPEN_AT_START + completed);

// ----------------------------------------------------------------- setup ---

/** The enemy commander for an op (null when nobody commands: waves or no enemy). */
export function opAiState(op: OpDef, seed?: number): AiState | null {
  if (!op.ai || op.ai === "survival") return null;
  return createAiState(op.ai.strategy, op.ai.difficulty, seed, op.ai.tweak);
}

function spreadSpot(w: World, kind: UnitKind, x: number, y: number, i: number): { x: number; y: number } {
  // a loose 3-wide block; ground units nudge onto passable tiles nearby
  const bx = x + ((i % 3) - 1) * 0.9;
  const by = y + Math.floor(i / 3) * 0.9;
  if (UNITS[kind].domain === "air") return { x: bx, y: by };
  const mc = moveClassOf(kind);
  for (let r = 0; r <= 3; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const tx = Math.floor(bx) + dx;
        const ty = Math.floor(by) + dy;
        if (inBounds(w, tx, ty) && passable(w, tx, ty, mc) && w.occupancy[ty * w.width + tx] === 0)
          return { x: tx + (bx - Math.floor(bx)), y: ty + (by - Math.floor(by)) };
      }
  return { x: bx, y: by };
}

/**
 * Turn a fresh map world into an op (createMapWorld calls this last, when
 * MatchOptions.op is set): rules, the wave director or the enemy base,
 * the op's own setup, and the OpsState that tickOps() evaluates.
 */
export function setupOp(w: World, id: string): void {
  const op = opById(id);
  if (!op) return;
  const player: Faction = "blue";
  const enemy: Faction = "red";
  const st: OpsState = {
    id: op.id, player, enemy, tags: {}, killed: {}, lost: {}, starsLost: 0, lastTagDeath: null, result: null
  };
  // rules: mutators for both sides, then the player's bans and income
  const r = makeRules(op.rules?.mutators ?? []);
  if (op.rules?.playerBans) r.sideBans = { [player]: { units: op.rules.playerBans.units ?? [], buildings: op.rules.playerBans.buildings ?? [] } };
  if (op.rules?.playerIncome !== undefined || op.rules?.enemyIncome !== undefined)
    r.sideIncome = { [player]: op.rules.playerIncome ?? 1, [enemy]: op.rules.enemyIncome ?? 1 };
  r.banLabel = "Disabled in this op";
  if (op.rules?.calldowns === false) r.noCalldowns = true;
  w.rules = r;
  if (op.ai === "survival") setupSurvival(w, op.survival ?? {}, player);
  w.factions[player].scrap = op.scrap ?? r.startScrap;
  const tag = (name: string | undefined, id: number) => {
    if (name) (st.tags[name] ??= []).push(id);
  };
  const helpers: OpSetup = {
    building(faction, kind, tx, ty, t) {
      const b = spawnBuilding(w, kind, faction, tx, ty);
      tag(t, b.id);
      return b.id;
    },
    units(faction, kind, n, x, y, t) {
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = spreadSpot(w, kind, x, y, i);
        const u = spawnUnit(w, kind, faction, p.x, p.y);
        if (kind === "harvester") {
          const f = nearestReachableResource(w, u.x, u.y, u.faction);
          if (f) u.order = { type: "harvest", fieldX: f.x, fieldY: f.y, phase: "toField" };
        }
        tag(t, u.id);
        ids.push(u.id);
      }
      return ids;
    },
    removeUnits(faction, kind) {
      for (const u of [...w.units.values()]) if (u.faction === faction && u.kind === kind) w.units.delete(u.id);
    }
  };
  op.setup?.(w, helpers);
  w.ops = st;
}

// ------------------------------------------------------------ evaluation ---

const secsOf = (w: World): number => w.tick / TICK_RATE;

export function fmtClock(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const fmtNum = (n: number): string => Math.floor(n).toLocaleString("en-US");

const kindName = (k: UnitKind | BuildingKind): string => (k in UNITS ? UNITS[k as UnitKind].name : BUILDINGS[k as BuildingKind].name);
const plural = (k: UnitKind | BuildingKind, n: number): string => (n === 1 ? kindName(k) : `${kindName(k)}s`);

/** Living members of a protect goal's group, and how many there were (squads aboard a Condor count). */
function protectCount(w: World, st: OpsState, g: Extract<Goal, { type: "protect" }>): { alive: number; total: number } {
  if (g.tag) {
    const ids = st.tags[g.tag] ?? [];
    const alive = ids.filter((id) => w.units.has(id) || w.buildings.has(id) || carrierOf(w, id)).length;
    return { alive, total: ids.length };
  }
  let alive = 0;
  if (g.kind)
    for (const e of [...w.units.values(), ...w.buildings.values(), ...[...w.units.values()].flatMap((u) => u.passengers ?? [])])
      if (e.faction === st.player && e.kind === g.kind) alive++;
  return { alive, total: Math.max(alive, g.min) };
}

/** Evaluate one goal against the world right now (pure). */
export function evalGoal(w: World, st: OpsState, g: Goal): GoalEval {
  const t = secsOf(w);
  const stats = w.factions[st.player].stats;
  switch (g.type) {
    case "destroyHq": {
      const hq = hqOf(w, st.enemy);
      return { state: hq ? "pending" : "done", label: "Enemy HQ", value: hq ? `${Math.ceil((hq.hp / BUILDINGS.hq.hp) * 100)}%` : "down", progress: hq ? 1 - hq.hp / BUILDINGS.hq.hp : 1 };
    }
    case "destroy": {
      const n = st.killed[g.kind] ?? 0;
      return { state: n >= g.count ? "done" : "pending", label: plural(g.kind, 2), value: `${Math.min(n, g.count)}/${g.count}`, progress: Math.min(1, n / g.count) };
    }
    case "survive":
      return { state: t >= g.secs ? "done" : "pending", label: "Hold", value: fmtClock(g.secs - t), progress: Math.min(1, t / g.secs) };
    case "waves": {
      const n = wavesSurvived(w);
      return { state: n >= g.count ? "done" : "pending", label: "Waves", value: `${Math.min(n, g.count)}/${g.count}`, progress: Math.min(1, n / g.count) };
    }
    case "deliver": {
      const n = stats.scrapHarvested;
      return { state: n >= g.scrap ? "done" : "pending", label: "Scrap", value: `${fmtNum(Math.min(n, g.scrap))}/${fmtNum(g.scrap)}`, progress: Math.min(1, n / g.scrap) };
    }
    case "protect": {
      const { alive, total } = protectCount(w, st, g);
      return { state: alive >= g.min ? "ok" : "failed", label: g.short ?? plural(g.kind ?? "turret", 2), value: `${alive}/${total}`, progress: total ? alive / total : 0 };
    }
    case "within":
      return { state: t > g.secs ? "failed" : "ok", label: "Time", value: fmtClock(g.secs - t), progress: Math.max(0, 1 - t / g.secs) };
    case "maxLosses": {
      const n = g.kind ? (st.lost[g.kind] ?? 0) : g.buildings ? stats.buildingsLost : stats.unitsLost;
      return { state: n > g.n ? "failed" : "ok", label: "Lost", value: `${n}/${g.n}`, progress: g.n > 0 ? Math.min(1, n / g.n) : n > 0 ? 1 : 0 };
    }
  }
}

/** Plain-language goal text for the briefing and the objective list. */
export function goalText(g: Goal, asStar = false): string {
  switch (g.type) {
    case "destroyHq":
      return "Destroy the enemy HQ";
    case "destroy":
      return `Destroy ${g.count} enemy ${plural(g.kind, g.count)}`;
    case "survive":
      return `Hold out for ${fmtClock(g.secs)}`;
    case "waves":
      return `Survive ${g.count} waves`;
    case "deliver":
      return `Deliver ${fmtNum(g.scrap)} scrap`;
    case "protect":
      return g.label;
    case "within":
      return asStar ? `Finish in under ${fmtClock(g.secs)}` : `Before the clock hits ${fmtClock(g.secs)}`;
    case "maxLosses": {
      const what = g.kind ? plural(g.kind, g.n) : g.buildings ? (g.n === 1 ? "building" : "buildings") : g.n === 1 ? "unit" : "units";
      return g.n === 0 ? `Lose no ${g.kind ? plural(g.kind, 2) : g.buildings ? "buildings" : "units"}` : `Lose ${g.n} ${what} or fewer`;
    }
  }
}

/** The objective as one line: "Destroy the enemy HQ before 3:00 · Keep a bridge turret standing". */
export function objectiveLine(op: OpDef): string {
  const main = op.goals.filter(isAchieveGoal).map((g) => goalText(g));
  const limit = op.goals.find((g): g is Extract<Goal, { type: "within" }> => g.type === "within");
  const rest = op.goals.filter((g) => !isAchieveGoal(g) && g.type !== "within").map((g) => goalText(g));
  const head = `${main.join(" and ")}${limit ? ` before ${fmtClock(limit.secs)}` : ""}`;
  return [head, ...rest].filter(Boolean).join(" · ");
}

/** Does a star condition hold right now? (achievements: done; conditions: unbroken) */
const holds = (e: GoalEval): boolean => e.state === "done" || e.state === "ok";

/** Star bitmask a win right now would earn. */
export function starsNow(w: World, op: OpDef, st: OpsState): number {
  let mask = 1;
  op.stars.forEach((g, i) => {
    if (holds(evalGoal(w, st, g))) mask |= 2 << i;
  });
  return mask;
}

function winReason(w: World, op: OpDef, st: OpsState): string {
  const g = op.goals.find(isAchieveGoal);
  if (!g) return "Objective complete";
  switch (g.type) {
    case "survive":
      return `Held for ${fmtClock(g.secs)}`;
    case "waves":
      return `${g.count} waves survived`;
    case "deliver":
      return `${fmtNum(w.factions[st.player].stats.scrapHarvested)} scrap delivered`;
    case "destroy":
      return `${g.count} enemy ${plural(g.kind, g.count)} destroyed`;
    default:
      return "Enemy HQ destroyed";
  }
}

function failReason(g: Goal): string {
  switch (g.type) {
    case "within":
      return "Out of time";
    case "protect":
      return g.tag ? `${g.label.replace(/^Keep (an? |the )?/i, "").replace(/ standing$/i, "")} lost` : "Lost what we had to protect";
    case "maxLosses":
      return "Too many losses";
    default:
      return "Objective failed";
  }
}

function centreOf(w: World, f: Faction): { x: number; y: number } {
  const hq = hqOf(w, f);
  return hq ? buildingCenter(hq) : { x: w.width / 2, y: w.height / 2 };
}

function finish(w: World, op: OpDef, st: OpsState, won: boolean, reason: string, at: { x: number; y: number }, byGoal: boolean): void {
  st.result = { won, reason, stars: won ? starsNow(w, op, st) : 0, secs: Math.round(secsOf(w)), x: at.x, y: at.y, byGoal };
  if (!w.winner) w.winner = won ? st.player : st.enemy;
}

/** This tick's `death` event matching `pred`, if any. */
function deathOf(w: World, pred: (ev: Extract<FxEvent, { type: "death" }>) => boolean): Extract<FxEvent, { type: "death" }> | undefined {
  for (const ev of w.fx) if (ev.type === "death" && pred(ev)) return ev;
  return undefined;
}

/**
 * Per-tick op bookkeeping (step() calls it after deaths are cleaned up):
 * tally kills and losses, and once a second check the goals — completing
 * or failing the op sets World.winner.
 */
export function tickOps(w: World): void {
  const st = w.ops;
  if (!st || st.result) return;
  const op = opById(st.id);
  if (!op) return;
  for (const ev of w.fx) {
    if (ev.type !== "death") continue;
    const kind = ev.unitKind ?? ev.buildingKind;
    if (!kind) continue;
    const book = ev.faction === st.player ? st.lost : st.killed;
    book[kind] = (book[kind] ?? 0) + 1;
    if (Object.values(st.tags).some((ids) => ids.includes(ev.id))) st.lastTagDeath = { x: ev.x, y: ev.y };
  }
  // an op is a base to hold: our HQ falling loses it, even with a Goliath still standing
  if (!w.winner && !hqOf(w, st.player)) {
    const fell = deathOf(w, (ev) => ev.buildingKind === "hq" && ev.faction === st.player);
    finish(w, op, st, false, "Our HQ has fallen", fell ? { x: fell.x, y: fell.y } : centreOf(w, st.player), false);
    return;
  }
  // an HQ (or an enemy's last Goliath, its HQ already gone) fell this tick: combat already named the winner
  if (w.winner) {
    const won = w.winner === st.player;
    const hq = won ? null : hqOf(w, st.player);
    const lastGoliath = won ? deathOf(w, (ev) => ev.unitKind === "goliath" && ev.faction === st.enemy) : undefined;
    const enemyHqFell = !!deathOf(w, (ev) => ev.buildingKind === "hq" && ev.faction === st.enemy);
    if (lastGoliath && !enemyHqFell) finish(w, op, st, true, "Enemy Goliath destroyed", { x: lastGoliath.x, y: lastGoliath.y }, false);
    else finish(w, op, st, won, won ? "Enemy HQ destroyed" : "Our HQ has fallen", hq ? buildingCenter(hq) : centreOf(w, won ? st.enemy : st.player), false);
    return;
  }
  if (w.tick % TICK_RATE !== 0) return;
  // star conditions broken so far (for the HUD's "star lost" notice)
  op.stars.forEach((g, i) => {
    if (!isAchieveGoal(g) && evalGoal(w, st, g).state === "failed") st.starsLost |= 2 << i;
  });
  const evals = op.goals.map((g) => ({ g, e: evalGoal(w, st, g) }));
  const failed = evals.find((x) => x.e.state === "failed");
  const achieve = evals.filter((x) => isAchieveGoal(x.g));
  if (achieve.length > 0 && achieve.every((x) => x.e.state === "done")) {
    finish(w, op, st, true, winReason(w, op, st), centreOf(w, st.player), true);
    return;
  }
  if (failed) {
    const g = failed.g;
    const at =
      g.type === "protect" && st.lastTagDeath
        ? st.lastTagDeath
        : g.type === "within" && hqOf(w, st.enemy)
          ? centreOf(w, st.enemy)
          : centreOf(w, st.player);
    finish(w, op, st, false, failReason(g), at, true);
  }
}

/** Everything the HUD shows about the running op. */
export interface OpStatus {
  op: OpDef;
  secs: number;
  goals: { goal: Goal; eval: GoalEval }[];
  stars: { goal: Goal; eval: GoalEval }[];
  /** Live star bitmask a win now would earn (bit 1 always set). */
  starsNow: number;
  starsLost: number;
  result: OpResult | null;
}

export function opStatus(w: World): OpStatus | null {
  const st = w.ops;
  const op = st ? opById(st.id) : null;
  if (!st || !op) return null;
  return {
    op,
    secs: secsOf(w),
    goals: op.goals.map((goal) => ({ goal, eval: evalGoal(w, st, goal) })),
    stars: op.stars.map((goal) => ({ goal, eval: evalGoal(w, st, goal) })),
    starsNow: starsNow(w, op, st),
    starsLost: st.starsLost,
    result: st.result
  };
}

import { createAiState, tickAi, type Difficulty, type Strategy, type StrategyName } from "../src/sim/ai/commander";
import { BUILDINGS, TICK_RATE, UNITS } from "../src/sim/balance";
import { canPlaceBuilding, nearestReachableResource, unitBlocker } from "../src/sim/economy";
import { isVisible, knownBuildings } from "../src/sim/fog";
import { isInfantry } from "../src/sim/infantry";
import { createMapWorld } from "../src/sim/maps";
import { survivalStatus } from "../src/sim/modes/survival";
import { opAiState, opById, type OpResult } from "../src/sim/ops";
import { step } from "../src/sim/sim";
import type { BuildingKind, Command, Unit, UnitKind, World } from "../src/sim/types";
import { buildingCenter, dist, hqOf } from "../src/sim/world";

/**
 * Stand-in players for the Ops tests and the tuning harness (tools/ops.ts):
 * a "pilot" issues blue's commands each tick. Shared by tests/ops.test.ts.
 */
export type Pilot = (w: World) => Command[];
export type PilotFactory = (w: World, seed: number) => Pilot;

/** An AI commander flying the player's side. */
export const aiPilot =
  (strategy: StrategyName, difficulty: Difficulty = "normal", tweak?: Partial<Strategy>): PilotFactory =>
  (_w, seed) => {
    const s = createAiState(strategy, difficulty, seed, tweak);
    return (w) => tickAi(w, "blue", s);
  };

/** Does nothing (the op must still set up and run without errors). */
export const idlePilot: PilotFactory = () => () => [];

export interface OpRun {
  world: World;
  result: OpResult | null;
  secs: number;
}

/** Play an op to its end (or `maxSecs`) with a pilot on blue and the op's own enemy on red. */
export function runOp(id: string, pilot: PilotFactory, seed = 1, maxSecs = 900): OpRun {
  const op = opById(id)!;
  const w = createMapWorld(op.map, { op: id, seed });
  const red = opAiState(op, seed * 7 + 3);
  const blue = pilot(w, seed);
  for (let i = 0; i < maxSecs * TICK_RATE && !w.winner; i++)
    step(w, [...blue(w), ...(red ? tickAi(w, "red", red) : [])]);
  return { world: w, result: w.ops?.result ?? null, secs: w.tick / TICK_RATE };
}

// ------------------------------------------------------- scripted pilots ---

type Pt = { x: number; y: number };
const centroid = (us: Unit[]): Pt => ({
  x: us.reduce((a, u) => a + u.x, 0) / Math.max(1, us.length),
  y: us.reduce((a, u) => a + u.y, 0) / Math.max(1, us.length)
});
const armyValue = (us: Unit[]) => us.reduce((v, u) => v + UNITS[u.kind].cost, 0);
/** How many of these units are vehicles (not robot infantry). */
const vehicles = (us: Unit[]) => us.filter((u) => !isInfantry(u.kind)).length;

/** Closest legal spot for a building to an anchor (what a player taps). */
function spotFor(w: World, kind: BuildingKind, anchor: Pt): { tx: number; ty: number } | null {
  const size = BUILDINGS[kind].size;
  let best: { tx: number; ty: number } | null = null;
  let bd = Infinity;
  for (let ty = 0; ty < w.height; ty++)
    for (let tx = 0; tx < w.width; tx++) {
      const d = Math.hypot(tx + size / 2 - anchor.x, ty + size / 2 - anchor.y);
      if (d < bd && canPlaceBuilding(w, "blue", kind, tx, ty)) {
        bd = d;
        best = { tx, ty };
      }
    }
  return best;
}

export interface ScriptCfg {
  /** Buildings to construct, in order (placed near `anchor` or the HQ). */
  build: BuildingKind[];
  /** Where each kind goes (default: toward the map centre from the HQ). */
  anchor?: (w: World, kind: BuildingKind) => Pt;
  harvesters: number;
  /** What a Fab Plant / Airpad should make next (null = nothing). */
  fab?: (w: World, army: Unit[]) => UnitKind | null;
  air?: (w: World, army: Unit[]) => UnitKind | null;
  /** Where the idle army waits. */
  hold: (w: World) => Pt;
  /** Launch an all-in attack once the army is worth this much (Infinity = never). */
  attackAt: number;
  /** Known enemy building kinds to hit first, in order, before the HQ. */
  targets?: BuildingKind[];
  /** Only buildings this close to the enemy HQ count as targets. */
  targetRadius?: number;
}

/**
 * A scripted "decent phone player": one decision a second, a fixed build
 * list, factories kept one deep, harvesters topped up, the army pulled onto
 * whatever attacks the base, and one all-in push at a set army value that
 * goes for known defences, then the HQ. It sees only what blue has seen.
 */
export const scriptPilot =
  (cfg: ScriptCfg): PilotFactory =>
  () => {
    let bi = 0;
    let attacking = false;
    return (w) => {
      if (w.tick % TICK_RATE !== 0) return [];
      const cmds: Command[] = [];
      const f = w.factions.blue;
      const hq = hqOf(w, "blue");
      if (!hq) return cmds;
      const hqC = buildingCenter(hq);
      const mine = [...w.units.values()].filter((u) => u.faction === "blue");
      const myB = [...w.buildings.values()].filter((b) => b.faction === "blue");
      const army = mine.filter((u) => u.kind !== "harvester" && UNITS[u.kind].dps > 0);
      let scrap = f.scrap;
      // construction
      if (f.pending?.ready) {
        const k = f.pending.kind;
        const s = spotFor(w, k, cfg.anchor?.(w, k) ?? { x: hqC.x + (w.width / 2 - hqC.x) * 0.12, y: hqC.y + (w.height / 2 - hqC.y) * 0.12 });
        if (s) cmds.push({ type: "placeBuilding", faction: "blue", tx: s.tx, ty: s.ty });
        else cmds.push({ type: "cancelBuilding", faction: "blue" });
      } else if (!f.pending && bi < cfg.build.length) {
        const next = cfg.build[bi]!;
        const req = BUILDINGS[next].requires;
        if (scrap >= BUILDINGS[next].cost && (!req || req.some((r) => myB.some((b) => b.kind === r)))) {
          cmds.push({ type: "startBuilding", faction: "blue", building: next });
          scrap -= BUILDINGS[next].cost;
          bi++;
        }
      }
      // economy
      const harv = mine.filter((u) => u.kind === "harvester");
      if (harv.length + hq.queue.length < cfg.harvesters && scrap >= 150 && !unitBlocker(w, "blue", "harvester")) {
        cmds.push({ type: "produce", faction: "blue", buildingId: hq.id, unit: "harvester" });
        scrap -= 150;
      }
      for (const h of harv)
        if (h.order.type === "idle") {
          const r = nearestReachableResource(w, h.x, h.y);
          if (r) cmds.push({ type: "harvest", faction: "blue", unitIds: [h.id], x: r.x + 0.5, y: r.y + 0.5 });
        }
      // production
      const hold = cfg.hold(w);
      const forces = mine.filter((u) => u.kind !== "harvester");
      for (const b of myB) {
        if (b.queue.length >= 1) continue;
        const kind = b.kind === "fab-plant" ? cfg.fab?.(w, forces) : b.kind === "airpad" ? cfg.air?.(w, forces) : null;
        if (!kind || unitBlocker(w, "blue", kind) || scrap < UNITS[kind].cost) continue;
        cmds.push({ type: "produce", faction: "blue", buildingId: b.id, unit: kind });
        scrap -= UNITS[kind].cost;
        if (!b.rally) cmds.push({ type: "rally", faction: "blue", buildingId: b.id, x: hold.x, y: hold.y });
      }
      // scouts sweep the enemy half
      const eGuess = { x: w.width - hqC.x, y: w.height - hqC.y };
      for (const sc of mine.filter((u) => u.kind === "scout" && u.order.type === "idle")) {
        const leg = Math.floor(w.tick / (20 * TICK_RATE)) % 3;
        const p = leg === 0 ? eGuess : leg === 1 ? { x: eGuess.x, y: hqC.y * 0.5 + eGuess.y * 0.5 } : { x: hqC.x * 0.5 + eGuess.x * 0.5, y: eGuess.y };
        cmds.push({ type: "move", faction: "blue", unitIds: [sc.id], x: p.x, y: p.y });
      }
      // defence: pull idle units onto visible attackers near our stuff
      const foes = [...w.units.values()].filter(
        (u) => u.faction === "red" && UNITS[u.kind].dps > 0 && isVisible(w, "blue", Math.floor(u.x), Math.floor(u.y))
      );
      const near = foes
        .map((u) => ({ u, d: Math.min(...myB.map((b) => dist(u.x, u.y, buildingCenter(b).x, buildingCenter(b).y)), ...harv.map((h) => dist(u.x, u.y, h.x, h.y) + 4)) }))
        .filter((e) => e.d < 12)
        .sort((a, b) => a.d - b.d);
      // offence: one all-in push
      if (!attacking && armyValue(army) >= cfg.attackAt) attacking = true;
      if (attacking && army.length > 0) {
        const enemyHq = knownBuildings(w, "blue").find((b) => b.kind === "hq");
        const eHq = enemyHq ? { x: enemyHq.tx + 1.5, y: enemyHq.ty + 1.5 } : { x: w.width - hqC.x, y: w.height - hqC.y };
        let target: { id: number; x: number; y: number } | null = null;
        for (const k of cfg.targets ?? []) {
          const c = knownBuildings(w, "blue")
            .filter((b) => b.kind === k && dist(b.tx, b.ty, eHq.x, eHq.y) < (cfg.targetRadius ?? 12))
            .sort((a, b) => dist(a.tx, a.ty, centroid(army).x, centroid(army).y) - dist(b.tx, b.ty, centroid(army).x, centroid(army).y))[0];
          if (c) {
            target = { id: c.id, x: c.tx + BUILDINGS[c.kind].size / 2, y: c.ty + BUILDINGS[c.kind].size / 2 };
            break;
          }
        }
        if (!target && enemyHq) target = { id: enemyHq.id, x: eHq.x, y: eHq.y };
        const busy = (u: Unit) => u.order.type === "attack" && w.buildings.has(u.order.targetId) && u.order.targetId === target?.id;
        const free = army.filter((u) => !busy(u));
        if (free.length) {
          const hitsGround = free.filter((u) => UNITS[u.kind].targets !== "air");
          const escorts = free.filter((u) => UNITS[u.kind].targets === "air");
          if (target && hitsGround.length) cmds.push({ type: "attack", faction: "blue", unitIds: hitsGround.map((u) => u.id), targetId: target.id });
          else if (hitsGround.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: hitsGround.map((u) => u.id), x: eHq.x, y: eHq.y });
          if (escorts.length) {
            const c = centroid(hitsGround.length ? hitsGround : escorts);
            cmds.push({ type: "attackMove", faction: "blue", unitIds: escorts.map((u) => u.id), x: target?.x ?? c.x, y: target?.y ?? c.y });
          }
        }
      } else if (near[0]) {
        const idle = army.filter((u) => u.order.type === "idle" && u.autoTargetId === null);
        if (idle.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: idle.map((u) => u.id), x: near[0].u.x, y: near[0].u.y });
      } else {
        const strays = army.filter((u) => u.order.type === "idle" && u.autoTargetId === null && dist(u.x, u.y, hold.x, hold.y) > 5);
        if (strays.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: strays.map((u) => u.id), x: hold.x, y: hold.y });
      }
      return cmds;
    };
  };

/**
 * Decapitation: micro a fixed strike group — gather short of the enemy base,
 * then fighters hunt aircraft and fly cover, ground units kill Flak first,
 * bombers take out SAM sites and turrets, and everyone finishes the HQ.
 */
export const strikePilot: PilotFactory = () => {
  let gathered = false;
  return (w) => {
    if (w.tick % TICK_RATE !== 0) return [];
    const cmds: Command[] = [];
    const mine = [...w.units.values()].filter((u) => u.faction === "blue");
    if (!mine.length) return cmds;
    const hq = hqOf(w, "blue");
    const hqC = hq ? buildingCenter(hq) : centroid(mine);
    const known = knownBuildings(w, "blue");
    const eHqK = known.find((b) => b.kind === "hq");
    const eHq = eHqK ? { x: eHqK.tx + 1.5, y: eHqK.ty + 1.5 } : { x: w.width - hqC.x, y: w.height - hqC.y };
    const ids = (us: Unit[]) => us.map((u) => u.id);
    if (!gathered) {
      const len = Math.max(1, dist(hqC.x, hqC.y, eHq.x, eHq.y));
      const stage = { x: eHq.x + ((hqC.x - eHq.x) / len) * 13, y: eHq.y + ((hqC.y - eHq.y) / len) * 13 };
      const ground = mine.filter((u) => UNITS[u.kind].domain === "ground");
      const ready = mine.every((u) => dist(u.x, u.y, stage.x, stage.y) < 5) || w.tick > 70 * TICK_RATE;
      if (!ready) {
        if (w.tick % (5 * TICK_RATE) === 0) cmds.push({ type: "move", faction: "blue", unitIds: ids(mine), x: stage.x, y: stage.y });
        return cmds;
      }
      gathered = true;
      void ground;
    }
    const foes = [...w.units.values()].filter((u) => u.faction === "red" && isVisible(w, "blue", Math.floor(u.x), Math.floor(u.y)));
    const c = centroid(mine);
    const nearest = <T extends Pt>(xs: T[], p: Pt) => [...xs].sort((a, b) => dist(a.x, a.y, p.x, p.y) - dist(b.x, b.y, p.x, p.y))[0];
    const bld = (k: BuildingKind) => known.filter((b) => b.kind === k).map((b) => ({ id: b.id, x: b.tx + 0.5, y: b.ty + 0.5 }));
    const hqT = eHqK ? { id: eHqK.id, ...eHq } : null;
    const air = nearest(foes.filter((u) => UNITS[u.kind].domain === "air" && dist(u.x, u.y, c.x, c.y) < 12), c);
    const flak = nearest(foes.filter((u) => u.kind === "flak-crawler" || u.kind === "stinger"), c);
    const sam = nearest(bld("sam-site"), c);
    const tur = nearest(bld("turret"), c);
    const fighters = mine.filter((u) => UNITS[u.kind].targets === "air");
    const ground = mine.filter((u) => UNITS[u.kind].domain === "ground");
    const bombers = mine.filter((u) => UNITS[u.kind].domain === "air" && UNITS[u.kind].targets !== "air");
    if (fighters.length)
      cmds.push(air ? { type: "attack", faction: "blue", unitIds: ids(fighters), targetId: air.id } : { type: "attackMove", faction: "blue", unitIds: ids(fighters), x: c.x, y: c.y });
    const gT = flak ?? tur ?? sam ?? hqT;
    if (ground.length && gT) cmds.push({ type: "attack", faction: "blue", unitIds: ids(ground), targetId: gT.id });
    else if (ground.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: ids(ground), x: eHq.x, y: eHq.y });
    const bT = sam ?? tur ?? hqT;
    if (bombers.length && bT) cmds.push({ type: "attack", faction: "blue", unitIds: ids(bombers), targetId: bT.id });
    else if (bombers.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: ids(bombers), x: eHq.x, y: eHq.y });
    return cmds;
  };
};

/** Last Stand ops: a defender that counters the announced wave and fights near the base. */
export const defenderPilot: PilotFactory = (w0) => {
  const hq = hqOf(w0, "blue")!;
  const hqC = buildingCenter(hq);
  return scriptPilot({
    build: ["turret", "tech-lab", "sam-site", "turret", "fab-plant", "turret", "sam-site", "turret"],
    harvesters: 4,
    hold: (w) => {
      const st = survivalStatus(w);
      if (!st?.site) return hqC;
      const len = Math.max(1, dist(hqC.x, hqC.y, st.site.x, st.site.y));
      return { x: hqC.x + ((st.site.x - hqC.x) / len) * 6, y: hqC.y + ((st.site.y - hqC.y) / len) * 6 };
    },
    fab: (w, army) => {
      const air = survivalStatus(w)?.nextTheme === "air";
      if (air && army.filter((u) => u.kind === "flak-crawler").length < 4) return "flak-crawler";
      return army.length % 3 === 0 && !unitBlocker(w, "blue", "mastodon") ? "mastodon" : army.length % 3 === 1 && !unitBlocker(w, "blue", "lancer") ? "lancer" : "stinger";
    },
    air: (w) => (survivalStatus(w)?.nextTheme === "air" ? "raptor" : "wasp"),
    attackAt: Infinity
  })(w0, 0);
};

/** The pilots each op is checked with (tests: at least one must complete it). */
export const PILOTS: Record<string, Record<string, PilotFactory>> = {
  bridgehead: {
    idle: idlePilot,
    holder: scriptPilot({
      build: ["fab-plant", "turret", "fab-plant", "turret"],
      anchor: (_w, k) => (k === "turret" ? { x: 24, y: 31 } : { x: 8, y: 46 }),
      harvesters: 3,
      fab: (_w, army) => (army.filter((u) => u.kind === "flak-crawler").length < 1 ? "flak-crawler" : "stinger"),
      hold: () => ({ x: 23.5, y: 32.5 }),
      attackAt: Infinity
    }),
    balanced: aiPilot("balanced")
  },
  "harvest-moon": {
    idle: idlePilot,
    miner: scriptPilot({
      build: ["fab-plant", "turret", "turret", "airpad"],
      anchor: (_w, k) => (k === "turret" ? { x: 13, y: 41 } : { x: 8, y: 45 }),
      harvesters: 6,
      fab: (_w, army) => (army.filter((u) => u.kind === "flak-crawler").length < 4 ? "flak-crawler" : "stinger"),
      air: () => "raptor",
      hold: () => ({ x: 11, y: 43 }),
      attackAt: Infinity
    }),
    balanced: aiPilot("balanced")
  },
  decapitation: { idle: idlePilot, strike: strikePilot, balanced: aiPilot("balanced") },
  "iron-tide": {
    idle: idlePilot,
    holder: scriptPilot({
      build: ["turret", "turret", "airpad", "turret"],
      anchor: () => ({ x: 12, y: 36 }),
      harvesters: 4,
      fab: (_w, army) => (army.length % 2 === 0 ? "lancer" : "stinger"),
      air: () => "wasp",
      hold: () => ({ x: 12, y: 37 }),
      attackAt: Infinity
    }),
    balanced: aiPilot("balanced"),
    ironclad: aiPilot("ironclad")
  },
  "sky-pirates": {
    idle: idlePilot,
    raider: scriptPilot({
      build: ["airpad", "turret"],
      harvesters: 4,
      air: (_w, f) =>
        !f.some((u) => u.kind === "scout") ? "scout" : f.length % 4 === 1 ? "raptor" : f.length % 4 === 3 ? "wasp" : "hornet",
      hold: () => ({ x: 12, y: 50 }),
      attackAt: 2800,
      targets: ["sam-site", "turret"]
    }),
    skyforce: aiPilot("skyforce"),
    balanced: aiPilot("balanced")
  },
  "frozen-assets": {
    idle: idlePilot,
    rusher: scriptPilot({
      build: [],
      harvesters: 0,
      // the mix alternates by vehicles built so far (the starting Trooper Squad doesn't shift it)
      fab: (_w, f) => (vehicles(f) % 3 === 0 ? "mastodon" : "stinger"),
      air: (_w, f) => (vehicles(f) % 2 === 0 ? "hornet" : "raptor"),
      hold: () => ({ x: 12, y: 36 }),
      attackAt: 2600,
      targets: ["turret"]
    }),
    rush: aiPilot("rush"),
    balanced: aiPilot("balanced")
  },
  "glass-jaw": {
    idle: idlePilot,
    general: scriptPilot({
      build: ["fab-plant", "turret", "airpad", "turret"],
      harvesters: 4,
      fab: (_w, army) => (army.length % 4 === 3 ? "flak-crawler" : "stinger"),
      air: () => "wasp",
      hold: () => ({ x: 14, y: 42 }),
      attackAt: 2400,
      targets: ["turret"]
    }),
    balanced: aiPilot("balanced")
  },
  "last-light": { idle: idlePilot, defender: defenderPilot, balanced: aiPilot("balanced") }
};

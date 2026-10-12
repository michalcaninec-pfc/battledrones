// A scripted skirmish player for blue (tools/beginner.ts, the on-ramp harness):
// one look at the battle every few seconds, a fixed build list, factories
// kept busy, harvesters topped up, the army pulled onto attackers near the
// base, never a calldown, an Uplink or a crate, and an all-in push once the
// army is big enough (and late enough). Sees only what blue has seen.
import { createAiState, tickAi, type Difficulty, type StrategyName } from "../src/sim/ai/commander";
import { BUILDINGS, TICK_RATE, UNITS } from "../src/sim/balance";
import { canPlaceBuilding, nearestReachableResource, unitBlocker } from "../src/sim/economy";
import { isVisible, knownBuildings } from "../src/sim/fog";
import { createMapWorld } from "../src/sim/maps";
import { pickAiOpener, type OpenerId } from "../src/sim/openers";
import { step } from "../src/sim/sim";
import type { BuildingKind, Command, Unit, UnitKind, World } from "../src/sim/types";
import { buildingCenter, dist, hqOf } from "../src/sim/world";

export interface PlayerProfile {
  /** Seconds between looks at the battle. */
  every: number;
  /** Buildings, in order (an opener's factory counts as built). */
  build: BuildingKind[];
  /** Harvesters it keeps. */
  harvesters: number;
  /** Production orders per look (a novice queues one thing, then looks away). */
  ordersPerLook: number;
  /** Earliest attack (s) and the army it waits for (combat units). */
  attackFrom: number;
  attackUnits: number;
}

const FULL_BUILD: BuildingKind[] = ["fab-plant", "airpad", "turret", "tech-lab", "turret"];

export const PROFILES: Record<string, PlayerProfile> = {
  /** A first-week phone player: slow, never techs, one order per look, attacks at 8:00. */
  novice: { every: 4, build: ["fab-plant", "turret", "airpad"], harvesters: 3, ordersPerLook: 1, attackFrom: 480, attackUnits: 12 },
  /** A patient beginner: slow looks but steady macro, turrets, attacks at 7:00 with 12+ units. */
  beginner: { every: 3, build: FULL_BUILD, harvesters: 4, ordersPerLook: 9, attackFrom: 420, attackUnits: 12 },
  /** A decent player: looks every second and attacks with 8+ units from the start. */
  decent: { every: 1, build: FULL_BUILD, harvesters: 4, ordersPerLook: 9, attackFrom: 0, attackUnits: 8 }
};

/** A scripted player for blue (see the header). */
export function scriptedPlayer(p: PlayerProfile): (w: World) => Command[] {
  let bi = 0;
  let attacking = false;
  const step = Math.round(p.every * TICK_RATE);
  return (w) => {
    if (w.tick % step !== 0) return [];
    const cmds: Command[] = [];
    const f = w.factions.blue;
    const hq = hqOf(w, "blue");
    if (!hq) return cmds;
    const hqC = buildingCenter(hq);
    const mine = [...w.units.values()].filter((u) => u.faction === "blue");
    const myB = [...w.buildings.values()].filter((b) => b.faction === "blue");
    const harv = mine.filter((u) => u.kind === "harvester");
    const army = mine.filter((u) => u.kind !== "harvester" && UNITS[u.kind].dps > 0);
    const front = { x: hqC.x + (w.width / 2 - hqC.x) * 0.25, y: hqC.y + (w.height / 2 - hqC.y) * 0.25 };
    let scrap = f.scrap;
    // construction: next building of the list, placed (where a phone's placement ghost suggests) near the HQ
    if (f.pending?.ready) {
      const k = f.pending.kind;
      const anchor = k === "turret" ? front : { x: hqC.x + (w.width / 2 - hqC.x) * 0.1, y: hqC.y + (w.height / 2 - hqC.y) * 0.1 };
      const size = BUILDINGS[k].size;
      let best: { tx: number; ty: number } | null = null;
      let bd = Infinity;
      for (let ty = 0; ty < w.height; ty++)
        for (let tx = 0; tx < w.width; tx++) {
          const d = Math.hypot(tx + size / 2 - anchor.x, ty + size / 2 - anchor.y);
          if (d < bd && canPlaceBuilding(w, "blue", k, tx, ty)) {
            bd = d;
            best = { tx, ty };
          }
        }
      cmds.push(best ? { type: "placeBuilding", faction: "blue", ...best } : { type: "cancelBuilding", faction: "blue" });
    } else if (!f.pending) {
      const BUILD = p.build;
      while (bi < BUILD.length && myB.some((b) => b.kind === BUILD[bi]) && BUILD.indexOf(BUILD[bi]!) === bi) bi++; // opener gave it
      const next = BUILD[bi];
      if (next) {
        const req = BUILDINGS[next].requires;
        if (scrap >= BUILDINGS[next].cost && (!req || req.some((r) => myB.some((b) => b.kind === r)))) {
          cmds.push({ type: "startBuilding", faction: "blue", building: next });
          scrap -= BUILDINGS[next].cost;
          bi++;
        }
      }
    }
    // economy: four harvesters, idle ones back to work
    let orders = p.ordersPerLook;
    if (harv.length + hq.queue.length < p.harvesters && scrap >= UNITS.harvester.cost) {
      orders--;
      cmds.push({ type: "produce", faction: "blue", buildingId: hq.id, unit: "harvester" });
      scrap -= UNITS.harvester.cost;
    }
    for (const h of harv)
      if (h.order.type === "idle") {
        const r = nearestReachableResource(w, h.x, h.y, "blue");
        if (r) cmds.push({ type: "harvest", faction: "blue", unitIds: [h.id], x: r.x + 0.5, y: r.y + 0.5 });
      }
    // production: one deep, a sensible mix, anti-air once aircraft show up
    const foes = [...w.units.values()].filter(
      (u) => u.faction === "red" && UNITS[u.kind].dps > 0 && isVisible(w, "blue", Math.floor(u.x), Math.floor(u.y))
    );
    const seenAir = foes.filter((u) => UNITS[u.kind].domain === "air").length;
    const count = (k: UnitKind) => army.filter((u) => u.kind === k).length;
    for (const b of myB) {
      if (b.queue.length >= 1 || orders <= 0) continue;
      let kind: UnitKind | null = null;
      if (b.kind === "fab-plant") {
        if (seenAir > 0 && count("flak-crawler") < 1 + Math.ceil(seenAir / 2)) kind = "flak-crawler";
        else if (!unitBlocker(w, "blue", "mastodon")) kind = army.length % 3 === 0 ? "mastodon" : army.length % 3 === 1 ? "lancer" : "stinger";
        else kind = "stinger";
      } else if (b.kind === "airpad") kind = seenAir > count("raptor") + count("flak-crawler") ? "raptor" : "wasp";
      if (!kind || unitBlocker(w, "blue", kind) || scrap < UNITS[kind].cost) continue;
      cmds.push({ type: "produce", faction: "blue", buildingId: b.id, unit: kind });
      scrap -= UNITS[kind].cost;
      orders--;
      if (!b.rally) cmds.push({ type: "rally", faction: "blue", buildingId: b.id, x: front.x, y: front.y });
    }
    // attack: late and all-in; regroup at home when the push is spent
    if (!attacking && w.tick >= p.attackFrom * TICK_RATE && army.length >= p.attackUnits) attacking = true;
    if (attacking && army.length < Math.max(3, p.attackUnits / 3)) attacking = false;
    const near = foes
      .map((u) => ({ u, d: Math.min(...myB.map((b) => dist(u.x, u.y, buildingCenter(b).x, buildingCenter(b).y)), ...harv.map((h) => dist(u.x, u.y, h.x, h.y) + 3)) }))
      .filter((e) => e.d < 12)
      .sort((a, b) => a.d - b.d);
    const idle = (u: Unit) => u.order.type === "idle" && u.autoTargetId === null;
    if (near[0] && near.reduce((v, e) => v + UNITS[e.u.kind].cost, 0) >= 300) {
      // the base is under attack: everyone home (even mid-push)
      const ids = army.filter((u) => idle(u) || dist(u.x, u.y, near[0]!.u.x, near[0]!.u.y) > 14).map((u) => u.id);
      if (ids.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: ids, x: near[0].u.x, y: near[0].u.y });
    } else if (attacking) {
      const eHqK = knownBuildings(w, "blue").find((b) => b.kind === "hq");
      const eHq = eHqK ? { x: eHqK.tx + 1.5, y: eHqK.ty + 1.5 } : { x: w.width - hqC.x, y: w.height - hqC.y };
      const ids = army.filter(idle).map((u) => u.id);
      if (ids.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: ids, x: eHq.x, y: eHq.y });
    } else if (near[0]) {
      const ids = army.filter(idle).map((u) => u.id);
      if (ids.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: ids, x: near[0].u.x, y: near[0].u.y });
    } else {
      const strays = army.filter((u) => idle(u) && dist(u.x, u.y, front.x, front.y) > 5).map((u) => u.id);
      if (strays.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: strays, x: front.x, y: front.y });
    }
    return cmds;
  };
}

export interface PlayerMatch {
  map: string;
  ai: StrategyName;
  opener: OpenerId;
  winner: string;
  min: number;
}

export function playerMatch(profile: PlayerProfile, map: string, ai: StrategyName, diff: Difficulty, opener: OpenerId, seed: number, maxMin = 25): PlayerMatch {
  const w = createMapWorld(map, { seed, objectives: true, openers: { blue: opener, red: pickAiOpener(ai, seed, "red") } });
  const red = createAiState(ai, diff, seed * 3 + 1);
  const blue = scriptedPlayer(profile);
  for (let i = 0; i < maxMin * 60 * TICK_RATE && !w.winner; i++) step(w, [...blue(w), ...tickAi(w, "red", red)]);
  return { map, ai, opener, winner: w.winner ?? "draw", min: w.tick / TICK_RATE / 60 };
}


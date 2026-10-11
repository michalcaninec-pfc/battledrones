import { SALVAGE, TICK_RATE, UNITS } from "./balance";
import { isInfantry } from "./infantry";
import type { Faction, Unit, World, Wreck } from "./types";
import { incomeOf } from "./rules";
import { buildingAtTile, groundPassable } from "./world";
import { hypot } from "./fmath";

/**
 * Battlefield salvage. A destroyed combat unit leaves a burning wreck worth
 * ~30% of its cost for a minute; after it cools (a couple of seconds) the
 * first ground unit of EITHER side to drive within reach scoops it up. Fights
 * leave loot worth holding the field for, and a defender who repels a wave
 * gets paid for it — the one mechanic the design panel measured loosening
 * the snowball.
 */

/**
 * Wreck value of a unit kind (0 for harvesters: they spill their cargo, not a
 * hull; and 0 for robot infantry: a fallen squad leaves nothing worth hauling).
 */
export function wreckValue(kind: Unit["kind"], share: number = SALVAGE.share): number {
  if (kind === "harvester" || isInfantry(kind)) return 0;
  return Math.round(UNITS[kind].cost * share);
}

/**
 * Share of its cost a dead unit of `faction` leaves as a wreck in this world:
 * SALVAGE.share, except Last Stand's wave units (the survival state's own,
 * much smaller share — the waves are not an economy to farm).
 */
export function wreckShareOf(w: World, faction: Faction): number {
  const s = w.survival;
  return s && faction !== s.defender ? s.wreckShare : SALVAGE.share;
}

/**
 * Where a wreck dying at (x, y) comes to rest: the spot itself if a tank
 * could stand there, else the closest point of a passable tile within
 * `SALVAGE.shiftRadius` (aircraft over rock, a Lancer sinking near the bank,
 * a drone crashing onto a building), else null (lost in the lava).
 */
export function wreckRestingSpot(w: World, x: number, y: number): { x: number; y: number } | null {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (groundPassable(w, tx, ty)) return { x, y };
  const R = SALVAGE.shiftRadius;
  const span = Math.ceil(R);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  // fixed scan order + strict comparison: deterministic tie-breaks
  for (let dy = -span; dy <= span; dy++)
    for (let dx = -span; dx <= span; dx++) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (!groundPassable(w, nx, ny)) continue;
      // nearest point of that tile, kept off its very edge
      const cx = Math.max(nx + 0.2, Math.min(nx + 0.8, x));
      const cy = Math.max(ny + 0.2, Math.min(ny + 0.8, y));
      const d = hypot(cx - x, cy - y);
      if (d > R || d >= bestD) continue;
      bestD = d;
      best = { x: cx, y: cy };
    }
  return best;
}

/** Leave a wreck where unit `u` died (called from cleanupDeaths). */
export function leaveWreck(w: World, u: Unit): Wreck | null {
  if (u.free) return null; // a map-given unit cost nothing, so it leaves nothing to cash in
  const value = wreckValue(u.kind, wreckShareOf(w, u.faction));
  if (value <= 0) return null;
  const spot = wreckRestingSpot(w, u.x, u.y);
  if (!spot) return null;
  // the field holds so much: the oldest wreck burns out first
  while (w.wrecks.length >= SALVAGE.maxWrecks) w.wrecks.shift();
  const r: Wreck = {
    id: u.id,
    kind: u.kind,
    faction: u.faction,
    x: spot.x,
    y: spot.y,
    facing: u.facing,
    value,
    ttl: Math.round(SALVAGE.ttl * TICK_RATE),
    hot: Math.round(SALVAGE.hot * TICK_RATE)
  };
  w.wrecks.push(r);
  return r;
}

/** Credit a wreck to `faction` (scaled by its income multipliers and match rules) and emit the event. */
function collect(w: World, r: Wreck, faction: Faction, collectorId: number): void {
  const f = w.factions[faction];
  const amount = r.value * incomeOf(w, faction);
  f.scrap += amount;
  f.stats.scrapSalvaged += amount;
  w.fx.push({ type: "salvage", faction, x: r.x, y: r.y, value: amount, wreckId: r.id, collectorId });
}

/**
 * Per tick, after deaths are cleaned up: age wrecks, burn out old ones and
 * let ground units (either side, harvesters included) scoop up cool ones.
 * The nearest unit in reach wins; ties go to the earliest-built.
 */
export function tickSalvage(w: World): void {
  if (w.wrecks.length === 0) return;
  const reach = SALVAGE.pickupRadius;
  // a side on a frozen economy (an op's zero income) can't cash wrecks in: its units drive over them
  const earns = { blue: incomeOf(w, "blue") > 0, red: incomeOf(w, "red") > 0 };
  // ...nor can Last Stand's waves (no economy to feed): the wrecks stay for the defender
  if (w.survival) earns[w.survival.defender === "blue" ? "red" : "blue"] = false;
  const ground: Unit[] = [];
  for (const u of w.units.values()) if (UNITS[u.kind].domain === "ground" && earns[u.faction]) ground.push(u);
  const keep: Wreck[] = [];
  for (const r of w.wrecks) {
    if (--r.ttl <= 0) continue; // burnt out
    if (r.hot > 0) {
      r.hot--;
      keep.push(r);
      continue;
    }
    // a building placed over a wreck clears it: its owner keeps the scrap
    const b = buildingAtTile(w, Math.floor(r.x), Math.floor(r.y));
    if (b) {
      if (earns[b.faction]) collect(w, r, b.faction, b.id);
      continue;
    }
    let best: Unit | null = null;
    let bestD = reach;
    for (const u of ground) {
      const dx = u.x - r.x;
      if (dx > reach || dx < -reach) continue;
      const dy = u.y - r.y;
      if (dy > reach || dy < -reach) continue;
      const d = hypot(dx, dy);
      if (d <= bestD && (best === null || d < bestD)) {
        best = u;
        bestD = d;
      }
    }
    if (best) collect(w, r, best.faction, best.id);
    else keep.push(r);
  }
  w.wrecks = keep;
}

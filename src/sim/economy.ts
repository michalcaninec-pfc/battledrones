import { BUILDINGS, ECONOMY, TERRAIN, TICK_RATE, UNITS } from "./balance";
import { moveUnitToward } from "./movement";
import { blocksObjective } from "./objectives";
import { isStunned } from "./powers";
import {
  Terrain,
  type Building,
  type BuildingKind,
  type Command,
  type Faction,
  type Unit,
  type UnitKind,
  type World
} from "./types";
import {
  buildingCenter,
  buildingAtTile,
  distToBuilding,
  hasBuilding,
  inBounds,
  isResource,
  moveClassOf,
  nearestDropOff,
  passable,
  removeBuilding,
  sideFrame,
  spawnBuilding,
  spawnUnit,
  terrainAt,
  tileIndex,
  invalidatePathsThrough,
  onHomeLand
} from "./world";
import { applySpawnRank, bannedBy, incomeOf, rulesOf } from "./rules";
import { atan2, hypot } from "./fmath";

// ---------------------------------------------------------- tech rules ----

/** Why this building can't be started right now (null = it can). */
export function buildingBlocker(w: World, faction: Faction, kind: BuildingKind): string | null {
  const stats = BUILDINGS[kind];
  if (kind === "hq") return "Unique";
  const banned = bannedBy(w, kind, faction);
  if (banned) return banned;
  if (stats.requires && !stats.requires.some((k) => hasBuilding(w, faction, k)))
    return `Needs ${stats.requires.map((k) => BUILDINGS[k].name).join(" or ")}`;
  return null;
}

/** Why this unit can't be queued right now (null = it can). */
export function unitBlocker(w: World, faction: Faction, kind: UnitKind): string | null {
  const stats = UNITS[kind];
  const banned = bannedBy(w, kind, faction);
  if (banned) return banned;
  if (!hasBuilding(w, faction, stats.builtAt)) return `Needs ${BUILDINGS[stats.builtAt].name}`;
  if (stats.requires && !hasBuilding(w, faction, stats.requires))
    return `Needs ${BUILDINGS[stats.requires].name}`;
  return null;
}

// ------------------------------------------------------------- commands ----

export function startBuilding(w: World, faction: Faction, kind: BuildingKind): void {
  const f = w.factions[faction];
  const stats = BUILDINGS[kind];
  if (f.pending || buildingBlocker(w, faction, kind)) return;
  if (f.scrap < stats.cost) return;
  f.scrap -= stats.cost;
  f.pending = { kind, remaining: stats.buildTime * TICK_RATE, ready: false };
}

export function cancelBuilding(w: World, faction: Faction): void {
  const f = w.factions[faction];
  if (!f.pending) return;
  f.scrap += BUILDINGS[f.pending.kind].cost;
  f.pending = null;
}

export function canPlaceBuilding(
  w: World,
  faction: Faction,
  kind: BuildingKind,
  tx: number,
  ty: number
): boolean {
  const size = BUILDINGS[kind].size;
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (!inBounds(w, x, y)) return false;
      if (!TERRAIN[terrainAt(w, x, y)].buildable) return false;
      if (buildingAtTile(w, x, y)) return false;
      if (!onHomeLand(w, faction, x, y)) return false; // never out on an island (or across the sea)
    }
  // no ground unit parked inside the footprint
  for (const u of w.units.values())
    if (
      UNITS[u.kind].domain === "ground" &&
      u.x >= tx && u.x < tx + size &&
      u.y >= ty && u.y < ty + size
    )
      return false;
  if (blocksObjective(w, tx, ty, size)) return false; // Uplink platforms and crates stay open ground
  // within build radius of a friendly building
  const cx = tx + size / 2;
  const cy = ty + size / 2;
  for (const b of w.buildings.values())
    if (b.faction === faction && distToBuilding(b, cx, cy) <= ECONOMY.buildRadius)
      return true;
  return false;
}

export function placeBuilding(w: World, faction: Faction, tx: number, ty: number): void {
  const f = w.factions[faction];
  if (!f.pending || !f.pending.ready) return;
  if (!canPlaceBuilding(w, faction, f.pending.kind, tx, ty)) return;
  const b = spawnBuilding(w, f.pending.kind, faction, tx, ty);
  f.pending = null;
  w.fx.push({ type: "built", faction, id: b.id });
  // paths that ran across the new footprint must re-plan
  invalidatePathsThrough(w, b);
}

export function sellBuilding(w: World, faction: Faction, buildingId: number): void {
  const b = w.buildings.get(buildingId);
  if (!b || b.faction !== faction || b.kind === "hq") return;
  const stats = BUILDINGS[b.kind];
  // refund scales with remaining health, plus anything still in its queue
  const refund = stats.cost * ECONOMY.sellRefund * (b.hp / stats.hp);
  const queued = b.queue.reduce((s, q) => s + UNITS[q.kind].cost, 0);
  w.factions[faction].scrap += Math.floor(refund + queued);
  w.fx.push({ type: "sold", id: b.id });
  removeBuilding(w, b);
}

export function produceUnit(w: World, faction: Faction, buildingId: number, kind: UnitKind): void {
  const b = w.buildings.get(buildingId);
  const f = w.factions[faction];
  const stats = UNITS[kind];
  if (!b || b.faction !== faction || stats.builtAt !== b.kind) return;
  if (unitBlocker(w, faction, kind)) return;
  if (b.queue.length >= ECONOMY.maxQueue) return;
  if (f.scrap < stats.cost) return;
  f.scrap -= stats.cost;
  b.queue.push({ kind, remaining: stats.buildTime * TICK_RATE });
}

/** Cancel the most recently queued unit of this kind (refunded in full). */
export function cancelProduce(w: World, faction: Faction, buildingId: number, kind: UnitKind): void {
  const b = w.buildings.get(buildingId);
  if (!b || b.faction !== faction) return;
  for (let i = b.queue.length - 1; i >= 0; i--)
    if (b.queue[i]!.kind === kind) {
      b.queue.splice(i, 1);
      w.factions[faction].scrap += UNITS[kind].cost;
      return;
    }
}

export function setRally(w: World, faction: Faction, buildingId: number, x: number, y: number): void {
  const b = w.buildings.get(buildingId);
  if (!b || b.faction !== faction) return;
  b.rally = { x, y };
}

// ---------------------------------------------------------------- ticks ----

export function tickConstruction(w: World): void {
  for (const f of Object.values(w.factions)) {
    if (!f.pending || f.pending.ready) continue;
    if ((f.pending.remaining -= rulesOf(w).buildSpeed) <= 0) f.pending.ready = true;
  }
}

export function tickProduction(w: World): void {
  for (const b of w.buildings.values()) {
    const head = b.queue[0];
    if (!head) continue;
    if (isStunned(w, b.id)) continue; // EMP'd: production paused
    // a unit whose tech building was lost pauses (stays queued)
    if (UNITS[head.kind].requires && !hasBuilding(w, b.faction, UNITS[head.kind].requires!)) continue;
    if ((head.remaining -= rulesOf(w).buildSpeed) > 0) continue;
    b.queue.shift();
    const spot = findSpawnSpot(w, b, head.kind);
    const u = spawnUnit(w, head.kind, b.faction, spot.x, spot.y);
    applySpawnRank(w, u);
    const c = buildingCenter(b);
    u.facing = u.aim = atan2(spot.x - c.x, -(spot.y - c.y));
    w.factions[b.faction].stats.unitsBuilt++;
    w.fx.push({ type: "built", faction: b.faction, id: u.id });
    applyRally(w, u, b);
  }
}

function findSpawnSpot(w: World, b: Building, kind: UnitKind): { x: number; y: number } {
  const size = BUILDINGS[b.kind].size;
  const mc = moveClassOf(kind);
  // Prefer the back of the base (blue: the south side, where the bay doors
  // face on the art), then ring out. Searched in the side's own frame — red
  // plays the map rotated 180°, so its "south" is north and its scan order
  // runs backwards — or red's units would roll out toward the enemy and
  // blue's away from it (part of the old Ashlands red-side bias).
  const flip = b.faction === "red";
  for (let r = 1; r <= 4; r++) {
    const ring: { x: number; y: number; pref: number }[] = [];
    for (let i = -r; i <= size + r - 1; i++)
      for (let j = -r; j <= size + r - 1; j++) {
        const dy = flip ? size - 1 - i : i;
        const dx = flip ? size - 1 - j : j;
        if (Math.max(dx < 0 ? -dx : dx - size + 1, dy < 0 ? -dy : dy - size + 1) !== r) continue;
        const tx = b.tx + dx;
        const ty = b.ty + dy;
        if (!inBounds(w, tx, ty)) continue;
        if (mc !== "air" && (!passable(w, tx, ty, mc) || !onHomeLand(w, b.faction, tx, ty))) continue;
        const back = flip ? dy - (size - 1) : -dy; // own-frame "south" first
        ring.push({ x: tx + 0.5, y: ty + 0.5, pref: back + Math.abs(dx - (size - 1) / 2) * 0.5 });
      }
    ring.sort((p, q) => p.pref - q.pref);
    if (ring[0]) return { x: ring[0].x, y: ring[0].y };
  }
  // (boxed in: by the bay doors, but never off the map)
  return { x: b.tx + size / 2, y: Math.min(w.height - 0.5, Math.max(0.5, flip ? b.ty + size + 1 : b.ty - 1)) };
}

function applyRally(w: World, u: Unit, b: Building): void {
  if (!b.rally) {
    // fresh harvesters go straight to work on the nearest field
    if (u.kind === "harvester") {
      const f = nearestReachableResource(w, u.x, u.y, u.faction);
      if (f) u.order = { type: "harvest", fieldX: f.x, fieldY: f.y, phase: "toField" };
    }
    return;
  }
  const { x, y } = b.rally;
  if (u.kind === "harvester" && isResource(w, tileIndex(w, Math.floor(x), Math.floor(y)))) {
    u.order = { type: "harvest", fieldX: Math.floor(x), fieldY: Math.floor(y), phase: "toField" };
  } else {
    u.order = { type: "attackMove", x, y };
  }
}

// -------------------------------------------------------------- harvest ----

/**
 * Find the closest scrap/crystal tile with anything remaining, or null.
 * Ties go by scan order, run in `faction`'s own frame (see sideFrame).
 */
export function nearestScrapTile(w: World, x: number, y: number, faction?: Faction): { x: number; y: number } | null {
  const fr = sideFrame(w, faction);
  const p = fr.pt({ x, y });
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let fy = 0; fy < w.height; fy++)
    for (let fx = 0; fx < w.width; fx++) {
      const [tx, ty] = fr.tile(fx, fy, 1);
      if (!isResource(w, tileIndex(w, tx, ty))) continue;
      const d = hypot(fx + 0.5 - p.x, fy + 0.5 - p.y);
      if (d < bestD) {
        bestD = d;
        best = { x: tx, y: ty };
      }
    }
  return best;
}

/**
 * Nearest resource tile a ground unit at (x, y) can actually drive to,
 * by breadth-first search over passable tiles (8-way, no corner cutting).
 * Straight-line distance is fooled by rivers and rock-locked tiles.
 * `accept` (optional) skips fields it turns down (the AI keeps to its own
 * side of an island map's bridges).
 */
export function nearestReachableResource(
  w: World,
  x: number,
  y: number,
  faction?: Faction,
  accept?: (tx: number, ty: number) => boolean
): { x: number; y: number } | null {
  const W = w.width;
  // neighbour order in the side's own frame: red's BFS is blue's, turned 180°
  const s = faction === "red" ? -1 : 1;
  const start = tileIndex(w, Math.floor(x), Math.floor(y));
  if (start < 0 || start >= W * w.height) return null;
  const seen = new Uint8Array(W * w.height);
  const queue = new Int32Array(W * w.height);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const cur = queue[head++]!;
    if (isResource(w, cur) && (!accept || accept(cur % W, Math.floor(cur / W)))) return { x: cur % W, y: Math.floor(cur / W) };
    const cx = cur % W;
    const cy = Math.floor(cur / W);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const dy = i * s;
        const dx = j * s;
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!passable(w, nx, ny, "ground")) continue;
        if (dx !== 0 && dy !== 0 && (!passable(w, cx + dx, cy, "ground") || !passable(w, cx, cy + dy, "ground")))
          continue;
        const ni = ny * W + nx;
        if (seen[ni]) continue;
        seen[ni] = 1;
        queue[tail++] = ni;
      }
  }
  return null;
}

/** Passive HQ income so no side can be left permanently broke. */
export function tickTrickle(w: World): void {
  if ((w.tick + 1) % TICK_RATE !== 0) return; // once per full second
  for (const b of w.buildings.values())
    if (b.kind === "hq") {
      w.factions[b.faction].scrap += (rulesOf(w).hqTrickle ?? ECONOMY.hqTrickle) * incomeOf(w, b.faction);
    }
}

/** Ticks a harvester keeps running for home after being shot. */
const FLEE_TICKS = 4 * TICK_RATE;

/** Where a harvester parks to unload at a drop-off: just outside the footprint, nearest side. */
function dockPoint(b: Building, x: number, y: number): { x: number; y: number } {
  const size = BUILDINGS[b.kind].size;
  const cx = Math.max(b.tx + 0.5, Math.min(b.tx + size - 0.5, x));
  const cy = Math.max(b.ty + 0.5, Math.min(b.ty + size - 0.5, y));
  // push the clamped point out of the footprint toward the harvester (ties
  // break toward the side's own east/south, so red docks as blue's mirror)
  const c = buildingCenter(b);
  const red = b.faction === "red";
  const dx = cx - c.x;
  const dy = cy - c.y;
  const east = dx > 0 || (dx === 0 && !red);
  const south = dy > 0 || (dy === 0 && !red);
  if (Math.abs(dx) >= Math.abs(dy)) return { x: east ? b.tx + size + 0.5 : b.tx - 0.5, y: cy };
  return { x: cx, y: south ? b.ty + size + 0.5 : b.ty - 0.5 };
}

export function tickHarvest(w: World): void {
  for (const u of w.units.values()) {
    if (u.order.type !== "harvest") continue;
    if (isStunned(w, u.id)) continue; // EMP'd: frozen in place
    const o = u.order;
    const perTick = (rate: number) => rate / TICK_RATE;

    // under fire: abandon mining and run for a drop-off until the heat is off
    // (toBase/unloading already head home, so only interrupt field phases)
    if (
      w.tick - u.damagedTick < FLEE_TICKS &&
      (o.phase === "toField" || o.phase === "harvesting")
    ) {
      const home = nearestDropOff(w, u.faction, u.x, u.y);
      if (home) {
        const d = dockPoint(home, u.x, u.y);
        moveUnitToward(w, u, d.x, d.y);
        o.phase = "toField"; // resume mining from scratch once safe
        continue;
      }
    }

    if (o.phase === "toField") {
      // already standing on minable scrap? dig in right here — this also
      // resolves the jam where several harvesters contest one tile centre
      // and separation steering keeps all but one from ever "arriving"
      const curI = tileIndex(w, Math.floor(u.x), Math.floor(u.y));
      if (isResource(w, curI) && hypot(Math.floor(u.x) - o.fieldX, Math.floor(u.y) - o.fieldY) < 4) {
        o.fieldX = Math.floor(u.x);
        o.fieldY = Math.floor(u.y);
        o.phase = "harvesting";
        continue;
      }
      const i = tileIndex(w, o.fieldX, o.fieldY);
      if (!isResource(w, i)) {
        const next = nearestReachableResource(w, u.x, u.y, u.faction);
        if (!next) {
          u.order = { type: "idle" };
          continue;
        }
        o.fieldX = next.x;
        o.fieldY = next.y;
      }
      if (moveUnitToward(w, u, o.fieldX + 0.5, o.fieldY + 0.5)) {
        // unreachable fields make moveUnitToward "arrive" instantly — only
        // start digging if we're really there
        if (hypot(o.fieldX + 0.5 - u.x, o.fieldY + 0.5 - u.y) < 2.2) o.phase = "harvesting";
        else {
          // that field is cut off — settle for the nearest one we can reach
          const next = nearestReachableResource(w, u.x, u.y, u.faction);
          if (next && (next.x !== o.fieldX || next.y !== o.fieldY)) {
            o.fieldX = next.x;
            o.fieldY = next.y;
            u.path = null;
          } else u.order = { type: "idle" };
        }
      }
    } else if (o.phase === "harvesting") {
      const i = tileIndex(w, o.fieldX, o.fieldY);
      const available = w.scrap[i]!;
      if (available <= 0) {
        o.phase = "toField";
        continue;
      }
      const value = w.terrain[i] === Terrain.Crystal ? ECONOMY.crystalValue : 1;
      const room = (ECONOMY.harvesterCapacity - u.cargo) / value;
      const mined = Math.min(perTick(ECONOMY.harvestRate), available, room);
      u.cargo += mined * value;
      w.scrap[i] = Math.max(0, available - mined);
      if (u.cargo >= ECONOMY.harvesterCapacity - 1e-6) {
        u.cargo = ECONOMY.harvesterCapacity;
        o.phase = "toBase";
      }
    } else if (o.phase === "toBase") {
      const home = nearestDropOff(w, u.faction, u.x, u.y);
      if (!home) {
        u.order = { type: "idle" };
        continue;
      }
      const d = dockPoint(home, u.x, u.y);
      if (moveUnitToward(w, u, d.x, d.y) || distToBuilding(home, u.x, u.y) < 1.2) {
        o.phase = "unloading";
        const c = buildingCenter(home);
        const amount = u.cargo * incomeOf(w, u.faction);
        w.fx.push({ type: "deposit", faction: u.faction, id: u.id, x: c.x, y: c.y, amount });
      }
    } else {
      // unloading
      const transfer = Math.min(perTick(ECONOMY.unloadRate), u.cargo);
      u.cargo -= transfer;
      const f = w.factions[u.faction];
      const mult = incomeOf(w, u.faction);
      f.scrap += transfer * mult;
      f.stats.scrapHarvested += transfer * mult;
      if (u.cargo <= 1e-6) {
        u.cargo = 0;
        o.phase = "toField";
      }
    }
  }
}

export function applyEconomyCommand(w: World, c: Command): void {
  switch (c.type) {
    case "startBuilding":
      startBuilding(w, c.faction, c.building);
      break;
    case "cancelBuilding":
      cancelBuilding(w, c.faction);
      break;
    case "placeBuilding":
      placeBuilding(w, c.faction, c.tx, c.ty);
      break;
    case "sell":
      sellBuilding(w, c.faction, c.buildingId);
      break;
    case "produce":
      produceUnit(w, c.faction, c.buildingId, c.unit);
      break;
    case "cancelProduce":
      cancelProduce(w, c.faction, c.buildingId, c.unit);
      break;
    case "rally":
      setRally(w, c.faction, c.buildingId, c.x, c.y);
      break;
  }
}

export { buildingCenter };

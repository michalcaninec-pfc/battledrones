/**
 * Building placement helpers for the player's touch flow (and anything else
 * that wants to explain or suggest a spot). The rule itself stays
 * `canPlaceBuilding` in economy.ts: these functions only explain why a spot
 * fails and find a good valid one, so they can never disagree with it.
 */
import { BUILDINGS, ECONOMY, TERRAIN, UNITS } from "./balance";
import { canPlaceBuilding } from "./economy";
import { Terrain, type BuildingKind, type Faction, type World } from "./types";
import { buildingAtTile, buildingCenter, distToBuilding, inBounds, terrainAt } from "./world";
import { hypot } from "./fmath";

/** Short names for unbuildable ground, per biome where it differs. */
function groundName(w: World, t: Terrain): string {
  switch (t) {
    case Terrain.Water:
      return w.biome === "volcanic" ? "lava" : "water";
    case Terrain.Deep:
      return "open sea";
    case Terrain.Rock:
      return "rock";
    case Terrain.Rough:
      return { temperate: "mud", desert: "scree", arctic: "slush", volcanic: "cinders", tropical: "mudflat" }[w.biome];
    case Terrain.Forest:
      return "woods";
    case Terrain.Scrap:
      return "scrap";
    case Terrain.Crystal:
      return "crystals";
    case Terrain.Bridge:
      return "a bridge";
    case Terrain.Shallows:
      return "a ford";
    default:
      return TERRAIN[t].name.toLowerCase();
  }
}

/**
 * Why `kind` can't go at top-left tile (tx, ty), as a short phrase for the
 * HUD ("Too far from base", "Blocked", "Not on water"), or null when it can.
 * Agrees with canPlaceBuilding by construction.
 */
export function placementBlocker(
  w: World,
  faction: Faction,
  kind: BuildingKind,
  tx: number,
  ty: number
): string | null {
  if (canPlaceBuilding(w, faction, kind, tx, ty)) return null;
  const size = BUILDINGS[kind].size;
  let offMap = false;
  let ground: Terrain | null = null;
  let building = false;
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (!inBounds(w, x, y)) {
        offMap = true;
        continue;
      }
      if (buildingAtTile(w, x, y)) building = true;
      else if (!TERRAIN[terrainAt(w, x, y)].buildable && ground === null) ground = terrainAt(w, x, y);
    }
  if (offMap) return "Off the map";
  // the most fundamental problem first: nothing nearby can be fixed by nudging
  if (!inBuildRange(w, faction, tx + size / 2, ty + size / 2)) return "Too far from base";
  if (ground !== null) return `Not on ${groundName(w, ground)}`;
  if (building) return "Blocked";
  for (const u of w.units.values())
    if (UNITS[u.kind].domain === "ground" && u.x >= tx && u.x < tx + size && u.y >= ty && u.y < ty + size)
      return "Unit in the way";
  return "Blocked"; // a rule this explainer doesn't know about yet
}

/** Is a footprint centred at (cx, cy) within build range of `faction`'s base? */
export function inBuildRange(w: World, faction: Faction, cx: number, cy: number): boolean {
  for (const b of w.buildings.values())
    if (b.faction === faction && distToBuilding(b, cx, cy) <= ECONOMY.buildRadius) return true;
  return false;
}

/**
 * Would a footprint here leave no free tile along some side, walling in
 * what's next to it? (Mirrors the AI's own lane-keeping rule.)
 */
function cramped(w: World, tx: number, ty: number, size: number): boolean {
  let free = 0;
  for (let i = -1; i <= size; i++)
    for (const [x, y] of [
      [tx + i, ty - 1],
      [tx + i, ty + size],
      [tx - 1, ty + i],
      [tx + size, ty + i]
    ] as [number, number][]) {
      if (!inBounds(w, x, y)) continue;
      if (w.occupancy[y * w.width + x] === 0 && TERRAIN[terrainAt(w, x, y)].ground) free++;
    }
  return free < (size + 2) * 2;
}

/**
 * The best valid top-left tile for `kind` near `anchor` (tile coords, e.g.
 * the middle of the player's view): the closest spot in build range, with a
 * small penalty for spots that would wall a lane shut. Null if nowhere fits.
 */
export function suggestPlacement(
  w: World,
  faction: Faction,
  kind: BuildingKind,
  anchor: { x: number; y: number }
): { tx: number; ty: number } | null {
  const size = BUILDINGS[kind].size;
  const r = Math.ceil(ECONOMY.buildRadius + size);
  const seen = new Set<number>();
  let best: { tx: number; ty: number } | null = null;
  let bestScore = Infinity;
  for (const b of w.buildings.values()) {
    if (b.faction !== faction) continue;
    const c = buildingCenter(b);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const tx = Math.round(c.x + dx - size / 2);
        const ty = Math.round(c.y + dy - size / 2);
        const key = ty * 4096 + tx;
        if (seen.has(key)) continue;
        seen.add(key);
        const d = hypot(tx + size / 2 - anchor.x, ty + size / 2 - anchor.y);
        if (d >= bestScore) continue;
        if (!canPlaceBuilding(w, faction, kind, tx, ty)) continue;
        const score = d + (size > 1 && cramped(w, tx, ty, size) ? 4 : 0);
        if (score < bestScore || (score === bestScore && best && (ty < best.ty || (ty === best.ty && tx < best.tx)))) {
          best = { tx, ty };
          bestScore = score;
        }
      }
  }
  return best;
}

/**
 * A finger tap is imprecise: if (tx, ty) is invalid but a valid spot is one
 * tile away, use that (closest first, in a fixed order). Otherwise the tap
 * stands, so the ghost can show why it can't go there.
 */
export function snapPlacement(
  w: World,
  faction: Faction,
  kind: BuildingKind,
  tx: number,
  ty: number
): { tx: number; ty: number } {
  if (canPlaceBuilding(w, faction, kind, tx, ty)) return { tx, ty };
  const ring: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];
  for (const [dx, dy] of ring)
    if (canPlaceBuilding(w, faction, kind, tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
  return { tx, ty };
}

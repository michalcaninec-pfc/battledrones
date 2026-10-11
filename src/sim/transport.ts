import { INFANTRY, TICK_RATE, UNITS } from "./balance";
import { isInfantry, isTransport } from "./infantry";
import { moveUnitToward } from "./movement";
import { isStunned } from "./powers";
import type { Command, Faction, Unit, UnitOrder, World } from "./types";
import { inBounds, passable, sideFrame, type SideFrame } from "./world";
import { cos, hypot, sin } from "./fmath";

/**
 * The Condor dropship (INFANTRY.md). Infantry squads BOARD it — walk up, and
 * after INFANTRY.boardTime within INFANTRY.boardRange they are taken off the
 * map into `condor.passengers` — and it UNLOADS them: flies to a drop point,
 * hovers INFANTRY.unloadHover, puts them back (same ids) around the point,
 * and backs off their heads.
 *
 * Passengers are OUT of `World.units` while aboard, so every system that walks
 * the units (combat, vision, capture, targeting, salvage) ignores them for
 * free. Code that must still find a squad aboard uses findUnit / carrierOf.
 *
 * Shot down: over ground a squad could stand on the passengers bail out hurt;
 * over water or rock they are lost with it (combat.ts cleanupDeaths).
 */

// ----------------------------------------------------------- helpers ---

/** A unit by id, on the field or aboard a Condor (null when it is gone). */
export function findUnit(w: World, id: number): Unit | null {
  const u = w.units.get(id);
  if (u) return u;
  for (const c of w.units.values()) {
    if (!c.passengers?.length) continue;
    for (const p of c.passengers) if (p.id === id) return p;
  }
  return null;
}

/** The Condor carrying unit `unitId`, or null when it is not aboard one. */
export function carrierOf(w: World, unitId: number): Unit | null {
  for (const c of w.units.values()) if (c.passengers?.some((p) => p.id === unitId)) return c;
  return null;
}

/**
 * Put a squad straight into a Condor's hold, no walk or climb (a match that
 * starts with the squad aboard; the free replacement Condor's crew).
 */
export function stowAboard(w: World, c: Unit, squad: Unit): void {
  if (freeSeats(c) === 0) return;
  w.fx.push({ type: "embark", faction: squad.faction, carrierId: c.id, unitId: squad.id, x: squad.x, y: squad.y });
  w.units.delete(squad.id);
  squad.order = { type: "idle" };
  squad.path = null;
  squad.pathGoal = null;
  squad.autoTargetId = null;
  squad.x = c.x;
  squad.y = c.y;
  c.passengers!.push(squad);
}

/** Seats left aboard a transport (0 for anything that carries nothing). */
export function freeSeats(c: Unit): number {
  return Math.max(0, (UNITS[c.kind].capacity ?? 0) - (c.passengers?.length ?? 0));
}

/** Is this a transport with anyone aboard? */
export function isLoaded(c: Unit): boolean {
  return (c.passengers?.length ?? 0) > 0;
}

/** Can a squad stand on this tile? (Foot-passable ground, no building on it.) */
const standable = (w: World, tx: number, ty: number): boolean => passable(w, tx, ty, "foot");

/** Can a squad stand on tile (fx, fy) of a side's frame? (Off the map: no.) */
type StandOk = (fx: number, fy: number) => boolean;

function standOk(w: World, fr: SideFrame): StandOk {
  return (fx, fy) => {
    const [tx, ty] = fr.tile(fx, fy, 1);
    return inBounds(w, tx, ty) && standable(w, tx, ty);
  };
}

/**
 * Is frame point (x, y) somewhere a squad can be set down: on a tile it can
 * stand on, and at least INFANTRY.dropClear from every tile it can't (and
 * the map's edge), so none of its robots stands in the water?
 */
function isClear(ok: StandOk, x: number, y: number): boolean {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  if (!ok(fx, fy)) return false;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if ((dx === 0 && dy === 0) || ok(fx + dx, fy + dy)) continue;
      const gx = Math.max(fx + dx - x, 0, x - (fx + dx + 1));
      const gy = Math.max(fy + dy - y, 0, y - (fy + dy + 1));
      if (hypot(gx, gy) < INFANTRY.dropClear - 1e-9) return false;
    }
  return true;
}

const CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const;

/**
 * The clear point (isClear) of frame tile (fx, fy) nearest (px, py): kept
 * INFANTRY.dropClear off the sides and corners a squad can't stand past, and
 * a little off the others (never exactly on a tile edge). The tile's centre
 * when that fails; null when a squad can't stand on the tile at all.
 */
function clearIn(ok: StandOk, fx: number, fy: number, px: number, py: number): { x: number; y: number } | null {
  if (!ok(fx, fy)) return null;
  const c = INFANTRY.dropClear;
  const m = (open: boolean) => (open ? 0.1 : c);
  let x = Math.max(fx + m(ok(fx - 1, fy)), Math.min(fx + 1 - m(ok(fx + 1, fy)), px));
  let y = Math.max(fy + m(ok(fx, fy - 1)), Math.min(fy + 1 - m(ok(fx, fy + 1)), py));
  for (const [dx, dy] of CORNERS) {
    if (ok(fx + dx, fy + dy)) continue;
    const cx = fx + (dx > 0 ? 1 : 0);
    const cy = fy + (dy > 0 ? 1 : 0);
    const d = hypot(x - cx, y - cy);
    if (d < c) {
      x = cx + ((x - cx) / d) * c;
      y = cy + ((y - cy) / d) * c;
    }
  }
  return isClear(ok, x, y) ? { x, y } : { x: fx + 0.5, y: fy + 0.5 };
}

/**
 * The clear point nearest frame point p, over the tiles within `span` of it
 * and no farther than `maxD`: p itself when it is clear. Fixed (frame) scan
 * order, and a later spot must be nearer by more than rounding noise:
 * deterministic, mirror-fair ties (red's frame point is blue's give or take
 * the last bit).
 */
function nearestClear(ok: StandOk, p: { x: number; y: number }, span: number, maxD: number): { x: number; y: number } | null {
  if (isClear(ok, p.x, p.y)) return { x: p.x, y: p.y };
  const fx0 = Math.floor(p.x);
  const fy0 = Math.floor(p.y);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  let bdx = 0;
  let bdy = 0;
  // rings of tiles outward from p's; a tile r rings out holds no point
  // nearer than r - 1, so the search stops once that can't beat the best.
  // Ties keep the first in row-major order, as a plain square scan would.
  for (let r = 0; r <= span && bestD > r - 1; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx += Math.abs(dy) === r ? 1 : 2 * r) {
        const q = clearIn(ok, fx0 + dx, fy0 + dy, p.x, p.y);
        if (!q) continue;
        const d = hypot(q.x - p.x, q.y - p.y);
        if (d > maxD + 1e-9) continue;
        const nearer = d < bestD - 1e-9;
        const tie = !nearer && d < bestD + 1e-9 && (dy < bdy || (dy === bdy && dx < bdx));
        if (!nearer && !tie) continue;
        bestD = d;
        best = q;
        bdx = dx;
        bdy = dy;
      }
  return best;
}

/**
 * Where infantry dropped at (x, y) by `faction` touch down: the point itself
 * when squads can be set down there (isClear: on ground they can stand on,
 * INFANTRY.dropClear from any they can't), else the nearest such point within
 * INFANTRY.dropSearch — or, out over a big lake, the nearest anywhere. Never
 * Water, Rock or a building. Scanned in the side's own frame, so red's choice
 * is always the mirror image of blue's. Null only when nowhere on the map will do.
 */
export function dropPoint(w: World, faction: Faction, x: number, y: number): { x: number; y: number } | null {
  const fr = sideFrame(w, faction);
  const ok = standOk(w, fr);
  const p = fr.pt({ x, y });
  if (isClear(ok, p.x, p.y)) return { x, y };
  const R = INFANTRY.dropSearch;
  const at = nearestClear(ok, p, Math.ceil(R), R) ?? nearestClear(ok, p, Math.max(w.width, w.height), Infinity);
  return at ? fr.pt(at) : null;
}

/** Ring steps (eighths of a turn) a passenger tries from its own spot, alternating either way… */
const SEAT_STEPS = [0, 1, -1, 2, -2, 3, -3, 4];
/** …on a small ring round the drop point, then (cramped in a corner) wider ones. */
const SEAT_RINGS = [0.45, 0.9, 1.35];

/**
 * Where a Condor's passengers step off around a (clear) drop point: a small
 * ring, in the side's own frame. Each takes the first spot round the ring
 * from its own (then round wider rings), nudged clear (isClear) of ground it
 * can't stand on, that is a separation's width from the squads already down,
 * so separation never shoves one toward the water; failing that, the point
 * itself.
 */
function seatSpots(w: World, faction: Faction, x: number, y: number, ps: readonly Unit[]): { x: number; y: number }[] {
  if (ps.length <= 1) return ps.map(() => ({ x, y }));
  const fr = sideFrame(w, faction);
  const ok = standOk(w, fr);
  const p = fr.pt({ x, y });
  const out: { x: number; y: number }[] = [];
  ps.forEach((u, i) => {
    const a0 = (i / ps.length) * Math.PI * 2 + 0.4;
    const at = (a: number, r: number) => ({ x: p.x + sin(a) * r, y: p.y - cos(a) * r });
    // (movement.ts separate: squads part to max(0.7, the two radii))
    const apart = (q: { x: number; y: number }) =>
      out.every((o, j) => hypot(q.x - o.x, q.y - o.y) >= Math.max(0.7, UNITS[u.kind].radius + UNITS[ps[j]!.kind].radius) - 1e-9);
    let s: { x: number; y: number } | null = null;
    for (const a of SEAT_RINGS.flatMap((r) => SEAT_STEPS.map((k) => at(a0 + (k * Math.PI) / 4, r)))) {
      const q = nearestClear(ok, a, 1, 0.4); // (a spot by the water's edge: just off it)
      if (q && apart(q)) {
        s = q;
        break;
      }
    }
    out.push(s ?? p);
  });
  return out.map((q) => fr.pt(q));
}

/** Put a Condor's passengers back on the field around (x, y); returns their ids. */
function disembarkAll(w: World, c: Unit, x: number, y: number, bailout: boolean): number[] {
  const ps = c.passengers ?? [];
  const ids: number[] = [];
  const seats = seatSpots(w, c.faction, x, y, ps);
  ps.forEach((p, i) => {
    const s = seats[i]!;
    p.x = s.x;
    p.y = s.y;
    p.facing = p.aim = c.facing;
    p.order = { type: "idle" };
    p.path = null;
    p.pathGoal = null;
    p.autoTargetId = null;
    if (bailout) p.hp = Math.min(p.hp, UNITS[p.kind].hp * INFANTRY.bailoutHp);
    w.units.set(p.id, p);
    ids.push(p.id);
  });
  c.passengers = [];
  if (ids.length > 0) w.fx.push({ type: "disembark", faction: c.faction, carrierId: c.id, unitIds: ids, x, y, bailout });
  return ids;
}

// ---------------------------------------------------------- shot down ---

/** Is the Condor over ground its passengers could bail out onto? (Not Water, Rock or a building; the tile under it in its side's frame.) */
export function canBailOut(w: World, c: Unit): boolean {
  const fr = sideFrame(w, c.faction);
  const p = fr.pt(c);
  return standOk(w, fr)(Math.floor(p.x), Math.floor(p.y));
}

/**
 * A Condor was shot down over walkable ground (cleanupDeaths): its passengers
 * bail out where it fell, each with at most INFANTRY.bailoutHp of its max HP.
 * Returns their ids.
 */
export function bailOut(w: World, c: Unit): number[] {
  // (where it fell, nudged clear of the water's edge: in the side's frame, like a drop)
  const fr = sideFrame(w, c.faction);
  const at = nearestClear(standOk(w, fr), fr.pt(c), 1, 1.5);
  const p = at ? fr.pt(at) : { x: c.x, y: c.y };
  return disembarkAll(w, c, p.x, p.y, true);
}

// ----------------------------------------------------------- commands ---

/** Apply a `board` or `unload` command (validated: own units of the right kinds only). */
export function applyTransportCommand(w: World, c: Extract<Command, { type: "board" | "unload" }>): void {
  if (c.type === "board") {
    const carrier = w.units.get(c.carrierId);
    if (!carrier || carrier.faction !== c.faction || !isTransport(carrier.kind)) return;
    for (const id of c.unitIds) {
      // (a squad already aboard is not on the field: w.units misses it and it is ignored)
      const u = w.units.get(id);
      if (!u || u.faction !== c.faction || !isInfantry(u.kind)) continue;
      u.order = { type: "board", carrierId: carrier.id, ticks: 0 };
      u.path = null;
      u.autoTargetId = null;
    }
    return;
  }
  for (const id of c.unitIds) {
    const u = w.units.get(id);
    if (!u || u.faction !== c.faction || !isLoaded(u)) continue;
    const hasPoint = Number.isFinite(c.x) && Number.isFinite(c.y);
    const at = dropPoint(w, u.faction, hasPoint ? c.x! : u.x, hasPoint ? c.y! : u.y);
    if (!at) continue; // nowhere within reach a squad could stand
    u.order = { type: "unload", x: at.x, y: at.y, hover: -1 };
    u.path = null;
    u.autoTargetId = null;
  }
}

// --------------------------------------------------------------- tick ---

/**
 * After a drop the Condor lifts off its squads' heads (it would hide them):
 * it backs off INFANTRY.dropBackOff the way it came (against its facing, so
 * mirror-image drops part as mirror images), then idles there.
 */
function backOff(w: World, c: Unit): UnitOrder {
  const d = INFANTRY.dropBackOff;
  return {
    type: "move",
    x: Math.min(w.width - 0.5, Math.max(0.5, c.x - sin(c.facing) * d)),
    y: Math.min(w.height - 0.5, Math.max(0.5, c.y + cos(c.facing) * d))
  };
}

/**
 * Per tick, after combat and before movement: boarding squads walk to their
 * Condor and climb in; idle Condors drift to meet squads boarding them;
 * unloading Condors fly to the drop point, hover, put their squads down and
 * back off them (backOff).
 * EMP-stunned squads and Condors pause. Passengers ride along (their x/y
 * follow the Condor, for the UI).
 */
export function tickTransport(w: World): void {
  const boardTicks = Math.round(INFANTRY.boardTime * TICK_RATE);
  const hoverTicks = Math.round(INFANTRY.unloadHover * TICK_RATE);
  /** Condor id → the squads walking to board it (for idle Condors to meet). */
  const boarders = new Map<number, Unit[]>();
  /** Condors a squad is climbing into right now: they hold still until it is aboard. */
  const climbing = new Set<number>();

  // collected first: embarking takes squads out of w.units, dropping puts them back
  const boarding: Unit[] = [];
  const transports: Unit[] = [];
  for (const u of w.units.values()) {
    if (u.order.type === "board") boarding.push(u);
    else if (u.passengers) transports.push(u);
  }
  for (const u of boarding) {
    if (u.order.type !== "board" || u.hp <= 0) continue;
    const o = u.order;
    const c = w.units.get(o.carrierId);
    if (!c || c.hp <= 0 || c.faction !== u.faction || freeSeats(c) === 0) {
      u.order = { type: "idle" }; // carrier gone or full
      u.path = null;
      continue;
    }
    if (isStunned(w, u.id)) continue; // EMP'd: frozen in place, the clock stops
    const d = hypot(c.x - u.x, c.y - u.y);
    if (d > INFANTRY.boardRange) {
      o.ticks = 0;
      moveUnitToward(w, u, c.x, c.y);
      const list = boarders.get(c.id);
      if (list) list.push(u);
      else boarders.set(c.id, [u]);
      continue;
    }
    u.path = null;
    climbing.add(c.id);
    if (++o.ticks < boardTicks) continue;
    // climb aboard (from where it stands): off the field, into the hold
    w.fx.push({ type: "embark", faction: u.faction, carrierId: c.id, unitId: u.id, x: u.x, y: u.y });
    w.units.delete(u.id);
    u.order = { type: "idle" };
    u.pathGoal = null;
    u.autoTargetId = null;
    u.x = c.x;
    u.y = c.y;
    c.passengers!.push(u);
  }

  for (const c of transports) {
    if (c.hp <= 0) continue;
    const stunned = isStunned(w, c.id);
    if (c.order.type === "unload" && !stunned) {
      const o = c.order;
      if (!isLoaded(c)) {
        c.order = { type: "idle" }; // nothing left to drop
      } else if (o.hover < 0) {
        if (moveUnitToward(w, c, o.x, o.y)) o.hover = 0;
      } else if (++o.hover >= hoverTicks) {
        // re-validated: a building may have gone up on the spot meanwhile
        const at = dropPoint(w, c.faction, o.x, o.y);
        if (at) disembarkAll(w, c, at.x, at.y, false);
        c.order = at ? backOff(w, c) : { type: "idle" };
      }
    } else if (c.order.type === "idle" && !stunned && freeSeats(c) > 0 && !climbing.has(c.id)) {
      // an idle Condor comes to meet the nearest squad boarding it (not drifting off one that is climbing in)
      let near: Unit | null = null;
      let nearD = Infinity;
      for (const s of boarders.get(c.id) ?? []) {
        const d = hypot(s.x - c.x, s.y - c.y);
        if (d < nearD) {
          nearD = d;
          near = s;
        }
      }
      if (near && nearD > INFANTRY.boardRange * 0.6) moveUnitToward(w, c, near.x, near.y);
    }
    for (const p of c.passengers ?? []) {
      p.x = c.x;
      p.y = c.y;
    }
  }
}

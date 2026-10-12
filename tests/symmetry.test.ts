import { describe, expect, it } from "vitest";
import { createAiState, tickAi, type StrategyName } from "../src/sim/ai/commander";
import { BUILDINGS, TICK_RATE } from "../src/sim/balance";
import { nearestReachableResource, nearestScrapTile } from "../src/sim/economy";
import { MAPS, createMapWorld } from "../src/sim/maps";
import { findPath } from "../src/sim/movement";
import type { OpenerId } from "../src/sim/openers";
import { step } from "../src/sim/sim";
import type { World } from "../src/sim/types";
import { goliathsOf } from "../src/sim/goliath";
import { groundPassable, hqOf, spawnUnit } from "../src/sim/world";

/**
 * Every map is point-symmetric and red plays it rotated 180°, so every rule
 * must treat the two sides as mirror images. Searches whose ties went by
 * scan order (BFS/A* neighbour order, grid scans, "spawn on the south side",
 * flooring a point on a tile edge) once broke that: red won ~65–70% of
 * Ashlands mirror games and out-harvested blue by 9% at 4:00.
 */

const tileMirror = (w: World, p: { x: number; y: number }) => ({ x: w.width - 1 - p.x, y: w.height - 1 - p.y });
const ptMirror = (w: World, p: { x: number; y: number }) => ({ x: w.width - p.x, y: w.height - p.y });

/** A spread of passable sample tiles (deterministic). */
function samples(w: World, step = 5): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let ty = 1; ty < w.height - 1; ty += step)
    for (let tx = 1 + (ty % 3); tx < w.width - 1; tx += step) if (groundPassable(w, tx, ty)) out.push({ x: tx, y: ty });
  return out;
}

describe("mirror symmetry under the 180° map turn", () => {
  for (const def of MAPS) {
    it(`resource searches pick mirror-image fields on ${def.name}`, () => {
      const w = createMapWorld(def.id);
      for (const t of samples(w)) {
        const p = { x: t.x + 0.5, y: t.y + 0.5 };
        const m = ptMirror(w, p);
        const b = nearestReachableResource(w, p.x, p.y, "blue");
        const r = nearestReachableResource(w, m.x, m.y, "red");
        expect(r === null ? null : tileMirror(w, r)).toEqual(b);
        const bs = nearestScrapTile(w, p.x, p.y, "blue");
        const rs = nearestScrapTile(w, m.x, m.y, "red");
        expect(rs === null ? null : tileMirror(w, rs)).toEqual(bs);
      }
    });

    it(`A* paths are mirror images on ${def.name}, even to a point on a tile edge`, () => {
      const w = createMapWorld(def.id);
      const pts = samples(w, 9);
      let n = 0;
      for (let i = 0; i < pts.length; i += 2) {
        const a = { x: pts[i]!.x + 0.5, y: pts[i]!.y + 0.5 };
        const g = pts[(i * 7 + 3) % pts.length]!;
        // every other goal sits exactly on a tile corner (like Riverlands' centre Uplink)
        const b = i % 4 === 0 ? { x: g.x, y: g.y } : { x: g.x + 0.5, y: g.y + 0.5 };
        const pb = findPath(w, a.x, a.y, b.x, b.y, "ground", "blue");
        const ma = ptMirror(w, a);
        const mb = ptMirror(w, b);
        const pr = findPath(w, ma.x, ma.y, mb.x, mb.y, "ground", "red");
        expect(pr === null ? null : pr.map((q) => ptMirror(w, q))).toEqual(pb);
        n++;
      }
      expect(n).toBeGreaterThan(5);
    });
  }

  it("units roll out of mirror-image sides of each HQ and factory", () => {
    const w = createMapWorld("ashlands", { openers: { blue: "blitz", red: "blitz" } });
    for (const f of ["blue", "red"] as const) w.factions[f].scrap = 1000;
    step(
      w,
      (["blue", "red"] as const).map((f) => ({ type: "produce" as const, faction: f, buildingId: hqOf(w, f)!.id, unit: "harvester" as const }))
    );
    const before = new Set(w.units.keys());
    for (let i = 0; i < 20 * TICK_RATE && w.units.size < before.size + 2; i++) step(w, []);
    const fresh = [...w.units.values()].filter((u) => !before.has(u.id));
    expect(fresh).toHaveLength(2);
    const blue = fresh.find((u) => u.faction === "blue")!;
    const red = fresh.find((u) => u.faction === "red")!;
    const m = ptMirror(w, red);
    expect(m.x).toBeCloseTo(blue.x, 9);
    expect(m.y).toBeCloseTo(blue.y, 9);
  });

  // A mirror match (same personality, opener and AI seed on both sides) stays
  // its own exact mirror image through the opening — every placement, harvest
  // trip, path and production choice. (Later, combat between interleaved
  // unit ids drifts it apart at float precision; that is noise, not bias.)
  const cases: [string, StrategyName, OpenerId][] = [
    ["ashlands", "balanced", "industry"],
    ["ashlands", "boom", "industry"],
    ["riverlands", "rush", "blitz"],
    ["dune-sea", "airswarm", "airwing"],
    ["frostbite", "ironclad", "blitz"],
    ["proving-grounds", "skyforce", "airwing"]
  ];
  /** Units (by kind, place, health, order and Goliath mode) and buildings of a side, red's turned back into blue's frame. */
  const picture = (w: World, f: "blue" | "red") => ({
    units: [...w.units.values()]
      .filter((u) => u.faction === f)
      .map((u) => {
        const q = f === "red" ? ptMirror(w, u) : u;
        return `${u.kind} ${q.x.toFixed(4)} ${q.y.toFixed(4)} ${u.hp.toFixed(2)} ${u.order.type} ${u.goliath?.mode ?? ""}`;
      })
      .sort(),
    buildings: [...w.buildings.values()]
      .filter((b) => b.faction === f)
      .map((b) => {
        const s = BUILDINGS[b.kind].size;
        const [tx, ty] = f === "red" ? [w.width - b.tx - s, w.height - b.ty - s] : [b.tx, b.ty];
        return `${b.kind} ${tx} ${ty} ${b.outpost ? "outpost" : ""} ${b.queue.map((q) => q.kind).join(",")}`;
      })
      .sort()
  });

  // The Goliath's planner (ai/goliath.ts) picks sites, outposts, escorts and
  // harvesters by scans in the side's own frame: a mirror match with one on
  // each side stays a mirror image as it walks out, digs in and builds round itself.
  // (Float ties in the sim's own geometry can still split a pair after a while — a unit at
  // exactly a waypoint's 0.7-tile consume distance on one side and a hair inside it on the
  // other — so these cases are ones that stay clear of such ties for their whole run.)
  const goliathCases: [string, StrategyName, "spawn" | "nomads"][] = [
    ["ashlands", "balanced", "spawn"],
    ["frostbite", "ironclad", "spawn"],
    ["riverlands", "balanced", "nomads"]
  ];
  for (const [map, p, how] of goliathCases)
    it(`an AI mirror match on ${map} with a Goliath each (${how === "nomads" ? "Nomads" : p}) stays a mirror image for 75 s`, () => {
      const w = createMapWorld(map, { seed: 99, objectives: true, ...(how === "nomads" ? { mutators: ["nomads" as const] } : {}) });
      if (how === "spawn")
        for (const f of ["blue", "red"] as const) {
          const hq = hqOf(w, f)!;
          const c = { x: hq.tx + 1.5, y: hq.ty + 1.5 };
          const s = f === "blue" ? 1 : -1;
          spawnUnit(w, "goliath", f, c.x + 4 * s, c.y - 4 * s);
          spawnUnit(w, "mender", f, c.x + 2 * s, c.y + 3 * s);
          w.factions[f].scrap = 3000;
        }
      const ai = { blue: createAiState(p, "normal", 7), red: createAiState(p, "normal", 7) };
      for (let i = 0; i < 75 * TICK_RATE; i++) step(w, [...tickAi(w, "blue", ai.blue), ...tickAi(w, "red", ai.red)]);
      expect(picture(w, "red")).toEqual(picture(w, "blue"));
      expect(goliathsOf(w, "blue").some((g) => g.goliath!.mode !== "walking" || Math.hypot(g.x - w.width / 2, g.y - w.height / 2) > 0)).toBe(true);
      expect(w.factions.red.scrap).toBeCloseTo(w.factions.blue.scrap, 6);
    });

  for (const [map, p, opener] of cases)
    it(`an AI mirror match on ${map} (${p}) stays a mirror image for its first 40 s`, () => {
      const w = createMapWorld(map, { seed: 99, objectives: true, openers: { blue: opener, red: opener } });
      const ai = { blue: createAiState(p, "normal", 7), red: createAiState(p, "normal", 7) };
      for (let i = 0; i < 40 * TICK_RATE; i++) step(w, [...tickAi(w, "blue", ai.blue), ...tickAi(w, "red", ai.red)]);
      const units = (f: "blue" | "red") =>
        [...w.units.values()]
          .filter((u) => u.faction === f)
          .map((u) => {
            const q = f === "red" ? ptMirror(w, u) : u;
            return `${u.kind} ${q.x.toFixed(4)} ${q.y.toFixed(4)} ${u.hp.toFixed(2)} ${u.order.type}`;
          })
          .sort();
      const buildings = (f: "blue" | "red") =>
        [...w.buildings.values()]
          .filter((b) => b.faction === f)
          .map((b) => {
            const s = BUILDINGS[b.kind].size;
            const [tx, ty] = f === "red" ? [w.width - b.tx - s, w.height - b.ty - s] : [b.tx, b.ty];
            return `${b.kind} ${tx} ${ty} ${b.queue.map((q) => q.kind).join(",")}`;
          })
          .sort();
      expect(units("red")).toEqual(units("blue"));
      expect(buildings("red")).toEqual(buildings("blue"));
      expect(w.factions.red.scrap).toBeCloseTo(w.factions.blue.scrap, 6);
      expect(w.factions.red.stats.scrapHarvested).toBeCloseTo(w.factions.blue.stats.scrapHarvested, 6);
    });
});

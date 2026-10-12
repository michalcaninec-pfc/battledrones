import { describe, expect, it } from "vitest";
import { createAiState, tickAi, type StrategyName } from "../src/sim/ai/commander";
import { objectiveHolds, planObjectives } from "../src/sim/ai/objectives";
import { COMBAT, OBJECTIVES, POWERS, TICK_RATE, UNITS } from "../src/sim/balance";
import { canPlaceBuilding } from "../src/sim/economy";
import { isVisible, tickFog } from "../src/sim/fog";
import { MAPS, createMapWorld } from "../src/sim/maps";
import {
  CRATE_REWARDS,
  claimCrate,
  dropAnnounceTick,
  dropLandTick,
  mirrorPoint,
  nextDropTick,
  pickDropSite,
  rollReward,
  setupObjectives
} from "../src/sim/objectives";
import { pickAiOpener } from "../src/sim/openers";
import { step } from "../src/sim/sim";
import type { Crate, CrateReward, Faction, FxEvent, Unit, UnitKind, World } from "../src/sim/types";
import { createWorld, passable, spawnBuilding, spawnUnit } from "../src/sim/world";

const U = OBJECTIVES.uplink;
const D = OBJECTIVES.drops;

/** A 40×40 open world with one Uplink at its centre (the centre is its own mirror). */
function uplinkWorld(): World {
  const w = createWorld(40, 40);
  setupObjectives(w, [[20, 20]], []);
  return w;
}

/** Park `n` units of a kind in a tight cluster at (x, y); they never move on their own. */
function squad(w: World, kind: UnitKind, f: Faction, n: number, x = 20, y = 20): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < n; i++) out.push(spawnUnit(w, kind, f, x - 0.4 + (i % 2) * 0.8, y - 0.4 + Math.floor(i / 2) * 0.8));
  return out;
}

/** Step until `pred` holds (or `max` ticks); returns ticks taken and every event seen. */
function until(w: World, pred: () => boolean, max = 2000): { ticks: number; fx: FxEvent[] } {
  const fx: FxEvent[] = [];
  for (let t = 1; t <= max; t++) {
    step(w, []);
    fx.push(...w.fx);
    if (pred()) return { ticks: t, fx };
  }
  return { ticks: -1, fx };
}

function run(w: World, ticks: number): FxEvent[] {
  const fx: FxEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    step(w, []);
    fx.push(...w.fx);
  }
  return fx;
}

describe("map objectives setup", () => {
  it("is off by default: the classic start has no Uplinks or drops", () => {
    for (const m of MAPS) {
      const w = createMapWorld(m.id);
      expect(w.objectives.uplinks).toHaveLength(0);
      expect(w.objectives.dropSites).toHaveLength(0);
      expect(nextDropTick(w)).toBeNull();
    }
  });

  it("every map gets 2–3 mirrored Uplinks on ground units can stand on (an island map, more, for infantry)", () => {
    for (const m of MAPS) {
      const w = createMapWorld(m.id, { objectives: true });
      const ls = w.objectives.uplinks;
      expect(ls.length).toBeGreaterThanOrEqual(2);
      expect(ls.length).toBeLessThanOrEqual(m.islands ? 9 : 3);
      for (const l of ls) {
        const mm = mirrorPoint(w, l.x, l.y);
        expect(ls.some((o) => Math.hypot(o.x - mm.x, o.y - mm.y) < 1e-9)).toBe(true);
        expect(l.owner).toBeNull();
        expect(l.progress).toBe(0);
        // a tank can stand in the zone (Riverlands' centre Uplink sits on the bridge);
        // on an island, a squad
        const open = [...Array(25).keys()].filter((i) => {
          const tx = Math.floor(l.x) - 2 + (i % 5);
          const ty = Math.floor(l.y) - 2 + Math.floor(i / 5);
          return l.infantryOnly ? passable(w, tx, ty, "foot") : canStand(w, tx, ty);
        }).length;
        expect(open).toBeGreaterThan(8);
      }
      expect(w.objectives.dropSites.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the classic start's units and buildings untouched", () => {
    for (const m of MAPS) {
      const a = createMapWorld(m.id, { seed: 9, openers: { blue: "blitz", red: "airwing" } });
      const b = createMapWorld(m.id, { seed: 9, openers: { blue: "blitz", red: "airwing" }, objectives: true });
      const pick = (w: World) => ({
        u: [...w.units.values()].map((u) => [u.id, u.kind, u.faction, u.x, u.y]),
        b: [...w.buildings.values()].map((x) => [x.id, x.kind, x.faction, x.tx, x.ty]),
        s: [w.factions.blue.scrap, w.factions.red.scrap]
      });
      expect(pick(b)).toEqual(pick(a));
    }
  });

  it("no building may be placed on an Uplink platform", () => {
    const w = uplinkWorld();
    spawnBuilding(w, "hq", "blue", 15, 18);
    expect(canPlaceBuilding(w, "blue", "turret", 19, 19)).toBe(false);
    expect(canPlaceBuilding(w, "blue", "turret", 20, 20)).toBe(false);
    expect(canPlaceBuilding(w, "blue", "turret", 19, 23)).toBe(true);
  });
});

function canStand(w: World, tx: number, ty: number): boolean {
  const t = w.terrain[ty * w.width + tx];
  return t !== undefined && t !== 1 && t !== 3; // not rock, not deep water
}

describe("Uplink capture", () => {
  it("four units take a neutral Uplink in about 7 seconds", () => {
    const w = uplinkWorld();
    const l = w.objectives.uplinks[0]!;
    squad(w, "stinger", "blue", 4);
    const { ticks, fx } = until(w, () => l.owner === "blue");
    expect(ticks).toBeGreaterThanOrEqual(65);
    expect(ticks).toBeLessThanOrEqual(80);
    expect(l.progress).toBe(100);
    expect(fx.filter((e) => e.type === "uplinkContest")).toHaveLength(1);
    const flip = fx.find((e) => e.type === "uplinkFlip");
    expect(flip).toMatchObject({ id: l.id, owner: "blue", prev: null, by: "blue" });
    expect(w.objectives.stats.blue.captures).toBe(1);
  });

  it("the rate scales with presence up to a cap; aircraft count half, harvesters not at all", () => {
    const rate = (kinds: [UnitKind, number][]) => {
      const w = uplinkWorld();
      for (const [k, n] of kinds) squad(w, k, "red", n);
      run(w, TICK_RATE);
      return -w.objectives.uplinks[0]!.progress; // per second, toward red
    };
    expect(rate([["stinger", 1]])).toBeCloseTo(U.perUnit, 5);
    expect(rate([["stinger", 2]])).toBeCloseTo(2 * U.perUnit, 5);
    expect(rate([["stinger", 6]])).toBeCloseTo(U.maxRate, 5);
    expect(rate([["wasp", 2]])).toBeCloseTo(2 * U.airWeight * U.perUnit, 5);
    expect(Math.abs(rate([["harvester", 3]]))).toBe(0);
  });

  it("units outside the zone don't count", () => {
    const w = uplinkWorld();
    spawnUnit(w, "stinger", "blue", 20 + U.radius + 0.3, 20);
    run(w, 30);
    expect(w.objectives.uplinks[0]!.progress).toBe(0);
  });

  it("a contested Uplink freezes", () => {
    const w = uplinkWorld();
    const l = w.objectives.uplinks[0]!;
    squad(w, "stinger", "blue", 2);
    run(w, 20);
    const before = l.progress;
    expect(before).toBeGreaterThan(0);
    // an (unarmed) enemy scout drifts in: nobody gains
    const r = spawnUnit(w, "scout", "red", 21.5, 20);
    run(w, 30);
    expect(w.units.has(r.id)).toBe(true);
    expect(l.contested).toBe(true);
    expect(l.pushing).toBeNull();
    expect(l.progress).toBe(before);
  });

  it("an enemy must neutralise an owned Uplink before taking it; the owner loses it at neutral", () => {
    const w = uplinkWorld();
    const l = w.objectives.uplinks[0]!;
    l.owner = "blue";
    l.progress = 100;
    squad(w, "flak-crawler", "red", 4); // flak can't hit ground: no fight, just a push
    const lost = until(w, () => l.owner === null);
    expect(lost.ticks).toBeGreaterThan(65);
    expect(lost.ticks).toBeLessThanOrEqual(80);
    expect(lost.fx.find((e) => e.type === "uplinkFlip")).toMatchObject({ owner: null, prev: "blue", by: "red" });
    expect(lost.fx.find((e) => e.type === "uplinkContest")).toMatchObject({ faction: "red", owner: "blue" });
    const taken = until(w, () => l.owner === "red");
    expect(taken.ticks).toBeGreaterThan(65);
    expect(l.progress).toBe(-100);
    expect(w.objectives.stats.red.captures).toBe(1);
  });

  it("abandoned bars drift back: to the owner's full bar, or to neutral", () => {
    const w = uplinkWorld();
    const l = w.objectives.uplinks[0]!;
    l.owner = "blue";
    l.progress = 40;
    run(w, 10 * TICK_RATE);
    expect(l.progress).toBeCloseTo(40 + 10 * U.settle, 5);
    expect(l.owner).toBe("blue");
    const w2 = uplinkWorld();
    const n = w2.objectives.uplinks[0]!;
    n.progress = -30;
    run(w2, 5 * TICK_RATE);
    expect(n.progress).toBeCloseTo(-30 + 5 * U.settle, 5);
    expect(n.owner).toBeNull();
  });

  it("a held Uplink pays scrap and charge every second, scaled by income", () => {
    const w = uplinkWorld();
    const l = w.objectives.uplinks[0]!;
    l.owner = "red";
    l.progress = -100;
    w.factions.red.incomeMult = 1.3;
    const s0 = w.factions.red.scrap;
    const b0 = w.factions.blue.scrap;
    run(w, 10 * TICK_RATE);
    expect(w.factions.red.scrap - s0).toBeCloseTo(10 * U.income * 1.3, 5);
    expect(w.factions.blue.scrap).toBe(b0);
    expect(w.objectives.stats.red.uplinkScrap).toBeCloseTo(10 * U.income * 1.3, 5);
    // passive meter fill plus the Uplink's
    expect(w.powers.meter.red - w.powers.meter.blue).toBeCloseTo(10 * U.charge, 3);
  });

  it("the owner sees around its Uplink", () => {
    const w = uplinkWorld();
    tickFog(w);
    expect(isVisible(w, "blue", 20, 20)).toBe(false);
    w.objectives.uplinks[0]!.owner = "blue";
    tickFog(w);
    expect(isVisible(w, "blue", 20, 20)).toBe(true);
    expect(isVisible(w, "blue", 20 + Math.floor(U.sight) - 1, 20)).toBe(true);
    expect(isVisible(w, "red", 20, 20)).toBe(false);
  });

  it("Uplinks are no target: armed units ignore them", () => {
    const w = uplinkWorld();
    w.objectives.uplinks[0]!.owner = "red";
    const s = spawnUnit(w, "stinger", "blue", 18, 20);
    const fx = run(w, 30);
    expect(fx.some((e) => e.type === "shot" && e.sourceId === s.id)).toBe(false);
  });
});

describe("supply drops", () => {
  const dropWorld = (seed = 7) => createMapWorld("riverlands", { seed, objectives: true });

  it("are announced 10 s ahead, first landing at 1:30 and then every 75 s", () => {
    expect(dropLandTick(0)).toBe(D.first * TICK_RATE);
    expect(dropLandTick(1) - dropLandTick(0)).toBe(D.every * TICK_RATE);
    expect(dropLandTick(0) - dropAnnounceTick(0)).toBe(D.warning * TICK_RATE);
    const w = dropWorld();
    expect(nextDropTick(w)).toBe(dropAnnounceTick(0));
    const fx = run(w, dropAnnounceTick(0) + 1);
    const inc = fx.filter((e) => e.type === "crateIncoming");
    expect(inc).toHaveLength(2);
    expect(w.objectives.crates.every((c) => c.announcedTick === dropAnnounceTick(0))).toBe(true);
    expect(inc.every((e) => e.type === "crateIncoming" && e.landTick === dropLandTick(0))).toBe(true);
    expect(nextDropTick(w)).toBe(dropAnnounceTick(1));
  });

  it("drop pairs are mirror images holding the same reward (fair to both sides)", () => {
    for (const m of MAPS)
      for (const seed of [1, 2, 3]) {
        const w = createMapWorld(m.id, { seed, objectives: true });
        run(w, dropAnnounceTick(0) + 1);
        const [a, b] = w.objectives.crates;
        expect(a && b).toBeTruthy();
        const mm = mirrorPoint(w, a!.x, a!.y);
        expect(b!.x).toBeCloseTo(mm.x, 9);
        expect(b!.y).toBeCloseTo(mm.y, 9);
        expect(a!.reward).toBe(b!.reward);
      }
  });

  it("sites and rewards are seeded: same seed, same drops; never the same site twice running", () => {
    const sites = (seed: number) => {
      const w = dropWorld(seed);
      const out: number[] = [];
      let last = -1;
      for (let k = 0; k < 12; k++) out.push((last = pickDropSite(w, k, last)));
      return out;
    };
    expect(sites(5)).toEqual(sites(5));
    expect(sites(5)).not.toEqual(sites(6));
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = sites(seed);
      for (let i = 1; i < s.length; i++) expect(s[i]).not.toBe(s[i - 1]);
    }
    const rewards = (seed: number) => [...Array(40).keys()].map((k) => rollReward(dropWorld(seed), k));
    expect(rewards(3)).toEqual(rewards(3));
    // the weights show through over many drops
    const all = [1, 2, 3, 4, 5].flatMap(rewards);
    for (const r of CRATE_REWARDS) expect(all.filter((x) => x === r).length).toBeGreaterThan(0);
    expect(all.filter((x) => x === "scrap").length).toBeGreaterThan(all.filter((x) => x === "unit").length);
  });

  it("a crate can't be claimed before it lands; then the nearest non-harvester unit in reach takes it", () => {
    const w = dropWorld();
    run(w, dropAnnounceTick(0) + 1);
    const [a, b] = w.objectives.crates as [Crate, Crate];
    // a harvester sits right on crate a; a blue Stinger close by, a red one a bit nearer still
    spawnUnit(w, "harvester", "blue", a.x, a.y);
    spawnUnit(w, "stinger", "blue", a.x + 0.6, a.y);
    const near = spawnUnit(w, "stinger", "red", a.x - 0.4, a.y);
    // a unit on crate b well before it lands
    const early = spawnUnit(w, "wasp", "blue", b.x, b.y);
    const before = run(w, a.landTick - w.tick - 1);
    expect(before.some((e) => e.type === "crateClaimed")).toBe(false);
    const fx = run(w, 2);
    expect(fx.filter((e) => e.type === "crateLanded")).toHaveLength(2);
    const claims = fx.filter((e): e is Extract<FxEvent, { type: "crateClaimed" }> => e.type === "crateClaimed");
    expect(claims.find((e) => e.id === a.id)).toMatchObject({ faction: "red", collectorId: near.id });
    expect(claims.find((e) => e.id === b.id)).toMatchObject({ faction: "blue", collectorId: early.id });
    expect(w.objectives.crates).toHaveLength(0);
    expect(w.objectives.stats.red.crates).toBe(1);
  });

  it("unclaimed crates burn out after 45 s", () => {
    const w = dropWorld();
    run(w, dropAnnounceTick(0) + 1);
    const ids = w.objectives.crates.map((c) => c.id);
    const fx = run(w, dropLandTick(0) + D.ttl * TICK_RATE - w.tick - 1);
    expect(fx.some((e) => e.type === "crateExpired")).toBe(false);
    expect(w.objectives.crates.map((c) => c.id)).toEqual(ids);
    const fx2 = run(w, 2);
    expect(fx2.filter((e) => e.type === "crateExpired").map((e) => (e as { id: number }).id).sort()).toEqual(ids.sort());
    expect(w.objectives.crates.filter((c) => ids.includes(c.id))).toHaveLength(0);
  });
});

describe("crate rewards", () => {
  /** A landed crate with a given reward, at (20, 20) in a fresh world. */
  function crateWorld(reward: CrateReward): { w: World; c: Crate } {
    const w = createWorld(40, 40);
    const c: Crate = { id: w.nextId++, x: 20, y: 20, reward, drop: 0, announcedTick: 0, landTick: 0, expireTick: 1e9 };
    w.objectives.crates.push(c);
    return { w, c };
  }
  const claimed = (w: World) => w.fx.find((e) => e.type === "crateClaimed") as Extract<FxEvent, { type: "crateClaimed" }>;

  it("scrap: the drop's scrap × the claimer's income multiplier", () => {
    const { w, c } = crateWorld("scrap");
    w.factions.blue.incomeMult = 0.75;
    const s0 = w.factions.blue.scrap;
    claimCrate(w, c, "blue", 1);
    expect(w.factions.blue.scrap - s0).toBeCloseTo(D.scrap * 0.75, 6);
    expect(claimed(w)).toMatchObject({ reward: "scrap", scrap: D.scrap * 0.75 });
  });

  it("veterans: +1 rank to the claimer and allies within 3 tiles, with the XP that rank takes", () => {
    const { w, c } = crateWorld("veterans");
    const claimer = spawnUnit(w, "stinger", "blue", 20, 20);
    const ally = spawnUnit(w, "mastodon", "blue", 22, 20);
    const elite = spawnUnit(w, "lancer", "blue", 19, 21);
    elite.rank = 3;
    const far = spawnUnit(w, "wasp", "blue", 20 + D.veteranRadius + 0.5, 20);
    const foe = spawnUnit(w, "stinger", "red", 20.5, 20);
    const harv = spawnUnit(w, "harvester", "blue", 20, 21);
    claimCrate(w, c, "blue", claimer.id);
    expect(claimer.rank).toBe(1);
    expect(claimer.xp).toBe(COMBAT.rankXp[0]! * UNITS.stinger.cost);
    expect(ally.rank).toBe(1);
    expect(elite.rank).toBe(3);
    expect(far.rank).toBe(0);
    expect(foe.rank).toBe(0);
    expect(harv.rank).toBe(0);
    expect(claimed(w).unitIds.sort()).toEqual([claimer.id, ally.id].sort());
    expect(w.fx.filter((e) => e.type === "rankUp")).toHaveLength(2);
  });

  it("repair: own units within 4 tiles heal half their max HP", () => {
    const { w, c } = crateWorld("repair");
    const a = spawnUnit(w, "mastodon", "blue", 21, 20);
    a.hp = 100;
    const b = spawnUnit(w, "stinger", "blue", 20, 22);
    b.hp = UNITS.stinger.hp - 20;
    const far = spawnUnit(w, "stinger", "blue", 25, 20);
    far.hp = 50;
    claimCrate(w, c, "blue", a.id);
    expect(a.hp).toBeCloseTo(100 + UNITS.mastodon.hp * D.repairShare, 6);
    expect(b.hp).toBe(UNITS.stinger.hp);
    expect(far.hp).toBe(50);
    expect(claimed(w).scrap).toBe(0);
  });

  it("charge: +40 on the Command meter; what doesn't fit becomes scrap", () => {
    const { w, c } = crateWorld("charge");
    w.powers.meter.red = 10;
    claimCrate(w, c, "red", 1);
    expect(w.powers.meter.red).toBe(10 + D.charge);
    expect(claimed(w).scrap).toBe(0);
    const { w: w2, c: c2 } = crateWorld("charge");
    w2.powers.meter.red = POWERS.meterMax - 10;
    const s0 = w2.factions.red.scrap;
    claimCrate(w2, c2, "red", 1);
    expect(w2.powers.meter.red).toBe(POWERS.meterMax);
    expect(w2.factions.red.scrap - s0).toBe(Math.round(D.fallbackScrap * (1 - 10 / D.charge)));
  });

  it("a kit with nothing to do (no one hurt) is stripped for scrap", () => {
    const { w, c } = crateWorld("repair");
    const u = spawnUnit(w, "stinger", "blue", 20, 20);
    const s0 = w.factions.blue.scrap;
    claimCrate(w, c, "blue", u.id);
    expect(w.factions.blue.scrap - s0).toBe(D.fallbackScrap);
    expect(claimed(w)).toMatchObject({ amount: 0, scrap: D.fallbackScrap });
  });

  it("the rare drop: a free veteran Lancer steps out of the crate", () => {
    const { w, c } = crateWorld("unit");
    const before = w.units.size;
    claimCrate(w, c, "red", 1);
    expect(w.units.size).toBe(before + 1);
    const u = w.units.get(claimed(w).unitIds[0]!)!;
    expect(u).toMatchObject({ kind: D.unit, faction: "red", rank: D.unitRank, x: 20, y: 20 });
  });
});

describe("AI and objectives", () => {
  function match(map: string, a: StrategyName, b: StrategyName, mins: number, seed = 3): World {
    const w = createMapWorld(map, {
      seed, objectives: true, openers: { blue: pickAiOpener(a, seed, "blue"), red: pickAiOpener(b, seed, "red") }
    });
    const sa = createAiState(a, "normal", 11);
    const sb = createAiState(b, "normal", 12);
    for (let t = 0; t < mins * 60 * TICK_RATE && !w.winner; t++) step(w, [...tickAi(w, "blue", sa), ...tickAi(w, "red", sb)]);
    return w;
  }

  it("both commanders take Uplinks and claim supply crates", () => {
    let caps = 0;
    let crates = 0;
    const sides = { blue: 0, red: 0 };
    for (const map of ["riverlands", "frostbite", "proving-grounds"]) {
      const w = match(map, "balanced", "balanced", 5);
      for (const f of ["blue", "red"] as const) {
        caps += w.objectives.stats[f].captures;
        crates += w.objectives.stats[f].crates;
        sides[f] += w.objectives.stats[f].captures;
      }
    }
    expect(caps).toBeGreaterThanOrEqual(4);
    expect(sides.blue).toBeGreaterThan(0);
    expect(sides.red).toBeGreaterThan(0);
    expect(crates).toBeGreaterThanOrEqual(4);
  });

  it("parks a unit on an Uplink it holds and keeps it there", () => {
    const w = createMapWorld("proving-grounds", { seed: 4, objectives: true, openers: { red: "blitz" } });
    const s = createAiState("balanced", "normal", 5);
    const l = w.objectives.uplinks.find((x) => Math.hypot(x.x - 12.5, x.y - 12.5) < 0.1)!;
    l.owner = "red";
    l.progress = -100;
    const stingers = [...w.units.values()].filter((u) => u.faction === "red" && u.kind === "stinger");
    // one of them standing next to the Uplink already
    stingers[0]!.x = l.x + 4;
    stingers[0]!.y = l.y;
    w.tick = 30 * TICK_RATE;
    const used = new Set<number>();
    const cmds = planObjectives(w, "red", s, {
      mode: "buildup", hqC: { x: 42.5, y: 6.5 }, enemyHqPos: { x: 5.5, y: 41.5 }, guardPoint: { x: 35, y: 11 },
      guardNeed: 0, army: stingers, used, threatened: false
    });
    expect(cmds[0]).toMatchObject({ type: "attackMove", unitIds: [stingers[0]!.id], x: l.x, y: l.y });
    stingers[0]!.x = l.x + 1;
    stingers[0]!.order = { type: "idle" };
    expect(objectiveHolds(w, "red", s)).toContain(stingers[0]!.id);
  });

  it("Easy takes neutral Uplinks but never comes for yours; Normal does", () => {
    const plan = (difficulty: "easy" | "normal") => {
      const w = createMapWorld("proving-grounds", { seed: 4, objectives: true, openers: { red: "blitz" } });
      for (const l of w.objectives.uplinks) {
        l.owner = "blue";
        l.progress = 100;
      }
      const s = createAiState("balanced", difficulty, 5);
      const army = [...w.units.values()].filter((u) => u.faction === "red" && u.kind === "stinger");
      w.tick = 60 * TICK_RATE;
      return planObjectives(w, "red", s, {
        mode: "buildup", hqC: { x: 42.5, y: 6.5 }, enemyHqPos: { x: 5.5, y: 41.5 }, guardPoint: { x: 30, y: 20 },
        guardNeed: 0, army, used: new Set(), threatened: false
      });
    };
    expect(plan("easy")).toHaveLength(0);
    const normal = plan("normal");
    expect(normal).toHaveLength(1);
    expect(normal[0]).toMatchObject({ type: "attackMove" });
    expect((normal[0] as { unitIds: number[] }).unitIds).toHaveLength(3);
  });

  it("sends robot infantry (double capture weight) to take an Uplink, and parks a Trooper Squad on one it holds", () => {
    const w = createMapWorld("proving-grounds", { seed: 4, objectives: true });
    const s = createAiState("balanced", "normal", 5);
    // (the relay red goes for first: nearer its own HQ)
    const l = w.objectives.uplinks.find((x) => Math.hypot(x.x - 35.5, x.y - 35.5) < 0.1)!;
    w.tick = 60 * TICK_RATE;
    // a Stinger a little nearer than four Trooper Squads
    const tank = spawnUnit(w, "stinger", "red", l.x + 8, l.y);
    const squads = [0, 1, 2, 3].map((i) => spawnUnit(w, "trooper", "red", l.x + 11, l.y - 1.5 + i));
    const ctx = {
      mode: "buildup" as const, hqC: { x: 42.5, y: 6.5 }, enemyHqPos: { x: 5.5, y: 41.5 }, guardPoint: { x: 35, y: 11 },
      guardNeed: 0, army: [tank, ...squads], used: new Set<number>(), threatened: false
    };
    const run = planObjectives(w, "red", s, ctx).find((c) => c.type === "attackMove" && c.x === l.x && c.y === l.y);
    expect(run).toBeDefined();
    expect([...(run as { unitIds: number[] }).unitIds].sort()).toEqual(squads.map((u) => u.id).sort());
    // held: the cheapest unit near it stands guard (a squad, though the Stinger is nearer)
    const s2 = createAiState("balanced", "normal", 5);
    l.owner = "red";
    l.progress = -100;
    for (const u of [tank, ...squads]) u.order = { type: "idle" };
    tank.x = l.x + 3;
    squads[0]!.x = l.x + 4;
    squads[0]!.y = l.y;
    const garrison = planObjectives(w, "red", s2, { ...ctx, used: new Set<number>() })[0];
    expect(garrison).toMatchObject({ type: "attackMove", unitIds: [squads[0]!.id], x: l.x, y: l.y });
  });

  it("is deterministic: the same match replays to the same objective results", () => {
    const a = match("dune-sea", "rush", "airswarm", 4, 8);
    const b = match("dune-sea", "rush", "airswarm", 4, 8);
    expect(a.objectives.stats).toEqual(b.objectives.stats);
    expect(a.objectives.uplinks.map((l) => [l.owner, l.progress])).toEqual(b.objectives.uplinks.map((l) => [l.owner, l.progress]));
    expect(a.tick).toBe(b.tick);
  });
});

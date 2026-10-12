import { describe, expect, it } from "vitest";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { BUILDINGS, TICK_RATE, UNITS } from "../src/sim/balance";
import { tickFog } from "../src/sim/fog";
import { createSkirmishWorld } from "../src/sim/map";
import { createMapWorld } from "../src/sim/maps";
import { applyOpener } from "../src/sim/openers";
import { tickSalvage } from "../src/sim/salvage";
import { step } from "../src/sim/sim";
import type { Command, FxEvent, World } from "../src/sim/types";
import {
  buildingCenter,
  createWorld,
  dist,
  groundPassable,
  hqOf,
  removeBuilding,
  spawnBuilding,
  spawnUnit
} from "../src/sim/world";

/**
 * Regressions for defects found by the adversarial review of the fun
 * overhaul (ids from that review in each test name).
 */

describe("AI assault waves (sim-1)", () => {
  it("a remembered building removed out of sight doesn't freeze a staged wave", () => {
    const w = createSkirmishWorld();
    // a low assault bar so eight Stingers are a launchable wave
    const s = createAiState("rush", "normal", 1, { assaultValue: 800 });
    const hq = hqOf(w, "red")!;
    const hqC = buildingCenter(hq);
    // the staging point: 9 tiles from the HQ toward the (unknown) enemy home
    const home = { x: w.width - hqC.x, y: w.height - hqC.y };
    const len = dist(hqC.x, hqC.y, home.x, home.y);
    const stage = { x: hqC.x + ((home.x - hqC.x) / len) * 9, y: hqC.y + ((home.y - hqC.y) / len) * 9 };
    const wave = Array.from({ length: 8 }, (_, i) =>
      spawnUnit(w, "stinger", "red", stage.x + (i % 3) - 1, stage.y + Math.floor(i / 3) - 1)
    );
    // red once scouted a blue Fab Plant; it is sold (or shelled) while nothing red can see it
    const fab = spawnBuilding(w, "fab-plant", "blue", 14, 12);
    w.fog.red.known.set(fab.id, { id: fab.id, kind: fab.kind, faction: fab.faction, tx: fab.tx, ty: fab.ty });
    removeBuilding(w, fab);
    const ghost = { x: 14 + BUILDINGS["fab-plant"].size / 2, y: 12 + BUILDINGS["fab-plant"].size / 2 };

    const deadAttacks: Command[] = [];
    let closest = Infinity;
    for (let i = 0; i < 40 * TICK_RATE; i++) {
      const cmds = tickAi(w, "red", s);
      deadAttacks.push(...cmds.filter((c) => c.type === "attack" && c.targetId === fab.id));
      step(w, cmds);
      const alive = wave.filter((u) => w.units.has(u.id));
      const mean = alive.reduce((d, u) => d + dist(u.x, u.y, ghost.x, ghost.y), 0) / Math.max(1, alive.length);
      closest = Math.min(closest, mean);
    }
    expect(s.mode).toBe("assault");
    expect(deadAttacks).toEqual([]); // no orders on a dead id (those idle the wave on the spot)
    expect(closest).toBeLessThan(5); // the wave marched on the remembered spot
    expect(w.fog.red.known.has(fab.id)).toBe(false); // ...saw it was gone, and forgot it
  }, 30000);
});

describe("Last Stand waves have no commander (sim-2 / render-2 / integration-1)", () => {
  it("a red AI ticked beside the waves (as the game used to) issues nothing, not even dodges", () => {
    const w = createMapWorld("riverlands", { seed: 11, survival: { difficulty: "normal" } });
    expect(hqOf(w, "red")).toBeNull();
    const hq = buildingCenter(hqOf(w, "blue")!);
    // a wave clump in front of the defender's HQ, and a Barrage on it
    const at = { x: hq.x + 5, y: hq.y };
    const wave = [0, 1, 2].map((i) => spawnUnit(w, "stinger", "red", at.x + (i - 1) * 0.6, at.y));
    tickFog(w);
    w.powers.meter.blue = 100;
    const phantom = createAiState("balanced", "hard");
    const red: Command[] = [];
    for (let i = 0; i < 4 * TICK_RATE; i++) {
      const cmds = tickAi(w, "red", phantom);
      red.push(...cmds);
      step(w, i === 0 ? [{ type: "calldown", faction: "blue", power: "barrage", x: at.x, y: at.y }, ...cmds] : cmds);
      if (i === 0) expect(w.powers.active.length).toBe(1);
    }
    expect(red).toEqual([]);
    for (const u of wave) if (w.units.has(u.id)) expect(u.order.type).not.toBe("move");
  });
});

describe("kill credit on a mutual kill (sim-3)", () => {
  it("two units that kill each other on the same tick both get the kill, whatever the id order", () => {
    for (const blueFirst of [true, false]) {
      const w = createWorld(24, 24);
      const [a, b] = blueFirst
        ? [spawnUnit(w, "stinger", "blue", 10, 10), spawnUnit(w, "stinger", "red", 12, 10)]
        : [spawnUnit(w, "stinger", "red", 12, 10), spawnUnit(w, "stinger", "blue", 10, 10)];
      a.hp = b.hp = 5;
      const deaths: Extract<FxEvent, { type: "death" }>[] = [];
      for (let i = 0; i < 20 && deaths.length < 2; i++) {
        step(w, []);
        for (const ev of w.fx) if (ev.type === "death") deaths.push(ev);
      }
      expect(deaths.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
      for (const [victim, killer] of [[a, b], [b, a]] as const) {
        const d = deaths.find((e) => e.id === victim.id)!;
        expect(d.killerId).toBe(killer.id);
        expect(d.killerKind).toBe("stinger");
        expect(d.kills).toBe(1); // its own last kill counts on its death record
        expect(victim.xp).toBe(UNITS.stinger.cost);
      }
      expect(w.factions.blue.stats.unitsKilled).toBe(1);
      expect(w.factions.red.stats.unitsKilled).toBe(1);
    }
  });
});

describe("Veterans mutator and openers (sim-4 / integration-2)", () => {
  it("opener armies roll out at the mutator's starting rank like everything else", () => {
    const w = createMapWorld("riverlands", { seed: 3, mutators: ["veterans"] });
    const blitz = applyOpener(w, "blue", "blitz");
    const air = applyOpener(w, "red", "airwing");
    const army = [...blitz.unitIds, ...air.unitIds].map((id) => w.units.get(id)!).filter((u) => UNITS[u.kind].dps > 0);
    expect(army.map((u) => u.kind).sort()).toEqual(["stinger", "stinger", "stinger", "wasp", "wasp", "wasp"]);
    for (const u of army) expect(u.rank).toBe(1);
    // ...and without the mutator they are fresh recruits
    const plain = createMapWorld("riverlands", { seed: 3 });
    for (const id of applyOpener(plain, "blue", "blitz").unitIds) expect(plain.units.get(id)!.rank).toBe(0);
  });
});

describe("Last Stand salvage (sim-5)", () => {
  /** A cooled blue wreck on open ground in the middle of the map, with a red unit parked on it. */
  function wreckUnderRed(w: World) {
    let at = { x: w.width / 2, y: w.height / 2 };
    for (let r = 0; r < 10 && !groundPassable(w, Math.floor(at.x), Math.floor(at.y)); r++) at = { x: at.x + 1, y: at.y + 1 };
    const tx = Math.floor(at.x);
    const ty = Math.floor(at.y);
    expect(groundPassable(w, tx, ty)).toBe(true);
    const red = spawnUnit(w, "stinger", "red", tx + 0.5, ty + 0.5);
    w.wrecks.push({ id: 1e6, kind: "mastodon", faction: "blue", x: tx + 0.5, y: ty + 0.5, facing: 0, value: 140, ttl: 600, hot: 0 });
    return red;
  }

  it("the waves drive over wrecks; the defender collects them", () => {
    const w = createMapWorld("riverlands", { seed: 5, survival: { difficulty: "normal" } });
    const red = wreckUnderRed(w);
    tickSalvage(w);
    expect(w.wrecks).toHaveLength(1);
    expect(w.factions.red.stats.scrapSalvaged).toBe(0);
    spawnUnit(w, "stinger", "blue", red.x + 0.3, red.y);
    const before = w.factions.blue.stats.scrapSalvaged;
    tickSalvage(w);
    expect(w.wrecks).toHaveLength(0);
    expect(w.factions.blue.stats.scrapSalvaged).toBeGreaterThan(before);
  });

  it("(in a skirmish both sides still salvage)", () => {
    const w = createMapWorld("riverlands", { seed: 5 });
    wreckUnderRed(w);
    tickSalvage(w);
    expect(w.wrecks).toHaveLength(0);
    expect(w.factions.red.stats.scrapSalvaged).toBeGreaterThan(0);
  });
});

describe("AI veterans and the dodge reflex (merge-veteran-retreat-overrides-dodge)", () => {
  it("a wounded veteran dodging a reticle isn't ordered home through it", () => {
    const w = createWorld(40, 40);
    spawnBuilding(w, "hq", "blue", 2, 2);
    const hq = buildingCenter(spawnBuilding(w, "hq", "red", 35, 35));
    w.powers.meter.blue = 100;
    // a rank-2 Mastodon at 30% HP, 9 tiles out from its HQ; a Barrage lands just on the home side of it
    const t = spawnUnit(w, "mastodon", "red", hq.x - 6.4, hq.y - 6.4);
    t.rank = 2;
    t.hp = UNITS.mastodon.hp * 0.3;
    const start = t.hp;
    const at = { x: t.x + 0.85, y: t.y + 0.85 };
    tickFog(w);
    w.fog.blue.vis.fill(2);
    const s = createAiState("balanced", "normal", 1);
    const orders: { tick: number; x: number; y: number }[] = [];
    let lastShell = 0;
    for (let i = 0; i < 6 * TICK_RATE; i++) {
      const cmds = tickAi(w, "red", s);
      for (const c of cmds) if (c.type === "move" && c.unitIds.includes(t.id)) orders.push({ tick: w.tick, x: c.x, y: c.y });
      step(w, i === 0 ? [{ type: "calldown", faction: "blue", power: "barrage", x: at.x, y: at.y }, ...cmds] : cmds);
      if (i === 0) {
        const c = w.powers.active[0]!;
        lastShell = c.shells.length > 0 ? c.shells[c.shells.length - 1]!.tick : c.landTick;
      }
    }
    // the reflex sends it out of the reticle (away from home)...
    const dodge = orders.findIndex((o) => dist(o.x, o.y, hq.x, hq.y) > 9);
    expect(dodge).toBeGreaterThanOrEqual(0);
    // ...nothing turns it round until the last shell has landed...
    expect(orders.slice(dodge + 1).filter((o) => o.tick <= lastShell)).toEqual([]);
    expect(t.hp).toBe(start);
    // ...and then it resumes its retreat
    expect(orders.slice(dodge + 1).some((o) => dist(o.x, o.y, hq.x, hq.y) < 4)).toBe(true);
  });
});

describe("a decided world stays quiet (render-1)", () => {
  it("stepping past the winning tick hands out no stale events and no time", () => {
    const w = createSkirmishWorld();
    hqOf(w, "red")!.hp = 0;
    step(w, []);
    expect(w.winner).toBe("blue");
    expect(w.fx.some((e) => e.type === "death" && e.buildingKind === "hq")).toBe(true);
    const tick = w.tick;
    // (the game loop stops on a winner too; any other caller must not replay the deciding tick)
    step(w, []);
    expect(w.fx).toEqual([]);
    expect(w.tick).toBe(tick);
  });
});

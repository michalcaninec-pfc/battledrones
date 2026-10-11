import { describe, expect, it } from "vitest";
import { BUILDINGS, COMBAT, TICK_RATE, UNITS } from "../src/sim/balance";
import { areaBlast, findTarget } from "../src/sim/combat";
import { step } from "../src/sim/sim";
import { Terrain, type World } from "../src/sim/types";
import { buildingCenter, createWorld, setTerrain, spawnBuilding, spawnUnit } from "../src/sim/world";

const runTicks = (w: ReturnType<typeof createWorld>, n: number) => {
  for (let i = 0; i < n; i++) step(w, []);
};

describe("domain targeting rules", () => {
  it("a stinger engages ground but ignores air", () => {
    const w = createWorld(24, 24);
    const stinger = spawnUnit(w, "stinger", "blue", 5.5, 5.5);
    const wasp = spawnUnit(w, "wasp", "red", 6.5, 5.5);
    void stinger;
    const waspHp = wasp.hp;
    runTicks(w, 10);
    expect(wasp.hp).toBe(waspHp); // stinger can't touch air
  });

  it("a flak crawler shreds air but cannot hit ground", () => {
    const w = createWorld(24, 24);
    spawnUnit(w, "flak-crawler", "blue", 5.5, 5.5);
    const wasp = spawnUnit(w, "wasp", "red", 7.5, 5.5);
    const stinger = spawnUnit(w, "stinger", "red", 6.5, 5.5);
    // wasp will fight back; give the crawler company to make it decisive
    const stingerHp = stinger.hp;
    runTicks(w, 30);
    expect(wasp.hp).toBeLessThan(UNITS.wasp.hp);
    expect(stinger.hp).toBe(stingerHp);
  });

  it("the counter-triangle resolves: flak beats wasp, wasp beats stinger", () => {
    // flak vs wasp
    let w = createWorld(24, 24);
    spawnUnit(w, "flak-crawler", "blue", 5.5, 5.5);
    let wasp = spawnUnit(w, "wasp", "red", 6.5, 5.5);
    step(w, [{ type: "attack", faction: "red", unitIds: [wasp.id], targetId: [...w.units.values()][0]!.id }]);
    runTicks(w, 30 * TICK_RATE);
    expect(w.units.has(wasp.id)).toBe(false); // wasp died (can't even shoot back... it can, flak is ground)
    // wasp vs stinger: wasp wins because stinger can't return fire
    w = createWorld(24, 24);
    const stinger = spawnUnit(w, "stinger", "blue", 5.5, 5.5);
    wasp = spawnUnit(w, "wasp", "red", 6.5, 5.5);
    step(w, [{ type: "attack", faction: "red", unitIds: [wasp.id], targetId: stinger.id }]);
    runTicks(w, 30 * TICK_RATE);
    expect(w.units.has(stinger.id)).toBe(false);
    expect(w.units.has(wasp.id)).toBe(true);
  });
});

describe("orders and auto-engagement", () => {
  it("an explicit attack order chases the target across the map", () => {
    const w = createWorld(32, 32);
    const stinger = spawnUnit(w, "stinger", "blue", 2.5, 2.5);
    const victim = spawnUnit(w, "harvester", "red", 20.5, 2.5);
    step(w, [{ type: "attack", faction: "blue", unitIds: [stinger.id], targetId: victim.id }]);
    runTicks(w, 20 * TICK_RATE);
    expect(w.units.has(victim.id)).toBe(false);
  });

  it("attack-move pauses to engage targets encountered on the way", () => {
    const w = createWorld(32, 32);
    const stinger = spawnUnit(w, "stinger", "blue", 2.5, 5.5);
    const bystander = spawnUnit(w, "harvester", "red", 10.5, 5.5);
    step(w, [{ type: "attackMove", faction: "blue", unitIds: [stinger.id], x: 25.5, y: 5.5 }]);
    runTicks(w, 20 * TICK_RATE);
    expect(w.units.has(bystander.id)).toBe(false); // killed in passing
    runTicks(w, 15 * TICK_RATE);
    expect(Math.hypot(stinger.x - 25.5, stinger.y - 5.5)).toBeLessThan(1); // then carried on
  });

  it("a plain move order does NOT stop to fight", () => {
    const w = createWorld(32, 32);
    const stinger = spawnUnit(w, "stinger", "blue", 2.5, 5.5);
    spawnUnit(w, "harvester", "red", 10.5, 8.5);
    step(w, [{ type: "move", faction: "blue", unitIds: [stinger.id], x: 25.5, y: 5.5 }]);
    runTicks(w, 16 * TICK_RATE);
    expect(Math.hypot(stinger.x - 25.5, stinger.y - 5.5)).toBeLessThan(1);
  });

  it("idle units defend themselves within acquire range without wandering", () => {
    const w = createWorld(24, 24);
    const guard = spawnUnit(w, "stinger", "blue", 5.5, 5.5);
    const intruder = spawnUnit(w, "harvester", "red", 8.5, 5.5);
    runTicks(w, 15 * TICK_RATE);
    expect(w.units.has(intruder.id)).toBe(false);
    expect(Math.hypot(guard.x - 5.5, guard.y - 5.5)).toBeLessThan(1.5); // held position
  });
});

describe("turrets", () => {
  it("hits both domains and emits shot fx", () => {
    const w = createWorld(24, 24);
    spawnBuilding(w, "turret", "blue", 5, 5);
    const wasp = spawnUnit(w, "wasp", "red", 7.5, 5.5);
    const stinger = spawnUnit(w, "stinger", "red", 4.5, 7.5);
    let sawShot = false;
    for (let i = 0; i < 20 * TICK_RATE; i++) {
      step(w, []);
      if (w.fx.some((f) => f.type === "shot")) sawShot = true;
    }
    expect(sawShot).toBe(true);
    expect(w.units.has(wasp.id) && w.units.has(stinger.id)).toBe(false);
  });
});

describe("attacking buildings", () => {
  it("units can raze a building and the HQ kill ends the match", () => {
    const w = createWorld(24, 24);
    spawnBuilding(w, "hq", "blue", 2, 2);
    const redHq = spawnBuilding(w, "hq", "red", 18, 18);
    const army = Array.from({ length: 4 }, (_, i) =>
      spawnUnit(w, "stinger", "blue", 14.5 + i, 16.5)
    );
    step(w, [
      { type: "attack", faction: "blue", unitIds: army.map((u) => u.id), targetId: redHq.id }
    ]);
    runTicks(w, 120 * TICK_RATE);
    expect(w.buildings.has(redHq.id)).toBe(false);
    expect(w.winner).toBe("blue");
  });

  it("a dead unit stops being targetable and leaves explosion fx", () => {
    const w = createWorld(24, 24);
    spawnUnit(w, "stinger", "blue", 5.5, 5.5);
    const victim = spawnUnit(w, "harvester", "red", 6.5, 5.5);
    let sawExplosion = false;
    for (let i = 0; i < 20 * TICK_RATE && !sawExplosion; i++) {
      step(w, []);
      if (w.fx.some((f) => f.type === "explosion")) sawExplosion = true;
    }
    expect(sawExplosion).toBe(true);
    expect(w.units.has(victim.id)).toBe(false);
  });
});

describe("Menders are shot first", () => {
  it("auto-targeting picks an enemy Mender over a nearer armed unit", () => {
    const w = createWorld(24, 24);
    const flak = spawnUnit(w, "flak-crawler", "blue", 5.5, 5.5);
    const wasp = spawnUnit(w, "wasp", "red", 7.5, 5.5);
    // a little farther off than the wasp, but within the healer bonus
    const mender = spawnUnit(w, "mender", "red", 5.5, 5.5 + 2 + COMBAT.healerPriority - 0.5);
    expect(findTarget(w, "blue", "air", flak.x, flak.y, 10)?.id).toBe(mender.id);
    mender.y = 5.5 + 2 + COMBAT.healerPriority + 0.5; // beyond it: the nearest threat comes first
    expect(findTarget(w, "blue", "air", flak.x, flak.y, 10)?.id).toBe(wasp.id);
  });

  it("drops the target it was shooting for a Mender that comes into range", () => {
    const w = createWorld(24, 24);
    const flak = spawnUnit(w, "flak-crawler", "blue", 5.5, 5.5);
    const wasp = spawnUnit(w, "wasp", "red", 6.5, 5.5);
    w.powers.stunned.set(wasp.id, 1e9); // (sits still)
    runTicks(w, 2);
    expect(flak.autoTargetId).toBe(wasp.id);
    // a Mender flies in to patch the wasp up, from the far side of it
    const mender = spawnUnit(w, "mender", "red", 5.5 + UNITS["flak-crawler"].range - 0.2, 5.5);
    w.powers.stunned.set(mender.id, 1e9);
    runTicks(w, 2);
    expect(flak.autoTargetId).toBe(mender.id);
    // and back to the wasp once the Mender is down
    w.units.delete(mender.id);
    runTicks(w, 2);
    expect(flak.autoTargetId).toBe(wasp.id);
  });

  it("an explicit attack order isn't overridden", () => {
    const w = createWorld(24, 24);
    const flak = spawnUnit(w, "flak-crawler", "blue", 5.5, 5.5);
    const wasp = spawnUnit(w, "wasp", "red", 6.5, 5.5);
    spawnUnit(w, "mender", "red", 5.5, 6.5);
    step(w, [{ type: "attack", faction: "blue", unitIds: [flak.id], targetId: wasp.id }]);
    runTicks(w, 3);
    expect(flak.order).toMatchObject({ type: "attack", targetId: wasp.id });
  });
});

describe("HQ defence", () => {
  // a 3×3 HQ centred on (15.5, 15.5); a Mortar's range (8) reaches its edge from 9.5 tiles off
  const setup = () => {
    const w = createWorld(40, 40);
    const hq = spawnBuilding(w, "hq", "blue", 14, 14);
    return { w, hq };
  };
  const shell = (w: World, hq: { id: number }, x: number, y: number) => {
    const m = spawnUnit(w, "mortar", "red", x, y);
    step(w, [{ type: "attack", faction: "red", unitIds: [m.id], targetId: hq.id }]);
    return m;
  };

  it("the nearest idle unit anywhere answers a Mortar shelling the HQ from full range", () => {
    const { w, hq } = setup();
    const guard = spawnUnit(w, "stinger", "blue", 15.5, 35.5); // 22 tiles from the Mortar
    const mortar = shell(w, hq, 24.8, 15.5);
    runTicks(w, 5 * TICK_RATE);
    expect(guard.order).toEqual({ type: "attack", targetId: mortar.id, defending: hq.id });
    runTicks(w, 30 * TICK_RATE);
    expect(w.units.has(mortar.id)).toBe(false);
    expect(hq.hp).toBeGreaterThan(BUILDINGS.hq.hp * 0.7);
  });

  it("sends one responder per attacker, the nearest to each", () => {
    const { w, hq } = setup();
    const east = spawnUnit(w, "stinger", "blue", 30.5, 30.5);
    const west = spawnUnit(w, "stinger", "blue", 2.5, 30.5);
    const spare = spawnUnit(w, "stinger", "blue", 15.5, 38.5);
    const a = shell(w, hq, 24.8, 15.5);
    const b = shell(w, hq, 6.2, 15.5);
    runTicks(w, 6 * TICK_RATE);
    expect(east.order).toEqual({ type: "attack", targetId: a.id, defending: hq.id });
    expect(west.order).toEqual({ type: "attack", targetId: b.id, defending: hq.id });
    expect(spare.order).toEqual({ type: "idle" });
  });

  it("never overrides an order, and skips units that can't hurt the attacker", () => {
    const { w, hq } = setup();
    const titan = spawnUnit(w, "titan", "red", 20.5, 15.5);
    step(w, [{ type: "attack", faction: "red", unitIds: [titan.id], targetId: hq.id }]);
    const busy = spawnUnit(w, "stinger", "blue", 24.5, 18.5);
    step(w, [{ type: "move", faction: "blue", unitIds: [busy.id], x: 36.5, y: 36.5 }]);
    const sniper = spawnUnit(w, "sniper", "blue", 27.5, 15.5); // auto-targets the Titan, to no effect
    const flak = spawnUnit(w, "flak-crawler", "blue", 20.5, 24.5); // can't shoot ground
    const guard = spawnUnit(w, "stinger", "blue", 20.5, 33.5);
    runTicks(w, 3 * TICK_RATE);
    expect(guard.order).toEqual({ type: "attack", targetId: titan.id, defending: hq.id });
    expect(busy.order.type).toBe("move");
    expect(sniper.order).toEqual({ type: "idle" });
    expect(flak.order).toEqual({ type: "idle" });
  });

  it("passes over a unit that can't get within range (a tank on an island)", () => {
    const { w, hq } = setup();
    for (let ty = 25; ty <= 35; ty++)
      for (let tx = 25; tx <= 35; tx++)
        if (tx < 28 || tx > 32 || ty < 28 || ty > 32) setTerrain(w, tx, ty, Terrain.Water);
    const marooned = spawnUnit(w, "stinger", "blue", 30.5, 30.5);
    const guard = spawnUnit(w, "stinger", "blue", 5.5, 35.5);
    const mortar = shell(w, hq, 24.8, 15.5);
    runTicks(w, 5 * TICK_RATE);
    expect(marooned.order).toEqual({ type: "idle" });
    expect(guard.order).toEqual({ type: "attack", targetId: mortar.id, defending: hq.id });
  });

  it("the responder sees the attacker off but doesn't chase it home (COMBAT.hqLeash)", () => {
    const { w, hq } = setup();
    const titan = spawnUnit(w, "titan", "blue", 15.5, 35.5); // slower than the Mortar it answers
    const mortar = shell(w, hq, 24.8, 15.5);
    runTicks(w, 5 * TICK_RATE);
    expect(titan.order).toEqual({ type: "attack", targetId: mortar.id, defending: hq.id });
    step(w, [{ type: "move", faction: "red", unitIds: [mortar.id], x: 38.5, y: 4.5 }]);
    runTicks(w, 30 * TICK_RATE);
    expect(w.units.has(mortar.id)).toBe(true);
    expect(titan.order).toEqual({ type: "idle" });
    expect(Math.hypot(titan.x - 38.5, titan.y - 4.5)).toBeGreaterThan(12);
    // a player's own attack order on the same target still chases it anywhere
    step(w, [{ type: "attack", faction: "blue", unitIds: [titan.id], targetId: mortar.id }]);
    runTicks(w, 40 * TICK_RATE);
    expect(w.units.has(mortar.id)).toBe(false);
  });

  it("sends nobody at the enemy HQ when a calldown lands on ours", () => {
    const { w, hq } = setup();
    const redHq = spawnBuilding(w, "hq", "red", 34, 34);
    const guard = spawnUnit(w, "stinger", "blue", 5.5, 35.5);
    const c = buildingCenter(hq);
    expect(areaBlast(w, "red", c.x, c.y, 2, 100, "explosive", "ground", redHq.id)).toBeGreaterThan(0);
    runTicks(w, TICK_RATE);
    expect(guard.order).toEqual({ type: "idle" });
  });
});

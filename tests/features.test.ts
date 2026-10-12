import { describe, expect, it } from "vitest";
import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "../src/sim/balance";
import { canPlaceBuilding } from "../src/sim/economy";
import { MAPS, createMapWorld } from "../src/sim/maps";
import { findPath } from "../src/sim/movement";
import { step } from "../src/sim/sim";
import { Terrain, type World } from "../src/sim/types";
import { createWorld, hqOf, setTerrain, spawnBuilding, spawnUnit, terrainAt } from "../src/sim/world";

const runTicks = (w: World, n: number) => {
  for (let i = 0; i < n; i++) step(w, []);
};

describe("terrain", () => {
  it("deep water blocks tanks but hover units and aircraft cross it", () => {
    const w = createWorld(24, 24);
    for (let ty = 0; ty < 24; ty++) for (let tx = 10; tx <= 12; tx++) setTerrain(w, tx, ty, Terrain.Water);
    expect(findPath(w, 3.5, 5.5, 20.5, 5.5, "ground")).toBeNull();
    expect(findPath(w, 3.5, 5.5, 20.5, 5.5, "hover")).not.toBeNull();
    const lancer = spawnUnit(w, "lancer", "blue", 3.5, 5.5);
    const stinger = spawnUnit(w, "stinger", "blue", 3.5, 8.5);
    step(w, [
      { type: "move", faction: "blue", unitIds: [lancer.id], x: 20.5, y: 5.5 },
      { type: "move", faction: "blue", unitIds: [stinger.id], x: 20.5, y: 8.5 }
    ]);
    runTicks(w, 12 * TICK_RATE);
    expect(lancer.x).toBeGreaterThan(19);
    expect(stinger.x).toBeLessThan(10);
  });

  it("bridges and shallows let ground units cross a river", () => {
    const w = createWorld(24, 24);
    for (let ty = 0; ty < 24; ty++) for (let tx = 10; tx <= 12; tx++) setTerrain(w, tx, ty, Terrain.Water);
    for (let tx = 10; tx <= 12; tx++) setTerrain(w, tx, 20, Terrain.Bridge);
    const path = findPath(w, 3.5, 5.5, 20.5, 5.5, "ground")!;
    expect(path).not.toBeNull();
    expect(path.some((p) => p.y === 20.5)).toBe(true);
    for (let tx = 10; tx <= 12; tx++) setTerrain(w, tx, 6, Terrain.Shallows);
    const ford = findPath(w, 3.5, 5.5, 20.5, 5.5, "ground")!;
    expect(ford.some((p) => p.y === 20.5)).toBe(false); // the ford is much shorter
  });

  it("roads are faster and mud is slower than open ground", () => {
    const race = (t: Terrain) => {
      const w = createWorld(30, 6);
      for (let ty = 0; ty < 6; ty++) for (let tx = 0; tx < 30; tx++) setTerrain(w, tx, ty, t);
      const u = spawnUnit(w, "stinger", "blue", 1.5, 2.5);
      step(w, [{ type: "move", faction: "blue", unitIds: [u.id], x: 28.5, y: 2.5 }]);
      runTicks(w, 5 * TICK_RATE);
      return u.x;
    };
    expect(race(Terrain.Road)).toBeGreaterThan(race(Terrain.Ground) + 2);
    expect(race(Terrain.Rough)).toBeLessThan(race(Terrain.Ground) - 2);
  });

  it("A* prefers a road detour over wading through mud", () => {
    const w = createWorld(20, 10);
    for (let tx = 2; tx < 18; tx++) setTerrain(w, tx, 5, Terrain.Rough);
    for (let tx = 1; tx < 19; tx++) setTerrain(w, tx, 7, Terrain.Road);
    const path = findPath(w, 1.5, 5.5, 18.5, 5.5)!;
    expect(path.filter((p) => p.y === 7.5).length).toBeGreaterThan(8);
  });

  it("woods give ground units cover", () => {
    const hitsTaken = (t: Terrain) => {
      const w = createWorld(16, 16);
      setTerrain(w, 8, 8, t);
      const victim = spawnUnit(w, "mastodon", "red", 8.5, 8.5);
      spawnUnit(w, "stinger", "blue", 5.5, 8.5);
      runTicks(w, 5 * TICK_RATE);
      return UNITS.mastodon.hp - victim.hp;
    };
    expect(hitsTaken(Terrain.Forest)).toBeLessThan(hitsTaken(Terrain.Ground) * 0.8);
  });
});

describe("tech tree and buildings", () => {
  it("the Tech Lab needs a Fab Plant or Airpad, and gates advanced units", () => {
    const w = createWorld(24, 24);
    const hq = spawnBuilding(w, "hq", "blue", 2, 2);
    void hq;
    w.factions.blue.scrap = 5000;
    step(w, [{ type: "startBuilding", faction: "blue", building: "tech-lab" }]);
    expect(w.factions.blue.pending).toBeNull();
    const fab = spawnBuilding(w, "fab-plant", "blue", 8, 2);
    step(w, [{ type: "produce", faction: "blue", buildingId: fab.id, unit: "mastodon" }]);
    expect(fab.queue).toHaveLength(0);
    step(w, [{ type: "startBuilding", faction: "blue", building: "tech-lab" }]);
    expect(w.factions.blue.pending?.kind).toBe("tech-lab");
    spawnBuilding(w, "tech-lab", "blue", 12, 2);
    step(w, [{ type: "produce", faction: "blue", buildingId: fab.id, unit: "mastodon" }]);
    expect(fab.queue).toHaveLength(1);
  });

  it("selling refunds half the cost (scaled by health) and frees the footprint", () => {
    const w = createWorld(24, 24);
    spawnBuilding(w, "hq", "blue", 2, 2);
    const t = spawnBuilding(w, "turret", "blue", 8, 3);
    w.factions.blue.scrap = 0;
    step(w, [{ type: "sell", faction: "blue", buildingId: t.id }]);
    expect(w.buildings.has(t.id)).toBe(false);
    expect(w.factions.blue.scrap).toBe(Math.floor(BUILDINGS.turret.cost * ECONOMY.sellRefund));
    expect(w.occupancy[3 * 24 + 8]).toBe(0);
  });

  it("the HQ can't be sold", () => {
    const w = createWorld(24, 24);
    const hq = spawnBuilding(w, "hq", "blue", 2, 2);
    step(w, [{ type: "sell", faction: "blue", buildingId: hq.id }]);
    expect(w.buildings.has(hq.id)).toBe(true);
  });

  it("buildings can't go on water, woods or rough ground", () => {
    const w = createWorld(24, 24);
    spawnBuilding(w, "hq", "blue", 2, 2);
    for (const t of [Terrain.Water, Terrain.Forest, Terrain.Rough, Terrain.Scrap]) {
      setTerrain(w, 7, 3, t);
      expect(canPlaceBuilding(w, "blue", "turret", 7, 3)).toBe(false);
    }
    setTerrain(w, 7, 3, Terrain.Road);
    expect(canPlaceBuilding(w, "blue", "turret", 7, 3)).toBe(true);
  });

  it("harvesters unload at a nearer depot instead of the HQ", () => {
    const w = createWorld(40, 12);
    spawnBuilding(w, "hq", "blue", 1, 4);
    spawnBuilding(w, "depot", "blue", 30, 4);
    setTerrain(w, 34, 5, Terrain.Scrap);
    const h = spawnUnit(w, "harvester", "blue", 33.5, 5.5);
    w.factions.blue.scrap = 0;
    step(w, [{ type: "harvest", faction: "blue", unitIds: [h.id], x: 34.5, y: 5.5 }]);
    runTicks(w, 25 * TICK_RATE);
    expect(w.factions.blue.scrap).toBeGreaterThan(150);
    expect(h.x).toBeGreaterThan(25); // never trekked back to the HQ
  });

  it("crystal fields fill the hold faster than scrap", () => {
    const earn = (t: Terrain) => {
      const w = createWorld(24, 12);
      spawnBuilding(w, "hq", "blue", 2, 4);
      setTerrain(w, 10, 5, t);
      const h = spawnUnit(w, "harvester", "blue", 9.5, 5.5);
      w.factions.blue.scrap = 0;
      step(w, [{ type: "harvest", faction: "blue", unitIds: [h.id], x: 10.5, y: 5.5 }]);
      runTicks(w, 60 * TICK_RATE);
      return w.factions.blue.scrap;
    };
    expect(earn(Terrain.Crystal)).toBeGreaterThan(earn(Terrain.Scrap) * 1.1);
  });
});

describe("new weapons", () => {
  it("mortar shells splash several clumped targets", () => {
    const w = createWorld(24, 24);
    spawnUnit(w, "mortar", "blue", 4.5, 10.5);
    const victims = [0, 1, 2].map((i) => spawnUnit(w, "harvester", "red", 11 + i * 0.5, 10.5));
    runTicks(w, 6 * TICK_RATE);
    expect(victims.filter((v) => v.hp < UNITS.harvester.hp).length).toBeGreaterThanOrEqual(2);
  });

  it("mortars can't fire inside their minimum range", () => {
    const w = createWorld(24, 24);
    spawnUnit(w, "mortar", "blue", 10.5, 10.5);
    const v = spawnUnit(w, "harvester", "red", 11.5, 10.5);
    let shots = 0;
    for (let i = 0; i < 5 * TICK_RATE; i++) {
      step(w, []);
      shots += w.fx.filter((f) => f.type === "shot").length;
    }
    expect(shots).toBe(0);
    expect(v.hp).toBe(UNITS.harvester.hp);
  });

  it("shells land where the target was: a fast mover can dodge", () => {
    const w = createWorld(40, 24);
    spawnUnit(w, "mortar", "blue", 3.5, 10.5);
    const runner = spawnUnit(w, "scout", "red", 10.5, 10.5); // air: can't be targeted
    void runner;
    const tank = spawnUnit(w, "stinger", "red", 10.5, 12.5);
    runTicks(w, 3); // mortar fires at the tank
    expect(w.projectiles.length).toBe(1);
    step(w, [{ type: "move", faction: "red", unitIds: [tank.id], x: 10.5, y: 22.5 }]);
    runTicks(w, 2 * TICK_RATE);
    expect(tank.hp).toBe(UNITS.stinger.hp);
  });

  it("menders repair damaged units and buildings", () => {
    const w = createWorld(24, 24);
    const m = spawnUnit(w, "mender", "blue", 5.5, 5.5);
    void m;
    const hurt = spawnUnit(w, "stinger", "blue", 7.5, 5.5);
    hurt.hp = 50;
    const b = spawnBuilding(w, "turret", "blue", 5, 9);
    b.hp = 100;
    runTicks(w, 8 * TICK_RATE);
    expect(hurt.hp).toBeGreaterThan(120);
    // the Stinger (1.5× HP since the longer-fights pass) is topped up first
    runTicks(w, 40 * TICK_RATE);
    expect(b.hp).toBeGreaterThan(300);
  });

  it("lancers hit both air and ground", () => {
    const w = createWorld(24, 24);
    // unarmed targets, so the lancer survives to engage both
    spawnUnit(w, "lancer", "blue", 5.5, 5.5);
    const scout = spawnUnit(w, "scout", "red", 8.5, 5.5);
    const truck = spawnUnit(w, "harvester", "red", 5.5, 8.5);
    runTicks(w, 12 * TICK_RATE);
    expect(scout.hp).toBeLessThan(UNITS.scout.hp);
    expect(truck.hp).toBeLessThan(UNITS.harvester.hp);
  });

  it("the HQ's point defence swats drones but ignores tanks", () => {
    const w = createWorld(24, 24);
    spawnBuilding(w, "hq", "blue", 5, 5);
    const wasp = spawnUnit(w, "wasp", "red", 10.5, 6.5);
    const tank = spawnUnit(w, "harvester", "red", 6.5, 10.5);
    runTicks(w, 3 * TICK_RATE);
    expect(wasp.hp).toBeLessThan(UNITS.wasp.hp);
    expect(tank.hp).toBe(UNITS.harvester.hp);
  });
});

describe("unit behaviour", () => {
  it("idle units retaliate against an attacker out of their acquire range", () => {
    const w = createWorld(30, 24);
    const guard = spawnUnit(w, "stinger", "blue", 5.5, 10.5);
    const mortar = spawnUnit(w, "mortar", "red", 12.5, 10.5);
    step(w, [{ type: "attack", faction: "red", unitIds: [mortar.id], targetId: guard.id }]);
    runTicks(w, 4 * TICK_RATE);
    expect(guard.order).toEqual({ type: "attack", targetId: mortar.id });
    runTicks(w, 20 * TICK_RATE);
    expect(w.units.has(mortar.id)).toBe(false);
  });

  it("veterans rank up after kills and hit harder", () => {
    const w = createWorld(24, 24);
    const vet = spawnUnit(w, "mastodon", "blue", 5.5, 5.5);
    for (let i = 0; i < 4; i++) spawnUnit(w, "stinger", "red", 8.5, 3.5 + i * 1.2);
    runTicks(w, 30 * TICK_RATE);
    expect(vet.rank).toBeGreaterThanOrEqual(1);
    expect(vet.xp).toBeGreaterThanOrEqual(UNITS.mastodon.cost);
  });
});

describe("maps", () => {
  for (const def of MAPS) {
    it(`${def.name}: symmetric, connected and buildable`, () => {
      const w = createMapWorld(def.id);
      expect(w.width).toBe(def.size);
      const blue = hqOf(w, "blue")!;
      const red = hqOf(w, "red")!;
      // point symmetry
      for (let ty = 0; ty < w.height; ty++)
        for (let tx = 0; tx < w.width; tx++)
          expect(terrainAt(w, tx, ty)).toBe(terrainAt(w, w.width - 1 - tx, w.height - 1 - ty));
      // tanks can drive from one base to the other
      expect(findPath(w, blue.tx + 1.5, blue.ty + 3.5, red.tx + 1.5, red.ty - 0.5)).not.toBeNull();
      // each side has scrap within reach of home
      let near = 0;
      for (let ty = 0; ty < w.height; ty++)
        for (let tx = 0; tx < w.width; tx++) {
          const t = terrainAt(w, tx, ty);
          if ((t === Terrain.Scrap || t === Terrain.Crystal) && Math.hypot(tx - blue.tx, ty - blue.ty) < 14) near++;
        }
      expect(near).toBeGreaterThanOrEqual(8);
      // room for a 2x2 building beside the HQ
      let spots = 0;
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++)
          if (canPlaceBuilding(w, "blue", "fab-plant", blue.tx + dx, blue.ty + dy)) spots++;
      expect(spots).toBeGreaterThan(6);
    });
  }
});

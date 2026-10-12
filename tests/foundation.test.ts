import { describe, expect, it } from "vitest";
import { createMapWorld } from "../src/sim/maps";
import { hash32, worldPick, worldRandom } from "../src/sim/rand";
import { step } from "../src/sim/sim";
import type { FxEvent } from "../src/sim/types";
import { createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";

describe("deterministic randomness", () => {
  it("is a pure function of the seed and keys", () => {
    const a = createMapWorld("riverlands", { seed: 42 });
    const b = createMapWorld("riverlands", { seed: 42 });
    const c = createMapWorld("riverlands", { seed: 43 });
    expect(worldRandom(a, "drop", 7)).toBe(worldRandom(b, "drop", 7));
    expect(worldRandom(a, "drop", 7)).not.toBe(worldRandom(c, "drop", 7));
    expect(worldRandom(a, "drop", 7)).not.toBe(worldRandom(a, "wave", 7));
    expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3));
  });

  it("stays in range and spreads evenly", () => {
    const w = createMapWorld("riverlands", { seed: 9 });
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) {
      const r = worldRandom(w, "spread", i);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
      counts[worldPick(w, 4, "pick", i)]!++;
    }
    for (const n of counts) expect(n).toBeGreaterThan(850);
  });

  it("defaults the match seed to the map seed", () => {
    expect(createMapWorld("frostbite").seed).toBe(createMapWorld("frostbite").seed);
  });
});

describe("kill credit and death events", () => {
  const collect = (w: ReturnType<typeof createWorld>, ticks: number) => {
    const out: FxEvent[] = [];
    for (let i = 0; i < ticks && w.units.size + w.buildings.size > 0; i++) {
      step(w, []);
      out.push(...w.fx);
    }
    return out;
  };

  it("credits the killing unit and emits a death event with the killer", () => {
    const w = createWorld(20, 20);
    const mastodon = spawnUnit(w, "mastodon", "blue", 5.5, 5.5);
    const victim = spawnUnit(w, "harvester", "red", 8.5, 5.5); // unarmed, can't fight back
    victim.hp = 30;
    const fx = collect(w, 50);
    const death = fx.find((e) => e.type === "death");
    expect(death).toMatchObject({ type: "death", id: victim.id, faction: "red", unitKind: "harvester", killerId: mastodon.id, killerKind: "mastodon" });
    expect(mastodon.kills).toBe(1);
    expect(w.factions.blue.stats.unitsKilled).toBe(1);
  });

  it("credits kills made by buildings to their faction", () => {
    const w = createWorld(20, 20);
    spawnBuilding(w, "turret", "blue", 5, 5);
    const victim = spawnUnit(w, "scout", "red", 7.5, 5.5);
    victim.hp = 20;
    collect(w, 60);
    expect(w.units.has(victim.id)).toBe(false);
    expect(w.factions.blue.stats.unitsKilled).toBe(1);
  });

  it("counts destroyed buildings for the attacker", () => {
    const w = createWorld(20, 20);
    spawnUnit(w, "mastodon", "blue", 5.5, 5.5);
    const radar = spawnBuilding(w, "radar", "red", 8, 5);
    radar.hp = 40;
    const fx = collect(w, 60);
    expect(fx.some((e) => e.type === "death" && e.buildingKind === "radar")).toBe(true);
    expect(w.factions.blue.stats.buildingsKilled).toBe(1);
  });

  it("hit events carry victim and attacker ids", () => {
    const w = createWorld(20, 20);
    const a = spawnUnit(w, "stinger", "blue", 5.5, 5.5);
    const b = spawnUnit(w, "harvester", "red", 7.5, 5.5);
    const fx = collect(w, 20);
    const hit = fx.find((e) => e.type === "hit");
    expect(hit).toMatchObject({ id: b.id, attackerId: a.id, faction: "red" });
  });
});

describe("deposit events", () => {
  it("fires once per load when a harvester starts unloading", () => {
    const w = createMapWorld("proving-grounds");
    const h = [...w.units.values()].find((u) => u.faction === "blue" && u.kind === "harvester")!;
    step(w, [{ type: "harvest", faction: "blue", unitIds: [h.id], x: 13.5, y: 37.5 }]);
    const deposits: FxEvent[] = [];
    for (let i = 0; i < 60 * 10; i++) {
      step(w, []);
      deposits.push(...w.fx.filter((e) => e.type === "deposit" && e.faction === "blue"));
    }
    expect(deposits.length).toBeGreaterThanOrEqual(2);
    expect(deposits[0]).toMatchObject({ type: "deposit", id: h.id, amount: 100 });
  });
});

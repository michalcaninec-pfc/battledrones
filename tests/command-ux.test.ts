import { describe, expect, it } from "vitest";
import { BUILDINGS, ECONOMY, UNITS } from "../src/sim/balance";
import { canPlaceBuilding } from "../src/sim/economy";
import { tickFog } from "../src/sim/fog";
import { MAPS, createMapWorld } from "../src/sim/maps";
import { placementBlocker, snapPlacement, suggestPlacement } from "../src/sim/placement";
import { Terrain, type BuildingKind, type FxEvent, type World } from "../src/sim/types";
import { buildingCenter, createWorld, hqOf, setTerrain, spawnBuilding, spawnUnit } from "../src/sim/world";
import { Controller } from "../src/game/controller";
import { SQUAD, Squads } from "../src/game/squads";
import { ADVISOR, COUNTERS, EnemyIntel, IdleWatch, adviceNote, counterAdvice } from "../src/game/advisor";
import { applyMutators, rulesOf } from "../src/sim/rules";

const BUILDABLE: BuildingKind[] = ["fab-plant", "airpad", "tech-lab", "depot", "turret", "sam-site", "radar"];

/** A flat 40×40 field with a blue HQ at (4,4) and a red HQ at (32,32). */
function field(): World {
  const w = createWorld(40, 40);
  spawnBuilding(w, "hq", "blue", 4, 4);
  spawnBuilding(w, "hq", "red", 32, 32);
  return w;
}

const hit = (id: number, building = false): FxEvent => ({
  type: "hit", faction: "blue", id, x: 0, y: 0, building, attackerId: 0
});

describe("placement: why not, and where instead", () => {
  it("explains exactly the spots canPlaceBuilding refuses, on every map", () => {
    for (const def of MAPS) {
      const w = createMapWorld(def.id);
      const hq = hqOf(w, "blue")!;
      // a unit parked near the HQ, so "Unit in the way" is exercised too
      spawnUnit(w, "stinger", "blue", hq.tx + 4.5, hq.ty + 1.5);
      for (const kind of ["turret", "fab-plant"] as BuildingKind[])
        for (let ty = hq.ty - 9; ty <= hq.ty + 9; ty++)
          for (let tx = hq.tx - 9; tx <= hq.tx + 9; tx++) {
            const ok = canPlaceBuilding(w, "blue", kind, tx, ty);
            const why = placementBlocker(w, "blue", kind, tx, ty);
            expect(why === null, `${def.id} ${kind} ${tx},${ty}: ${why}`).toBe(ok);
          }
    }
  });

  it("names the problem: range, ground, buildings, units, map edge", () => {
    const w = field();
    expect(placementBlocker(w, "blue", "turret", 9, 5)).toBeNull();
    expect(placementBlocker(w, "blue", "turret", 25, 5)).toBe("Too far from base");
    expect(placementBlocker(w, "blue", "turret", 5, 5)).toBe("Blocked");
    expect(placementBlocker(w, "blue", "fab-plant", -1, 5)).toBe("Off the map");
    setTerrain(w, 9, 6, Terrain.Water);
    expect(placementBlocker(w, "blue", "turret", 9, 6)).toBe("Not on water");
    w.biome = "volcanic";
    expect(placementBlocker(w, "blue", "turret", 9, 6)).toBe("Not on lava");
    setTerrain(w, 9, 7, Terrain.Rock);
    expect(placementBlocker(w, "blue", "turret", 9, 7)).toBe("Not on rock");
    setTerrain(w, 10, 8, Terrain.Rough);
    expect(placementBlocker(w, "blue", "turret", 10, 8)).toBe("Not on cinders");
    spawnUnit(w, "titan", "blue", 9.5, 9.5);
    expect(placementBlocker(w, "blue", "turret", 9, 9)).toBe("Unit in the way");
    // aircraft overhead don't block
    spawnUnit(w, "wasp", "blue", 8.5, 9.5);
    expect(placementBlocker(w, "blue", "turret", 8, 9)).toBeNull();
    // the enemy's base doesn't count as yours
    expect(placementBlocker(w, "blue", "turret", 30, 30)).toBe("Too far from base");
  });

  it("suggests the valid spot nearest the view centre, inside build range", () => {
    for (const def of MAPS) {
      const w = createMapWorld(def.id);
      const hq = hqOf(w, "blue")!;
      const c = buildingCenter(hq);
      for (const kind of BUILDABLE) {
        for (const anchor of [c, { x: c.x + 3, y: c.y + 6 }, { x: w.width / 2, y: w.height / 2 }]) {
          const s = suggestPlacement(w, "blue", kind, anchor);
          expect(s, `${def.id} ${kind}`).not.toBeNull();
          expect(canPlaceBuilding(w, "blue", kind, s!.tx, s!.ty)).toBe(true);
        }
      }
    }
  });

  it("prefers the spot closest to the anchor, and is deterministic", () => {
    const w = field();
    const s = suggestPlacement(w, "blue", "turret", { x: 10.5, y: 5.5 })!;
    expect(s).toEqual({ tx: 10, ty: 5 });
    // a far-away anchor still lands at the base edge facing it
    const far = suggestPlacement(w, "blue", "turret", { x: 30, y: 5.5 })!;
    expect(canPlaceBuilding(w, "blue", "turret", far.tx, far.ty)).toBe(true);
    expect(far.tx).toBeGreaterThan(8);
    expect(Math.abs(far.ty + 0.5 - 5.5)).toBeLessThanOrEqual(2);
    expect(suggestPlacement(w, "blue", "turret", { x: 30, y: 5.5 })).toEqual(far);
    // nothing of ours, nowhere to build
    const empty = createWorld(20, 20);
    expect(suggestPlacement(empty, "blue", "turret", { x: 5, y: 5 })).toBeNull();
  });

  it("keeps lanes open for big buildings when it can", () => {
    const w = field();
    // a 2×2 pocket walled in by rock right where the player is looking
    for (let y = 3; y <= 6; y++)
      for (let x = 8; x <= 11; x++) if (!(x >= 9 && x <= 10 && y >= 4 && y <= 5)) setTerrain(w, x, y, Terrain.Rock);
    expect(canPlaceBuilding(w, "blue", "fab-plant", 9, 4)).toBe(true);
    const s = suggestPlacement(w, "blue", "fab-plant", { x: 10, y: 5 })!;
    expect(s).not.toEqual({ tx: 9, ty: 4 }); // that would seal it in
    expect(canPlaceBuilding(w, "blue", "fab-plant", s.tx, s.ty)).toBe(true);
    // a turret doesn't care
    expect(suggestPlacement(w, "blue", "turret", { x: 9.5, y: 4.5 })).toEqual({ tx: 9, ty: 4 });
  });

  it("snaps an imprecise tap one tile onto a valid spot, else leaves it", () => {
    const w = field();
    // (6,6) is inside the HQ: (6,7) is free ground right below it
    const snapped = snapPlacement(w, "blue", "turret", 6, 6);
    expect(canPlaceBuilding(w, "blue", "turret", snapped.tx, snapped.ty)).toBe(true);
    expect(Math.max(Math.abs(snapped.tx - 6), Math.abs(snapped.ty - 6))).toBe(1);
    expect(snapPlacement(w, "blue", "turret", 9, 5)).toEqual({ tx: 9, ty: 5 });
    expect(snapPlacement(w, "blue", "turret", 25, 25)).toEqual({ tx: 25, ty: 25 });
  });
});

describe("controller: touch placement", () => {
  const ready = (w: World, kind: BuildingKind) => {
    w.factions.blue.pending = { kind, remaining: 0, ready: true };
  };

  it("moves the ghost without building, then builds on confirm", () => {
    const w = field();
    const c = new Controller(w);
    ready(w, "turret");
    c.placing = "turret";
    c.movePlacement(9, 5);
    expect(c.placeAt).toEqual({ tx: 9, ty: 5 });
    expect(c.drainCommands()).toEqual([]);
    expect(c.placementProblem()).toBeNull();
    expect(c.commitPlacement()).toBe(true);
    expect(c.drainCommands()).toEqual([{ type: "placeBuilding", faction: "blue", tx: 9, ty: 5 }]);
    expect(c.placing).toBeNull();
    expect(c.placeAt).toBeNull();
    expect(c.lastFeedback?.kind).toBe("place");
  });

  it("refuses a bad spot with the reason, staying in placement", () => {
    const w = field();
    const c = new Controller(w);
    ready(w, "turret");
    c.placing = "turret";
    c.movePlacement(25, 25);
    expect(c.placementProblem()).toBe("Too far from base");
    expect(c.commitPlacement()).toBe(false);
    expect(c.denied).toEqual({ reason: "Too far from base", tx: 25, ty: 25 });
    expect(c.placing).toBe("turret");
    expect(c.drainCommands()).toEqual([]);
  });

  it("keeps one-click placement for mouse taps, and denies a bad click", () => {
    const w = field();
    const c = new Controller(w);
    ready(w, "turret");
    c.placing = "turret";
    c.tapWorld(25.5, 25.5, { kind: "ground" });
    expect(c.denied?.reason).toBe("Too far from base");
    expect(c.placing).toBe("turret");
    c.tapWorld(9.5, 5.5, { kind: "ground" });
    expect(c.drainCommands()).toEqual([{ type: "placeBuilding", faction: "blue", tx: 9, ty: 5 }]);
  });

  it("drops the ghost when placement ends", () => {
    const w = field();
    const c = new Controller(w);
    ready(w, "turret");
    c.placing = "turret";
    c.movePlacement(9, 5);
    w.factions.blue.pending = null; // cancelled elsewhere
    c.prune();
    expect(c.placing).toBeNull();
    expect(c.placeAt).toBeNull();
  });

  it("selects units with no orders", () => {
    const w = field();
    const c = new Controller(w);
    const a = spawnUnit(w, "stinger", "blue", 10, 10);
    const b = spawnUnit(w, "stinger", "blue", 11, 10);
    spawnUnit(w, "harvester", "blue", 12, 10);
    spawnUnit(w, "stinger", "red", 13, 10);
    b.order = { type: "move", x: 20, y: 20 };
    expect(c.idleArmy()).toEqual([a.id]);
  });

  it("Shift+click adds a unit to the selection, or takes it out", () => {
    const w = field();
    const c = new Controller(w);
    const [a, b, d] = [1, 2, 3].map((i) => spawnUnit(w, "stinger", "blue", 10 + i, 10));
    c.tapWorld(11, 10, { kind: "ownUnit", id: a!.id });
    c.tapWorld(12, 10, { kind: "ownUnit", id: b!.id }, true);
    expect([...c.selectedUnits]).toEqual([a!.id, b!.id]);
    c.forceMove = true;
    const before = c.selectedUnits;
    c.tapWorld(11, 10, { kind: "ownUnit", id: a!.id }, true);
    expect([...c.selectedUnits]).toEqual([b!.id]);
    expect(c.selectedUnits).toBe(before); // taking one out is quiet (no voice)
    expect(c.forceMove).toBe(true); // an armed Move only survives
    c.tapWorld(13, 10, { kind: "ownUnit", id: d!.id }, true);
    expect([...c.selectedUnits]).toEqual([b!.id, d!.id]);
    expect(c.selectedUnits).not.toBe(before); // adding one is a fresh selection: the voices answer
    // Shift only changes taps on your own units: the ground still gets the (Move only) order
    c.tapWorld(20.5, 20.5, { kind: "ground" }, true);
    expect(c.drainCommands()).toEqual([{ type: "move", faction: "blue", unitIds: [b!.id, d!.id], x: 20.5, y: 20.5 }]);
    // a Shift+click on a unit while a building is selected starts a unit selection
    const hq = hqOf(w, "blue")!;
    c.clearSelection();
    c.selectedBuilding = hq.id;
    c.tapWorld(11, 10, { kind: "ownUnit", id: a!.id }, true);
    expect(c.selectedBuilding).toBeNull();
    expect([...c.selectedUnits]).toEqual([a!.id]);
  });
});

describe("squads", () => {
  it("saves a selection; a unit lives in one squad at a time", () => {
    const w = field();
    const c = new Controller(w);
    const [a, b, d] = [1, 2, 3].map((i) => spawnUnit(w, "stinger", "blue", 10 + i, 10));
    const enemy = spawnUnit(w, "wasp", "red", 20, 20);
    c.selectUnits([a!.id, b!.id, enemy.id]);
    expect(c.assignSquad(0)).toBe(2); // enemies never join
    c.selectUnits([b!.id, d!.id]);
    c.assignSquad(1);
    expect(c.squads.ids(0, w)).toEqual([a!.id]);
    expect(c.squads.ids(1, w)).toEqual([b!.id, d!.id]);
    expect(c.squads.slotOf(b!.id)).toBe(1);
    c.clearSelection();
    expect(c.selectSquad(1)).toBe(2);
    expect([...c.selectedUnits]).toEqual([b!.id, d!.id]);
    expect(c.squads.matches(1, c.selectedUnits, w)).toBe(true);
    expect(c.squads.matches(0, c.selectedUnits, w)).toBe(false);
    expect(c.selectSquad(2)).toBe(0); // empty: selection kept
    expect(c.selectedUnits.size).toBe(2);
  });

  it("selecting a squad replaces the selection set (voices hear a new selection)", () => {
    const w = field();
    const c = new Controller(w);
    const u = spawnUnit(w, "titan", "blue", 10, 10);
    c.selectUnits([u.id]);
    c.assignSquad(0);
    const before = c.selectedUnits;
    c.selectSquad(0);
    expect(c.selectedUnits).not.toBe(before);
  });

  it("forgets the dead and summarises the living", () => {
    const w = field();
    const s = new Squads("blue");
    const st = [0, 1, 2].map((i) => spawnUnit(w, "stinger", "blue", 10 + i, 10));
    const ti = spawnUnit(w, "titan", "blue", 14, 10);
    s.assign(0, [...st.map((u) => u.id), ti.id], w);
    st[0]!.hp = UNITS.stinger.hp / 2;
    let sum = s.summary(0, w)!;
    expect(sum.kind).toBe("stinger");
    expect(sum.count).toBe(4);
    const max = UNITS.stinger.hp * 3 + UNITS.titan.hp;
    expect(sum.hp).toBeCloseTo((max - UNITS.stinger.hp / 2) / max);
    w.units.delete(st[1]!.id);
    w.units.delete(st[2]!.id);
    s.prune(w);
    expect(s.slots[0]).toEqual([st[0]!.id, ti.id]);
    // 1 stinger vs 1 titan: the pricier kind is the face of the squad
    sum = s.summary(0, w)!;
    expect(sum.kind).toBe("titan");
    expect(sum.count).toBe(2);
    w.units.delete(st[0]!.id);
    w.units.delete(ti.id);
    expect(s.summary(0, w)).toBeNull();
    expect(s.focus(0, w)).toBeNull();
  });

  it("flies to the member nearest the middle, not empty ground between two halves", () => {
    const w = field();
    const s = new Squads("blue");
    const us = [
      spawnUnit(w, "wasp", "blue", 5, 20),
      spawnUnit(w, "wasp", "blue", 6, 20),
      spawnUnit(w, "wasp", "blue", 30, 20)
    ];
    s.assign(2, us.map((u) => u.id), w);
    expect(s.focus(2, w)).toEqual({ x: 6, y: 20 });
  });

  it("lights a chip red while a member is hit", () => {
    const w = field();
    const s = new Squads("blue");
    const u = spawnUnit(w, "stinger", "blue", 10, 10);
    const other = spawnUnit(w, "stinger", "blue", 12, 10);
    s.assign(1, [u.id], w);
    s.events([hit(other.id), hit(u.id, true)], 1000);
    expect(s.isHurt(1, 1000)).toBe(false); // not a member / a building hit
    s.events([hit(u.id)], 1000);
    expect(s.isHurt(1, 1000 + SQUAD.hurtMs - 1)).toBe(true);
    expect(s.isHurt(1, 1000 + SQUAD.hurtMs + 1)).toBe(false);
    expect(s.isHurt(0, 1000)).toBe(false);
    // red's hits on its own units don't touch blue's squads
    s.events([{ type: "hit", faction: "red", id: u.id, x: 0, y: 0, building: false, attackerId: 0 }], 5000);
    expect(s.isHurt(1, 5000)).toBe(false);
  });
});

describe("build advisor", () => {
  /** Blue base with vision around it; red units placed at (x, y). */
  function scene() {
    const w = field();
    spawnBuilding(w, "fab-plant", "blue", 9, 4);
    spawnBuilding(w, "airpad", "blue", 9, 7);
    tickFog(w);
    return w;
  }

  it("remembers only enemies standing where you can see, for a minute", () => {
    const w = scene();
    const intel = new EnemyIntel(w, "blue");
    const near = spawnUnit(w, "wasp", "red", 8, 9);
    spawnUnit(w, "wasp", "red", 30, 20); // in the fog
    spawnUnit(w, "scout", "red", 8, 10); // scouts are ignored
    spawnUnit(w, "harvester", "red", 9, 10); // so are harvesters
    tickFog(w);
    intel.update(0);
    expect(intel.count("wasp", 0)).toBe(1);
    expect(intel.count("scout", 0)).toBe(0);
    expect(intel.count("harvester", 0)).toBe(0);
    // seen again later: still one wasp (distinct ids)
    intel.update(10);
    expect(intel.count("wasp", 10)).toBe(1);
    // it leaves; forgotten a minute after its last sighting
    near.x = 30;
    tickFog(w);
    intel.update(20);
    expect(intel.count("wasp", 10 + ADVISOR.memoryS - 1)).toBe(1);
    intel.update(10 + ADVISOR.memoryS + 1);
    expect(intel.count("wasp", 10 + ADVISOR.memoryS + 1)).toBe(0);
  });

  it("counts enemy defences from the fog memory", () => {
    const w = scene();
    const intel = new EnemyIntel(w, "blue");
    spawnBuilding(w, "turret", "red", 11, 10);
    spawnBuilding(w, "turret", "red", 30, 12); // never seen
    tickFog(w);
    expect(intel.count("turret", 0)).toBe(1);
  });

  it("lights the counters after two sightings, until you've answered them", () => {
    const w = scene();
    const intel = new EnemyIntel(w, "blue");
    spawnUnit(w, "wasp", "red", 8, 9);
    tickFog(w);
    intel.update(0);
    expect(counterAdvice(w, "blue", intel, "flak-crawler", 0).active).toBe(false); // one sighting
    spawnUnit(w, "wasp", "red", 9, 9);
    tickFog(w);
    intel.update(1);
    for (const k of ["flak-crawler", "raptor", "sam-site"] as const)
      expect(counterAdvice(w, "blue", intel, k, 1).active, k).toBe(true);
    for (const k of ["stinger", "titan", "wasp", "turret"] as const)
      expect(counterAdvice(w, "blue", intel, k, 1).active, k).toBe(false);
    expect(adviceNote(counterAdvice(w, "blue", intel, "flak-crawler", 1))).toBe("Counters Wasps (seen ×2)");
    // two wasps (400) vs flak: queued and built flak both count toward the answer
    const fab = [...w.buildings.values()].find((b) => b.kind === "fab-plant")!;
    fab.queue.push({ kind: "flak-crawler", remaining: 100 });
    expect(counterAdvice(w, "blue", intel, "flak-crawler", 1).active).toBe(true); // 190 < 300
    spawnUnit(w, "flak-crawler", "blue", 6, 9);
    expect(counterAdvice(w, "blue", intel, "flak-crawler", 1).active).toBe(false); // 380 ≥ 300
    // the info card still explains it
    expect(adviceNote(counterAdvice(w, "blue", intel, "flak-crawler", 1))).toBe("Counters Wasps (seen ×2)");
  });

  it("never suggests an option the match rules ban (Air War: no Flak, no SAM Sites)", () => {
    const w = scene();
    applyMutators(w, ["airwar"]);
    const intel = new EnemyIntel(w, "blue");
    spawnUnit(w, "wasp", "red", 8, 9);
    spawnUnit(w, "wasp", "red", 9, 9);
    tickFog(w);
    intel.update(0);
    for (const k of ["flak-crawler", "sam-site"] as const) {
      expect(counterAdvice(w, "blue", intel, k, 0).active, k).toBe(false);
      expect(adviceNote(counterAdvice(w, "blue", intel, k, 0)), k).toBeNull();
    }
    // the allowed answer still lights up
    expect(counterAdvice(w, "blue", intel, "raptor", 0).active).toBe(true);
    expect(adviceNote(counterAdvice(w, "blue", intel, "raptor", 0))).toBe("Counters Wasps (seen ×2)");
    // an op's one-sided ban counts too
    const op = scene();
    op.rules = { ...rulesOf(op), sideBans: { blue: { units: ["raptor"] } } };
    const intel2 = new EnemyIntel(op, "blue");
    spawnUnit(op, "wasp", "red", 8, 9);
    spawnUnit(op, "wasp", "red", 9, 9);
    tickFog(op);
    intel2.update(0);
    expect(counterAdvice(op, "blue", intel2, "raptor", 0).active).toBe(false);
    expect(counterAdvice(op, "blue", intel2, "flak-crawler", 0).active).toBe(true);
  });

  it("lists several threats, most seen first", () => {
    const w = scene();
    const intel = new EnemyIntel(w, "blue");
    spawnUnit(w, "hornet", "red", 8, 9);
    for (let i = 0; i < 3; i++) spawnUnit(w, "wasp", "red", 9 + i * 0.5, 10);
    tickFog(w);
    intel.update(0);
    expect(adviceNote(counterAdvice(w, "blue", intel, "raptor", 0))).toBe("Counters Wasps (seen ×3), Hornets (×1)");
    expect(adviceNote(counterAdvice(w, "blue", intel, "stinger", 0))).toBeNull();
  });

  it("every counter entry is something you can build, against something that exists", () => {
    for (const [k, threats] of Object.entries(COUNTERS)) {
      expect(k in UNITS || k in BUILDINGS).toBe(true);
      for (const t of threats!) expect(t in UNITS || t === "turret" || t === "sam-site").toBe(true);
    }
  });

  it("nudges a factory idle for a while when you can afford its units", () => {
    const w = scene();
    const idle = new IdleWatch(w, "blue");
    w.factions.blue.scrap = 1000;
    expect(idle.update(0)).toEqual({ ground: false, air: false });
    expect(idle.update(ADVISOR.idleS - 0.1)).toEqual({ ground: false, air: false });
    expect(idle.update(ADVISOR.idleS + 0.1)).toEqual({ ground: true, air: true });
    // busy again: the clock restarts
    const pad = [...w.buildings.values()].find((b) => b.kind === "airpad")!;
    pad.queue.push({ kind: "wasp", remaining: 50 });
    expect(idle.update(ADVISOR.idleS + 0.2).air).toBe(false);
    pad.queue.length = 0;
    expect(idle.update(ADVISOR.idleS + 1).air).toBe(false);
    expect(idle.update(2 * ADVISOR.idleS + 1.1).air).toBe(true);
    // broke: no nudge (the cheapest Fab unit costs 150)
    w.factions.blue.scrap = UNITS.stinger.cost - 1;
    expect(idle.update(100).ground).toBe(false);
    expect(ECONOMY.maxQueue).toBeGreaterThan(0);
  });
});

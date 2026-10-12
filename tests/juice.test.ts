import { describe, expect, it } from "vitest";
import {
  DepositPops,
  FlashClock,
  HpTrail,
  JUICE,
  SpendWatch,
  barBlink,
  coinPitch,
  combatAge,
  deathCue,
  enemyBarColor,
  ringStrength,
  shakeFor
} from "../src/game/juice";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import type { FxEvent } from "../src/sim/types";
import { buildingCenter, createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";

type Death = Extract<FxEvent, { type: "death" }>;
const death = (over: Partial<Death>): Death => ({
  type: "death", id: 1, faction: "red", unitKind: "stinger", buildingKind: null, x: 5, y: 5, air: false,
  value: 150, killerId: null, killerKind: null, rank: 0, kills: 0, ...over
});

describe("hit flash clock", () => {
  it("flashes for flashMs and throttles repeat hits per entity", () => {
    const c = new FlashClock();
    expect(c.hit(7, 1000)).toBe(true);
    expect(c.active(7, 1000 + JUICE.flashMs - 1)).toBe(true);
    expect(c.active(7, 1000 + JUICE.flashMs)).toBe(false);
    expect(c.hit(7, 1000 + JUICE.flashGapMs - 1)).toBe(false); // throttled
    expect(c.hit(8, 1010)).toBe(true); // other entities are independent
    expect(c.hit(7, 1000 + JUICE.flashGapMs)).toBe(true);
  });

  it("fades its level from 1 to 0 and supports building timings", () => {
    const c = new FlashClock();
    c.hit(3, 0, 100, 280);
    expect(c.level(3, 0, 100)).toBe(1);
    expect(c.level(3, 50, 100)).toBeCloseTo(0.5);
    expect(c.level(3, 100, 100)).toBe(0);
    expect(c.hit(3, 200, 100, 280)).toBe(false);
    expect(c.hit(3, 280, 100, 280)).toBe(true);
  });

  it("caps a sustained barrage at one flash per gap, and forgets old entities", () => {
    const c = new FlashClock();
    let flashes = 0;
    // 40 hits a second on one target for 3 s (a big focus-fire)
    for (let t = 0; t < 3000; t += 25) if (c.hit(1, t)) flashes++;
    expect(flashes).toBeLessThanOrEqual(Math.ceil(3000 / JUICE.flashGapMs));
    expect(flashes).toBeGreaterThan(10);
    for (let id = 100; id < 400; id++) c.hit(id, 0);
    for (let id = 400; id < 600; id++) c.hit(id, 10_000);
    expect(c.size).toBeLessThan(300); // stale ids got swept
  });
});

describe("damage-trail health bars", () => {
  it("holds the lost chunk, then drains it at trailRate per second", () => {
    const t = new HpTrail();
    expect(t.update(1, 1, 1, 0)).toBe(1);
    expect(t.update(1, 0.6, 1, 10)).toBe(1); // hit: the chunk stays
    expect(t.update(1, 0.6, 1, 10 + JUICE.trailHoldMs - 1)).toBe(1);
    const after = t.update(1, 0.6, 1, 10 + JUICE.trailHoldMs + 100);
    expect(after).toBeCloseTo(1 - JUICE.trailRate * 0.1, 5);
    expect(t.update(1, 0.6, 1, 5000)).toBe(0.6); // never below real hp
    expect(t.value(1)).toBe(0.6);
  });

  it("keeps draining under sustained fire instead of freezing", () => {
    const t = new HpTrail();
    t.update(1, 100, 100, 0);
    let hp = 100;
    let shown = 100;
    for (let ms = 100; ms <= 2000; ms += 100) {
      hp -= 4;
      shown = t.update(1, hp, 100, ms);
    }
    // 2 s of fire: the trail has caught most of the way down, not stuck at 100
    expect(shown).toBeLessThan(80);
    expect(shown).toBeGreaterThanOrEqual(hp);
  });

  it("snaps up when healed and forgets dead entities", () => {
    const t = new HpTrail();
    t.update(1, 0.5, 1, 0);
    expect(t.update(1, 0.8, 1, 50)).toBe(0.8);
    t.update(2, 1, 1, 0);
    t.retain((id) => id === 2);
    expect(t.size).toBe(1);
    expect(t.value(1)).toBeUndefined();
  });

  it("blinks only enemy bars, only when critical, at 2 Hz", () => {
    expect(barBlink(0.1, true, 300)).toBe(1);
    expect(barBlink(0.5, false, 300)).toBe(1);
    expect(barBlink(0.2, false, 100)).toBe(1);
    expect(barBlink(0.2, false, 300)).toBeLessThan(1);
    expect(barBlink(0.2, false, 600)).toBe(1);
    expect(enemyBarColor(0.1)).not.toBe(enemyBarColor(0.9));
  });
});

describe("team combat rings", () => {
  it("light up shooter and victim, then fade within the combat window", () => {
    const w = createWorld(20, 20);
    const a = spawnUnit(w, "stinger", "blue", 5.5, 5.5);
    const b = spawnUnit(w, "stinger", "red", 7.5, 5.5);
    expect(ringStrength(combatAge(a, w.tick))).toBe(0); // fresh units: no ring
    for (let i = 0; i < 20; i++) step(w, []);
    expect(ringStrength(combatAge(a, w.tick))).toBe(1);
    expect(ringStrength(combatAge(b, w.tick))).toBe(1);
    // pull them apart: the rings fade out once the shooting stops
    a.x = 1.5;
    b.x = 18.5;
    a.order = b.order = { type: "idle" };
    const last = w.tick;
    for (let i = 0; i < JUICE.combatTicks + 5; i++) {
      step(w, []);
      a.x = 1.5;
      b.x = 18.5;
    }
    expect(w.tick - last).toBeGreaterThan(JUICE.combatTicks);
    expect(ringStrength(combatAge(a, w.tick))).toBe(0);
  });

  it("fades smoothly over the last ticks", () => {
    expect(ringStrength(0)).toBe(1);
    expect(ringStrength(JUICE.combatTicks - JUICE.ringFadeTicks)).toBe(1);
    const mid = ringStrength(JUICE.combatTicks - JUICE.ringFadeTicks / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(ringStrength(JUICE.combatTicks)).toBe(0);
    expect(ringStrength(-1)).toBe(0);
  });

  it("building hits flash the building (hit event carries its id)", () => {
    const w = createWorld(20, 20);
    spawnUnit(w, "mastodon", "blue", 5.5, 5.5);
    const radar = spawnBuilding(w, "radar", "red", 8, 5);
    const hits: FxEvent[] = [];
    for (let i = 0; i < 30; i++) {
      step(w, []);
      hits.push(...w.fx.filter((e) => e.type === "hit"));
    }
    expect(hits[0]).toMatchObject({ type: "hit", id: radar.id, building: true, faction: "red" });
  });
});

describe("death cues", () => {
  it("tells kills from losses", () => {
    expect(deathCue(death({ faction: "red" }), "blue", false, true).sound).toBe("kill");
    expect(deathCue(death({ faction: "red" }), "blue", false, false).sound).toBeNull(); // fogged
    expect(deathCue(death({ faction: "blue" }), "blue", false, false).sound).toBe("lost");
  });

  it("vibrates only for our lost buildings, and stays quiet for spectators", () => {
    const ours = death({ faction: "blue", unitKind: null, buildingKind: "depot" });
    expect(deathCue(ours, "blue", false, true)).toEqual({ sound: null, vibrate: true });
    expect(deathCue(death({ faction: "red", unitKind: null, buildingKind: "depot" }), "blue", false, true).vibrate).toBe(false);
    expect(deathCue(death({ faction: "blue" }), "blue", true, true)).toEqual({ sound: null, vibrate: false });
    expect(deathCue(death({ faction: "red" }), "blue", true, true)).toEqual({ sound: null, vibrate: false });
  });

  it("scales camera shake with what died and keeps small deaths subtle", () => {
    const stinger = shakeFor({ unitKind: "stinger", buildingKind: null });
    const mastodon = shakeFor({ unitKind: "mastodon", buildingKind: null });
    const turret = shakeFor({ unitKind: null, buildingKind: "turret" });
    const fab = shakeFor({ unitKind: null, buildingKind: "fab-plant" });
    const hq = shakeFor({ unitKind: null, buildingKind: "hq" });
    expect(stinger.intensity).toBeLessThan(0.0015);
    expect(mastodon.intensity).toBeGreaterThan(stinger.intensity);
    expect(fab.intensity).toBeGreaterThan(turret.intensity);
    expect(hq.intensity).toBeGreaterThan(fab.intensity);
    expect(hq.ms).toBeGreaterThan(stinger.ms);
    expect(hq.intensity).toBeLessThan(0.01);
  });
});

describe("economy pops", () => {
  it("merges deliveries at one drop-off and keeps others separate", () => {
    const p = new DepositPops();
    expect(p.add(1, 100, 0)).toMatchObject({ amount: 100, merged: false, streak: 0 });
    expect(p.add(1, 100, 200)).toMatchObject({ amount: 200, merged: true, streak: 1 });
    expect(p.add(2, 100, 250)).toMatchObject({ amount: 100, merged: false, streak: 2 });
    expect(p.add(1, 100, 200 + JUICE.popMergeMs)).toMatchObject({ amount: 100, merged: false });
  });

  it("builds a rising coin streak that resets after a pause", () => {
    const p = new DepositPops();
    const streaks = [0, 2000, 4000, 6000].map((t, i) => p.add(i, 100, t).streak);
    expect(streaks).toEqual([0, 1, 2, 3]);
    expect(p.add(9, 100, 6000 + JUICE.streakMs + 1).streak).toBe(0);
    const pitches = [0, 1, 2, 3, 4, 5, 6, 9].map(coinPitch);
    for (let i = 1; i < pitches.length; i++) expect(pitches[i]).toBeGreaterThanOrEqual(pitches[i - 1]!);
    expect(coinPitch(0)).toBe(1);
    expect(coinPitch(99)).toBe(2); // capped at an octave
  });

  it("deposit events land on the drop-off centre, so pops can merge per drop-off", () => {
    const w = createMapWorld("proving-grounds");
    const hq = [...w.buildings.values()].find((b) => b.faction === "blue" && b.kind === "hq")!;
    const h = [...w.units.values()].find((u) => u.faction === "blue" && u.kind === "harvester")!;
    step(w, [{ type: "harvest", faction: "blue", unitIds: [h.id], x: 13.5, y: 37.5 }]);
    const pops = new DepositPops();
    let shown = 0;
    for (let i = 0; i < 60 * 10; i++) {
      step(w, []);
      for (const e of w.fx)
        if (e.type === "deposit" && e.faction === "blue") {
          expect({ x: e.x, y: e.y }).toEqual(buildingCenter(hq));
          if (!pops.add(Math.round(e.x * 2) * 4096 + Math.round(e.y * 2), e.amount, i * 100).merged) shown++;
        }
    }
    expect(shown).toBeGreaterThanOrEqual(2);
  });

  it("flags purchases on the scrap pill, not income or the HQ trickle", () => {
    const s = new SpendWatch();
    expect(s.update(600)).toBe(0);
    expect(s.update(602)).toBe(0);
    expect(s.update(601)).toBe(0);
    expect(s.update(451)).toBe(150);
    expect(s.update(551)).toBe(0);
    // a real purchase through the sim
    const w = createMapWorld("riverlands");
    const watch = new SpendWatch();
    watch.update(w.factions.blue.scrap);
    step(w, [{ type: "startBuilding", faction: "blue", building: "fab-plant" }]);
    expect(watch.update(w.factions.blue.scrap)).toBeGreaterThanOrEqual(JUICE.spendThreshold);
  });
});

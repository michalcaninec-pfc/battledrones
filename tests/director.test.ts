import { describe, expect, it } from "vitest";
import type { Faction, FxEvent, World } from "../src/sim/types";
import { createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";
import { CINE, Director, zoomForSpread } from "../src/game/director";

const hit = (faction: Faction, id: number, x: number, y: number, building = false): FxEvent => ({
  type: "hit", faction, id, x, y, building, attackerId: 0
});
const shot = (x: number, y: number): FxEvent => ({
  type: "shot", fx: "cannon", x: x - 2, y, tx: x, ty: y, fromAir: false, air: false, sourceId: 0
});

/** A skirmish-sized world: two HQs, an army each. */
function battle(): World {
  const w = createWorld(96, 96);
  spawnBuilding(w, "hq", "blue", 6, 6);
  spawnBuilding(w, "hq", "red", 86, 86);
  for (let i = 0; i < 4; i++) {
    spawnUnit(w, "stinger", "blue", 20 + i, 20);
    spawnUnit(w, "stinger", "red", 70 + i, 74);
  }
  return w;
}

/** Run `s` real seconds at 60 fps, feeding `fx(t)` every sim tick (10 Hz). */
function run(d: Director, view: { x: number; y: number; zoom: number }, s: number, simT: { t: number }, fx: (t: number) => FxEvent[] = () => []) {
  let last = null as ReturnType<Director["update"]>;
  let cuts = 0;
  const frames = Math.round(s * 60);
  for (let i = 0; i < frames; i++) {
    if (i % 6 === 0) {
      simT.t += 0.1;
      d.events(fx(simT.t), simT.t);
    }
    last = d.update(1 / 60, view);
    if (last) {
      view.x = last.x;
      view.y = last.y;
      view.zoom = last.zoom;
      if (last.cut) cuts++;
    }
  }
  return { last, cuts };
}

const near = (a: { x: number; y: number }, x: number, y: number, tiles: number) => Math.hypot(a.x - x, a.y - y) < tiles;

describe("cinematic camera director", () => {
  it("tours the armies while nothing is happening", () => {
    const w = battle();
    const d = new Director(w);
    const view = { x: 48, y: 48, zoom: 42 };
    const t = { t: 0 };
    // the first look goes to one side's army, the next tour stop to the other's
    run(d, view, 6, t);
    const first = { ...view };
    run(d, view, CINE.tourS + 2, t);
    const blue = { x: 21.5, y: 20 };
    const red = { x: 71.5, y: 74 };
    const at = (p: { x: number; y: number }) => (near(p, blue.x, blue.y, 6) ? "blue" : near(p, red.x, red.y, 6) ? "red" : "?");
    expect(at(first)).not.toBe("?");
    expect(at(view)).not.toBe("?");
    expect(at(view)).not.toBe(at(first));
  });

  it("glides onto a fight and follows it, zoomed for how spread out it is", () => {
    const w = battle();
    const d = new Director(w);
    const view = { x: 48, y: 48, zoom: 42 };
    const t = { t: 0 };
    run(d, view, 1, t);
    const fight = () => [shot(40, 30), hit("red", 99, 40.5, 30.5), shot(41, 31)];
    const r = run(d, view, 6, t, fight);
    expect(r.cuts).toBe(0); // a fight in the open is a glide, not a cut
    expect(near(view, 40.5, 30.5, 3)).toBe(true);
    expect(view.zoom).toBeGreaterThan(CINE.zoom.mid); // a tight scrap: in close
    // the fight moves; the camera goes with it
    run(d, view, 6, t, () => [shot(48, 34), hit("red", 99, 48.5, 34.5)]);
    expect(near(view, 48.5, 34.5, 3)).toBe(true);
  });

  it("doesn't flick between two similar fights", () => {
    const w = battle();
    const d = new Director(w);
    const view = { x: 48, y: 48, zoom: 42 };
    const t = { t: 0 };
    run(d, view, 4, t, () => [hit("red", 1, 30, 30), shot(30, 30)]);
    expect(near(view, 30, 30, 3)).toBe(true);
    // a second, slightly hotter fight across the map: not enough to leave this one
    run(d, view, 8, t, () => [hit("red", 1, 30, 30), shot(30, 30), hit("blue", 2, 70, 60), shot(70, 60), shot(70, 60)]);
    expect(near(view, 30, 30, 3)).toBe(true);
  });

  it("cuts to a far-off surprise, but not twice in a row", () => {
    const w = battle();
    const d = new Director(w);
    const view = { x: 20, y: 20, zoom: 42 };
    const t = { t: 0 };
    run(d, view, 3, t, () => [hit("red", 1, 22, 22), shot(22, 22)]);
    const strike: FxEvent = { type: "calldown", id: 1, faction: "blue", power: "barrage", x: 80, y: 70, radius: 3, landTick: 999 };
    let fired = false;
    const r = run(d, view, 0.5, t, () => (fired ? [] : ((fired = true), [strike])));
    expect(r.cuts).toBe(1);
    expect(near(view, 80, 70, 3)).toBe(true);
    // another surprise far away right after: a glide at most (the cut cooldown)
    fired = false;
    const again: FxEvent = { ...strike, id: 2, x: 15, y: 80 };
    const r2 = run(d, view, CINE.holdAfterSurpriseS + 1, t, () => (fired ? [] : ((fired = true), [again])));
    expect(r2.cuts).toBe(0);
  });

  it("first shots on an HQ are a surprise; the siege after them isn't", () => {
    const w = battle();
    const hq = [...w.buildings.values()].find((b) => b.faction === "red")!;
    const d = new Director(w);
    const view = { x: 20, y: 20, zoom: 42 };
    const t = { t: 0 };
    run(d, view, 3, t, () => [hit("red", 1, 22, 22), shot(22, 22)]);
    let n = 0;
    const r = run(d, view, 1, t, () => (n++ < 1 ? [hit("red", hq.id, 87.5, 87.5, true)] : []));
    expect(r.cuts).toBe(1);
  });

  it("stands aside while the player has the camera, then takes it back smoothly", () => {
    const w = battle();
    const d = new Director(w);
    const view = { x: 48, y: 48, zoom: 42 };
    const t = { t: 0 };
    run(d, view, 2, t);
    d.hold();
    expect(d.held).toBe(true);
    expect(d.update(1 / 60, view)).toBeNull();
    // the player looks somewhere else
    view.x = 10;
    view.y = 90;
    run(d, view, CINE.handBackS - 1, t);
    expect(view).toMatchObject({ x: 10, y: 90 });
    // handed back: it starts from where the player left the camera, no jump
    const r = run(d, view, 1.2, t);
    expect(d.held).toBe(false);
    expect(r.cuts).toBe(0);
    expect(near(view, 10, 90, 4)).toBe(true);
  });

  it("zooms in on tight action and out on sprawling action", () => {
    expect(zoomForSpread(0.5)).toBeGreaterThan(zoomForSpread(3));
    expect(zoomForSpread(3)).toBeGreaterThan(zoomForSpread(10));
    expect(zoomForSpread(0)).toBeLessThanOrEqual(CINE.zoom.close);
    expect(zoomForSpread(50)).toBeGreaterThanOrEqual(CINE.zoom.wide);
  });
});

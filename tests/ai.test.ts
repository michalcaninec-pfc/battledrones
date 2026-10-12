import { describe, expect, it } from "vitest";
import { STRATEGIES, createAiState, tickAi } from "../src/sim/ai/commander";
import { CONDOR_AI } from "../src/sim/ai/condor";
import { planMenders } from "../src/sim/ai/menders";
import { AA_COVER, aaWeight } from "../src/sim/ai/intel";
import { BUILDINGS, TICK_RATE, UNITS } from "../src/sim/balance";
import { unitSeenBy } from "../src/sim/infantry";
import { createSkirmishWorld } from "../src/sim/map";
import { nearestScrapTile } from "../src/sim/economy";
import { tickFog } from "../src/sim/fog";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import { buildingCenter, hqOf, setTerrain, spawnBuilding, spawnUnit } from "../src/sim/world";
import { Terrain, type FxEvent, type World } from "../src/sim/types";

function runWithAi(w: World, seconds: number, state = createAiState()) {
  for (let i = 0; i < seconds * TICK_RATE; i++) {
    if (w.winner) break;
    step(w, tickAi(w, "red", state));
  }
  return state;
}

describe("AI commander", () => {
  it("follows the opening build order: harvesters, fab plant, airpad", () => {
    const w = createSkirmishWorld();
    runWithAi(w, 120, createAiState("balanced"));
    const red = [...w.units.values()].filter((u) => u.faction === "red");
    const redBuildings = [...w.buildings.values()].filter((b) => b.faction === "red");
    expect(red.filter((u) => u.kind === "harvester").length).toBeGreaterThanOrEqual(2);
    expect(redBuildings.some((b) => b.kind === "fab-plant")).toBe(true);
    expect(redBuildings.some((b) => b.kind === "airpad")).toBe(true);
  });

  it("keeps its harvesters mining (economy grows)", () => {
    const w = createSkirmishWorld();
    runWithAi(w, 90, createAiState("balanced"));
    // it has been spending, so measure gross income: scrap removed from fields
    let fieldScrap = 0;
    for (let i = 0; i < w.scrap.length; i++) fieldScrap += w.scrap[i]!;
    const fresh = createSkirmishWorld();
    let freshScrap = 0;
    for (let i = 0; i < fresh.scrap.length; i++) freshScrap += fresh.scrap[i]!;
    expect(fieldScrap).toBeLessThan(freshScrap);
  });

  it("builds anti-air after spotting enemy air power", () => {
    const w = createSkirmishWorld();
    const state = createAiState("balanced");
    runWithAi(w, 100, state);
    // park blue wasps mid-map with a red scout beside them: red plainly
    // sees enemy air, and wasps (ground-only weapons) can't kill the scout
    // — nothing dies, no HQ gets razed, the match keeps running
    for (let i = 0; i < 4; i++) spawnUnit(w, "wasp", "blue", 18.5 + i * 0.4, 18.5);
    spawnUnit(w, "scout", "red", 19.5, 19.5);
    let sawFlak = false;
    for (let i = 0; i < 90 * TICK_RATE; i++) {
      step(w, tickAi(w, "red", state));
      if (
        [...w.units.values()].some(
          (u) => u.faction === "red" && u.kind === "flak-crawler"
        )
      )
        sawFlak = true;
    }
    expect(state.seenAir).toBeGreaterThan(1);
    expect(sawFlak).toBe(true);
  });

  it("escalates to assault mode once its army is large", () => {
    const w = createSkirmishWorld();
    const state = createAiState("balanced");
    // hand it a big army
    for (let i = 0; i < 6; i++) {
      spawnUnit(w, "stinger", "red", 38.5 + (i % 3), 8.5 + Math.floor(i / 3));
      spawnUnit(w, "wasp", "red", 34.5 + (i % 3), 8.5 + Math.floor(i / 3));
    }
    runWithAi(w, 10, state);
    expect(state.mode).toBe("assault");
  });

  it("beats a completely passive opponent inside 12 minutes", () => {
    const w = createSkirmishWorld();
    runWithAi(w, 12 * 60, createAiState("balanced"));
    expect(w.winner).toBe("red");
  }, 30000);

  it("every strategy beats a passive opponent inside 15 minutes", () => {
    for (const name of Object.keys(STRATEGIES) as (keyof typeof STRATEGIES)[]) {
      const w = createSkirmishWorld();
      runWithAi(w, 15 * 60, createAiState(name));
      expect(w.winner, `strategy ${name} failed to win`).toBe("red");
    }
  }, 120000);

  it("skyforce leads with an air force; ground units only guard home", () => {
    const w = createSkirmishWorld();
    const state = createAiState("skyforce");
    let maxStingers = 0;
    for (let i = 0; i < 6 * 60 * TICK_RATE && !w.winner; i++) {
      step(w, tickAi(w, "red", state));
      const red = [...w.units.values()].filter((u) => u.faction === "red");
      maxStingers = Math.max(maxStingers, red.filter((u) => u.kind === "stinger").length);
      for (const u of red) expect(["mastodon", "mortar", "lancer"]).not.toContain(u.kind);
    }
    expect(maxStingers).toBeLessThanOrEqual(4);
    const redBuildings = [...w.buildings.values()].filter((b) => b.faction === "red");
    expect(redBuildings.some((b) => b.kind === "airpad")).toBe(true);
    expect(redBuildings.some((b) => b.kind === "turret")).toBe(true);
    // it actually fields an air force
    const air = [...w.units.values()].filter(
      (u) => u.faction === "red" && (u.kind === "wasp" || u.kind === "raptor")
    );
    expect(air.length).toBeGreaterThan(0);
  }, 60000);

  it("dispatches capable defenders at an unengaged intruder (threat response)", () => {
    const w = createSkirmishWorld();
    const state = createAiState("balanced");
    runWithAi(w, 150, state); // build up an army with an airpad + fab
    // give red an idle interceptor at base, then park a blue wasp on the
    // red harvester line, plainly visible and engaging nobody
    const raptor = spawnUnit(w, "raptor", "red", 40.5, 7.5);
    void raptor;
    const intruder = spawnUnit(w, "wasp", "blue", 36.5, 10.5);
    let answered = false;
    for (let i = 0; i < 30 * TICK_RATE && !answered; i++) {
      step(w, tickAi(w, "red", state));
      for (const u of w.units.values())
        if (
          u.faction === "red" &&
          u.order.type === "attack" &&
          u.order.targetId === intruder.id
        )
          answered = true;
      if (!w.units.has(intruder.id)) answered = true; // or they just killed it
    }
    expect(answered).toBe(true);
  }, 30000);

  it("places turrets covering the mining line, not a random ring tile", () => {
    const w = createSkirmishWorld();
    const state = createAiState("skyforce"); // three turrets in its build order
    runWithAi(w, 240, state);
    const turrets = [...w.buildings.values()].filter(
      (b) => b.faction === "red" && b.kind === "turret"
    );
    expect(turrets.length).toBeGreaterThanOrEqual(1);
    // red home field centres around (34, 10); turrets should lean that way
    const nearField = turrets.some(
      (t) => Math.hypot(t.tx + 0.5 - 34, t.ty + 0.5 - 10) < 8
    );
    expect(nearField).toBe(true);
  }, 30000);

  it("AI vs AI reaches a decisive result inside 25 minutes", () => {
    const w = createSkirmishWorld();
    const red = createAiState("rush");
    const blue = createAiState("boom");
    for (let i = 0; i < 25 * 60 * TICK_RATE && !w.winner; i++)
      step(w, [...tickAi(w, "red", red), ...tickAi(w, "blue", blue)]);
    expect(w.winner).not.toBeNull();
  }, 120000);
});

describe("AI and robot infantry", () => {
  const units = (w: World, f: "blue" | "red", kind?: string) =>
    [...w.units.values()].filter((u) => u.faction === f && (!kind || u.kind === kind));

  it("weighs anti-air by what it does to aircraft: a lone rifle squad is not flak", () => {
    expect(aaWeight(UNITS["flak-crawler"])).toBe(1);
    expect(aaWeight(UNITS.raptor)).toBe(1);
    expect(aaWeight(UNITS.lancer)).toBeCloseTo(0.6, 9);
    expect(aaWeight(UNITS.stinger)).toBe(0);
    expect(aaWeight(UNITS.trooper)).toBeLessThan(AA_COVER);
    expect(aaWeight(UNITS["rocket-squad"])).toBeGreaterThanOrEqual(AA_COVER);
  });

  it("tallies the robot infantry it sees, but not a Sniper Team hidden in the woods", () => {
    const w = createMapWorld("proving-grounds");
    const ai = createAiState("balanced", "normal", 1);
    const hq = buildingCenter(hqOf(w, "red")!);
    const squads = [0, 1, 2].map((i) => spawnUnit(w, "trooper", "blue", hq.x - 5 + i * 0.8, hq.y + 4));
    // in sight of the HQ, more than INFANTRY.concealRadius from anything of red's
    const tx = Math.floor(hq.x) + 1;
    const ty = Math.floor(hq.y) + 6;
    setTerrain(w, tx, ty, Terrain.Forest);
    const sniper = spawnUnit(w, "sniper", "blue", tx + 0.5, ty + 0.5);
    for (const u of [...squads, sniper]) w.powers.stunned.set(u.id, 1e9);
    for (let i = 0; i < 30; i++) step(w, []); // fog settles; the sniper hasn't fired
    expect(unitSeenBy(w, "red", squads[0]!)).toBe(true);
    expect(unitSeenBy(w, "red", sniper)).toBe(false);
    tickAi(w, "red", ai);
    expect(ai.seenInfantry).toBe(3);
    // out of the woods it shows
    setTerrain(w, tx, ty, Terrain.Ground);
    ai.lastDecisionTick = -1000;
    tickAi(w, "red", ai);
    expect(ai.seenInfantry).toBe(4);
  });

  for (const [diff, snipers] of [["normal", true], ["easy", false]] as const)
    it(`answers Mastodons with Rocket Squads and enemy squads with ${snipers ? "Sniper Teams" : "no Snipers (Easy)"}`, () => {
      const w = createMapWorld("proving-grounds");
      const ai = createAiState("ironclad", diff, 1);
      const hq = hqOf(w, "red")!;
      const c = buildingCenter(hq);
      spawnBuilding(w, "assembly-bay", "red", hq.tx - 3, hq.ty + 4);
      spawnBuilding(w, "tech-lab", "red", hq.tx + 1, hq.ty + 4);
      w.factions.red.scrap = 6000;
      const foes = [
        ...[0, 1].map((i) => spawnUnit(w, "mastodon", "blue", c.x - 6 + i, c.y + 5)),
        ...[0, 1, 2, 3, 4, 5].map((i) => spawnUnit(w, "trooper", "blue", c.x - 6 + (i % 3) * 0.8, c.y + 6.5 + Math.floor(i / 3) * 0.8))
      ];
      for (const u of foes) w.powers.stunned.set(u.id, 1e9);
      const built = new Set<string>();
      for (let i = 0; i < 40 * TICK_RATE; i++) {
        const cmds = tickAi(w, "red", ai);
        for (const cmd of cmds) if (cmd.type === "produce") built.add(cmd.unit);
        step(w, cmds);
      }
      expect(ai.seenHeavy).toBeGreaterThanOrEqual(1);
      expect(ai.seenInfantry).toBeGreaterThanOrEqual(3);
      expect(built.has("rocket-squad")).toBe(true);
      expect(built.has("sniper")).toBe(snipers);
    });

  it("answers an intruder with units that can hurt it: no Sniper Team sent at a tank", () => {
    const w = createMapWorld("proving-grounds");
    const ai = createAiState("balanced", "normal", 1);
    const c = buildingCenter(hqOf(w, "red")!);
    const sniper = spawnUnit(w, "sniper", "red", c.x - 1, c.y + 3);
    const tank = spawnUnit(w, "stinger", "red", c.x, c.y + 3);
    const intruder = spawnUnit(w, "stinger", "blue", c.x - 6, c.y + 6);
    w.powers.stunned.set(intruder.id, 1e9);
    step(w, []);
    const cmds = tickAi(w, "red", ai);
    const answer = cmds.find((cmd) => cmd.type === "attack" && cmd.targetId === intruder.id);
    expect(answer).toBeDefined();
    expect((answer as { unitIds: number[] }).unitIds).toContain(tank.id);
    expect((answer as { unitIds: number[] }).unitIds).not.toContain(sniper.id);
    // …but a squad of robot infantry is the Sniper's to answer
    const w2 = createMapWorld("proving-grounds");
    const ai2 = createAiState("balanced", "normal", 1);
    const sniper2 = spawnUnit(w2, "sniper", "red", c.x - 1, c.y + 3);
    const squad = spawnUnit(w2, "trooper", "blue", c.x - 6, c.y + 6);
    w2.powers.stunned.set(squad.id, 1e9);
    step(w2, []);
    const cmds2 = tickAi(w2, "red", ai2);
    expect(cmds2.some((cmd) => cmd.type === "attack" && cmd.targetId === squad.id && cmd.unitIds.includes(sniper2.id))).toBe(true);
  });

  it("launches a wave with the robot infantry still marching up to the staging point", () => {
    const w = createMapWorld("proving-grounds");
    const ai = createAiState("balanced", "normal", 1);
    const hq = buildingCenter(hqOf(w, "red")!);
    const far = { x: w.width - hq.x, y: w.height - hq.y }; // the enemy HQ, as red guesses it
    const len = Math.hypot(far.x - hq.x, far.y - hq.y);
    const stage = { x: hq.x + ((far.x - hq.x) / len) * 9, y: hq.y + ((far.y - hq.y) / len) * 9 };
    // a wave's worth gathered at the staging point…
    for (let i = 0; i < 12; i++) spawnUnit(w, "stinger", "red", stage.x - 1 + (i % 4) * 0.7, stage.y - 1 + Math.floor(i / 4) * 0.7);
    // …and a Trooper Squad still on its way there (slow: 1.8 tiles/s)
    const late = spawnUnit(w, "trooper", "red", hq.x + ((far.x - hq.x) / len) * 2, hq.y + ((far.y - hq.y) / len) * 2);
    late.order = { type: "attackMove", x: stage.x, y: stage.y };
    step(w, []);
    const cmds = tickAi(w, "red", ai);
    expect(ai.mode).toBe("assault");
    const wave = cmds.filter((c) => (c.type === "attack" || c.type === "attackMove") && c.unitIds.includes(late.id));
    expect(wave).toHaveLength(1);
    expect(wave[0]!.type === "attackMove" && Math.hypot(wave[0]!.x - stage.x, wave[0]!.y - stage.y) < 1).toBe(false);
  });

  it("Rush opens with an Assembly Bay and fields Troopers alongside its Stingers", () => {
    const w = createSkirmishWorld();
    const ai = createAiState("rush", "normal", 1);
    runWithAi(w, 180, ai);
    const red = [...w.buildings.values()].filter((b) => b.faction === "red").map((b) => b.kind);
    expect(red).toContain("assembly-bay");
    expect(units(w, "red", "trooper").length).toBeGreaterThanOrEqual(3); // the starting squad and more
    expect(units(w, "red", "stinger").length).toBeGreaterThanOrEqual(1);
  });

  it("Ironclad escorts its Mastodons with Rocket Squads, one per Mastodon", () => {
    const w = createMapWorld("proving-grounds");
    const ai = createAiState("ironclad", "normal", 1);
    const hq = hqOf(w, "red")!;
    const c = buildingCenter(hq);
    spawnBuilding(w, "assembly-bay", "red", hq.tx - 3, hq.ty + 4);
    for (let i = 0; i < 3; i++) spawnUnit(w, "mastodon", "red", c.x - 3 + i * 1.2, c.y + 8);
    w.factions.red.scrap = 3000;
    const rockets: number[] = [];
    for (let i = 0; i < 60 * TICK_RATE; i++) {
      const cmds = tickAi(w, "red", ai);
      for (const cmd of cmds) if (cmd.type === "produce" && cmd.unit === "rocket-squad") rockets.push(w.tick);
      step(w, cmds);
    }
    // nothing of the enemy's seen: the Rockets are for its own Mastodons
    expect(ai.seenHeavy).toBe(0);
    expect(rockets).toHaveLength(3);
  });

  /** Red, mid-game: an Airpad, an Assembly Bay, a Condor and a few squads at home. */
  function dropSetup(diff: "normal" | "easy", strategy: "balanced" | "rush" | "boom" = "balanced") {
    const w = createMapWorld("proving-grounds");
    const ai = createAiState(strategy, diff, 1);
    const hq = hqOf(w, "red")!;
    const c = buildingCenter(hq);
    spawnBuilding(w, "airpad", "red", hq.tx - 3, hq.ty + 4);
    spawnBuilding(w, "assembly-bay", "red", hq.tx + 1, hq.ty + 4);
    spawnUnit(w, "condor", "red", c.x + 0.5, c.y + 3);
    for (let i = 0; i < 2; i++) spawnUnit(w, "trooper", "red", c.x - 2 + i, c.y + 7);
    for (let i = 0; i < 3; i++) spawnUnit(w, "stinger", "red", c.x - 2 + i, c.y + 8.5);
    w.tick = CONDOR_AI.from * TICK_RATE;
    return { w, ai };
  }

  it("Balanced loads two squads into its Condor and drops them on the enemy harvesters", () => {
    const { w, ai } = dropSetup("normal");
    const blueHq = buildingCenter(hqOf(w, "blue")!);
    const redHq = buildingCenter(hqOf(w, "red")!);
    const fx: FxEvent[] = [];
    let homeAfterDrop = Infinity;
    let dropTick = -1;
    for (let i = 0; i < 90 * TICK_RATE && !w.winner; i++) {
      step(w, tickAi(w, "red", ai));
      fx.push(...w.fx.filter((e) => "faction" in e && e.faction === "red"));
      if (dropTick < 0 && fx.some((e) => e.type === "disembark")) dropTick = w.tick;
      // …and the empty Condor flies home (~40 tiles at 3.6 tiles/s)
      if (dropTick >= 0 && w.tick === dropTick + 20 * TICK_RATE) {
        const condor = units(w, "red", "condor")[0]!;
        homeAfterDrop = Math.hypot(condor.x - redHq.x, condor.y - redHq.y);
      }
    }
    const drop = fx.find((e) => e.type === "disembark");
    expect(drop).toBeDefined();
    if (drop?.type !== "disembark") return;
    expect(fx.slice(0, fx.indexOf(drop)).filter((e) => e.type === "embark")).toHaveLength(2);
    expect(drop.bailout).toBe(false);
    expect(drop.unitIds).toHaveLength(2);
    // in the enemy's half, by its mining line
    expect(Math.hypot(drop.x - blueHq.x, drop.y - blueHq.y)).toBeLessThan(14);
    expect(homeAfterDrop).toBeLessThan(6);
  }, 30000);

  it("never flies a drop on Easy, or as a personality that doesn't", () => {
    for (const [diff, strategy] of [["easy", "balanced"], ["normal", "boom"]] as const) {
      const { w, ai } = dropSetup(diff, strategy);
      for (let i = 0; i < 60 * TICK_RATE && !w.winner; i++) {
        const cmds = tickAi(w, "red", ai);
        expect(cmds.some((c) => c.type === "board" || c.type === "unload")).toBe(false);
        step(w, cmds);
      }
    }
  }, 30000);

  it("doesn't fly a drop into anti-air it can see", () => {
    const { w, ai } = dropSetup("normal");
    // flak on every blue harvester line and over the blue base
    const blueHq = buildingCenter(hqOf(w, "blue")!);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const f = spawnUnit(w, "flak-crawler", "blue", blueHq.x + Math.cos(a) * 5, blueHq.y + Math.sin(a) * 5);
      w.powers.stunned.set(f.id, 1e9);
    }
    // a scout parked over the blue base (frozen, and sturdier than any scout): red sees it all
    const scout = spawnUnit(w, "scout", "red", blueHq.x, blueHq.y);
    scout.hp = 1e9;
    w.powers.stunned.set(scout.id, 1e9);
    const reached: number[] = [];
    for (let i = 0; i < 60 * TICK_RATE && !w.winner; i++) {
      step(w, tickAi(w, "red", ai));
      for (const c of units(w, "red", "condor")) reached.push(Math.hypot(c.x - blueHq.x, c.y - blueHq.y));
      if (w.fx.some((e) => e.type === "disembark" && e.faction === "red" && Math.hypot(e.x - blueHq.x, e.y - blueHq.y) < 14))
        throw new Error("dropped into the flak");
    }
    expect(Math.min(...reached)).toBeGreaterThan(10);
  }, 30000);

  it("doesn't even board while every way in is covered (the squads stay on the ground)", () => {
    const { w, ai } = dropSetup("normal");
    const blueHq = buildingCenter(hqOf(w, "blue")!);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const f = spawnUnit(w, "flak-crawler", "blue", blueHq.x + Math.cos(a) * 5, blueHq.y + Math.sin(a) * 5);
      w.powers.stunned.set(f.id, 1e9);
    }
    const scout = spawnUnit(w, "scout", "red", blueHq.x, blueHq.y);
    scout.hp = 1e9;
    w.powers.stunned.set(scout.id, 1e9);
    tickFog(w); // (red sees it all from the first pass)
    for (let i = 0; i < 60 * TICK_RATE && !w.winner; i++) {
      const cmds = tickAi(w, "red", ai);
      expect(cmds.some((c) => c.type === "board")).toBe(false);
      step(w, cmds);
    }
  }, 30000);

  /** dropSetup, plus SAM sites by blue's home field that red hasn't seen when it plans its drop. */
  function samSetup(n: number) {
    const s = dropSetup("normal");
    const field = nearestScrapTile(s.w, buildingCenter(hqOf(s.w, "blue")!).x, buildingCenter(hqOf(s.w, "blue")!).y, "blue")!;
    for (let i = 0; i < n; i++) spawnBuilding(s.w, "sam-site", "blue", field.x + 2 + i * 2, field.y - 2);
    return s;
  }

  it("turns a drop back when anti-air turns up on the way in, sets the squads down at home, and doesn't fly straight back", () => {
    const { w, ai } = samSetup(2);
    const blueHq = buildingCenter(hqOf(w, "blue")!);
    const redHq = buildingCenter(hqOf(w, "red")!);
    const condor = units(w, "red", "condor")[0]!;
    const near = (x: number, y: number) => Math.hypot(x - blueHq.x, y - blueHq.y) < 14;
    let trips = 0;
    let homeDrop = false;
    for (let i = 0; i < 120 * TICK_RATE && !w.winner; i++) {
      const cmds = tickAi(w, "red", ai);
      for (const c of cmds) if (c.type === "unload" && c.x !== undefined && near(c.x, c.y!)) trips++;
      step(w, cmds);
      for (const e of w.fx)
        if (e.type === "disembark" && e.faction === "red") {
          expect(near(e.x, e.y), "dropped under the SAMs").toBe(false);
          if (Math.hypot(e.x - redHq.x, e.y - redHq.y) < 10) homeDrop = true;
        }
    }
    expect(w.units.has(condor.id)).toBe(true);
    expect(condor.hp).toBeGreaterThan(UNITS.condor.hp * (1 - CONDOR_AI.abortLoss));
    expect(homeDrop).toBe(true); // set down at home: they walk
    expect(trips).toBe(1); // …and no second trip into the SAMs it saw
  }, 30000);

  it("turns a drop back when it takes fire on the way in, even on a straight run", () => {
    const { w, ai } = dropSetup("normal");
    const blueHq = buildingCenter(hqOf(w, "blue")!);
    const condor = units(w, "red", "condor")[0]!;
    let hit = false;
    for (let i = 0; i < 60 * TICK_RATE && !w.winner; i++) {
      step(w, tickAi(w, "red", ai));
      // flying straight in to drop: hit hard (as by fighters it can't see coming)
      if (!hit && condor.order.type === "unload" && condor.order.hover < 0 && condor.order.x !== undefined &&
          Math.hypot(condor.order.x - blueHq.x, condor.order.y - blueHq.y) < 14 && Math.hypot(condor.x - blueHq.x, condor.y - blueHq.y) > 25) {
        condor.hp -= UNITS.condor.hp * (CONDOR_AI.abortLoss + 0.05);
        hit = true;
      }
      for (const e of w.fx)
        if (e.type === "disembark" && e.faction === "red")
          expect(Math.hypot(e.x - blueHq.x, e.y - blueHq.y), "dropped after taking fire").toBeGreaterThan(14);
    }
    expect(hit).toBe(true);
  }, 30000);

  it("boards a lone squad, and calls the next one aboard as it comes free (even off to a guard post)", () => {
    const { w, ai } = dropSetup("normal");
    const [first, ...rest] = units(w, "red", "trooper");
    for (const u of rest) w.units.delete(u.id); // only one squad at home to start with
    const boards: number[][] = [];
    let landed: number[] = [];
    let recalled = false;
    for (let i = 0; i < 120 * TICK_RATE && !w.winner && landed.length === 0; i++) {
      const cmds = tickAi(w, "red", ai);
      for (const c of cmds) if (c.type === "board") boards.push(c.unitIds);
      step(w, cmds);
      // a fresh squad turns up once the first is aboard, on its way somewhere
      if (!recalled && boards.length === 1) {
        const c = buildingCenter(hqOf(w, "red")!);
        const fresh = spawnUnit(w, "trooper", "red", c.x - 2, c.y + 7);
        fresh.order = { type: "attackMove", x: c.x - 8, y: c.y + 8 };
        recalled = true;
      }
      for (const e of w.fx) if (e.type === "disembark" && e.faction === "red" && !e.bailout) landed = e.unitIds;
    }
    expect(boards[0]).toEqual([first!.id]);
    expect(boards).toHaveLength(2);
    expect(landed).toHaveLength(2);
  }, 30000);

  it("with every harvester line covered, flies the squads up behind an assault wave instead", () => {
    const { w, ai } = dropSetup("normal");
    const blueHq = buildingCenter(hqOf(w, "blue")!);
    const redHq = buildingCenter(hqOf(w, "red")!);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const f = spawnUnit(w, "flak-crawler", "blue", blueHq.x + Math.cos(a) * 5, blueHq.y + Math.sin(a) * 5);
      w.powers.stunned.set(f.id, 1e9);
    }
    const scout = spawnUnit(w, "scout", "red", blueHq.x, blueHq.y);
    scout.hp = 1e9;
    w.powers.stunned.set(scout.id, 1e9);
    // a wave pushing out (held where it is), halfway to the enemy
    const lead = { x: redHq.x + (blueHq.x - redHq.x) * 0.5, y: redHq.y + (blueHq.y - redHq.y) * 0.5 };
    for (let i = 0; i < 6; i++) {
      const u = spawnUnit(w, "stinger", "red", lead.x + (i % 3) * 0.8, lead.y + Math.floor(i / 3) * 0.8);
      u.order = { type: "attackMove", x: blueHq.x, y: blueHq.y };
      w.powers.stunned.set(u.id, 1e9);
    }
    ai.mode = "assault";
    tickFog(w);
    let drop: Extract<FxEvent, { type: "disembark" }> | null = null;
    for (let i = 0; i < 60 * TICK_RATE && !w.winner && !drop; i++) {
      step(w, tickAi(w, "red", ai));
      for (const e of w.fx) if (e.type === "disembark" && e.faction === "red" && !e.bailout) drop = e;
    }
    expect(drop).not.toBeNull();
    expect(Math.hypot(drop!.x - lead.x, drop!.y - lead.y)).toBeLessThan(CONDOR_AI.frontBack + 3);
    // …and on the next decision pass they follow the wave in, rather than walking back to the staging point
    for (let i = 0; i < 3 * TICK_RATE; i++) step(w, tickAi(w, "red", ai));
    for (const id of drop!.unitIds) expect(w.units.get(id)!.order).toMatchObject({ type: "attackMove", x: blueHq.x, y: blueHq.y });
  }, 30000);

  it("rebuilds a lost Condor no sooner than CONDOR_AI.rebuild seconds later", () => {
    const { w, ai } = dropSetup("normal");
    w.tick -= 10 * TICK_RATE;
    hqOf(w, "blue")!.hp = 1e9; // (a long watch: blue never falls)
    for (let i = 0; i < 4 * TICK_RATE; i++) step(w, tickAi(w, "red", ai));
    const condor = units(w, "red", "condor")[0]!;
    w.units.delete(condor.id); // shot down (as cleanupDeaths leaves it)
    const lost = w.tick;
    let queued = -1;
    for (let i = 0; i < 120 * TICK_RATE && queued < 0; i++) {
      w.factions.red.scrap = Math.max(w.factions.red.scrap, 1000); // (the airpad always has the scrap and a free slot)
      const cmds = tickAi(w, "red", ai);
      if (cmds.some((c) => c.type === "produce" && c.unit === "condor")) queued = w.tick;
      step(w, cmds);
    }
    expect(queued).toBeGreaterThanOrEqual(lost + CONDOR_AI.rebuild * TICK_RATE);
  }, 30000);
});

describe("AI Menders", () => {
  /** Proving Grounds: red's home, blue's HQ, and a red Mender at `at`. */
  function scene(at: (blueHq: { x: number; y: number }) => { x: number; y: number }) {
    const w = createMapWorld("proving-grounds");
    const home = buildingCenter(hqOf(w, "red")!);
    const blueHq = buildingCenter(hqOf(w, "blue")!);
    const p = at(blueHq);
    const mender = spawnUnit(w, "mender", "red", p.x, p.y);
    return { w, home, blueHq, mender };
  }
  const army = (w: World) => [...w.units.values()].filter((u) => u.faction === "red" && u.kind !== "harvester");

  it("a Mender left on its own in enemy ground flies home instead of hanging around", () => {
    const { w, home, blueHq, mender } = scene((b) => ({ x: b.x + 6, y: b.y - 6 }));
    // a lone raider in there isn't worth following
    const raider = spawnUnit(w, "stinger", "red", blueHq.x + 4, blueHq.y - 4);
    raider.order = { type: "attackMove", x: blueHq.x, y: blueHq.y };
    const cmds = planMenders("red", army(w), [], new Set(), home, blueHq);
    expect(cmds).toEqual([{ type: "move", faction: "red", unitIds: [mender.id], x: home.x, y: home.y }]);
    // the whole AI does the same with an idle one, and keeps it out of its waves
    const ai = createAiState("balanced", "normal", 1);
    ai.mode = "assault";
    const issued = tickAi(w, "red", ai).filter((c) => "unitIds" in c && c.unitIds.includes(mender.id));
    expect(issued).toEqual(cmds);
  });

  it("follows a wave into enemy ground", () => {
    const { w, home, blueHq, mender } = scene((b) => ({ x: b.x + 12, y: b.y - 12 }));
    const wave = [0, 1, 2, 3].map((i) => {
      const u = spawnUnit(w, "stinger", "red", blueHq.x + 6 + i * 0.7, blueHq.y - 6);
      u.order = { type: "attackMove", x: blueHq.x, y: blueHq.y };
      return u;
    });
    const cmds = planMenders("red", army(w), [], new Set(), home, blueHq);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ type: "attackMove", unitIds: [mender.id] });
    const c = cmds[0] as { x: number; y: number };
    expect(wave.some((u) => u.x === c.x && u.y === c.y)).toBe(true);
  });

  it("goes to the wounded first, and patches up the base when there's nobody to follow", () => {
    const { w, home, blueHq, mender } = scene(() => ({ x: 24.5, y: 24.5 }));
    const busy = spawnUnit(w, "stinger", "red", 26.5, 24.5);
    busy.order = { type: "attackMove", x: 10, y: 30 };
    const hurt = spawnUnit(w, "stinger", "red", 24.5, 30.5);
    hurt.hp = UNITS.stinger.hp * 0.4;
    let cmds = planMenders("red", army(w), [], new Set(), home, blueHq);
    expect(cmds).toEqual([{ type: "attackMove", faction: "red", unitIds: [mender.id], x: hurt.x, y: hurt.y }]);
    w.units.delete(busy.id);
    w.units.delete(hurt.id);
    const hq = hqOf(w, "red")!;
    hq.hp = BUILDINGS.hq.hp * 0.5;
    cmds = planMenders("red", army(w), [hq], new Set(), home, blueHq);
    expect(cmds).toEqual([{ type: "move", faction: "red", unitIds: [mender.id], ...buildingCenter(hq) }]);
  });

  it("the commander sends anti-air after an enemy Mender working near its base", () => {
    const w = createMapWorld("proving-grounds");
    const home = buildingCenter(hqOf(w, "red")!);
    const mender = spawnUnit(w, "mender", "blue", home.x - 4, home.y + 5);
    w.powers.stunned.set(mender.id, 1e9);
    spawnUnit(w, "raptor", "red", home.x + 4, home.y - 3);
    tickFog(w);
    const ai = createAiState("balanced", "normal", 1);
    const cmds = tickAi(w, "red", ai);
    expect(cmds.some((c) => c.type === "attack" && c.targetId === mender.id)).toBe(true);
  });
});

/**
 * The Goliath's feedback layer (GOLIATH.md): radio lines and banners for a
 * Gantry's build, rollout, modes, weapon systems and lifts; an HQ that falls
 * while a Goliath fights on; the winner line when the last Goliath decides
 * it; awareness, advisor, mood, report, tips and medals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { tickFog } from "../src/sim/fog";
import { AWARDS, MEDALS, computeMedals, type MatchRecap } from "../src/sim/awards";
import { goliathsOf } from "../src/sim/goliath";
import { createMapWorld } from "../src/sim/maps";
import { makeRules } from "../src/sim/rules";
import { step } from "../src/sim/sim";
import type { Command, Faction, FactionStats, FxEvent, GoliathWeapon, World } from "../src/sim/types";
import { buildingCenter, createWorld, hqOf, spawnBuilding, spawnUnit } from "../src/sim/world";
import { onAnnounce, type Announcement } from "../src/game/announce";
import {
  CALLOUTS,
  GOLIATH_COUNTERS,
  BattleCallouts,
  RadioQueue,
  decidedByGoliath,
  isEndLine,
  speakable,
  type RadioLine
} from "../src/game/callouts";
import { lineSeconds } from "../src/game/announcer";
import { HeatMap, InboundWatch, TEMPO, TempoGuard, baseGoliath, raidAdvice, tallyView } from "../src/game/awareness";
import { ADVISOR, COUNTERS, EnemyIntel, FACTORY_TAB, counterAdvice, sightingWeight } from "../src/game/advisor";
import { BattleMood, FLAVOURS, MUSIC, stinger, stingerFor, type MoodHooks } from "../src/game/score";
import { Chronicle, moments, pickTip, type DeathRec, type Sample, type TipInput } from "../src/game/chronicle";
import { recapOf } from "../src/game/career";
import { HeroPresenter } from "../src/game/hero-fx";
import { UnitVoices } from "../src/game/voices";
import { goliathsFielded, headline } from "../src/ui/report";

// ------------------------------------------------------------ harness --

type Death = Extract<FxEvent, { type: "death" }>;
const death = (over: Partial<Death>): Death => ({
  type: "death", id: 900, faction: "red", unitKind: "stinger", buildingKind: null, x: 20, y: 20, air: false,
  value: 150, killerId: null, killerKind: null, rank: 0, kills: 0, ...over
});
const goliathDeath = (faction: Faction, id: number, over: Partial<Death> = {}): Death =>
  death({ faction, id, unitKind: "goliath", value: UNITS.goliath.cost, ...over });
const hqDeath = (faction: Faction, id = 500): Death => death({ faction, id, unitKind: null, buildingKind: "hq", value: 500 });
const hit = (faction: Faction, id: number, building = false, x = 20, y = 20): FxEvent => ({
  type: "hit", faction, id, x, y, building, attackerId: 0
});
const build = (faction: Faction, stage: "started" | "nearlyDone"): FxEvent => ({
  type: "goliathBuild", faction, buildingId: 77, stage, x: 30, y: 30
});
const rollout = (faction: Faction, id = 90): FxEvent => ({ type: "goliathRollout", faction, id, buildingId: 77, x: 30, y: 33 });
const mode = (faction: Faction, m: "walking" | "anchoring" | "anchored" | "packing", id = 90, x = 30): FxEvent => ({
  type: "goliathMode", faction, id, mode: m, x, y: 30
});
const weapon = (faction: Faction, w: GoliathWeapon, state: "offline" | "rebooting" | "online", id = 90): FxEvent => ({
  type: "goliathWeapon", faction, id, weapon: w, state, x: 30, y: 30
});
const lift = (faction: Faction, state: "hooked" | "setDown" | "dropped", id = 90, destroyed?: boolean): FxEvent => ({
  type: "goliathLift", faction, id, carrierIds: [91, 92], state, x: 30, y: 30, ...(destroyed !== undefined ? { destroyed } : {})
});

function rig(opts: { spectator?: boolean; onScreen?: (x: number, y: number) => boolean; world?: World; player?: Faction } = {}) {
  const w = opts.world ?? createWorld(48, 48);
  const radio: (RadioLine & { t: number })[] = [];
  const banners: (Announcement & { t: number })[] = [];
  let now = 0;
  const c = new BattleCallouts({
    world: w, player: opts.player ?? "blue", spectator: opts.spectator ?? false,
    onScreen: opts.onScreen ?? (() => false),
    radio: (l) => radio.push({ ...l, t: now }),
    announce: (a) => banners.push({ ...a, t: now })
  });
  const at = (t: number, ...fx: FxEvent[]) => {
    now = t;
    c.events(fx, t);
  };
  return { w, c, radio, banners, at, keys: () => radio.map((r) => r.key), texts: () => radio.map((r) => r.text) };
}

/** A world with both HQs (blue at the top-left, red at the bottom-right). */
function twoBases(): { w: World; blueHq: number; redHq: number } {
  const w = createWorld(48, 48);
  const blueHq = spawnBuilding(w, "hq", "blue", 3, 3).id;
  const redHq = spawnBuilding(w, "hq", "red", 40, 40).id;
  return { w, blueHq, redHq };
}

// ------------------------------------------------------------ callouts --

describe("Goliath callouts: the Gantry's build", () => {
  it("warns the enemy side at build start, nearly done and rollout, each once, with no fog check", () => {
    const r = rig(); // (an empty world: blue sees nothing at all)
    r.at(1, build("red", "started"));
    r.at(2, build("red", "started")); // (a restarted build inside the cooldown)
    expect(r.banners).toHaveLength(1);
    expect(r.banners[0]).toMatchObject({ key: "enemy-goliath-build", text: "Enemy Goliath in production", tone: "bad", priority: 1, x: 30, y: 30 });
    r.at(50, build("red", "nearlyDone"));
    expect(r.radio).toHaveLength(1);
    expect(r.radio[0]).toMatchObject({ key: "enemy-goliath-soon", text: "Enemy Goliath nearly complete", priority: 1, tone: "bad", caption: true });
    r.at(60, rollout("red"));
    expect(r.banners.at(-1)).toMatchObject({ key: "enemy-goliath", text: "Enemy Goliath on the field", tone: "bad", priority: 1 });
    expect(r.banners.at(-1)!.sub).toBe(`Counter: ${GOLIATH_COUNTERS}`);
    expect(GOLIATH_COUNTERS).toBe("Rocket Squads, Wasps, Lancers, Hornets");
    expect(r.banners).toHaveLength(2);
  });

  it("our own build is quiet until it walks out: 'Goliath ready'", () => {
    const r = rig();
    r.at(1, build("blue", "started"));
    r.at(50, build("blue", "nearlyDone"));
    expect(r.radio).toHaveLength(0);
    expect(r.banners).toHaveLength(0);
    r.at(60, rollout("blue"));
    // (a radio line, heard over any chatter: the banners are kept for news the player didn't make)
    expect(r.radio).toEqual([expect.objectContaining({ key: "goliath-ready", text: "Goliath ready", tone: "good", priority: 1, caption: true })]);
    expect(r.banners).toHaveLength(0);
  });

  it("speaks like a caster to spectators, for both sides", () => {
    const r = rig({ spectator: true });
    r.at(1, build("red", "started"), build("blue", "started"));
    expect(r.texts()).toEqual(["Red Goliath in production", "Blue Goliath in production"]);
    r.at(60, rollout("red"));
    expect(r.banners.at(-1)).toMatchObject({ key: "goliath-field-red", text: "Red Goliath on the field" });
    r.at(70, mode("red", "anchoring"));
    expect(r.radio.at(-1)!.text).toBe("Red Goliath digging in");
    r.at(80, weapon("red", "mortars", "offline"));
    expect(r.radio.at(-1)!.text).toBe("Red Goliath: mortars down");
    r.at(90, lift("blue", "hooked"));
    expect(r.radio.at(-1)!.text).toBe("Blue Goliath airborne");
    // never a player's line
    const all = [...r.radio.map((l) => l.text), ...r.banners.flatMap((b) => [b.text, b.sub ?? "", b.say ?? ""])];
    expect(all.some((s) => /\b(enemy|our|we)\b/i.test(s))).toBe(false);
  });
});

describe("Goliath callouts: modes, weapons and lifts", () => {
  it("an enemy Goliath digging in or packing up; ours anchored, captioned only off screen", () => {
    let visible = false;
    const r = rig({ onScreen: () => visible });
    r.at(1, mode("red", "anchoring"));
    r.at(2, mode("red", "anchored")); // (no news: it's dug in)
    r.at(5, mode("red", "anchoring")); // (cooldown)
    expect(r.radio).toEqual([expect.objectContaining({ key: "enemy-goliath-dig", text: "Enemy Goliath digging in", priority: 2, tone: "bad", caption: true })]);
    r.at(30, mode("red", "packing"));
    expect(r.radio.at(-1)).toMatchObject({ key: "enemy-goliath-pack", text: "Enemy Goliath packing up", priority: 3 });
    r.at(40, mode("blue", "anchoring"));
    r.at(44, mode("blue", "anchored"));
    expect(r.radio.at(-1)).toMatchObject({ key: "goliath-anchored", text: "Goliath anchored", priority: 3, tone: "good", caption: true });
    visible = true;
    r.at(44 + CALLOUTS.cooldownS["goliath-anchored"]!, mode("blue", "anchored"));
    expect(r.radio.at(-1)!.caption).toBe(false);
    r.at(80, mode("blue", "packing"), mode("blue", "walking"));
    expect(r.radio.at(-1)!.key).toBe("goliath-anchored"); // (ours packing up: the player ordered it)
  });

  it("names each weapon system lost, on its own key so queued lines don't overwrite each other", () => {
    const r = rig();
    r.at(1, weapon("red", "mortars", "offline"));
    r.at(2, weapon("red", "laser", "offline"));
    expect(r.radio.map((l) => [l.key, l.text, l.priority, l.tone])).toEqual([
      ["enemy-goliath-mortars", "Enemy Goliath: mortars down!", 2, "good"],
      ["enemy-goliath-laser", "Enemy Goliath: laser down!", 2, "good"]
    ]);
    // both wait in the announcer's queue: neither replaces the other
    const q = new RadioQueue();
    for (const l of r.radio) q.push(l, 0);
    expect(q.size).toBe(2);
    // a repair starts a reboot (no news), a hit knocks it back down (never came back: still no news)
    r.at(30, weapon("red", "mortars", "rebooting"));
    r.at(31, weapon("red", "mortars", "offline"));
    expect(r.radio).toHaveLength(2);
    r.at(40, weapon("red", "mortars", "rebooting"));
    r.at(43, weapon("red", "mortars", "online"));
    expect(r.radio.at(-1)).toMatchObject({ key: "enemy-goliath-mortars-up", text: "Enemy Goliath mortars back online", tone: "bad" });
    // systems lost in one blow: one line
    r.at(60, weapon("red", "laser", "online", 95), weapon("red", "mortars", "offline", 95), weapon("red", "cannons", "offline", 95));
    expect(r.radio.at(-1)!.text).toBe("Enemy Goliath: mortars and cannons down!");
    // the machine guns never go offline; if they did, it would be no line
    const n = r.radio.length;
    r.at(90, weapon("red", "mg", "offline", 96));
    expect(r.radio).toHaveLength(n);
  });

  it("our own weapon systems: offline is a warning, back online a flavour line", () => {
    const r = rig();
    r.at(1, weapon("blue", "mortars", "offline"));
    expect(r.radio[0]).toMatchObject({ key: "goliath-mortars-down", text: "Goliath mortars offline", priority: 1, tone: "bad", caption: true });
    r.at(5, weapon("blue", "mortars", "online"));
    expect(r.radio[1]).toMatchObject({ key: "goliath-mortars-up", text: "Goliath mortars back online", priority: 3, tone: "good" });
    // a flickering system is said at most once per cooldown
    r.at(8, weapon("blue", "mortars", "offline"));
    expect(r.radio).toHaveLength(2);
  });

  it("lifts: airborne, dropped, and lost in the drop (one banner, not a line and a banner)", () => {
    const r = rig();
    r.at(1, lift("blue", "hooked"));
    expect(r.radio.at(-1)).toMatchObject({ key: "goliath-airborne", text: "Goliath airborne", priority: 3 });
    r.at(10, lift("blue", "setDown"));
    expect(r.radio).toHaveLength(1);
    r.at(20, lift("blue", "dropped", 90, false));
    expect(r.radio.at(-1)).toMatchObject({ key: "goliath-dropped", text: "Goliath dropped!", priority: 1, tone: "bad" });
    r.at(40, lift("blue", "dropped", 93, true), goliathDeath("blue", 93));
    expect(r.radio).toHaveLength(2);
    expect(r.banners.at(-1)).toMatchObject({ key: "goliath-lost", text: "Goliath lost", say: "Goliath lost in the drop", sub: "Lost in the drop", tone: "bad" });
    // the enemy's
    r.at(50, lift("red", "hooked"));
    expect(r.radio.at(-1)).toMatchObject({ key: "enemy-goliath-airborne", text: "Enemy Goliath airborne", tone: "bad" });
    r.at(55, lift("red", "dropped", 90, false));
    expect(r.radio.at(-1)).toMatchObject({ key: "enemy-goliath-dropped", text: "Enemy Goliath dropped!", tone: "good" });
    r.at(60, lift("red", "dropped", 94, true), goliathDeath("red", 94));
    expect(r.banners.at(-1)).toMatchObject({ key: "kill-goliath", text: "Goliath down", sub: "Dropped from its lift" });
  });
});

describe("Goliath callouts: under fire, lost and destroyed", () => {
  it("'Our Goliath is under attack': its own key, P1, and P0 once the HQ is gone", () => {
    let visible = false;
    const { w, blueHq } = twoBases();
    const r = rig({ world: w, onScreen: () => visible });
    const g = spawnUnit(w, "goliath", "blue", 30, 10);
    r.at(1, hit("blue", g.id, false, 30, 10));
    r.at(2, hit("blue", g.id, false, 30, 10));
    expect(r.radio).toEqual([expect.objectContaining({ key: "goliath-attack", text: "Our Goliath is under attack", priority: 1, tone: "bad" })]);
    // not "Our units are under fire" on top
    const s = spawnUnit(w, "stinger", "blue", 20, 20);
    r.at(5, hit("blue", s.id));
    expect(r.keys()).toEqual(["goliath-attack"]);
    // walking into a fight the player is watching: no news
    visible = true;
    r.at(100, hit("blue", g.id, false, 30, 10));
    expect(r.radio).toHaveLength(1);
    // anchored, it's a base: said (on the longer cooldown) even in view
    g.goliath!.mode = "anchored";
    r.at(101, hit("blue", g.id, false, 30, 10));
    expect(r.radio).toHaveLength(2);
    r.at(101 + CALLOUTS.cooldownS["goliath-attack"]!, hit("blue", g.id, false, 30, 10));
    expect(r.radio).toHaveLength(2);
    // the HQ gone: the last life, a critical warning
    w.buildings.delete(blueHq);
    visible = false;
    r.at(300, hit("blue", g.id, false, 30, 10));
    expect(r.radio.at(-1)).toMatchObject({ key: "goliath-attack", priority: 0 });
    // spectators hear of a side's last Goliath only
    const spec = rig({ world: w, spectator: true });
    const rg = spawnUnit(w, "goliath", "red", 30, 30);
    spec.at(1, hit("red", rg.id, false, 30, 30));
    expect(spec.radio).toHaveLength(0);
    spec.at(2, hit("blue", g.id, false, 30, 10));
    expect(spec.radio.at(-1)).toMatchObject({ text: "Blue Goliath under attack", caption: true });
  });

  it("a Goliath loss is always said, on screen or off, and never folded into 'Squad lost'", () => {
    const { w } = twoBases();
    const r = rig({ world: w, onScreen: () => true });
    r.at(1, death({ faction: "blue", id: 1 }), death({ faction: "blue", id: 2 }));
    r.at(2, goliathDeath("blue", 3));
    expect(r.keys()).toEqual([]); // (two deaths and a Goliath: not a squad lost)
    expect(r.banners).toEqual([expect.objectContaining({ key: "goliath-lost", text: "Goliath lost", tone: "bad", priority: 1 })]);
    expect(r.banners[0]!.sub).toBeUndefined();
    // off screen too, and no "Goliath lost" radio line on top
    const off = rig({ world: w, onScreen: () => false });
    off.at(5, goliathDeath("blue", 4));
    expect(off.radio).toHaveLength(0);
    expect(off.banners.map((b) => b.key)).toEqual(["goliath-lost"]);
  });

  it("with our HQ gone, a Goliath lost is critical and says what is left", () => {
    const { w, blueHq } = twoBases();
    w.buildings.delete(blueHq);
    spawnUnit(w, "goliath", "blue", 30, 10); // the one still standing
    const r = rig({ world: w });
    r.at(1, goliathDeath("blue", 3));
    expect(r.banners[0]).toMatchObject({ key: "goliath-lost", priority: 0, sub: "Our last Goliath fights on" });
  });

  it("an enemy Goliath kill is its own epic banner: never gated by big-kill cooldowns, never swallowed by a streak", () => {
    const r = rig();
    r.at(1, death({ faction: "red" })); // first blood
    r.at(20, death({ faction: "red", unitKind: "mastodon", value: 475 })); // a big kill: its cooldown starts
    r.at(21, death({ faction: "red", id: 5 }), goliathDeath("red", 6)); // inside the cooldown, and a streak
    const g = r.banners.find((b) => b.key === "kill-goliath");
    expect(g).toMatchObject({ text: "Goliath down", say: "Enemy Goliath destroyed", tone: "epic", priority: 1, t: 21 });
    r.at(23);
    expect(r.banners.some((b) => b.key.startsWith("streak") && !!b.sub?.includes("Goliath"))).toBe(false); // (not under a streak banner)
    // a calldown kill names it; an elite says so
    r.at(60, goliathDeath("red", 7, { rank: 3 }));
    expect(r.banners.at(-1)).toMatchObject({ text: "Elite Goliath down", say: "Enemy Elite Goliath destroyed" });
    // spectators
    const s = rig({ spectator: true });
    s.at(1, goliathDeath("red", 8));
    expect(s.banners.at(-1)).toMatchObject({ key: "kill-goliath", text: "Red Goliath down", sub: "Blue scores", tone: "epic" });
  });

  it("with their HQ gone, an enemy Goliath kill says how many are left", () => {
    const { w, redHq } = twoBases();
    w.buildings.delete(redHq);
    spawnUnit(w, "goliath", "red", 30, 30);
    spawnUnit(w, "goliath", "red", 33, 30);
    const r = rig({ world: w });
    r.at(1, goliathDeath("red", 3));
    expect(r.banners.at(-1)).toMatchObject({ key: "kill-goliath", sub: "2 Goliaths left" });
  });
});

describe("Goliath callouts: the HQ falls, the match goes on", () => {
  it("our HQ: a P0 banner, 'The Goliath fights on'; theirs: 'Destroy their Goliath to win' (and no victory line)", () => {
    const { w } = twoBases();
    spawnUnit(w, "goliath", "blue", 30, 10);
    spawnUnit(w, "goliath", "red", 30, 30);
    const r = rig({ world: w });
    r.at(100, hqDeath("blue"));
    expect(r.banners.at(-1)).toMatchObject({ key: "hq-fell", text: "Our HQ has fallen", sub: "The Goliath fights on", tone: "bad", priority: 0 });
    r.at(200, hqDeath("red"));
    expect(r.banners.at(-1)).toMatchObject({ key: "enemy-hq-fell", text: "Enemy HQ destroyed", sub: "Destroy their Goliath to win", tone: "epic", priority: 1 });
    expect(r.keys().some((k) => k === "victory" || k === "defeat")).toBe(false);
    // two Goliaths: plural
    spawnUnit(w, "goliath", "blue", 33, 10);
    const p = rig({ world: w });
    p.at(1, hqDeath("blue"));
    expect(p.banners.at(-1)!.sub).toBe("The Goliaths fight on");
  });

  it("spectators get the neutral form", () => {
    const { w } = twoBases();
    spawnUnit(w, "goliath", "red", 30, 30);
    const r = rig({ world: w, spectator: true });
    r.at(1, hqDeath("red"));
    expect(r.banners.at(-1)).toMatchObject({ key: "hq-fell-red", text: "Red HQ destroyed", sub: "Red's Goliath fights on" });
  });

  it("the sim's own HQ death with a Goliath alive is no victory; the last Goliath's is, worded by what fell", () => {
    const { w, redHq } = twoBases();
    spawnUnit(w, "stinger", "blue", 6, 6); // (something on each side so the match is a match)
    const g = spawnUnit(w, "goliath", "red", 30, 30);
    const r = rig({ world: w });
    w.buildings.get(redHq)!.hp = 0;
    step(w, []);
    r.at(w.tick / TICK_RATE, ...w.fx);
    expect(w.winner).toBeNull();
    expect(r.banners.at(-1)).toMatchObject({ key: "enemy-hq-fell", sub: "Destroy their Goliath to win" });
    expect(r.keys()).not.toContain("victory");
    g.hp = 0;
    step(w, []);
    r.at(w.tick / TICK_RATE, ...w.fx);
    expect(w.winner).toBe("blue");
    expect(r.radio.at(-1)).toMatchObject({ key: "victory", text: "Last enemy Goliath destroyed. Victory!", tone: "epic", priority: 0 });
    expect(r.banners.some((b) => b.key === "kill-goliath")).toBe(false); // (the finale says it)
  });

  it("winner lines: by the last Goliath, or by the HQ when both fall in the same tick", () => {
    const lose = rig();
    lose.w.winner = "red";
    lose.at(10, goliathDeath("blue", 5));
    expect(lose.radio.at(-1)).toMatchObject({ key: "defeat", text: "Our last Goliath has fallen. Mission failed.", tone: "bad" });
    expect(lose.banners).toHaveLength(0); // (no "Goliath lost" banner over the defeat)
    const both = rig();
    both.w.winner = "blue";
    both.at(10, goliathDeath("red", 5), hqDeath("red"));
    expect(both.radio.at(-1)).toMatchObject({ key: "victory", text: "Enemy HQ destroyed. Victory!" });
    const spec = rig({ spectator: true });
    spec.w.winner = "blue";
    spec.at(10, goliathDeath("red", 5));
    expect(spec.radio.at(-1)).toMatchObject({ key: "victory", text: "Red's last Goliath destroyed. Blue wins the battle" });
    expect(decidedByGoliath([goliathDeath("red", 5)], "red")).toBe(true);
    expect(decidedByGoliath([goliathDeath("blue", 5)], "red")).toBe(false);
    expect(decidedByGoliath([goliathDeath("red", 5), hqDeath("red")], "red")).toBe(false);
    expect(decidedByGoliath([], "red")).toBe(false);
  });
});

describe("Robot Love and Nomads", () => {
  it("a draw closes the radio with its own last word, never a victory or a defeat", () => {
    for (const spectator of [false, true]) {
      const r = rig({ spectator });
      r.w.winner = "draw";
      r.w.love = { ids: [1, 2], x: 24, y: 20, tick: 900 };
      r.at(90, { type: "love", ids: [1, 2], x: 24, y: 20 });
      expect(r.radio).toEqual([
        expect.objectContaining({ key: "draw", text: "They fell in love. The battle is a draw.", priority: 0, tone: "good", x: 24, y: 20 })
      ]);
      r.at(91, death({ faction: "red" }), goliathDeath("red", 5));
      expect(r.radio).toHaveLength(1); // (then silence)
      expect(r.banners).toHaveLength(0);
    }
    expect(isEndLine({ key: "draw" })).toBe(true);
    expect(isEndLine({ key: "victory" })).toBe(true);
    expect(isEndLine({ key: "defeat" })).toBe(true);
    expect(isEndLine({ key: "goliath-lost" })).toBe(false);
  });

  it("the sim's own Robot Love ending is a draw on the radio", () => {
    const w = createWorld(48, 48);
    w.rules = makeRules(["robotlove"]);
    spawnBuilding(w, "hq", "blue", 2, 2);
    spawnBuilding(w, "hq", "red", 43, 43);
    spawnUnit(w, "goliath", "blue", 22, 24);
    spawnUnit(w, "goliath", "red", 25, 24);
    const r = rig({ world: w });
    step(w, []);
    r.at(w.tick / TICK_RATE, ...w.fx);
    expect(w.winner).toBe("draw");
    // (the shots they traded first are cleared by the announcer for the last word)
    expect(r.keys().at(-1)).toBe("draw");
    expect(r.keys().some((k) => k === "victory" || k === "defeat")).toBe(false);
  });

  it("Nomads: no HQ ever, so no HQ lines; the Goliath is the last life, and the last one decides it", () => {
    const w = createMapWorld("riverlands", { mutators: ["nomads"] });
    expect(hqOf(w, "blue")).toBeNull();
    const ours = goliathsOf(w, "blue")[0]!;
    const theirs = goliathsOf(w, "red")[0]!;
    const r = rig({ world: w });
    r.at(1, hit("blue", ours.id, false, ours.x, ours.y));
    expect(r.radio.at(-1)).toMatchObject({ key: "goliath-attack", priority: 0 });
    // a second Goliath: losing one is no longer the end, so the warning is P1 again
    spawnUnit(w, "goliath", "blue", ours.x + 6, ours.y);
    r.at(100, hit("blue", ours.id, false, ours.x, ours.y));
    expect(r.radio.at(-1)).toMatchObject({ key: "goliath-attack", priority: 1 });
    theirs.hp = 0;
    step(w, []);
    r.at(200, ...w.fx);
    expect(w.winner).toBe("blue");
    expect(r.radio.at(-1)).toMatchObject({ key: "victory", text: "Last enemy Goliath destroyed. Victory!" });
    const all = [...r.radio.map((l) => l.text), ...r.banners.flatMap((b) => [b.text, b.sub ?? "", b.say ?? ""])];
    expect(all.some((s) => /\bHQ\b/.test(s))).toBe(false);
  });
});

describe("Goliath chatter stays lean", () => {
  it("a long siege of an anchored Goliath doesn't flood the radio", () => {
    const { w } = twoBases();
    const g = spawnUnit(w, "goliath", "blue", 30, 10);
    g.goliath!.mode = "anchored";
    const r = rig({ world: w });
    const q = new RadioQueue();
    let delivered = 0;
    for (let t = 0; t < 120; t += 0.1) {
      const fx: FxEvent[] = [hit("blue", g.id, false, 30, 10)];
      // its systems flicker as Menders fight the damage
      const k = Math.floor(t / 7) % 2 === 0 ? "offline" : "online";
      if (Math.abs((t % 7) - 0.5) < 0.05) fx.push(weapon("blue", "mortars", k, g.id), weapon("red", "laser", k, 99));
      const before = r.radio.length;
      r.at(t, ...fx);
      for (const l of r.radio.slice(before)) q.push(l, t);
      if (q.next(t)) delivered++;
    }
    // under attack every 30 s, and each system's news at most every 20 s per direction
    expect(r.keys().filter((k) => k === "goliath-attack")).toHaveLength(4);
    expect(r.radio.length).toBeLessThanOrEqual(4 + 2 * 2 * Math.ceil(120 / CALLOUTS.cooldownS["goliath-weapon"]!));
    expect(delivered / 2).toBeLessThan(6.5); // lines a minute
  });

  it("an AI-vs-AI battle with a Goliath on each side stays as pleasant as one without", () => {
    const w = createMapWorld("proving-grounds", { seed: 4242 });
    const blue = createAiState("rush", "normal", 11);
    const red = createAiState("boom", "normal", 12);
    const hq = buildingCenter(hqOf(w, "blue")!);
    const rhq = buildingCenter(hqOf(w, "red")!);
    const bg = spawnUnit(w, "goliath", "blue", hq.x + 4, hq.y + 4);
    const rg = spawnUnit(w, "goliath", "red", rhq.x - 4, rhq.y - 4);
    const q = new RadioQueue();
    const delivered: { t: number; key: string }[] = [];
    const banners: { t: number; key: string }[] = [];
    let t = 0;
    let busyUntil = 0;
    const c = new BattleCallouts({
      world: w, player: "blue", spectator: false,
      onScreen: (x, y) => Math.abs(x - hq.x) <= 5.1 && Math.abs(y - hq.y) <= 8.4,
      radio: (l) => q.push(l, t),
      announce: (a) => {
        banners.push({ t, key: a.key });
        q.push({ key: `banner:${a.key}`, text: speakable(a.text), priority: a.priority ?? 2, tone: a.tone ?? "info", caption: false }, t);
      }
    });
    while (!w.winner && w.tick < 9 * 60 * TICK_RATE) {
      const orders: Command[] = [];
      // the Goliaths march on each other at 3:00; ours digs in halfway for a while, then pushes on
      if (w.tick === 180 * TICK_RATE) {
        orders.push({ type: "attackMove", faction: "red", unitIds: [rg.id], x: hq.x, y: hq.y });
        orders.push({ type: "attackMove", faction: "blue", unitIds: [bg.id], x: (hq.x + rhq.x) / 2, y: (hq.y + rhq.y) / 2 });
      }
      if (w.tick === 260 * TICK_RATE) orders.push({ type: "anchor", faction: "blue", unitIds: [bg.id] });
      if (w.tick === 330 * TICK_RATE) orders.push({ type: "attackMove", faction: "blue", unitIds: [bg.id], x: rhq.x, y: rhq.y });
      step(w, [...tickAi(w, "blue", blue), ...tickAi(w, "red", red), ...orders]);
      t = w.tick / TICK_RATE;
      c.events(w.fx, t);
      const l = q.next(t, t < busyUntil);
      if (l) {
        delivered.push({ t, key: l.key });
        busyUntil = t + lineSeconds(l.text) + 0.25;
      }
    }
    const mins = w.tick / TICK_RATE / 60;
    const max60 = (xs: { t: number }[]) => Math.max(0, ...xs.map((x) => xs.filter((y) => y.t >= x.t && y.t < x.t + 60).length));
    expect(mins).toBeGreaterThan(2);
    expect(delivered.some((d) => /goliath/.test(d.key))).toBe(true); // it does talk about them…
    expect(delivered.length / mins).toBeLessThan(6.5); // …within the same budgets as any battle
    expect(max60(delivered)).toBeLessThanOrEqual(10);
    expect(banners.length / mins).toBeLessThan(2.5);
    expect(max60(banners)).toBeLessThanOrEqual(6);
  });
});

// ----------------------------------------------------------- awareness --

describe("Goliath awareness", () => {
  it("advice for a Goliath raid names its counters", () => {
    expect(raidAdvice("ground", "goliath")).toEqual({ what: "Goliath", advice: "Rocket Squads, Wasps, Lancers or Hornets" });
  });

  it("an anchored Goliath (or the last life) is a base; a walking one with the HQ standing isn't", () => {
    const { w, blueHq } = twoBases();
    const g = spawnUnit(w, "goliath", "blue", 30, 10);
    const s = spawnUnit(w, "stinger", "blue", 30, 12);
    expect(baseGoliath(w, g)).toBe(false);
    expect(baseGoliath(w, s)).toBe(false);
    g.goliath!.mode = "anchored";
    expect(baseGoliath(w, g)).toBe(true);
    g.goliath!.mode = "walking";
    w.buildings.delete(blueHq);
    expect(baseGoliath(w, g)).toBe(true);
    expect(baseGoliath(w, s)).toBe(false);
  });

  it("guards an anchored Goliath out in the field, and warns of an enemy Goliath even in the fog", () => {
    const { w } = twoBases();
    const watch = new InboundWatch({ world: w, player: "blue" });
    const g = spawnUnit(w, "goliath", "blue", 30, 8);
    const scout = spawnUnit(w, "stinger", "blue", 30, 10); // eyes on the raiders
    const raiders = [spawnUnit(w, "stinger", "red", 30, 15), spawnUnit(w, "stinger", "red", 31, 15)];
    tickFog(w);
    expect(watch.events([], 1)).toEqual([]); // walking, with the HQ standing: not a base
    g.goliath!.mode = "anchored";
    const warned = watch.events([], 2);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ lead: "stinger", domain: "ground" });
    for (const u of [...raiders, scout]) w.units.delete(u.id);
    // an enemy Goliath walking up to our HQ through the fog
    const eg = spawnUnit(w, "goliath", "red", 14, 6);
    tickFog(w);
    const seen = watch.events([], 40);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ lead: "goliath", text: "Enemy Goliath inbound", short: "Goliath inbound", advice: "Rocket Squads, Wasps, Lancers or Hornets" });
    expect(seen[0]!.ids).toEqual([eg.id]);
  });

  it("the battle meter counts an enemy Goliath in the fog", () => {
    const w = createWorld(64, 64);
    spawnUnit(w, "stinger", "blue", 10, 10);
    spawnUnit(w, "goliath", "red", 12, 10);
    spawnUnit(w, "mastodon", "red", 13, 10);
    const t = tallyView(w, "blue", () => true, () => false, () => false);
    expect(t.enemy.n).toBe(1);
    expect(t.enemy.value).toBeCloseTo(UNITS.goliath.cost);
  });

  it("drops to 1× when the last-life Goliath comes under a new attack (not while the HQ stands)", () => {
    const { w, blueHq } = twoBases();
    const g = spawnUnit(w, "goliath", "blue", 30, 10);
    const guard = new TempoGuard({ world: w, player: "blue" });
    expect(guard.check([hit("blue", g.id, false, 30, 10)], 10, [], true)).toBeNull();
    w.buildings.delete(blueHq);
    expect(guard.check([hit("blue", g.id, false, 30, 10)], 50, [], true)).toMatchObject({ cause: "goliath", note: "Goliath under attack" });
    expect(guard.check([hit("blue", g.id, false, 30, 10)], 55, [], true)).toBeNull(); // the same siege
    expect(guard.check([hit("blue", g.id, false, 30, 10)], 55 + TEMPO.hqQuietS + 1, [], true)).toMatchObject({ cause: "goliath" });
  });

  it("hits on an anchored Goliath make a 'Base' hotspot", () => {
    const { w } = twoBases();
    const g = spawnUnit(w, "goliath", "blue", 30, 20);
    g.goliath!.mode = "anchored";
    const heat = new HeatMap({ world: w, player: "blue", spectator: false });
    for (let i = 0; i < 4; i++) heat.events([hit("blue", g.id, false, 30, 20)], i * 0.1);
    expect(heat.hotspots()[0]).toMatchObject({ kind: "defend", label: "Base" });
  });
});

// ------------------------------------------------------------- advisor --

describe("Goliath counters in the build advisor", () => {
  it("one Goliath sighting lights the Rocket Squads, Wasps, Lancers and Hornets", () => {
    const { w } = twoBases();
    spawnBuilding(w, "fab-plant", "blue", 8, 3);
    const intel = new EnemyIntel(w, "blue");
    spawnUnit(w, "goliath", "red", 35, 35); // (deep in the fog: it can't hide)
    tickFog(w);
    intel.update(0);
    expect(intel.count("goliath", 0)).toBe(1);
    expect(sightingWeight("goliath")).toBeGreaterThanOrEqual(ADVISOR.minSeen);
    expect(sightingWeight("mastodon")).toBe(1);
    for (const k of ["rocket-squad", "wasp", "lancer", "hornet"] as const) {
      expect(COUNTERS[k], k).toContain("goliath");
      expect(counterAdvice(w, "blue", intel, k, 0).active, k).toBe(true);
    }
    for (const k of ["stinger", "mastodon", "flak-crawler"] as const) expect(counterAdvice(w, "blue", intel, k, 0).active, k).toBe(false);
  });

  it("never nags about an idle Gantry", () => {
    expect(FACTORY_TAB.gantry).toBeUndefined();
  });
});

// ---------------------------------------------------------- mood, music --

describe("Goliath mood and music cues", () => {
  const hooks = (over: Partial<MoodHooks> = {}): MoodHooks => ({
    player: "blue", spectator: false, earshot: () => 1, sees: () => true, factionOf: () => null, ...over
  });

  it("hits on a Goliath that is our base sound the base alarm; on a walking one they don't", () => {
    const base = new BattleMood(hooks({ baseUnit: (id) => id === 7 }));
    for (let i = 0; i < MUSIC.alarmHits; i++) base.events([hit("blue", 7)], 10 + i * 0.5);
    expect(base.alarm()).toBe(true);
    const walking = new BattleMood(hooks({ baseUnit: () => false }));
    for (let i = 0; i < MUSIC.alarmHits; i++) walking.events([hit("blue", 8)], 10 + i * 0.5);
    expect(walking.alarm()).toBe(false);
    // spectators never get the alarm
    const spec = new BattleMood(hooks({ spectator: true, baseUnit: () => true }));
    for (let i = 0; i < MUSIC.alarmHits; i++) spec.events([hit("blue", 7)], 10 + i * 0.5);
    expect(spec.alarm()).toBe(false);
  });

  it("a draw ends on a sweet sting: bells over the tonic's sixth chord, no drums, neither fanfare nor lament", () => {
    for (const f of Object.values(FLAVOURS)) {
      const notes = stinger("draw", f, 0);
      expect(notes.some((n) => n.voice === "tom" || n.voice === "crash")).toBe(false);
      for (const n of notes) {
        expect(n.len).toBeGreaterThan(0);
        for (const m of n.midi) expect(m).toBeGreaterThan(12);
      }
      const t = ((f.tonic % 12) + 12) % 12;
      const chord = notes.find((n) => n.voice === "brass")!;
      expect(new Set(chord.midi.map((m) => m % 12))).toEqual(new Set([t, (t + 4) % 12, (t + 9) % 12]));
      const bells = notes.filter((n) => n.voice === "bell").map((n) => n.midi[0]!);
      for (let i = 1; i < bells.length; i++) expect(bells[i]!).toBeGreaterThan(bells[i - 1]!); // rising
    }
  });

  it("Goliath banners carry their stingers", () => {
    const r = rig();
    r.at(1, build("red", "started"));
    r.at(60, rollout("red"));
    r.at(70, goliathDeath("red", 5));
    r.at(80, goliathDeath("blue", 6));
    expect(r.banners.map((b) => [b.key, stingerFor(b)])).toEqual([
      ["enemy-goliath-build", "bad"],
      ["enemy-goliath", "bad"],
      ["first-blood", "first-blood"],
      ["kill-goliath", "epic"],
      ["goliath-lost", "bad"]
    ]);
    const hq = rig({ world: twoBases().w });
    spawnUnit(hq.w, "goliath", "blue", 30, 10);
    spawnUnit(hq.w, "goliath", "red", 30, 30);
    hq.at(1, hqDeath("blue"), hqDeath("red", 501));
    expect(hq.banners.map((b) => [b.key, stingerFor(b)])).toEqual([
      ["hq-fell", "bad"],
      ["enemy-hq-fell", "epic"]
    ]);
    expect(stingerFor({ key: "x", text: "x", tone: "epic", priority: 3 })).toBeNull();
    expect(stingerFor({ key: "x", text: "x", tone: "good", priority: 2 })).toBeNull();
    expect(stingerFor({ key: "x", text: "x", tone: "good", priority: 1 })).toBe("good");
  });
});

// --------------------------------------------------- report, tips, medals --

const stats = (o: Partial<FactionStats> = {}): FactionStats => ({
  unitsBuilt: 10, unitsLost: 10, unitsKilled: 10, buildingsLost: 1, buildingsKilled: 2, scrapHarvested: 4000, scrapSalvaged: 0, ...o
});

describe("Goliaths in the after-action report", () => {
  const base: TipInput = {
    pov: "blue", won: false, duration: 600, difficulty: "normal",
    built: { blue: { stinger: 10, "flak-crawler": 3, "tech-lab": 1 }, red: { goliath: 1 } },
    firstBuilt: { blue: { "tech-lab": 200 }, red: { goliath: 400 } },
    deaths: [], samples: [], factories: { blue: { total: 100, idleRich: 5 }, red: { total: 100, idleRich: 0 } }
  };

  it("tips: what beats a Goliath, unless you built it", () => {
    expect(pickTip(base)).toBe("They fielded a Goliath. Rocket Squads, Wasps, Lancers and Hornets bring one down; shoot its Menders first.");
    expect(pickTip({ ...base, built: { ...base.built, red: { goliath: 2 } } })).toMatch(/^They fielded 2 Goliaths\./);
    expect(pickTip({ ...base, built: { ...base.built, blue: { ...base.built.blue, "rocket-squad": 2, lancer: 1 } } })).not.toMatch(/Goliath/);
  });

  const refs = { width: 48, height: 48, hq: { blue: { x: 4.5, y: 4.5 }, red: { x: 41.5, y: 41.5 } } };
  const samples = (end: number): Sample[] =>
    Array.from({ length: Math.floor(end / 5) + 1 }, (_, i) => ({ t: i * 5, army: { blue: 500, red: 500 }, bank: { blue: 0, red: 0 }, harvesters: { blue: 4, red: 4 } }));
  const hqRec = (faction: Faction, t: number): DeathRec => ({
    t, x: 4.5, y: 4.5, faction, unitKind: null, buildingKind: "hq", value: 500, killerKind: "goliath", byBuilding: false
  });

  it("story beats: the first Goliath, and an HQ that fell while its Goliath fought on", () => {
    const firstBuilt = { blue: { goliath: 300 }, red: { goliath: 420 } };
    const m = moments({ samples: samples(600), deaths: [hqRec("blue", 480)], refs, firstBuilt }, "blue");
    expect(m.map((x) => [x.kind, x.title, x.text, x.tone])).toEqual([
      ["goliath", "Goliath", "Your first Goliath walked off the Gantry", "good"],
      ["hq", "HQ destroyed", "Your HQ fell; your Goliath fought on for 2:00", "bad"]
    ]);
    const spec = moments({ samples: samples(600), deaths: [hqRec("blue", 480)], refs, firstBuilt }, null);
    expect(spec.map((x) => x.text)).toEqual(["Blue's first Goliath walked off the Gantry", "Blue's HQ fell; Blue's Goliath fought on for 2:00"]);
    expect(spec.every((x) => x.tone === "neutral")).toBe(true);
    expect(moments({ samples: samples(600), deaths: [], refs, firstBuilt }, "red")[0]!.text).toBe("Their first Goliath walked off their Gantry");
    // an HQ that ended the match, or a side that never had a Goliath: no such beat
    expect(moments({ samples: samples(480), deaths: [hqRec("blue", 480)], refs, firstBuilt }, "blue").some((x) => x.kind === "hq")).toBe(false);
    expect(moments({ samples: samples(600), deaths: [hqRec("blue", 280)], refs, firstBuilt }, "blue").some((x) => x.kind === "hq")).toBe(false);
    // without a first-built log (older callers): the beats as before
    expect(moments({ samples: samples(600), deaths: [hqRec("blue", 480)], refs }, "blue")).toEqual([]);
  });

  it("Robot Love: the chronicle records where the Goliaths fell in love, the last beat of the story", () => {
    const w = createWorld(48, 48);
    const c = new Chronicle(w);
    w.tick = 540 * TICK_RATE;
    c.onFx({ type: "love", ids: [1, 2], x: 24, y: 24 });
    expect(c.love).toEqual({ t: 540, x: 24, y: 24 });
    const love = c.love!;
    const mine = moments({ samples: samples(540), deaths: [], refs, love }, "blue");
    expect(mine.at(-1)).toEqual({ kind: "love", t: 540, title: "Robot Love", text: "Your Goliath and theirs fell in love mid-map: a draw", tone: "neutral" });
    expect(moments({ samples: samples(540), deaths: [], refs, love }, null).at(-1)!.text).toBe("Blue's and Red's Goliaths fell in love mid-map: a draw");
  });

  it("counts Goliaths fielded, and never counts a Gantry as an idle factory", () => {
    const w = createWorld(48, 48);
    w.factions.blue.scrap = 5000;
    spawnBuilding(w, "gantry", "blue", 10, 10);
    const c = new Chronicle(w);
    expect(c.factories.blue.total).toBe(0);
    const g = spawnUnit(w, "goliath", "blue", 12, 14);
    c.onFx({ type: "built", faction: "blue", id: g.id });
    expect(goliathsFielded(c)).toEqual({ blue: 1, red: 0 });
    expect(c.firstBuilt.blue.goliath).toBe(0);
  });

  it("under Nomads counts each side's starting Goliath as fielded, and the tip sees the enemy's", async () => {
    const { createMapWorld } = await import("../src/sim/maps");
    const w = createMapWorld("riverlands", { mutators: ["nomads"] });
    const c = new Chronicle(w);
    expect(goliathsFielded(c)).toEqual({ blue: 1, red: 1 });
    const tip = pickTip({
      pov: "blue", won: false, duration: 600, difficulty: "normal", built: { blue: {}, red: {} }, firstBuilt: { blue: {}, red: {} },
      deaths: [], samples: [], factories: { blue: { total: 0, idleRich: 0 }, red: { total: 0, idleRich: 0 } }, startGoliaths: c.startGoliaths
    });
    expect(tip).toMatch(/^They fielded a Goliath\./);
  });

  it("the headline: VICTORY, DEFEAT, a spectator's winner, or a DRAW styled as neither", () => {
    const o = { pov: "blue" as Faction, spectator: false, love: false };
    expect(headline({ ...o, winner: "blue" })).toEqual({ title: "VICTORY", cls: "win", note: null });
    expect(headline({ ...o, winner: "red" })).toEqual({ title: "DEFEAT", cls: "lose", note: null });
    expect(headline({ ...o, winner: "red", spectator: true })).toEqual({ title: "RED WINS", cls: "lose", note: null });
    expect(headline({ ...o, winner: "draw", love: true })).toEqual({ title: "DRAW", cls: "draw", note: "💘 They fell in love" });
    expect(headline({ ...o, winner: "draw", spectator: true })).toEqual({ title: "DRAW", cls: "draw", note: null });
  });

  it("a draw is no win: no victory medal, but feats of arms still count", () => {
    const w = createWorld(48, 48);
    const c = new Chronicle(w);
    w.tick = 200 * TICK_RATE; // (a fast, flawless, untouched match: every victory medal, had it been won)
    c.onFx(goliathDeath("red", 5));
    w.winner = "blue";
    expect(computeMedals(recapOf(w, c, "blue"))).toEqual(["lightning", "untouchable", "flawless", "goliath-slayer"]);
    w.winner = "draw";
    expect(recapOf(w, c, "blue").won).toBe(false);
    expect(computeMedals(recapOf(w, c, "blue"))).toEqual(["goliath-slayer"]);
    expect(computeMedals(recapOf(w, c, "red"))).toEqual([]);
  });

  it("the Goliath Slayer medal: one enemy Goliath brought down", () => {
    const recap = (deaths: MatchRecap["deaths"]): MatchRecap => ({
      pov: "blue", won: false, secs: 600, stats: { blue: stats(), red: stats() }, samples: [], deaths, bestUnitKills: 0
    });
    const fell = (faction: Faction) => ({ t: 1, faction, unitKind: "goliath" as const, buildingKind: null, byBuilding: false });
    expect(AWARDS.goliathKills).toBe(1);
    expect(computeMedals(recap([fell("red")]))).toEqual(["goliath-slayer"]);
    expect(computeMedals(recap([fell("blue")]))).toEqual([]);
    expect(MEDALS["goliath-slayer"]).toMatchObject({ name: "Goliath Slayer", desc: "Bring down an enemy Goliath", mode: "skirmish" });
  });
});

// --------------------------------------------------------- heroes, voices --

describe("Goliath heroes and voices", () => {
  const off: (() => void)[] = [];
  afterEach(() => {
    for (const f of off.splice(0)) f();
    vi.restoreAllMocks();
  });

  const presenter = (w: World, notify: (msg: string) => void = () => {}) =>
    new HeroPresenter(null, w, {
      player: "blue", spectator: false, seesPoint: () => false, seesUnit: () => false, unitPos: () => null, notify
    });

  it("an elite Goliath isn't 'self-repairing' (only Menders mend it)", () => {
    const w = createWorld(32, 32);
    const seen: Announcement[] = [];
    off.push(onAnnounce((a) => seen.push(a)));
    const hp = presenter(w);
    const g = spawnUnit(w, "goliath", "blue", 10, 10);
    const m = spawnUnit(w, "mastodon", "blue", 12, 10);
    g.rank = m.rank = 3;
    hp.handleFx({ type: "rankUp", id: g.id });
    hp.handleFx({ type: "rankUp", id: m.id });
    expect(seen.map((a) => a.key)).toEqual(["unit-elite", "unit-elite"]);
    expect(seen[0]!.sub).not.toMatch(/self-repairing/);
    expect(seen[1]!.sub).toMatch(/self-repairing/);
  });

  it("an enemy ace Goliath going down in the fog is still news (it can't hide)", () => {
    const w = createWorld(32, 32);
    const notes: string[] = [];
    const hp = presenter(w, (msg) => notes.push(msg));
    hp.handleFx(goliathDeath("red", 50, { rank: 3, kills: 12 }));
    hp.handleFx(death({ faction: "red", id: 51, unitKind: "mastodon", rank: 3, kills: 12 })); // (in the fog: unseen)
    hp.flush();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/Enemy ace .*Goliath/);
  });

  it("our Goliath reports in when it has dug in where we can see it", () => {
    const w = createWorld(32, 32);
    const v = new UnitVoices();
    vi.spyOn(v, "answers").mockReturnValue(true);
    const said: [string, string, number][] = [];
    vi.spyOn(v, "say").mockImplementation((kind, line, id) => (said.push([kind, line, id]), true));
    const h = { world: w, player: "blue" as Faction, spectator: false, inView: (x: number) => x <= 30 };
    v.events([mode("blue", "anchoring", 5), mode("blue", "anchored", 5)], h);
    v.events([mode("blue", "anchored", 6, 35), mode("red", "anchored", 7)], h); // (out of view; the enemy's)
    expect(said).toEqual([["goliath", "ready", 5]]);
  });
});

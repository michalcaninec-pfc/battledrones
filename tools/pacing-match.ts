// One AI-vs-AI match with the pacing panel's measurements (tools/pacing.ts).
// Pure simulation: no Node APIs, so tests can import it.
import { createAiState, tickAi, type Difficulty, type StrategyName } from "../src/sim/ai/commander";
import { BUILDINGS, OBJECTIVES, TICK_RATE, UNITS } from "../src/sim/balance";
import { createMapWorld } from "../src/sim/maps";
import { pickAiOpener } from "../src/sim/openers";
import { rulesOf } from "../src/sim/rules";
import { step } from "../src/sim/sim";
import type { Faction, FxEvent, UnitKind } from "../src/sim/types";
import { buildingCenter, hqOf } from "../src/sim/world";

const COMBAT = new Set<UnitKind>([
  "stinger", "flak-crawler", "mortar", "mastodon", "lancer", "wasp", "raptor", "hornet", "mender", "trooper", "rocket-squad", "sniper"
]);
const SIDES: Faction[] = ["blue", "red"];

export interface Match {
  map: string;
  blue: StrategyName;
  red: StrategyName;
  seed: number;
  openers: Record<Faction, string>;
  winner: Faction | "draw";
  min: number;
  firstCombatDeath: number | null;
  /** Unit deaths in 10 bins along the blue HQ → red HQ line (all units / combat units). */
  bins: number[];
  combatBins: number[];
  /** Leader by > 200 value (units × HP share + buildings + scrap) at minute m, or null. */
  leadAt: Record<number, Faction | null>;
  /** Times the value lead (300 deadband, checked every 15 s) changed sides. */
  leadChanges: number;
  /** Was this side ever 800+ value behind? */
  wasBehind: Record<Faction, boolean>;
  /** Scrap destroyed per 10 s window. */
  series: number[];
  /** Big fights: runs of 10 s windows with ≥ 300 destroyed (a window under 150 ends one), ≥ 1000 in all. */
  fights: { start: number; end: number; destroyed: number }[];
  calldowns: Record<Faction, Record<string, number>>;
  uplinkFlips: number;
  /** Times a holder lost an Uplink (it changed hands). */
  uplinkLost: number;
  cratesLanded: number;
  cratesClaimed: number;
  /** Scrap each side had harvested by 4:00 (side-fairness check). */
  harvest4: Record<Faction, number>;
  /** Scrap value of the units each side built, by group (harvesters left out). */
  built: Record<Faction, Record<UnitGroup, number>>;
  /** Squads a Condor set down in an Uplink's zone vs anywhere else (drops, not bail-outs), and bail-outs. */
  unloads: { relay: number; elsewhere: number; bailout: number };
  /** Island Uplinks (infantry only) taken per side, how many of them from the other side, and when each side took its first (s). */
  islandCaptures: Record<Faction, number>;
  islandRetakes: Record<Faction, number>;
  firstIsland: Record<Faction, number | null>;
  /** Relay-seconds each side's island Uplinks were crewed (paying), summed over relays. */
  crewedSecs: Record<Faction, number>;
  /** Unit deaths in all, and within 8 tiles of an Uplink. */
  unitDeaths: number;
  relayDeaths: number;
  /** Condors each side lost. */
  condorsLost: Record<Faction, number>;
  /** Scrap each side harvested, and was paid by Uplinks, over the match. */
  income: Record<Faction, { harvested: number; uplinks: number }>;
  /** Wall-clock cost (only with `timing`: it makes replays differ). */
  perf?: { msPerMin: number; worstTick: number };
}

/** Unit groups for the value-built tally. */
export type UnitGroup = "infantry" | "condor" | "air" | "vehicles";

export function unitGroup(kind: UnitKind): UnitGroup | null {
  if (kind === "harvester") return null;
  if (kind === "condor") return "condor";
  if (UNITS[kind].squad) return "infantry";
  return UNITS[kind].domain === "air" ? "air" : "vehicles";
}

export interface PlayOptions {
  /** AI difficulty for both sides (default Normal). */
  difficulty?: Difficulty;
  /** Record wall-clock cost (Match.perf). */
  timing?: boolean;
  /** Ban the Goliath (and so its Gantry) for both sides: a match about something else, at the old pace. */
  noGoliath?: boolean;
}

export function playMatch(map: string, blue: StrategyName, red: StrategyName, seed: number, aiSeed: number, opts: PlayOptions = {}): Match {
  const openers = { blue: pickAiOpener(blue, seed, "blue"), red: pickAiOpener(red, seed, "red") };
  const w = createMapWorld(map, { seed, objectives: true, openers });
  if (opts.noGoliath) {
    const r = rulesOf(w);
    w.rules = { ...r, bannedUnits: [...r.bannedUnits, "goliath"], bannedBuildings: [...r.bannedBuildings, "gantry"] };
  }
  const diff = opts.difficulty ?? "normal";
  const ai = { blue: createAiState(blue, diff, aiSeed), red: createAiState(red, diff, aiSeed + 1) };
  const A = buildingCenter(hqOf(w, "blue")!);
  const B = buildingCenter(hqOf(w, "red")!);
  const vx = B.x - A.x;
  const vy = B.y - A.y;
  const vv = vx * vx + vy * vy;
  const m: Match = {
    map, blue, red, seed, openers, winner: "draw", min: 0, firstCombatDeath: null,
    bins: new Array(10).fill(0), combatBins: new Array(10).fill(0), leadAt: {}, leadChanges: 0,
    wasBehind: { blue: false, red: false }, series: [], fights: [], calldowns: { blue: {}, red: {} },
    uplinkFlips: 0, uplinkLost: 0, cratesLanded: 0, cratesClaimed: 0, harvest4: { blue: 0, red: 0 },
    built: { blue: { infantry: 0, condor: 0, air: 0, vehicles: 0 }, red: { infantry: 0, condor: 0, air: 0, vehicles: 0 } },
    unloads: { relay: 0, elsewhere: 0, bailout: 0 },
    islandCaptures: { blue: 0, red: 0 }, islandRetakes: { blue: 0, red: 0 }, firstIsland: { blue: null, red: null },
    crewedSecs: { blue: 0, red: 0 }, unitDeaths: 0, relayDeaths: 0, condorsLost: { blue: 0, red: 0 },
    income: { blue: { harvested: 0, uplinks: 0 }, red: { harvested: 0, uplinks: 0 } }
  };
  const uplinks = w.objectives.uplinks;
  const R = OBJECTIVES.uplink.radius;
  /** Uplink id → the side that last held it (a capture from the other side is a retake). */
  const lastHeld = new Map<number, Faction>();
  const t0 = opts.timing ? performance.now() : 0;
  let worstTick = 0;
  const value = (f: Faction) => {
    let v = w.factions[f].scrap;
    for (const u of w.units.values()) if (u.faction === f) v += UNITS[u.kind].cost * (u.hp / UNITS[u.kind].hp);
    for (const b of w.buildings.values()) if (b.faction === f) v += BUILDINGS[b.kind].cost;
    return v;
  };
  let leader: Faction | null = null;
  let window = 0;
  for (let i = 0; i < 25 * 60 * TICK_RATE && !w.winner; i++) {
    const tickStart = opts.timing ? performance.now() : 0;
    step(w, [...tickAi(w, "blue", ai.blue), ...tickAi(w, "red", ai.red)]);
    if (opts.timing) worstTick = Math.max(worstTick, performance.now() - tickStart);
    const t = w.tick / TICK_RATE;
    for (const ev of w.fx as FxEvent[]) {
      if (ev.type === "death") {
        window += ev.unitKind ? UNITS[ev.unitKind].cost : BUILDINGS[ev.buildingKind!].cost || 500;
        if (!ev.unitKind) continue;
        m.unitDeaths++;
        if (uplinks.some((l) => Math.hypot(l.x - ev.x, l.y - ev.y) <= 8)) m.relayDeaths++;
        if (ev.unitKind === "condor") m.condorsLost[ev.faction]++;
        const combat = COMBAT.has(ev.unitKind);
        if (combat && m.firstCombatDeath === null) m.firstCombatDeath = t;
        const bin = Math.max(0, Math.min(9, Math.floor((((ev.x - A.x) * vx + (ev.y - A.y) * vy) / vv) * 10)));
        m.bins[bin]!++;
        if (combat) m.combatBins[bin]!++;
      } else if (ev.type === "uplinkFlip") {
        m.uplinkFlips++;
        if (ev.prev) m.uplinkLost++;
        const l = uplinks.find((u) => u.id === ev.id);
        if (ev.owner && l?.infantryOnly) {
          m.islandCaptures[ev.owner]++;
          if (lastHeld.get(ev.id) && lastHeld.get(ev.id) !== ev.owner) m.islandRetakes[ev.owner]++;
          m.firstIsland[ev.owner] ??= t;
        }
        if (ev.owner) lastHeld.set(ev.id, ev.owner);
      } else if (ev.type === "built") {
        const u = w.units.get(ev.id);
        const g = u && unitGroup(u.kind);
        if (u && g) m.built[u.faction][g] += UNITS[u.kind].cost;
      } else if (ev.type === "disembark") {
        if (ev.bailout) m.unloads.bailout += ev.unitIds.length;
        else if (uplinks.some((l) => Math.hypot(l.x - ev.x, l.y - ev.y) <= R)) m.unloads.relay += ev.unitIds.length;
        else m.unloads.elsewhere += ev.unitIds.length;
      } else if (ev.type === "crateLanded") m.cratesLanded++;
      else if (ev.type === "crateClaimed") m.cratesClaimed++;
    }
    if (w.tick % TICK_RATE === 0) for (const l of uplinks) if (l.infantryOnly && l.owner && l.crewed) m.crewedSecs[l.owner]++;
    if (w.tick % (10 * TICK_RATE) === 0) {
      m.series.push(window);
      window = 0;
    }
    if (w.tick % (15 * TICK_RATE) === 0) {
      const d = value("blue") - value("red");
      const now: Faction | null = d > 300 ? "blue" : d < -300 ? "red" : leader;
      if (leader && now !== leader) m.leadChanges++;
      leader = now;
      if (d < -800) m.wasBehind.blue = true;
      if (d > 800) m.wasBehind.red = true;
    }
    if (w.tick === 4 * 60 * TICK_RATE) for (const s of SIDES) m.harvest4[s] = w.factions[s].stats.scrapHarvested;
    if (w.tick % (60 * TICK_RATE) === 0 && w.tick <= 6 * 60 * TICK_RATE) {
      const d = value("blue") - value("red");
      m.leadAt[w.tick / (60 * TICK_RATE)] = Math.abs(d) < 200 ? null : d > 0 ? "blue" : "red";
    }
  }
  if (window > 0) m.series.push(window);
  m.winner = w.winner ?? "draw";
  m.min = w.tick / TICK_RATE / 60;
  let f: { start: number; end: number; destroyed: number } | null = null;
  m.series.forEach((d, i) => {
    if (d >= 300) {
      f ??= { start: i * 10, end: i * 10 + 10, destroyed: 0 };
      f.destroyed += d;
      f.end = i * 10 + 10;
    } else if (f && d < 150) {
      if (f.destroyed >= 1000) m.fights.push(f);
      f = null;
    } else if (f) {
      f.destroyed += d;
      f.end = i * 10 + 10;
    }
  });
  if (f && (f as { destroyed: number }).destroyed >= 1000) m.fights.push(f);
  for (const s of SIDES) {
    m.calldowns[s] = { ...w.powers.fired[s] };
    m.income[s] = { harvested: Math.round(w.factions[s].stats.scrapHarvested), uplinks: Math.round(w.objectives.stats[s].uplinkScrap) };
  }
  if (opts.timing) m.perf = { msPerMin: Math.round((performance.now() - t0) / Math.max(1e-9, m.min)), worstTick: Math.round(worstTick * 10) / 10 };
  return m;
}


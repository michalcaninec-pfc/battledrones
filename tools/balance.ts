// Headless balance harness.
//   npx vite-node tools/balance.ts duels          cost-equal unit duel matrix
//   npx vite-node tools/balance.ts matches [map] [--classic] [--no-objectives]
//                                                 AI-vs-AI round robin (every map, or one), each AI
//                                                 taking its personality's opener, with Uplinks and
//                                                 supply drops (--classic: neither; --no-objectives)
//   npx vite-node tools/balance.ts passive        each strategy vs a passive foe
//   npx vite-node tools/balance.ts goliath [--menders N]
//                                                 a Goliath (plus N Menders) vs cost-equal groups
//                                                 of each unit, from both sides of the field
// `matches` also reports the Goliath numbers GOLIATH.md asks for (when the first one
// appears, what each earns and kills before it dies, outposts, lifts, how long a side
// lasts after its HQ falls); --no-goliath bans it for an A/B run.
// Any mode takes --tune '{"UNITS.trooper.hp":200}' to override exported balance numbers
// (and AI personalities: "STRATEGIES.rush.assaultValue"; the Goliath: "GOLIATH.costStep")
// for an A/B run.
import { STRATEGIES, createAiState, tickAi, type StrategyName } from "../src/sim/ai/commander";
import { CONDOR_AI } from "../src/sim/ai/condor";
import { GOLIATH_AI } from "../src/sim/ai/goliath";
import { MENDER_AI } from "../src/sim/ai/menders";
import * as balance from "../src/sim/balance";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { MAPS, createMapWorld, mapById } from "../src/sim/maps";
import { pickAiOpener } from "../src/sim/openers";
import { step } from "../src/sim/sim";
import { rulesOf } from "../src/sim/rules";
import type { Faction, UnitKind, World } from "../src/sim/types";
import { createWorld, spawnUnit } from "../src/sim/world";

const COMBAT: UnitKind[] = [
  "stinger", "flak-crawler", "mortar", "mastodon", "lancer", "wasp", "raptor", "hornet", "trooper", "rocket-squad", "sniper"
];
const BUDGET = 1800;

/** Army A (blue) vs army B (red), equal scrap, attack-moving into each other. */
function duel(a: UnitKind, b: UnitKind, seed: number): number {
  const w = createWorld(40, 40);
  const spawnArmy = (kind: UnitKind, faction: "blue" | "red", x: number) => {
    const n = Math.max(1, Math.round(BUDGET / UNITS[kind].cost));
    const ids: number[] = [];
    for (let i = 0; i < n; i++)
      ids.push(spawnUnit(w, kind, faction, x + (i % 3) * 0.8 + seed * 0.01, 16 + Math.floor(i / 3) * 0.8).id);
    return ids;
  };
  const A = spawnArmy(a, "blue", 8);
  const B = spawnArmy(b, "red", 30);
  step(w, [
    { type: "attackMove", faction: "blue", unitIds: A, x: 32, y: 17 },
    { type: "attackMove", faction: "red", unitIds: B, x: 8, y: 17 }
  ]);
  for (let t = 0; t < 120 * TICK_RATE; t++) {
    step(w, []);
    const blue = [...w.units.values()].some((u) => u.faction === "blue");
    const red = [...w.units.values()].some((u) => u.faction === "red");
    if (!blue || !red) break;
    // units that can't hit anything on the other side just idle: stop early
    if (t % 50 === 0 && t > 300 && w.fx.every((f) => f.type !== "shot")) break;
  }
  const left = (f: "blue" | "red") =>
    [...w.units.values()].filter((u) => u.faction === f).reduce((s, u) => s + (u.hp / UNITS[u.kind].hp) * UNITS[u.kind].cost, 0);
  // +1 = A wiped B with nothing lost; -1 = the reverse
  return (left("blue") - left("red")) / BUDGET;
}

function duels(): void {
  const pad = (s: string, n = 8) => s.slice(0, n).padStart(n);
  console.log(`cost-equal duels (${BUDGET} scrap each): row army vs column army, + = row wins`);
  console.log(pad("") + COMBAT.map((k) => pad(k)).join(""));
  for (const a of COMBAT) {
    let row = pad(a);
    for (const b of COMBAT) row += pad(a === b ? "-" : ((duel(a, b, 0) - duel(b, a, 0)) / 2).toFixed(2));
    console.log(row);
  }
}

/**
 * One Goliath (and `menders` Menders behind it) against a cost-equal group of
 * `kind`, attack-moving into each other. The Goliath's side is blue, or red
 * when `flip` (so neither side's spawn order decides it). Returns +1 when the
 * Goliath's side wiped the other with nothing lost, −1 the reverse.
 */
function goliathDuel(kind: UnitKind, menders: number, flip: boolean): { score: number; secs: number; lost: string } {
  const w = createWorld(40, 40);
  const budget = UNITS.goliath.cost + menders * UNITS.mender.cost;
  const gSide: Faction = flip ? "red" : "blue";
  const kSide: Faction = flip ? "blue" : "red";
  const gx = flip ? 30 : 8;
  const kx = flip ? 8 : 30;
  const g = spawnUnit(w, "goliath", gSide, gx, 17);
  const gIds = [g.id];
  for (let i = 0; i < menders; i++) gIds.push(spawnUnit(w, "mender", gSide, gx + (flip ? 1.5 : -1.5), 15.5 + i).id);
  const n = Math.max(1, Math.round(budget / UNITS[kind].cost));
  const kIds: number[] = [];
  for (let i = 0; i < n; i++) kIds.push(spawnUnit(w, kind, kSide, kx + (i % 3) * 0.8, 14 + Math.floor(i / 3) * 0.8).id);
  step(w, [
    { type: "attackMove", faction: gSide, unitIds: gIds, x: kx, y: 17 },
    { type: "attackMove", faction: kSide, unitIds: kIds, x: gx, y: 17 }
  ]);
  const lost: string[] = [];
  let t = 0;
  for (; t < 180 * TICK_RATE; t++) {
    step(w, []);
    for (const e of w.fx) if (e.type === "goliathWeapon" && e.state === "offline") lost.push(e.weapon);
    const alive = (f: Faction) => [...w.units.values()].some((u) => u.faction === f);
    if (!alive("blue") || !alive("red")) break;
    if (t % 50 === 0 && t > 300 && w.fx.every((f) => f.type !== "shot")) break;
  }
  const left = (f: Faction) =>
    [...w.units.values()].filter((u) => u.faction === f).reduce((s, u) => s + (u.hp / UNITS[u.kind].hp) * UNITS[u.kind].cost, 0);
  return { score: (left(gSide) - left(kSide)) / budget, secs: t / TICK_RATE, lost: lost.map((k) => k[0]).join("") || "-" };
}

function goliathDuels(): void {
  const at = process.argv.indexOf("--menders");
  const menders = at >= 0 ? Number(process.argv[at + 1]) : 0;
  const budget = UNITS.goliath.cost + menders * UNITS.mender.cost;
  console.log(`a Goliath${menders ? ` + ${menders} Mender${menders > 1 ? "s" : ""}` : ""} vs ${budget} scrap of each unit (+ = Goliath wins; weapons lost: m/l/c)`);
  for (const k of COMBAT) {
    const a = goliathDuel(k, menders, false);
    const b = goliathDuel(k, menders, true);
    const score = (a.score + b.score) / 2;
    console.log(
      `  ${k.padEnd(13)} ${score >= 0 ? "+" : ""}${score.toFixed(2)}   ${((a.secs + b.secs) / 2).toFixed(0).padStart(3)} s   lost ${a.lost}/${b.lost}`
    );
  }
}

const classic = process.argv.includes("--classic");
const noGoliath = process.argv.includes("--no-goliath");

/** What one match did with Goliaths (GOLIATH.md "What to measure"). */
interface GoliathLog {
  /** Match seconds of each side's first rollout (null: none). */
  first: Record<Faction, number | null>;
  rollouts: number;
  gantries: number;
  /** Per dead Goliath: seconds alive, scrap of kills, scrap unloaded at it. */
  deaths: { life: number; killed: number; earned: number }[];
  /** Goliaths alive at the end, with the same tallies so far. */
  survivors: { life: number; killed: number; earned: number }[];
  outposts: number;
  /** Scrap unloaded at outpost buildings. */
  outpostScrap: number;
  lifts: number;
  anchors: number;
  /** Seconds the losing side played on after its HQ fell (null: the HQ fall decided it, or no winner). */
  afterHq: number | null;
}

/** Watch a match's events each tick and fill in a GoliathLog. */
function goliathWatch(): { log: GoliathLog; tick(w: World): void } {
  const log: GoliathLog = {
    first: { blue: null, red: null }, rollouts: 0, gantries: 0, deaths: [], survivors: [],
    outposts: 0, outpostScrap: 0, lifts: 0, anchors: 0, afterHq: null
  };
  const born = new Map<number, { t: number; killed: number; earned: number }>();
  const hqFell: Record<Faction, number | null> = { blue: null, red: null };
  return {
    log,
    tick(w: World) {
      const t = w.tick / TICK_RATE;
      for (const e of w.fx) {
        if (e.type === "goliathRollout") {
          log.rollouts++;
          if (log.first[e.faction] === null) log.first[e.faction] = t;
          born.set(e.id, { t, killed: 0, earned: 0 });
        } else if (e.type === "built") {
          const b = w.buildings.get(e.id);
          if (b?.kind === "gantry") log.gantries++;
          if (b?.outpost) log.outposts++;
        } else if (e.type === "goliathLift" && e.state === "hooked") log.lifts++;
        else if (e.type === "goliathMode" && e.mode === "anchored") log.anchors++;
        else if (e.type === "deposit") {
          for (const u of w.units.values())
            if (u.goliath && Math.abs(u.x - e.x) < 1e-6 && Math.abs(u.y - e.y) < 1e-6) {
              const r = born.get(u.id);
              if (r) r.earned += e.amount;
            }
          for (const b of w.buildings.values())
            if (b.outpost && Math.abs(b.tx + 1 - e.x) < 1e-6 && Math.abs(b.ty + 1 - e.y) < 1e-6) log.outpostScrap += e.amount;
        } else if (e.type === "death" && e.unitKind === "goliath") {
          const r = born.get(e.id);
          if (r) log.deaths.push({ life: t - r.t, killed: r.killed, earned: r.earned });
          born.delete(e.id);
        } else if (e.type === "death" && e.buildingKind === "hq") hqFell[e.faction] = t;
      }
      if (w.tick % TICK_RATE === 0)
        for (const u of w.units.values()) {
          const r = u.goliath ? born.get(u.id) : undefined;
          if (r) r.killed = u.xp;
        }
      if (w.winner) {
        const loser: Faction = w.winner === "blue" ? "red" : "blue";
        const fell = hqFell[loser];
        if (fell !== null && t - fell > 0.5) log.afterHq = t - fell;
        for (const [, r] of born) log.survivors.push({ life: t - r.t, killed: r.killed, earned: r.earned });
        born.clear();
      }
    }
  };
}
const objectives = !classic && !process.argv.includes("--no-objectives");

function match(map: string, blue: StrategyName, red: StrategyName, maxMin = 25): { winner: string; min: number; w: World; g: GoliathLog } {
  const seed = mapById(map).seed;
  const w = createMapWorld(
    map,
    classic
      ? {}
      : { objectives, openers: { blue: pickAiOpener(blue, seed, "blue"), red: pickAiOpener(red, seed, "red") } }
  );
  if (noGoliath) {
    const r = rulesOf(w);
    w.rules = { ...r, bannedUnits: [...r.bannedUnits, "goliath"], bannedBuildings: [...r.bannedBuildings, "gantry"] };
  }
  const sb = createAiState(blue, "normal", 1);
  const sr = createAiState(red, "normal", 2);
  const watch = goliathWatch();
  for (let i = 0; i < maxMin * 60 * TICK_RATE && !w.winner; i++) {
    step(w, [...tickAi(w, "blue", sb), ...tickAi(w, "red", sr)]);
    watch.tick(w);
  }
  if (!w.winner) for (const u of w.units.values()) if (u.goliath) watch.log.survivors.push({ life: 0, killed: u.xp, earned: 0 });
  return { winner: w.winner ?? "draw", min: w.tick / TICK_RATE / 60, w, g: watch.log };
}

/** Print what the Goliaths did over a set of matches. */
function goliathReport(logs: { map: string; g: GoliathLog; min: number }[]): void {
  const n = logs.length;
  const withG = logs.filter((l) => l.g.rollouts > 0);
  const firsts = logs.flatMap((l) => [l.g.first.blue, l.g.first.red].filter((x): x is number => x !== null)).sort((a, b) => a - b);
  const med = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)]! : NaN);
  const mmss = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "-");
  console.log("\nGoliaths:");
  console.log(
    `  matches with one: ${withG.length}/${n}; Gantries ${logs.reduce((s, l) => s + l.g.gantries, 0)}, ` +
      `Goliaths ${logs.reduce((s, l) => s + l.g.rollouts, 0)}; first rollout median ${mmss(med(firsts))} (earliest ${mmss(firsts[0] ?? NaN)})`
  );
  const deaths = logs.flatMap((l) => l.g.deaths);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  if (deaths.length)
    console.log(
      `  ${deaths.length} died: lived ${mmss(avg(deaths.map((d) => d.life)))} on average, killed ${avg(deaths.map((d) => d.killed)).toFixed(0)} scrap ` +
        `and took in ${avg(deaths.map((d) => d.earned)).toFixed(0)} scrap of harvest first (list price ${UNITS.goliath.cost})`
    );
  const surv = logs.flatMap((l) => l.g.survivors);
  if (surv.length) console.log(`  ${surv.length} survived their match, having killed ${avg(surv.map((d) => d.killed)).toFixed(0)} scrap on average`);
  console.log(
    `  per match: ${(logs.reduce((s, l) => s + l.g.anchors, 0) / n).toFixed(1)} anchorings, ${(logs.reduce((s, l) => s + l.g.outposts, 0) / n).toFixed(1)} outposts ` +
      `(${(logs.reduce((s, l) => s + l.g.outpostScrap, 0) / n).toFixed(0)} scrap unloaded at them), ${(logs.reduce((s, l) => s + l.g.lifts, 0) / n).toFixed(1)} lifts`
  );
  const after = logs.map((l) => l.g.afterHq).filter((x): x is number => x !== null);
  console.log(
    `  a beaten side outlived its HQ in ${after.length}/${n} matches` +
      (after.length ? ` (by ${mmss(avg(after))} on average, longest ${mmss(Math.max(...after))})` : "")
  );
  const maps = [...new Set(logs.map((l) => l.map))];
  for (const m of maps) {
    const ls = logs.filter((l) => l.map === m);
    console.log(`  ${m.padEnd(16)} ${ls.filter((l) => l.g.rollouts > 0).length}/${ls.length} with a Goliath, mean ${(ls.reduce((s, l) => s + l.min, 0) / ls.length).toFixed(1)} min`);
  }
}

function matches(): void {
  const names = Object.keys(STRATEGIES) as StrategyName[];
  const wins: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  const games: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  const built: Record<string, number> = {};
  let draws = 0;
  let totalMin = 0;
  let n = 0;
  let salvaged = 0;
  let harvested = 0;
  const calls: Record<string, number> = {};
  let uplinkScrap = 0;
  let crateScrap = 0;
  let captures = 0;
  let crates = 0;
  const logs: { map: string; g: GoliathLog; min: number }[] = [];
  const only = process.argv.slice(3).find((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--tune");
  for (const map of MAPS.filter((m) => !only || m.id === only)) {
    for (let i = 0; i < names.length; i++)
      for (let j = 0; j < names.length; j++) {
        if (i === j) continue;
        const { winner, min, w, g } = match(map.id, names[i]!, names[j]!);
        logs.push({ map: map.id, g, min });
        n++;
        totalMin += min;
        games[names[i]!]!++;
        games[names[j]!]!++;
        if (winner === "blue") wins[names[i]!]!++;
        else if (winner === "red") wins[names[j]!]!++;
        else draws++;
        for (const f of ["blue", "red"] as const) {
          salvaged += w.factions[f].stats.scrapSalvaged;
          harvested += w.factions[f].stats.scrapHarvested;
          for (const [k, v] of Object.entries(w.powers.fired[f])) calls[k] = (calls[k] ?? 0) + v;
          const os = w.objectives.stats[f];
          uplinkScrap += os.uplinkScrap;
          crateScrap += os.crateScrap;
          captures += os.captures;
          crates += os.crates;
        }
        for (const u of w.units.values()) built[u.kind] = (built[u.kind] ?? 0) + 1;
        process.stdout.write(`${map.id} ${names[i]} vs ${names[j]}: ${winner} @ ${min.toFixed(1)}m\n`);
      }
  }
  console.log("\nwin rates:");
  for (const s of names) console.log(`  ${s.padEnd(10)} ${((100 * wins[s]!) / games[s]!).toFixed(0)}%`);
  console.log(`draws ${draws}/${n}, mean length ${(totalMin / n).toFixed(1)} min`);
  console.log(
    `salvage ${(salvaged / n).toFixed(0)} scrap per match (${((100 * salvaged) / Math.max(1, salvaged + harvested)).toFixed(1)}% of income)`
  );
  const totalCalls = Object.values(calls).reduce((a, b) => a + b, 0);
  console.log(
    `calldowns ${(totalCalls / n / 2).toFixed(1)} per AI per match (${Object.entries(calls)
      .map(([k, v]) => `${k} ${(v / n / 2).toFixed(1)}`)
      .join(", ")})`
  );
  if (objectives)
    console.log(
      `objectives per match: ${(captures / n).toFixed(1)} Uplink captures, ${(crates / n).toFixed(1)} crates claimed, ` +
        `${(uplinkScrap / n).toFixed(0)} Uplink + ${(crateScrap / n).toFixed(0)} crate scrap ` +
        `(${((100 * (uplinkScrap + crateScrap)) / Math.max(1, harvested + salvaged + uplinkScrap + crateScrap)).toFixed(1)}% of income)`
    );
  console.log("units alive at match end:", built);
  if (!noGoliath) goliathReport(logs);
}

function passive(): void {
  for (const map of MAPS)
    for (const s of Object.keys(STRATEGIES) as StrategyName[]) {
      const w = createMapWorld(map.id);
      const st = createAiState(s, "normal", 3);
      for (let i = 0; i < 20 * 60 * TICK_RATE && !w.winner; i++) step(w, tickAi(w, "red", st));
      console.log(`${map.id.padEnd(16)} ${s.padEnd(10)} ${w.winner ?? "none"} @ ${(w.tick / 600).toFixed(1)}m`);
    }
}

function applyTune(json: string | undefined): void {
  if (!json) return;
  const roots: Record<string, unknown> = { ...balance, STRATEGIES, CONDOR_AI, GOLIATH_AI, MENDER_AI };
  for (const [path, v] of Object.entries(JSON.parse(json) as Record<string, unknown>)) {
    const parts = path.split(".");
    let o = roots as Record<string, unknown>;
    for (const p of parts.slice(0, -1)) o = o[p] as Record<string, unknown>;
    const last = parts[parts.length - 1]!;
    if (!o || !(last in o)) throw new Error(`no such tunable: ${path}`);
    o[last] = v;
  }
}
const tuneAt = process.argv.indexOf("--tune");
applyTune(tuneAt >= 0 ? process.argv[tuneAt + 1] : undefined);

const mode = process.argv[2] ?? "duels";
if (mode === "duels") duels();
else if (mode === "matches") matches();
else if (mode === "passive") passive();
else if (mode === "goliath") goliathDuels();

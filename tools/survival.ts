// Last Stand tuning harness: how many waves does a defender survive?
//   npx vite-node tools/survival.ts [ai|human|both] [map|all] [easy|normal|hard|all] [seeds]
// "ai"    = blue is a Normal Balanced AI commander (src/sim/ai/commander.ts)
// "human" = blue is a scripted, reasonable phone player: reacts once a
//           second, keeps factory queues one deep, builds a few turrets,
//           counters the announced wave theme (Flak and Raptors for air,
//           Mortars and Hornets for a Bot Swarm once it has a Tech Lab) and
//           pulls its army onto attackers near the base — but never calls
//           waves early.
//           With --calldowns it also fires the Command meter like a player
//           would: the Sky Hammer and Barrages on the biggest wave clump near
//           the base, a Drop Pod when the base is outgunned. --no-calldowns
//           takes them away from the AI defender too (an A/B check).
// --tune '{"waveWreckShare":0.3}' overrides SURVIVAL numbers (A/B runs);
//   '{"themes":["swarm","swarm","swarm","swarm","swarm"]}' makes every regular
//   wave one theme (compare themes by waves survived).
// Prints waves survived per map and difficulty (plus run length, kills and
// salvage), then per theme and stage of the run: the scrap value the defender
// lost while each wave was the current one, and how many runs it ended.
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { BUILDINGS, TICK_RATE, UNITS } from "../src/sim/balance";
import { canPlaceBuilding, nearestScrapTile, unitBlocker } from "../src/sim/economy";
import { calldownBlocker, powerStatus } from "../src/sim/powers";
import { isVisible } from "../src/sim/fog";
import { isInfantry } from "../src/sim/infantry";
import { MAPS, createMapWorld } from "../src/sim/maps";
import { SURVIVAL, survivalStatus, wavesSurvived, type SurvivalDifficulty, type WaveTheme } from "../src/sim/modes/survival";
import { step } from "../src/sim/sim";
import type { BuildingKind, Command, Unit, UnitKind, World } from "../src/sim/types";
import { buildingCenter, dist, hqOf } from "../src/sim/world";

type Defender = "ai" | "human";
type Brain = (w: World) => Command[];

function aiDefender(seed: number): Brain {
  const s = createAiState("balanced", "normal", seed);
  return (w) => {
    const cmds = tickAi(w, "blue", s);
    return NO_AI_CALLDOWNS ? cmds.filter((c) => c.type !== "calldown") : cmds;
  };
}

/** A scripted "decent phone player" (see the header). */
function humanDefender(w0: World): Brain {
  const hq = hqOf(w0, "blue")!;
  const hqC = buildingCenter(hq);
  const field = nearestScrapTile(w0, hqC.x, hqC.y, "blue")!;
  const guard = { x: (field.x + hqC.x) / 2 + 1, y: (field.y + hqC.y) / 2 - 1 };
  const toward = (p: { x: number; y: number }, d: number) => {
    const len = Math.max(1, dist(hqC.x, hqC.y, p.x, p.y));
    return { x: hqC.x + ((p.x - hqC.x) / len) * d, y: hqC.y + ((p.y - hqC.y) / len) * d };
  };
  const front = toward({ x: w0.width / 2, y: w0.height / 2 }, 5);
  const build: BuildingKind[] = ["fab-plant", "turret", "airpad", "tech-lab", "turret", "sam-site", "turret", "fab-plant", "sam-site", "turret"];
  let bi = 0;
  let heldFor = 0;
  const spot = (w: World, kind: BuildingKind, anchor: { x: number; y: number }) => {
    const size = BUILDINGS[kind].size;
    let best: { tx: number; ty: number } | null = null;
    let bd = Infinity;
    for (let ty = 0; ty < w.height; ty++)
      for (let tx = 0; tx < w.width; tx++) {
        const d = Math.hypot(tx + size / 2 - anchor.x, ty + size / 2 - anchor.y);
        if (d < bd && canPlaceBuilding(w, "blue", kind, tx, ty)) {
          bd = d;
          best = { tx, ty };
        }
      }
    return best;
  };
  return (w) => {
    if (w.tick % TICK_RATE !== 0) return [];
    const cmds: Command[] = [];
    const f = w.factions.blue;
    const st = survivalStatus(w)!;
    const mine = [...w.units.values()].filter((u) => u.faction === "blue");
    const myB = [...w.buildings.values()].filter((b) => b.faction === "blue");
    const hqB = myB.find((b) => b.kind === "hq");
    if (!hqB) return cmds;
    const army = mine.filter((u) => u.kind !== "harvester");
    const foes = [...w.units.values()].filter((u) => u.faction === "red" && isVisible(w, "blue", Math.floor(u.x), Math.floor(u.y)));
    const airThreat = st.nextTheme === "air" || foes.filter((u) => UNITS[u.kind].domain === "air").length >= 2;
    const swarmThreat = st.nextTheme === "swarm" || foes.filter((u) => isInfantry(u.kind)).length >= 4;
    let scrap = f.scrap;
    if (f.pending?.ready) {
      const k = f.pending.kind;
      const anchor = k === "turret" || k === "sam-site" ? (bi % 2 ? front : guard) : toward({ x: w.width / 2, y: w.height / 2 }, 2);
      const s = spot(w, k, anchor);
      if (s) cmds.push({ type: "placeBuilding", faction: "blue", tx: s.tx, ty: s.ty });
    } else if (!f.pending && bi < build.length) {
      const next = build[bi]!;
      const req = BUILDINGS[next].requires;
      if (scrap >= BUILDINGS[next].cost && (!req || req.some((r) => myB.some((b) => b.kind === r)))) {
        cmds.push({ type: "startBuilding", faction: "blue", building: next });
        scrap -= BUILDINGS[next].cost;
        bi++;
      }
    }
    if (mine.filter((u) => u.kind === "harvester").length + hqB.queue.length < 4 && scrap >= 150) {
      cmds.push({ type: "produce", faction: "blue", buildingId: hqB.id, unit: "harvester" });
      scrap -= 150;
    }
    const count = (k: UnitKind) => army.filter((u) => u.kind === k).length;
    for (const b of myB) {
      if (b.queue.length >= 1) continue;
      let kind: UnitKind | null = null;
      if (b.kind === "fab-plant") {
        if (airThreat && count("flak-crawler") < 2 + Math.floor(st.wave / 3)) kind = "flak-crawler";
        else if (swarmThreat && !unitBlocker(w, "blue", "mortar") && count("mortar") < 2 + Math.floor(st.wave / 4)) kind = "mortar";
        else if (!unitBlocker(w, "blue", "mastodon")) kind = army.length % 3 === 0 ? "mastodon" : army.length % 3 === 1 ? "lancer" : "stinger";
        else kind = "stinger";
      } else if (b.kind === "airpad")
        kind = airThreat
          ? "raptor"
          : swarmThreat && !unitBlocker(w, "blue", "hornet")
            ? "hornet"
            : count("mender") < 2 && army.length > 8
              ? "mender"
              : "wasp";
      if (!kind || scrap < UNITS[kind].cost) continue;
      cmds.push({ type: "produce", faction: "blue", buildingId: b.id, unit: kind });
      scrap -= UNITS[kind].cost;
      if (!b.rally) cmds.push({ type: "rally", faction: "blue", buildingId: b.id, x: guard.x, y: guard.y });
    }
    if (CALLDOWNS) cmds.push(...playerCalldowns(w, foes, army, hqC));
    // fight whatever is hitting the base; otherwise hold toward the next wave
    const near = foes
      .map((u) => ({ u, d: Math.min(...myB.map((b) => dist(u.x, u.y, buildingCenter(b).x, buildingCenter(b).y))) }))
      .filter((e) => e.d < 15)
      .sort((a, b) => a.d - b.d);
    const idle = army.filter((u) => u.order.type === "idle" && u.autoTargetId === null);
    if (near[0] && idle.length > 0) {
      cmds.push({ type: "attackMove", faction: "blue", unitIds: idle.map((u) => u.id), x: near[0].u.x, y: near[0].u.y });
    } else if (st.warned && st.site && heldFor !== st.next && army.length > 0) {
      heldFor = st.next;
      const hold = toward(st.site, 7);
      cmds.push({ type: "attackMove", faction: "blue", unitIds: army.map((u) => u.id), x: hold.x, y: hold.y });
    }
    return cmds;
  };
}

const CALLDOWNS = process.argv.includes("--calldowns");
const NO_AI_CALLDOWNS = process.argv.includes("--no-calldowns");

/** A player's calldowns: strike the richest wave clump near the base, pod in help when outgunned. */
function playerCalldowns(w: World, foes: Unit[], army: Unit[], hqC: { x: number; y: number }): Command[] {
  const near = foes.filter((u) => dist(u.x, u.y, hqC.x, hqC.y) < 16);
  if (near.length === 0) return [];
  const clump = (us: Unit[], r: number) => {
    let best: { x: number; y: number; v: number } | null = null;
    for (const u of us) {
      const v = us.filter((o) => dist(o.x, o.y, u.x, u.y) <= r).reduce((a, o) => a + UNITS[o.kind].cost, 0);
      if (!best || v > best.v) best = { x: u.x, y: u.y, v };
    }
    return best;
  };
  const fire = (power: "hammer" | "barrage" | "droppod", x: number, y: number): Command[] =>
    powerStatus(w, "blue", power).ready && !calldownBlocker(w, "blue", power, x, y) ? [{ type: "calldown", faction: "blue", power, x, y }] : [];
  const h = clump(near, 2);
  if (h && h.v >= 600) {
    const c = fire("hammer", h.x, h.y);
    if (c.length) return c;
  }
  const g = clump(near.filter((u) => UNITS[u.kind].domain === "ground"), 1.8);
  if (g && g.v >= 500) {
    const c = fire("barrage", g.x, g.y);
    if (c.length) return c;
  }
  const threat = near.reduce((a, u) => a + UNITS[u.kind].cost, 0);
  const guard = army.filter((u) => dist(u.x, u.y, hqC.x, hqC.y) < 16).reduce((a, u) => a + UNITS[u.kind].cost, 0);
  if (threat > guard * 1.2) {
    const k = 3 / Math.max(3, dist(near[0]!.x, near[0]!.y, hqC.x, hqC.y));
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]]) {
      const c = fire("droppod", hqC.x + (near[0]!.x - hqC.x) * k + dx!, hqC.y + (near[0]!.y - hqC.y) * k + dy!);
      if (c.length) return c;
    }
  }
  return [];
}

/** One wave of a run, for the per-theme table. */
export interface WaveRecord {
  wave: number;
  theme: WaveTheme;
  /** Scrap value of the defender's units and buildings lost while this was the current wave. */
  lost: number;
  /** The run ended (HQ fell) during this wave. */
  fatal: boolean;
}

export interface SurvivalRun {
  waves: number;
  min: number;
  kills: number;
  lost: number;
  spawnTimes: number[];
  /** Scrap the defender salvaged from wrecks. */
  salvaged: number;
  perWave: WaveRecord[];
}

export function survivalRun(map: string, difficulty: SurvivalDifficulty, seed: number, defender: Defender = "ai", maxMin = 45): SurvivalRun {
  const w = createMapWorld(map, { seed, survival: { difficulty } });
  const brain = defender === "ai" ? aiDefender(seed) : humanDefender(w);
  const spawnTimes: number[] = [];
  const log = process.env.SURV_LOG === "1";
  const t = () => { const s = w.tick / TICK_RATE; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };
  const value = (f: string) =>
    [...w.units.values()].filter((u) => u.faction === f && u.kind !== "harvester").reduce((v, u) => v + UNITS[u.kind].cost, 0);
  let lostAt = 0;
  const perWave: WaveRecord[] = [];
  for (let i = 0; i < maxMin * 60 * TICK_RATE && !w.winner; i++) {
    step(w, brain(w));
    for (const e of w.fx) {
      const cur = perWave[perWave.length - 1];
      if (cur && e.type === "death" && e.faction === "blue") cur.lost += e.value;
      if (e.type === "waveSpawned") {
        perWave.push({ wave: e.wave, theme: e.theme, lost: 0, fatal: false });
        spawnTimes.push(w.tick / TICK_RATE);
        lostAt = w.factions.blue.stats.unitsLost;
        if (log) {
          const blds = [...w.buildings.values()].filter((b) => b.faction === "blue").map((b) => b.kind);
          console.log(`  ${t()} wave ${e.wave} ${e.name} (${e.count}) | blue army ${value("blue")} scrap ${Math.floor(w.factions.blue.scrap)} harvested ${w.factions.blue.stats.scrapHarvested} | defences ${blds.filter((k) => k === "turret" || k === "sam-site").length} buildings ${blds.length}`);
        }
      }
      if (log && e.type === "waveCleared") console.log(`  ${t()}   cleared ${e.wave}: blue lost ${w.factions.blue.stats.unitsLost - lostAt} units, +${e.bonus}`);
      if (log && e.type === "waveIncoming" && e.early) console.log(`  ${t()}   wave ${e.wave} called early +${e.early}`);
      if (log && e.type === "death" && e.faction === "blue" && e.buildingKind) console.log(`  ${t()}   lost ${e.buildingKind}`);
    }
    if (log && w.tick % 600 === 0) console.log(`  ${t()}   red live ${[...w.units.values()].filter((u) => u.faction === "red").length} (${value("red")}) pending ${w.survival!.pending.length}`);
  }
  const last = perWave[perWave.length - 1];
  if (w.winner && last) last.fatal = true;
  const st = w.factions.blue.stats;
  return { waves: wavesSurvived(w), min: w.tick / TICK_RATE / 60, kills: st.unitsKilled, lost: st.unitsLost, spawnTimes, salvaged: st.scrapSalvaged, perWave };
}

/** Stages of a run for the per-theme table: the first three blocks of five, then wider spans. */
const STAGES = [
  { label: "w1-5", from: 1, to: 5 },
  { label: "w6-10", from: 6, to: 10 },
  { label: "w11-15", from: 11, to: 15 },
  { label: "w16-25", from: 16, to: 25 },
  { label: "w26+", from: 26, to: Infinity }
];

/** Mean scrap lost per wave (and runs ended) by theme and stage: is one theme much harder than the others? */
function themeTable(records: WaveRecord[]): string {
  const themes = [...new Set(records.map((r) => r.theme))].sort();
  const cell = (rs: WaveRecord[]) =>
    rs.length === 0
      ? "-".padStart(16)
      : `${(rs.reduce((a, r) => a + r.lost, 0) / rs.length / 1000).toFixed(2)}k n${rs.length} †${rs.filter((r) => r.fatal).length}`.padStart(16);
  const lines = [`  ${"theme".padEnd(9)}${STAGES.map((g) => g.label.padStart(16)).join("")}`];
  for (const t of themes) {
    const mine = records.filter((r) => r.theme === t);
    lines.push(`  ${t.padEnd(9)}${STAGES.map((g) => cell(mine.filter((r) => r.wave >= g.from && r.wave <= g.to))).join("")}`);
  }
  return lines.join("\n");
}

function main(): void {
  // --tune '{"waveWreckShare":0.3,"budgetMult.normal":1.1}' overrides SURVIVAL numbers for an A/B run
  const ti = process.argv.indexOf("--tune");
  if (ti >= 0)
    for (const [path, v] of Object.entries(JSON.parse(process.argv[ti + 1]!) as Record<string, unknown>)) {
      const parts = path.split(".");
      let o = SURVIVAL as unknown as Record<string, unknown>;
      for (const p of parts.slice(0, -1)) o = o[p] as Record<string, unknown>;
      if (!o || !(parts[parts.length - 1]! in o)) throw new Error(`no such tunable: ${path}`);
      o[parts[parts.length - 1]!] = v;
    }
  const pos = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--tune");
  const defArg = pos[0] ?? "ai";
  const mapArg = pos[1] ?? "all";
  const diffArg = pos[2] ?? "normal";
  const seeds = Number(pos[3] ?? 3);
  const defenders: Defender[] = defArg === "both" ? ["ai", "human"] : [defArg as Defender];
  const maps = MAPS.filter((m) => mapArg === "all" || m.id === mapArg);
  const diffs: SurvivalDifficulty[] = diffArg === "all" ? ["easy", "normal", "hard"] : [diffArg as SurvivalDifficulty];
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  for (const def of defenders)
    for (const d of diffs) {
      const all: number[] = [];
      const records: WaveRecord[] = [];
      for (const m of maps) {
        const runs: SurvivalRun[] = [];
        for (let k = 0; k < seeds; k++) runs.push(survivalRun(m.id, d, 1000 + k * 7919, def));
        for (const r of runs) records.push(...r.perWave);
        const waves = runs.map((r) => r.waves);
        all.push(...waves);
        console.log(
          `${def.padEnd(5)} ${d.padEnd(6)} ${m.id.padEnd(16)} waves ${waves.join(",").padEnd(12)}` +
            ` mean ${(waves.reduce((a, b) => a + b, 0) / waves.length).toFixed(1).padStart(4)}` +
            `  len ${runs.map((r) => r.min.toFixed(1)).join(",")}m  kills ${runs.map((r) => r.kills).join(",")}` +
            `  salvaged ${runs.map((r) => (r.salvaged / 1000).toFixed(1)).join(",")}k` +
            `  first spawns ${runs[0]!.spawnTimes.slice(0, 4).map(fmt).join(" ")}`
        );
      }
      all.sort((a, b) => a - b);
      const mean = all.reduce((a, b) => a + b, 0) / Math.max(1, all.length);
      console.log(
        `${def} ${d}: median ${all[Math.floor(all.length / 2)]} waves, mean ${mean.toFixed(1)} (min ${all[0]}, max ${all[all.length - 1]}, n=${all.length}; ` +
          `fell within the first 3 waves in ${all.filter((x) => x < 3).length})`
      );
      console.log(`  scrap lost per wave by theme (n = waves, † = runs it ended):\n${themeTable(records)}\n`);
    }
}

main();

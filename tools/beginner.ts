// Difficulty on-ramp harness: a scripted phone player (blue) against the AI commander (red)
// in a real skirmish (openers, Uplinks and supply drops on).
//   npx vite-node tools/beginner.ts [novice|beginner|decent] [easy|normal|hard] [seeds] [--maps a,b] [--tune JSON] [--shard i/n]
// novice   = a first-week phone player: looks every 4 s, one order per look,
//            3 harvesters, Fab → Turret → Airpad (never techs), attacks at 8:00 with 12+.
// beginner = a patient beginner: looks every 3 s, steady macro (Fab → Airpad →
//            Turret → Tech Lab → Turret, 4 harvesters), answers attacks on its
//            base, attacks late (from 7:00, with 12+ units).
// decent   = the beginner's macro, looking every second and attacking with 8+ units.
// None touches calldowns, Uplinks or crates (tools/scripted-player.ts).
// Every map × every personality the difficulty draws × each of the three openers.
import * as balance from "../src/sim/balance";
import { DIFFICULTY, STRATEGIES, type Difficulty } from "../src/sim/ai/commander";
import { CONDOR_AI } from "../src/sim/ai/condor";
import { GOLIATH_AI } from "../src/sim/ai/goliath";
import { MENDER_AI } from "../src/sim/ai/menders";
import { MAPS } from "../src/sim/maps";
import { OPENER_IDS } from "../src/sim/openers";
import { PROFILES, playerMatch, type PlayerMatch } from "./scripted-player";

function applyTune(json: string | undefined): void {
  if (!json) return;
  const roots: Record<string, unknown> = { ...balance, STRATEGIES, DIFFICULTY, CONDOR_AI, GOLIATH_AI, MENDER_AI };
  for (const [path, v] of Object.entries(JSON.parse(json) as Record<string, unknown>)) {
    const parts = path.split(".");
    let o = roots as Record<string, unknown>;
    for (const p of parts.slice(0, -1)) o = o[p] as Record<string, unknown>;
    const last = parts[parts.length - 1]!;
    if (!o || !(last in o)) throw new Error(`no such tunable: ${path}`);
    o[last] = v;
  }
}

function main(): void {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const pos = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(all[i - 1] ?? "").startsWith("--"));
  const profile = PROFILES[pos[0] ?? "beginner"]!;
  const diff = (pos[1] ?? "easy") as Difficulty;
  const seeds = Number(pos[2] ?? 1);
  applyTune(arg("--tune"));
  const maps = arg("--maps")?.split(",") ?? MAPS.map((m) => m.id);
  const [shard, shards] = (arg("--shard") ?? "0/1").split("/").map(Number) as [number, number];
  const rows: PlayerMatch[] = [];
  let job = 0;
  for (let s = 0; s < seeds; s++)
    for (const map of maps)
      for (const ai of DIFFICULTY[diff].pool)
        for (const opener of OPENER_IDS) {
          if (job++ % shards !== shard) continue;
          const m = playerMatch(profile, map, ai, diff, opener, 300 + job * 31 + s * 7);
          rows.push(m);
          console.log(JSON.stringify(m));
        }
  const pct = (rs: PlayerMatch[]) => `${rs.filter((r) => r.winner === "blue").length}/${rs.length} (${Math.round((100 * rs.filter((r) => r.winner === "blue").length) / Math.max(1, rs.length))}%)`;
  const group = (key: (r: PlayerMatch) => string) => {
    const g: Record<string, PlayerMatch[]> = {};
    for (const r of rows) (g[key(r)] ??= []).push(r);
    return Object.entries(g).map(([k, rs]) => `${k} ${pct(rs)}`).join(", ");
  };
  const lost = rows.filter((r) => r.winner === "red").map((r) => r.min).sort((a, b) => a - b);
  console.log(`\nscripted ${pos[0] ?? "beginner"} vs ${diff} AI: won ${pct(rows)}, draws ${rows.filter((r) => r.winner === "draw").length}`);
  console.log(`  losses: earliest ${lost[0]?.toFixed(1) ?? "-"} min, median ${lost[Math.floor(lost.length / 2)]?.toFixed(1) ?? "-"} min`);
  console.log(`  by map: ${group((r) => r.map)}`);
  console.log(`  by AI: ${group((r) => r.ai)}`);
  console.log(`  by opener: ${group((r) => r.opener)}`);
}

main();

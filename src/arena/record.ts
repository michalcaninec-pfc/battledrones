/**
 * Battle records (AGENT-BATTLES.md "Battle records"): a small JSON file that
 * replays a battle exactly. The sim is deterministic — the seed and the
 * commands decide everything — so a record is the setup, every non-empty
 * turn's commands in true map coordinates, and a world hash every 100 ticks
 * to prove a replay matches. Round-by-round orders, notes and radio lines
 * ride along for the viewer and for reading how each side thought.
 */
import { createMapWorld } from "../sim/maps";
import { tickFog } from "../sim/fog";
import { applyOpener, type OpenerId } from "../sim/openers";
import type { MutatorId } from "../sim/rules";
import { step } from "../sim/sim";
import type { Command, Faction, World } from "../sim/types";

export const HASH_EVERY = 100;

export interface SeatInfo {
  /** "ai:rush:hard", "scripted", "openai:gpt-6-luna", "seat" (an outside agent)… */
  player: string;
  /** Model options (reasoning effort, temperature), budgets, client versions. */
  settings?: Record<string, unknown>;
}

export interface Usage {
  input: number;
  cached: number;
  output: number;
  /** Model responses (one per tool-loop step) and tool calls. */
  responses?: number;
  toolCalls?: number;
}

/** One side's round: what it ordered (in its own frame), what came back, its notes and radio. */
export interface RoundLog {
  round: number;
  tick: number;
  side: Faction;
  orders: unknown[];
  results: string[];
  notes: string;
  radio?: string;
  /** How the round ended for this seat: it called end_round, wait, ran out of budget, or the arena ended it. */
  ended?: string;
  usage?: Usage;
}

export interface BattleEnd {
  tick: number;
  winner: Faction | null;
  reason: "hq" | "time" | "aborted";
}

export interface BattleRecord {
  v: 1;
  /**
   * The release of the game that replays it ("v10"): the version tag whose
   * src/sim is the one that played it, published at /battledrones/<version>/.
   * null (or missing, in records from before it was kept): sim code no
   * release had.
   */
  version?: string | null;
  /** The code that played it: git commit, and a hash of src/sim/**. */
  commit: string | null;
  sim: string | null;
  created: string;
  map: string;
  mutators: MutatorId[];
  seed: number;
  /** Ticks per round. */
  round: number;
  maxTicks: number;
  openers: Partial<Record<Faction, OpenerId>>;
  /** Income multiplier per side when not 1 (the built-in AI's difficulty handicap: tickAi sets it every tick). */
  income?: Partial<Record<Faction, number>>;
  seats: Record<Faction, SeatInfo>;
  /** Coordinates in `log` are each side's own frame; `turns` and `radio` ticks are true. */
  frames: "own";
  /** Non-empty turns only: [tick, side, commands in true map coordinates]. */
  turns: [number, Faction, Command[]][];
  radio: [number, Faction, string][];
  /** [tick, hash] every HASH_EVERY ticks. */
  hashes: [number, string][];
  log: RoundLog[];
  /** How far the battle has been played: a live record grows round by round. */
  tick: number;
  end: BattleEnd | null;
  usage: Partial<Record<Faction, Usage>>;
  /** Re-simulated on newer sim code (resimulate), oldest first: what it was before each time. */
  upgraded?: Upgrade[];
}

/** One re-simulation: the code the record had been played (or last re-simulated) by, and how it ended then. */
export interface Upgrade {
  from: { version?: string | null; commit: string | null; sim: string | null };
  end: BattleEnd | null;
  at: string;
}

/** The match a record describes, set up as the arena set it up: a skirmish with objectives, both openers dealt, fog drawn. */
export function setupWorld(r: Pick<BattleRecord, "map" | "seed" | "mutators" | "openers" | "income">): World {
  const w = createMapWorld(r.map, { seed: r.seed, objectives: true, ...(r.mutators.length ? { mutators: r.mutators } : {}) });
  for (const f of ["blue", "red"] as const) {
    const o = r.openers[f];
    if (o) applyOpener(w, f, o);
    const m = r.income?.[f];
    if (m !== undefined) w.factions[f].incomeMult = m;
  }
  tickFog(w);
  return w;
}

// ------------------------------------------------------------------ hashing ---

const buf = new DataView(new ArrayBuffer(8));

/** FNV-1a over the bytes of numbers. */
class Fnv {
  h = 0x811c9dc5;
  num(n: number): void {
    buf.setFloat64(0, n);
    for (let i = 0; i < 8; i++) {
      this.h ^= buf.getUint8(i);
      this.h = Math.imul(this.h, 0x01000193);
    }
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) {
      this.h ^= s.charCodeAt(i) & 0xff;
      this.h = Math.imul(this.h, 0x01000193);
    }
  }
  hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, "0");
  }
}

/** A hash of everything that matters in the world: any drift shows up within 100 ticks. */
export function worldHash(w: World): string {
  const h = new Fnv();
  h.num(w.tick);
  h.num(w.nextId);
  for (const f of ["blue", "red"] as const) {
    h.num(w.factions[f].scrap);
    h.num(w.powers.meter[f]);
    h.num(w.factions[f].pending?.remaining ?? -1);
  }
  for (const id of [...w.units.keys()].sort((a, b) => a - b)) {
    const u = w.units.get(id)!;
    h.num(id);
    h.str(u.kind);
    h.num(u.x);
    h.num(u.y);
    h.num(u.hp);
    h.str(u.order.type);
    h.num(u.cargo);
  }
  for (const id of [...w.buildings.keys()].sort((a, b) => a - b)) {
    const b = w.buildings.get(id)!;
    h.num(id);
    h.num(b.hp);
    h.num(b.queue.length);
    h.num(b.queue[0]?.remaining ?? -1);
  }
  h.num(w.projectiles.length);
  h.num(w.wrecks.length);
  for (const l of w.objectives.uplinks) h.num(l.progress);
  h.str(w.winner ?? "-");
  return h.hex();
}

// ------------------------------------------------------------------- replay ---

export interface ReplayResult {
  world: World;
  /** First checkpoint whose hash didn't match (null: all matched). */
  divergedAt: number | null;
  checked: number;
}

/**
 * Re-run a record from its setup and commands, checking the hash trail.
 * `until` stops early (a tick); `onTick` sees the world after every step.
 */
export function replay(r: BattleRecord, opts: { until?: number; onTick?: (w: World) => void } = {}): ReplayResult {
  const w = setupWorld(r);
  const byTick = new Map<number, Command[]>();
  for (const [tick, , cmds] of r.turns) byTick.set(tick, [...(byTick.get(tick) ?? []), ...cmds]);
  const hashes = new Map(r.hashes);
  // (an unfinished record: as far as it was played; one from before `tick` was kept: its last checkpoint)
  const end = Math.min(opts.until ?? Infinity, r.end?.tick ?? r.tick ?? Math.max(0, ...r.hashes.map((h) => h[0])));
  let divergedAt: number | null = null;
  let checked = 0;
  while (w.tick < end && !w.winner) {
    step(w, byTick.get(w.tick) ?? []);
    opts.onTick?.(w);
    const want = hashes.get(w.tick);
    if (want !== undefined) {
      checked++;
      if (divergedAt === null && worldHash(w) !== want) divergedAt = w.tick;
    }
  }
  return { world: w, divergedAt, checked };
}

// --------------------------------------------------------------- upgrade ---

/**
 * The same battle on this sim code: the record's commands re-run from its
 * setup, with a new hash trail and ending, so a record from older sim code
 * replays (exactly, from then on) with this one. The commands were chosen
 * against the old sim's world, and they are kept as they were: a unit that
 * died a moment sooner ignores its last order, a building placed on a tile
 * now in use isn't, so a re-simulated battle can end differently, or later.
 * If no HQ has fallen by the original ending, it plays on with the standing
 * orders until one does, or until the battle's time limit (a draw). The
 * models' notes, orders and radio lines stay as they were played; `upgraded`
 * keeps what the record said before, its ending included.
 */
export function resimulate(r: BattleRecord, code: { version?: string | null; commit: string | null; sim: string | null }): BattleRecord {
  const w = setupWorld(r);
  const byTick = new Map<number, Command[]>();
  for (const [tick, , cmds] of r.turns) byTick.set(tick, [...(byTick.get(tick) ?? []), ...cmds]);
  // (a draw on time stays a draw on time; a finished battle plays on until an HQ falls; an unfinished one as far as it went)
  const limit = r.end?.reason === "time" ? r.end.tick : r.end ? r.maxTicks : r.tick;
  const hashes: [number, string][] = [];
  while (w.tick < limit && !w.winner) {
    step(w, byTick.get(w.tick) ?? []);
    if (w.tick % HASH_EVERY === 0) hashes.push([w.tick, worldHash(w)]);
  }
  const end: BattleEnd | null = w.winner
    ? { tick: w.tick, winner: w.winner, reason: "hq" }
    : r.end
      ? { tick: w.tick, winner: null, reason: r.end.reason === "aborted" ? "aborted" : "time" }
      : null;
  return {
    ...r,
    version: code.version ?? null,
    commit: code.commit,
    sim: code.sim,
    hashes,
    tick: w.tick,
    end,
    upgraded: [...(r.upgraded ?? []), { from: { version: r.version ?? null, commit: r.commit, sim: r.sim }, end: r.end, at: new Date().toISOString() }]
  };
}

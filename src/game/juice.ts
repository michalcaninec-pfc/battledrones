/**
 * Combat and economy "juice": the engine-free rules behind hit flashes,
 * damage-trail health bars, team combat rings, death cues, camera shake and
 * income pops. Kept free of three.js so the timing and throttling rules are
 * unit-testable (tests/juice.test.ts); render/juice-view.ts draws them.
 *
 * All times are render milliseconds (they stop while paused) unless noted.
 */
import { BUILDINGS, UNITS } from "../sim/balance";
import type { Faction, FxEvent } from "../sim/types";

export const JUICE = {
  /** Unit hit flash: white silhouette this long, at most once per gap. */
  flashMs: 70,
  flashGapMs: 120,
  /** Building hit flash: a warm additive glow, rarer so sieges don't strobe. */
  buildingFlashMs: 100,
  buildingFlashGapMs: 280,
  /** Damage trail: the lost chunk holds, then drains at this many max-HPs per second. */
  trailHoldMs: 300,
  trailRate: 1.5,
  /** A unit counts as "in combat" (team ground ring) for this many sim ticks after firing or being hit. */
  combatTicks: 30,
  /** The ring fades out over the last this-many ticks of that window. */
  ringFadeTicks: 10,
  /** Enemy health bars blink below this ratio. */
  criticalRatio: 0.25,
  blinkHz: 2,
  /** Income pops at one drop-off merge within this window. */
  popMergeMs: 400,
  /**
   * Deliveries closer together than this build a rising coin streak. Short on
   * purpose: AI-vs-AI replays average one blue delivery every ~3.5 s, so a
   * longer window would pin the coin at its top note all game.
   */
  streakMs: 2500,
  /** A scrap drop of at least this much between frames counts as spending. */
  spendThreshold: 50
} as const;

// ------------------------------------------------------------- hit flash ---

/** Per-entity hit flash timer with a throttle, so sustained fire flickers rather than strobes. */
export class FlashClock {
  private until = new Map<number, number>();
  private started = new Map<number, number>();
  private hits = 0;

  /** Register a hit at `now`; returns true when a new flash starts. */
  hit(id: number, now: number, dur: number = JUICE.flashMs, gap: number = JUICE.flashGapMs): boolean {
    const last = this.started.get(id);
    if (last !== undefined && now - last < gap) return false;
    // forget long-finished flashes now and then (dead entities never call back)
    if (this.started.size > 64 && ++this.hits % 64 === 0)
      for (const [k, t] of this.started) if (now - t > 2000) this.forget(k);
    this.started.set(id, now);
    this.until.set(id, now + dur);
    return true;
  }

  /** Flash strength 1 → 0 across the flash (0 when not flashing). */
  level(id: number, now: number, dur: number = JUICE.flashMs): number {
    const u = this.until.get(id);
    if (u === undefined || now >= u) return 0;
    return Math.min(1, (u - now) / dur);
  }

  active(id: number, now: number): boolean {
    return this.level(id, now) > 0;
  }

  forget(id: number): void {
    this.until.delete(id);
    this.started.delete(id);
  }

  get size(): number {
    return this.started.size;
  }
}

// ------------------------------------------------------- damage trail ---

interface TrailState {
  shown: number;
  lastHp: number;
  holdUntil: number;
  t: number;
}

/**
 * Damage-trail health bars: the HP just lost stays drawn as a pale chunk
 * for a moment, then drains toward the real value. A new burst of damage
 * only re-arms the hold once the trail has caught up, so under sustained
 * fire the chunk keeps draining instead of freezing.
 */
export class HpTrail {
  private s = new Map<number, TrailState>();

  /** Feed the current HP; returns the trailing HP to draw (always ≥ hp). */
  update(id: number, hp: number, max: number, now: number): number {
    const st = this.s.get(id);
    if (!st) {
      this.s.set(id, { shown: hp, lastHp: hp, holdUntil: -Infinity, t: now });
      return hp;
    }
    const prev = st.t;
    st.t = now;
    if (hp < st.lastHp && st.shown - st.lastHp < max * 0.002) st.holdUntil = now + JUICE.trailHoldMs;
    st.lastHp = hp;
    // drain only for the part of the frame that falls after the hold
    const dt = Math.max(0, now - Math.max(prev, st.holdUntil));
    st.shown -= (JUICE.trailRate * max * dt) / 1000;
    st.shown = Math.min(max, Math.max(hp, st.shown));
    return st.shown;
  }

  /** The trailing HP last computed for an entity, if it is tracked. */
  value(id: number): number | undefined {
    return this.s.get(id)?.shown;
  }

  /** Drop entities that no longer exist. */
  retain(alive: (id: number) => boolean): void {
    for (const id of this.s.keys()) if (!alive(id)) this.s.delete(id);
  }

  get size(): number {
    return this.s.size;
  }
}

// ---------------------------------------------------------- health bars ---

/** Friendly bars shade green → amber → red. */
export function friendlyBarColor(ratio: number): number {
  return ratio > 0.6 ? 0x53d769 : ratio > 0.3 ? 0xf2c14e : 0xf06a4a;
}

/** Enemy bars are red, brighter when the target is nearly dead. */
export function enemyBarColor(ratio: number): number {
  return ratio > 0.5 ? 0xe25555 : ratio > JUICE.criticalRatio ? 0xef4848 : 0xff3b3b;
}

/** Alpha for a health bar fill: enemy bars blink at 2 Hz once critical. */
export function barBlink(ratio: number, friendly: boolean, nowMs: number): number {
  if (friendly || ratio > JUICE.criticalRatio || ratio <= 0) return 1;
  const phase = (nowMs / 1000) * JUICE.blinkHz;
  return phase - Math.floor(phase) < 0.5 ? 1 : 0.35;
}

// ---------------------------------------------------------- team rings ---

/** Ticks since a unit last fired or took damage. */
export function combatAge(u: { firedTick: number; damagedTick: number }, tick: number): number {
  return tick - Math.max(u.firedTick, u.damagedTick);
}

/** Team-ring strength for a unit `age` ticks after its last combat (0 = no ring). */
export function ringStrength(age: number): number {
  if (age < 0 || age >= JUICE.combatTicks) return 0;
  const fadeFrom = JUICE.combatTicks - JUICE.ringFadeTicks;
  return age <= fadeFrom ? 1 : (JUICE.combatTicks - age) / JUICE.ringFadeTicks;
}

// --------------------------------------------------------- death cues ---

type DeathEvent = Extract<FxEvent, { type: "death" }>;

export interface DeathCue {
  /** "kill" when an enemy dies where we can see it, "lost" for our own unit. */
  sound: "kill" | "lost" | null;
  /** Haptic tick (we lost a building). */
  vibrate: boolean;
}

/**
 * What a death should sound/feel like to the local player. Spectators get
 * neither cue (both sides are the computer's), so the two can't be confused.
 */
export function deathCue(ev: DeathEvent, player: Faction, spectator: boolean, seen: boolean): DeathCue {
  if (spectator) return { sound: null, vibrate: false };
  const ours = ev.faction === player;
  if (ours) return { sound: ev.unitKind ? "lost" : null, vibrate: ev.buildingKind !== null };
  return { sound: seen ? "kill" : null, vibrate: false };
}

/** Camera shake for a death on screen, scaled by what died. */
export function shakeFor(ev: Pick<DeathEvent, "unitKind" | "buildingKind">): { ms: number; intensity: number } {
  if (ev.buildingKind) {
    const size = BUILDINGS[ev.buildingKind].size;
    if (ev.buildingKind === "hq") return { ms: 600, intensity: 0.009 };
    return { ms: 160 + size * 90, intensity: 0.0015 + size * 0.0018 };
  }
  // (a Goliath's death is the jolt of its reactor going: its topple slams down harder, render/goliath.ts)
  if (ev.unitKind === "goliath") return { ms: 320, intensity: 0.005 };
  if (ev.unitKind === "mastodon" || ev.unitKind === "hornet") return { ms: 140, intensity: 0.003 };
  const size = ev.unitKind ? UNITS[ev.unitKind].radius * 2 : 0.8;
  return { ms: 90, intensity: 0.0012 * size };
}

// ------------------------------------------------------------- economy ---

/** Coin pitch climbs a major-pentatonic scale on a delivery streak. */
const STREAK_STEPS = [0, 2, 4, 7, 9, 12];

export function coinPitch(streak: number): number {
  const i = Math.max(0, Math.min(STREAK_STEPS.length - 1, streak));
  return Math.pow(2, STREAK_STEPS[i]! / 12);
}

export interface PopResult {
  /** Total amount the pop at this drop-off now shows. */
  amount: number;
  /** True when the delivery merged into a pop already rising there. */
  merged: boolean;
  /** Deliveries in the current streak before this one (0 = fresh). */
  streak: number;
}

/**
 * Income pops: deliveries at the same drop-off within popMergeMs merge
 * into one "+200" rather than stacking; deliveries anywhere within
 * streakMs of each other build a streak that raises the coin's pitch.
 */
export class DepositPops {
  private open = new Map<number, { at: number; amount: number }>();
  private lastAt = -Infinity;
  private streak = -1;

  add(dropOff: number, amount: number, now: number): PopResult {
    this.streak = now - this.lastAt <= JUICE.streakMs ? this.streak + 1 : 0;
    this.lastAt = now;
    const cur = this.open.get(dropOff);
    if (cur && now - cur.at < JUICE.popMergeMs) {
      cur.amount += amount;
      return { amount: cur.amount, merged: true, streak: this.streak };
    }
    this.open.set(dropOff, { at: now, amount });
    return { amount, merged: false, streak: this.streak };
  }
}

/** Watches the scrap stockpile between frames and reports a purchase. */
export class SpendWatch {
  private last: number | null = null;

  /** Returns the amount spent since the last call (0 if none worth flagging). */
  update(scrap: number): number {
    const prev = this.last;
    this.last = scrap;
    if (prev === null) return 0;
    const drop = prev - scrap;
    return drop >= JUICE.spendThreshold ? drop : 0;
  }
}

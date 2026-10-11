export type Faction = "blue" | "red";
export type Domain = "ground" | "air";
export type TargetDomain = "ground" | "air" | "both" | "none";

export type UnitKind =
  | "harvester"
  | "scout"
  | "stinger"
  | "flak-crawler"
  | "mortar"
  | "titan"
  | "lancer"
  | "wasp"
  | "raptor"
  | "hornet"
  | "mender"
  // robot infantry (INFANTRY.md): each is ONE sim unit drawn as UNITS[kind].squad robots
  | "trooper"
  | "rocket-squad"
  | "sniper"
  /** Dropship: carries two infantry squads, unarmed. */
  | "condor";

export type BuildingKind =
  | "hq"
  | "fab-plant"
  | "airpad"
  | "tech-lab"
  | "depot"
  | "turret"
  | "sam-site"
  | "radar"
  /** Builds robot infantry. */
  | "assembly-bay";

/** Armor classes: weapons deal a damage-type-specific multiple vs each. */
export type ArmorClass = "light" | "medium" | "heavy" | "structure" | "infantry";

/** Damage types, each with a multiplier row in `DAMAGE_VS` (balance.ts). */
export type DamageType = "kinetic" | "cannon" | "flak" | "missile" | "explosive" | "laser" | "precision";

/** How a weapon looks when it fires (render-only hint carried on fx). */
export type WeaponFx =
  | "cannon"
  | "heavy-cannon"
  | "flak"
  | "rockets"
  | "missile"
  | "laser"
  | "shell"
  | "bomb"
  | "mg"
  /** Trooper rifles: a crackle of light tracers from each robot standing. */
  | "rifle"
  /** Sniper rail-rifle: one bright, instant streak. */
  | "snipe";

export const enum Terrain {
  Ground = 0,
  Rock = 1,
  Scrap = 2,
  /** Deep water (or lava): blocks tracked/wheeled units; hover and air cross. */
  Water = 3,
  /** Paved road: faster ground movement. */
  Road = 4,
  /** Mud, scree, slush: slow for wheels/tracks, hover glides over. */
  Rough = 5,
  /** Woods: slow for everyone on the ground, and cover (less damage taken). */
  Forest = 6,
  /** Rich crystal field: harvests into more scrap per load. */
  Crystal = 7,
  /** Bridge deck over water: a road that can't be built on. */
  Bridge = 8,
  /** Shallow ford: slow for ground units, open to hover. */
  Shallows = 9,
  /** Open sea: too deep and rough for anything but aircraft (hover included). */
  Deep = 10
}

/** Harvester internal cycle state. */
export type HarvestPhase = "toField" | "harvesting" | "toBase" | "unloading";

export type UnitOrder =
  | { type: "idle" }
  | { type: "move"; x: number; y: number }
  | { type: "attackMove"; x: number; y: number }
  /**
   * `defending`: called to this HQ's defence (combat.ts defendHq), so the
   * chase ends once the target is COMBAT.hqLeash from it.
   */
  | { type: "attack"; targetId: number; defending?: number }
  | { type: "harvest"; fieldX: number; fieldY: number; phase: HarvestPhase }
  /**
   * Infantry: walk to Condor `carrierId` and climb aboard (transport.ts).
   * `ticks` counts up while the squad is within boarding range; at
   * INFANTRY.boardTime it is taken off the map into the Condor.
   */
  | { type: "board"; carrierId: number; ticks: number }
  /**
   * Condor: fly to (x, y) — already snapped to the nearest tile infantry can
   * stand on — hover for INFANTRY.unloadHover, then drop every passenger.
   * `hover` is -1 while flying, then counts ticks spent hovering.
   */
  | { type: "unload"; x: number; y: number; hover: number };

export interface Unit {
  id: number;
  kind: UnitKind;
  faction: Faction;
  /** Position in tile units (floats); the unit's centre. */
  x: number;
  y: number;
  hp: number;
  /** Hull facing angle in radians, 0 = North (up), clockwise. */
  facing: number;
  /** Weapon aim angle (turrets track this independently of the hull). */
  aim: number;
  order: UnitOrder;
  /** Remaining path waypoints in tile coords (ground units). */
  path: { x: number; y: number }[] | null;
  /** Destination the current path was computed for (invalidation check). */
  pathGoal: { x: number; y: number } | null;
  /** Scrap carried (harvesters). */
  cargo: number;
  /** Ticks until this unit may fire again. */
  cooldown: number;
  /** Current auto-acquired target while attack-moving/idling. */
  autoTargetId: number | null;
  /** Tick this unit last took damage (drives harvester flee behaviour). */
  damagedTick: number;
  /** Who last hurt us (unit or building id) — idle units retaliate. */
  lastAttackerId: number | null;
  /** Tick this unit last fired (renderer: recoil, turret settle). */
  firedTick: number;
  /** Combat experience: scrap value of enemies destroyed. */
  xp: number;
  /** Veterancy rank 0–3 (derived from xp); boosts damage. */
  rank: number;
  /** Enemy units and buildings this unit has destroyed. */
  kills: number;
  /**
   * Condor only: the infantry squads aboard (at most INFANTRY.capacity).
   * Passengers are taken OUT of `World.units` while aboard — hidden, unable
   * to fire, no vision, no presence — and put back (same id) when dropped.
   * Absent on every other unit.
   */
  passengers?: Unit[];
  /**
   * A target this unit found it can't get in range of (across the water), left
   * alone until `until` (tick) so it fights what it can reach meanwhile.
   */
  ignore?: { id: number; until: number };
  /**
   * Handed out by the map, not bought: the island map's starting Condor and
   * the free replacement Condor with its squad (lifeline.ts). A free unit
   * leaves no wreck and its loss charges no one's ⚡ meter, so throwing one
   * away gains nothing.
   */
  free?: boolean;
}

export interface QueueItem {
  kind: UnitKind;
  /** Ticks of build time remaining. */
  remaining: number;
}

export interface Building {
  id: number;
  kind: BuildingKind;
  faction: Faction;
  /** Top-left tile of the footprint. */
  tx: number;
  ty: number;
  hp: number;
  queue: QueueItem[];
  rally: { x: number; y: number } | null;
  /** Turret head facing, radians clockwise from North. */
  facing: number;
  cooldown: number;
  damagedTick: number;
  lastAttackerId: number | null;
  firedTick: number;
}

/** A building being constructed C&C-style (timer in the "sidebar"). */
export interface PendingBuilding {
  kind: BuildingKind;
  remaining: number;
  ready: boolean;
}

export interface FactionStats {
  unitsBuilt: number;
  unitsLost: number;
  unitsKilled: number;
  buildingsLost: number;
  /** Enemy buildings destroyed (by anything this faction owns). */
  buildingsKilled: number;
  scrapHarvested: number;
  /** Scrap collected from battlefield wrecks (salvage.ts). */
  scrapSalvaged: number;
}

export interface FactionState {
  scrap: number;
  /** At most one building under construction at a time (C&C rule). */
  pending: PendingBuilding | null;
  stats: FactionStats;
  /** Multiplier on harvested scrap (AI difficulty handicap/bonus). */
  incomeMult: number;
}

/** A simulated slow projectile (artillery shell, bomb): dodgeable. */
export interface Projectile {
  id: number;
  faction: Faction;
  fx: WeaponFx;
  /** Launch point, current point, and ground impact point (tiles). */
  sx: number;
  sy: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** Tiles per tick. */
  speed: number;
  damage: number;
  splash: number;
  dmgType: DamageType;
  targets: TargetDomain;
  sourceId: number;
  /** Launched from the air (bombs fall rather than arc). */
  fromAir: boolean;
}

export type FxEvent =
  | {
      type: "shot";
      fx: WeaponFx;
      x: number;
      y: number;
      tx: number;
      ty: number;
      /** Shooter / target are airborne (for render altitude). */
      fromAir: boolean;
      air: boolean;
      sourceId: number;
    }
  | { type: "explosion"; x: number; y: number; size: number; air: boolean; kind: "unit" | "building" | "impact" }
  | { type: "heal"; x: number; y: number; tx: number; ty: number; sourceId: number; targetId: number }
  | { type: "built"; faction: Faction; id: number }
  | { type: "sold"; id: number }
  | {
      type: "hit";
      /** Victim's faction, id and position. */
      faction: Faction;
      id: number;
      x: number;
      y: number;
      building: boolean;
      /** Who dealt the damage (may already be dead next tick). */
      attackerId: number;
    }
  | { type: "rankUp"; id: number }
  | {
      /**
       * Something was destroyed. Emitted once per death alongside the
       * visual "explosion" event, with everything feedback, stats and
       * awards need (the entity is already gone from the world).
       */
      type: "death";
      id: number;
      /** The victim's faction; the kill is credited to the other one. */
      faction: Faction;
      unitKind: UnitKind | null;
      buildingKind: BuildingKind | null;
      x: number;
      y: number;
      air: boolean;
      /** Scrap value of what died (HQs count 500). */
      value: number;
      /** Killer unit/building id if it is still alive this tick, else null. */
      killerId: number | null;
      /** The killer's unit kind, when the killer is a living unit. */
      killerKind: UnitKind | null;
      /** Victim's veterancy rank and kill count at death (0 for buildings). */
      rank: number;
      kills: number;
      /** A map-given unit (Unit.free): its loss charges no ⚡ meter. */
      free?: boolean;
    }
  | {
      /** A harvester started unloading `amount` scrap at a drop-off. */
      type: "deposit";
      faction: Faction;
      id: number;
      x: number;
      y: number;
      amount: number;
    }
  | {
      /** Last Stand: wave `wave` lands in `eta` ticks at (x, y), entering from `dir`. */
      type: "waveIncoming";
      wave: number;
      theme: WaveTheme;
      name: string;
      x: number;
      y: number;
      dir: string;
      eta: number;
      /** Scrap paid because the defender called this wave early (0 if not). */
      early: number;
    }
  | { type: "waveSpawned"; wave: number; theme: WaveTheme; name: string; x: number; y: number; count: number }
  | {
      /** Last Stand: every wave unit is dead; the defender got `bonus` scrap. */
      type: "waveCleared";
      wave: number;
      bonus: number;
      next: string;
      nextTheme: WaveTheme;
    }
  | {
      /** A ground unit scooped up a wreck: `value` scrap (after incomeMult) went to `faction`. */
      type: "salvage";
      faction: Faction;
      x: number;
      y: number;
      value: number;
      wreckId: number;
      /** The collecting unit (or the building placed on top of the wreck). */
      collectorId: number;
    }
  | {
      /**
       * A commander calldown was fired (powers.ts). Public: both sides see
       * the telegraph through the fog. It lands at `landTick`.
       */
      type: "calldown";
      id: number;
      faction: Faction;
      power: PowerKind;
      x: number;
      y: number;
      radius: number;
      landTick: number;
    }
  | {
      /**
       * A calldown landed: one per Barrage shell; the EMP pulse; the Drop
       * Pod touching down (`unitIds` = its crew); the Sky Hammer strike.
       * `hits` = enemy units and buildings it damaged or stunned.
       */
      type: "calldownImpact";
      id: number;
      faction: Faction;
      power: PowerKind;
      x: number;
      y: number;
      radius: number;
      hits: number;
      unitIds: number[];
    }
  | {
      /** EMP: these entities (of `faction`) can't move, fire or produce until `until`. */
      type: "stun";
      faction: Faction;
      ids: number[];
      x: number;
      y: number;
      until: number;
    }
  | {
      /** A power just came online for `faction` (the Sky Hammer at 6:00). */
      type: "powerOnline";
      faction: Faction;
      power: PowerKind;
    }
  | {
      /**
       * An Uplink changed hands (objectives.ts): `owner` took it (from
       * neutral), or `owner` is null when `prev` lost it to a neutralising
       * push by `by`. Public: both sides see it.
       */
      type: "uplinkFlip";
      id: number;
      x: number;
      y: number;
      owner: Faction | null;
      prev: Faction | null;
      by: Faction;
    }
  | {
      /** `faction` started pushing an Uplink's capture bar its way (fires once per push). */
      type: "uplinkContest";
      id: number;
      x: number;
      y: number;
      faction: Faction;
      /** Owner at the moment the push began. */
      owner: Faction | null;
    }
  | {
      /** A supply crate was announced (public, both sides): it lands at `landTick`. */
      type: "crateIncoming";
      id: number;
      x: number;
      y: number;
      reward: CrateReward;
      landTick: number;
      /** Which drop of the match (0 = the first); both crates of a drop share it. */
      drop: number;
    }
  | { type: "crateLanded"; id: number; x: number; y: number; reward: CrateReward }
  | {
      /**
       * `faction` claimed a crate. `amount`: scrap or charge gained, units
       * promoted or healed; `unitIds`: the units it affected (or the one it
       * delivered).
       */
      type: "crateClaimed";
      id: number;
      x: number;
      y: number;
      faction: Faction;
      collectorId: number;
      reward: CrateReward;
      amount: number;
      unitIds: number[];
      /** Scrap credited (the scrap reward, or the fallback when a kit had nothing to work on). */
      scrap: number;
    }
  | { type: "crateExpired"; id: number; x: number; y: number }
  | {
      /** A free replacement Condor `id` flew in at (x, y) (lifeline.ts), `squad`: with a free squad aboard. */
      type: "lifeline";
      faction: Faction;
      id: number;
      x: number;
      y: number;
      squad: boolean;
    }
  | {
      /** Infantry squad `unitId` climbed into Condor `carrierId` (it left World.units). */
      type: "embark";
      faction: Faction;
      carrierId: number;
      unitId: number;
      x: number;
      y: number;
    }
  | {
      /**
       * Condor `carrierId` put squads `unitIds` back on the ground at (x, y):
       * a normal drop, or `bailout` when it was shot down (they land hurt).
       */
      type: "disembark";
      faction: Faction;
      carrierId: number;
      unitIds: number[];
      x: number;
      y: number;
      bailout: boolean;
    }
  | {
      /** A Titan rolled over enemy squad `id` this tick (crushing, INFANTRY.crushDps). */
      type: "crush";
      faction: Faction;
      id: number;
      attackerId: number;
      x: number;
      y: number;
    };

/**
 * A capturable Uplink relay (objectives.ts). Not a building: nothing
 * occupies its tiles and nothing can shoot it, so combat never sees it.
 */
export interface Uplink {
  id: number;
  /** Centre of the capture zone, in tiles. */
  x: number;
  y: number;
  owner: Faction | null;
  /** Capture bar: −100 (red holds it) … 0 (neutral) … +100 (blue holds it). */
  progress: number;
  /** Who is pushing the bar right now (null: nobody, or contested). */
  pushing: Faction | null;
  /** Both sides are inside the zone (the bar is frozen). */
  contested: boolean;
  /**
   * An island relay: only robot infantry count in its zone, to take it AND to
   * contest it (aircraft, the Condor and vehicles don't), and it pays only
   * while the holder's infantry stand in it ("crewed"). Set by the map.
   */
  infantryOnly?: boolean;
  /** Scrap per second to the holder (default OBJECTIVES.uplink.income). */
  income?: number;
  /** ⚡ meter per second to the holder (default OBJECTIVES.uplink.charge). */
  charge?: number;
  /** Infantry-only relays: the holder has a squad in the zone this tick, so it pays. */
  crewed?: boolean;
}

/** What a supply crate holds (the same for both crates of a drop: fair). */
export type CrateReward = "scrap" | "veterans" | "repair" | "charge" | "unit";

export interface Crate {
  id: number;
  x: number;
  y: number;
  reward: CrateReward;
  drop: number;
  /** Announced at, lands (claimable from) at, and burns out at, in ticks. */
  announcedTick: number;
  landTick: number;
  expireTick: number;
}

export interface ObjectiveState {
  uplinks: Uplink[];
  /** Announced or landed crates not yet claimed or expired. */
  crates: Crate[];
  /** Supply-drop sites (tiles, blue-side; each drop lands a crate here and at the mirror). Empty = no drops. */
  dropSites: { x: number; y: number }[];
  /** Drops announced so far (the next drop's index). */
  drops: number;
  /** Index into `dropSites` of the last drop (the next one lands elsewhere). */
  lastSite: number;
  /** Per side: scrap from Uplinks and crates, captures, crates claimed. */
  stats: Record<Faction, { uplinkScrap: number; crateScrap: number; captures: number; crates: number }>;
}

/**
 * What a destroyed combat unit leaves behind (salvage.ts): a burning hull
 * worth scrap to whichever side's ground unit reaches it first. Wrecks are
 * pure loot: they never block movement or placement.
 */
export interface Wreck {
  /** The dead unit's id (ids are never reused, so this is unique). */
  id: number;
  kind: UnitKind;
  /** Whose unit it was (the renderer tints the hull; anyone may salvage it). */
  faction: Faction;
  /** Resting position (tiles): where it died, or nudged onto passable ground. */
  x: number;
  y: number;
  /** Hull facing at death, radians clockwise from North. */
  facing: number;
  /** Scrap it is worth before the collector's incomeMult. */
  value: number;
  /** Ticks left before it burns out. */
  ttl: number;
  /** Ticks left while it is still too hot to salvage. */
  hot: number;
}

/** Commander calldowns (powers.ts): three on the Command meter plus the late-game Sky Hammer. */
export type PowerKind = "barrage" | "emp" | "droppod" | "hammer";

/** A calldown in flight: telegraphed from `startTick`, landing at `landTick`. */
export interface Calldown {
  id: number;
  faction: Faction;
  power: PowerKind;
  x: number;
  y: number;
  radius: number;
  startTick: number;
  landTick: number;
  /** Barrage: where and when each shell lands (seeded scatter). */
  shells: { x: number; y: number; tick: number }[];
}

export interface PowerState {
  /** Command meter per side, 0–POWERS.meterMax. */
  meter: Record<Faction, number>;
  /** Tick each power is next usable, per side (the Sky Hammer starts locked). */
  readyAt: Record<Faction, Record<PowerKind, number>>;
  /** Telegraphed calldowns not yet resolved (public information). */
  active: Calldown[];
  /** EMP'd entity id → tick the stun wears off. */
  stunned: Map<number, number>;
  /** Calldowns fired per side and power (stats). */
  fired: Record<Faction, Record<PowerKind, number>>;
}

import type { FactionFog } from "./fog";
import type { SurvivalState, WaveTheme } from "./modes/survival";
import type { Rules } from "./rules";
import type { OpsState } from "./ops";

export type Biome = "temperate" | "desert" | "arctic" | "volcanic" | "tropical";

export interface World {
  tick: number;
  width: number;
  height: number;
  terrain: Uint8Array;
  /** Scrap remaining per tile (only meaningful on scrap/crystal tiles). */
  scrap: Uint16Array;
  /** Building id occupying each tile (0 = none) — O(1) footprint lookups. */
  occupancy: Int32Array;
  nextId: number;
  units: Map<number, Unit>;
  buildings: Map<number, Building>;
  projectiles: Projectile[];
  /** Salvageable wrecks on the field, oldest first. */
  wrecks: Wreck[];
  /** Commander meters, cooldowns, calldowns in flight and EMP stuns (powers.ts). */
  powers: PowerState;
  /** Map objectives: Uplink relays and supply drops (objectives.ts). Empty unless the match enables them. */
  objectives: ObjectiveState;
  factions: Record<Faction, FactionState>;
  /** null while the match runs; the winning faction once an HQ dies. */
  winner: Faction | null;
  /** Transient render events emitted this tick (cleared each step). */
  fx: FxEvent[];
  fog: Record<Faction, FactionFog>;
  /** Map metadata for the renderer. */
  mapId: string;
  biome: Biome;
  /**
   * Per-match seed. All sim randomness must derive from this (see rand.ts),
   * never Math.random, so a match replays identically from its commands.
   */
  seed: number;
  /** Last Stand (survival mode) wave director state; absent in skirmish. */
  survival?: SurvivalState | null;
  /** Match mutators (rules.ts); absent = classic rules. Read via rulesOf(w). */
  rules?: Rules | null;
  /** Ops campaign scenario state (ops.ts); absent in skirmish and Last Stand. */
  ops?: OpsState | null;
  /** Free replacement Condors (lifeline.ts); absent unless the map hands them out. */
  lifeline?: Record<Faction, LifelineSlot> | null;
}

/** One side's free-Condor clock (lifeline.ts). */
export interface LifelineSlot {
  /** Tick the replacement flies in (null: the side has a Condor, or none is owed). */
  due: number | null;
  /** Free Condors handed out so far. */
  given: number;
}

export type Command =
  | { type: "move"; faction: Faction; unitIds: number[]; x: number; y: number }
  | { type: "attackMove"; faction: Faction; unitIds: number[]; x: number; y: number }
  | { type: "attack"; faction: Faction; unitIds: number[]; targetId: number }
  | { type: "harvest"; faction: Faction; unitIds: number[]; x: number; y: number }
  | { type: "stop"; faction: Faction; unitIds: number[] }
  | { type: "produce"; faction: Faction; buildingId: number; unit: UnitKind }
  | { type: "cancelProduce"; faction: Faction; buildingId: number; unit: UnitKind }
  | { type: "startBuilding"; faction: Faction; building: BuildingKind }
  | { type: "cancelBuilding"; faction: Faction }
  | { type: "placeBuilding"; faction: Faction; tx: number; ty: number }
  | { type: "sell"; faction: Faction; buildingId: number }
  | { type: "rally"; faction: Faction; buildingId: number; x: number; y: number }
  /** Last Stand: bring the next wave in now for a scrap bonus. */
  | { type: "callWave"; faction: Faction }
  | { type: "calldown"; faction: Faction; power: PowerKind; x: number; y: number }
  /** Infantry `unitIds` board Condor `carrierId` (the Condor comes to meet them if idle). */
  | { type: "board"; faction: Faction; unitIds: number[]; carrierId: number }
  /**
   * Condors `unitIds` drop their passengers: at (x, y) if given (they fly there
   * first; the drop snaps to the nearest tile infantry can stand on), else
   * right where they are.
   */
  | { type: "unload"; faction: Faction; unitIds: number[]; x?: number; y?: number };

import { BUILDINGS, UNITS } from "../sim/balance";
import { placementBlocker, snapPlacement } from "../sim/placement";
import type { BuildingKind, Command, Faction, World } from "../sim/types";
import { buildingAtTile, isResource, tileIndex } from "../sim/world";
import { Squads } from "./squads";

export const PLAYER: Faction = "blue";

/** What the player's last tap did, for on-map feedback markers. */
export type TapFeedback = { kind: "move" | "attack" | "harvest" | "rally" | "place"; x: number; y: number } | null;

/**
 * Bridges input/HUD and the sim: owns the player's selection, the command
 * queue drained each sim tick, and building-placement mode.
 */
export class Controller {
  selectedUnits = new Set<number>();
  selectedBuilding: number | null = null;
  /** When set, taps place this building instead of commanding. */
  placing: BuildingKind | null = null;
  /** Next ground tap issues a plain move (retreat) instead of attack-move. */
  forceMove = false;
  /** Debug: render fog of war (display-only — the sim always keeps fog). */
  showFog = true;
  /** Spectator (AI vs AI): taps may inspect but never command. */
  spectator = false;
  paused = false;
  lastFeedback: TapFeedback = null;
  /** Where the placement ghost sits (top-left tile) while placing. */
  placeAt: { tx: number; ty: number } | null = null;
  /** A placement attempt that failed, for the ghost shake (the scene consumes it). */
  denied: { reason: string; tx: number; ty: number } | null = null;
  /** Three saved control groups (squad chips, keys 1–3). */
  readonly squads = new Squads(PLAYER);
  private queue: Command[] = [];

  constructor(public world: World) {}

  drainCommands(): Command[] {
    const cmds = this.queue;
    this.queue = [];
    return cmds;
  }

  enqueue(cmd: Command): void {
    if (this.spectator) return;
    this.queue.push(cmd);
  }

  /** Drop selection entries for units that no longer exist. */
  prune(): void {
    for (const id of this.selectedUnits)
      if (!this.world.units.has(id)) this.selectedUnits.delete(id);
    if (this.selectedBuilding !== null && !this.world.buildings.has(this.selectedBuilding))
      this.selectedBuilding = null;
    if (this.placing && this.world.factions[PLAYER].pending?.kind !== this.placing)
      this.placing = null;
    if (!this.placing) this.placeAt = null;
    this.squads.prune(this.world);
  }

  selectUnits(ids: number[]): void {
    this.selectedUnits = new Set(ids);
    this.selectedBuilding = null;
    this.forceMove = false;
  }

  clearSelection(): void {
    this.selectedUnits.clear();
    this.selectedBuilding = null;
    this.forceMove = false;
  }

  /** Shift+click: add a unit to the selection, or take it out if it's already in. */
  toggleUnit(id: number): void {
    this.selectedBuilding = null;
    if (this.selectedUnits.delete(id)) return; // taken out quietly
    // adding makes a fresh selection set, so the voices answer
    this.selectedUnits = new Set([...this.selectedUnits, id]);
  }

  /** Select every combat unit the player owns. */
  selectArmy(): void {
    const ids = [...this.world.units.values()]
      .filter((u) => u.faction === PLAYER && u.kind !== "harvester")
      .map((u) => u.id);
    this.selectUnits(ids);
  }

  /** Combat units with no orders (sitting at home, or done with their last order). */
  idleArmy(): number[] {
    return [...this.world.units.values()]
      .filter((u) => u.faction === PLAYER && u.kind !== "harvester" && u.order.type === "idle")
      .map((u) => u.id);
  }

  /** Save the current unit selection as squad i. Returns how many were saved. */
  assignSquad(i: number): number {
    return this.squads.assign(i, this.selectedUnits, this.world);
  }

  /** Select squad i's living members. Returns how many. */
  selectSquad(i: number): number {
    const ids = this.squads.ids(i, this.world);
    if (ids.length > 0) this.selectUnits(ids);
    return ids.length;
  }

  // ----------------------------------------------------------- placement --

  /** Why the ghost can't be built where it sits, or null when it can. */
  placementProblem(): string | null {
    if (!this.placing || !this.placeAt) return null;
    return placementBlocker(this.world, PLAYER, this.placing, this.placeAt.tx, this.placeAt.ty);
  }

  /** Move the ghost to (tx, ty), nudged onto a valid spot a tile away if that's all it takes. */
  movePlacement(tx: number, ty: number, snap = true): void {
    if (!this.placing) return;
    this.placeAt = snap ? snapPlacement(this.world, PLAYER, this.placing, tx, ty) : { tx, ty };
  }

  /** Build the ghost where it sits. On failure, records why in `denied`. */
  commitPlacement(): boolean {
    const kind = this.placing;
    const at = this.placeAt;
    if (!kind || !at || this.spectator) return false;
    const why = placementBlocker(this.world, PLAYER, kind, at.tx, at.ty);
    if (why) {
      this.denied = { reason: why, tx: at.tx, ty: at.ty };
      return false;
    }
    const size = BUILDINGS[kind].size;
    this.enqueue({ type: "placeBuilding", faction: PLAYER, tx: at.tx, ty: at.ty });
    this.placing = null;
    this.placeAt = null;
    this.lastFeedback = { kind: "place", x: at.tx + size / 2, y: at.ty + size / 2 };
    return true;
  }

  /** Player tapped world position (wx, wy in tile units); `toggle` (Shift) adds or removes a tapped unit. */
  tapWorld(wx: number, wy: number, hit: TapHit, toggle = false): void {
    const w = this.world;
    this.lastFeedback = null;
    if (this.spectator) {
      // inspection only: selecting shows rings/health, orders are forbidden
      if (hit.kind === "ownUnit" || hit.kind === "enemy") this.selectUnits(w.units.has(hit.id) ? [hit.id] : []);
      else this.clearSelection();
      return;
    }
    if (this.placing) {
      // one-click placement (mouse): the ghost goes where you click and builds if it can
      const size = BUILDINGS[this.placing].size;
      this.placeAt = { tx: Math.round(wx - size / 2), ty: Math.round(wy - size / 2) };
      this.commitPlacement();
      return;
    }

    if (hit.kind === "ownUnit") {
      if (toggle) this.toggleUnit(hit.id);
      else this.selectUnits([hit.id]);
      return;
    }
    if (hit.kind === "ownBuilding") {
      // with units selected, tapping our own building just moves them there
      if (this.selectedUnits.size === 0) {
        this.selectedUnits.clear();
        this.selectedBuilding = hit.id;
        return;
      }
    }
    if (hit.kind === "enemy" && this.selectedUnits.size > 0) {
      const attackers = this.selectedAttackers(hit.targetsAir);
      if (attackers.length > 0) {
        this.enqueue({ type: "attack", faction: PLAYER, unitIds: attackers, targetId: hit.id });
        const others = [...this.selectedUnits].filter((id) => !attackers.includes(id));
        if (others.length > 0)
          this.enqueue({ type: "move", faction: PLAYER, unitIds: others, x: wx, y: wy });
        this.lastFeedback = { kind: "attack", x: wx, y: wy };
        return;
      }
    }
    if (hit.kind === "enemy" && this.selectedUnits.size === 0) return;

    // ground tap
    const tx = Math.floor(wx);
    const ty = Math.floor(wy);
    if (this.selectedUnits.size > 0) {
      const ids = [...this.selectedUnits].filter((id) => w.units.has(id));
      const harvesters = ids.filter((id) => w.units.get(id)!.kind === "harvester");
      const rest = ids.filter((id) => w.units.get(id)!.kind !== "harvester");
      const onResource =
        tx >= 0 && ty >= 0 && tx < w.width && ty < w.height && isResource(w, tileIndex(w, tx, ty));
      const type = this.forceMove ? "move" : "attackMove";
      if (onResource && harvesters.length > 0) {
        this.enqueue({ type: "harvest", faction: PLAYER, unitIds: harvesters, x: wx, y: wy });
        if (rest.length > 0) this.enqueue({ type, faction: PLAYER, unitIds: rest, x: wx, y: wy });
        this.lastFeedback = { kind: "harvest", x: wx, y: wy };
      } else {
        // harvesters always just drive (they have no guns to stop for)
        if (harvesters.length > 0) this.enqueue({ type: "move", faction: PLAYER, unitIds: harvesters, x: wx, y: wy });
        if (rest.length > 0) this.enqueue({ type, faction: PLAYER, unitIds: rest, x: wx, y: wy });
        this.lastFeedback = { kind: "move", x: wx, y: wy };
      }
      this.forceMove = false;
      return;
    }
    if (this.selectedBuilding !== null) {
      const b = w.buildings.get(this.selectedBuilding);
      if (b && (b.kind === "hq" || b.kind === "fab-plant" || b.kind === "airpad")) {
        this.enqueue({ type: "rally", faction: PLAYER, buildingId: this.selectedBuilding, x: wx, y: wy });
        this.lastFeedback = { kind: "rally", x: wx, y: wy };
      } else this.clearSelection();
    }
  }

  stopSelected(): void {
    if (this.selectedUnits.size > 0)
      this.enqueue({ type: "stop", faction: PLAYER, unitIds: [...this.selectedUnits] });
  }

  sellSelected(): void {
    if (this.selectedBuilding !== null)
      this.enqueue({ type: "sell", faction: PLAYER, buildingId: this.selectedBuilding });
    this.selectedBuilding = null;
  }

  /** Selected units able to shoot at the given domain (air or ground). */
  private selectedAttackers(air: boolean): number[] {
    const out: number[] = [];
    for (const id of this.selectedUnits) {
      const u = this.world.units.get(id);
      if (!u) continue;
      const t = UNITS[u.kind].targets;
      if (t === "both" || t === (air ? "air" : "ground")) out.push(id);
    }
    return out;
  }
}

export type TapHit =
  | { kind: "ownUnit"; id: number }
  | { kind: "ownBuilding"; id: number }
  | { kind: "enemy"; id: number; targetsAir: boolean }
  | { kind: "ground" };

/**
 * Hit-test a world point against entities with a forgiving radius.
 * `canSee` filters out enemies hidden in the fog.
 */
export function hitTest(
  w: World,
  wx: number,
  wy: number,
  radiusTiles: number,
  canSee: (id: number) => boolean = () => true
): TapHit {
  let best: TapHit = { kind: "ground" };
  let bestD = radiusTiles;
  for (const u of w.units.values()) {
    // aircraft are drawn lifted: test against where they appear
    const lift = UNITS[u.kind].domain === "air" ? 0.35 : 0;
    const d = Math.hypot(u.x - wx, u.y - lift - wy);
    if (d < bestD) {
      if (u.faction !== PLAYER && !canSee(u.id)) continue;
      bestD = d;
      best =
        u.faction === PLAYER
          ? { kind: "ownUnit", id: u.id }
          : { kind: "enemy", id: u.id, targetsAir: UNITS[u.kind].domain === "air" };
    }
  }
  if (best.kind !== "ground") return best;
  const b = buildingAtTile(w, Math.floor(wx), Math.floor(wy));
  if (b) {
    if (b.faction === PLAYER) return { kind: "ownBuilding", id: b.id };
    if (canSee(b.id)) return { kind: "enemy", id: b.id, targetsAir: false };
  }
  return best;
}

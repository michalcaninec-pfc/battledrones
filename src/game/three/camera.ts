import * as THREE from "three";

/**
 * The RTS camera: a perspective camera looking north and down at a ground
 * point, its distance set by `zoom` (CSS px per tile at that point) and its
 * pitch easing from a steep strategic view when zoomed out to a lower,
 * more cinematic angle close in. World units are tiles: x east, z south
 * (the sim's y), y up.
 */

export const FOV = 34;
/** Pitch (degrees below the horizon) zoomed all the way out / all the way in. */
const PITCH_FAR = 62;
const PITCH_NEAR = 47;
const ZOOM_FAR = 18;
const ZOOM_NEAR = 110;

export interface Pt {
  x: number;
  y: number;
}

const ndc = new THREE.Vector3();
const dir = new THREE.Vector3();
const tmp = new THREE.Vector3();

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 600);
  /** Ground point the camera looks at (tiles). */
  x = 0;
  y = 0;
  /** CSS px per tile at the look-at point. */
  zoom = 40;
  /** Viewport size, CSS px. */
  width = 1;
  height = 1;
  /** Look-at point limits (tiles). */
  bounds = { x0: -4, y0: -4, x1: 64, y1: 64 };
  private shakeT = 0;
  private shakeDur = 0;
  private shakeK = 0;
  private offset = new THREE.Vector3();

  setViewport(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.apply();
  }

  /** Pitch (radians below the horizon) for a zoom level. */
  pitchFor(zoom: number): number {
    const k = Math.min(1, Math.max(0, (zoom - ZOOM_FAR) / (ZOOM_NEAR - ZOOM_FAR)));
    const e = k * k * (3 - 2 * k);
    return THREE.MathUtils.degToRad(PITCH_FAR + (PITCH_NEAR - PITCH_FAR) * e);
  }

  /** Camera distance from the look-at point for the current zoom. */
  get distance(): number {
    return this.height / this.zoom / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
  }

  /** Recompute the camera transform from the rig state (and any shake). */
  apply(): void {
    this.x = Math.min(this.bounds.x1, Math.max(this.bounds.x0, this.x));
    this.y = Math.min(this.bounds.y1, Math.max(this.bounds.y0, this.y));
    const d = this.distance;
    const p = this.pitchFor(this.zoom);
    const c = this.camera;
    c.position.set(this.x, Math.sin(p) * d, this.y + Math.cos(p) * d);
    c.lookAt(this.x, 0, this.y);
    if (this.offset.lengthSq() > 0) c.position.add(this.offset);
    c.updateMatrixWorld(true);
  }

  centerOn(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.apply();
  }

  /** Tile point (x, y, height h) → CSS px on screen; `behind` when it can't be drawn. */
  project(x: number, y: number, h = 0): { x: number; y: number; behind: boolean } {
    ndc.set(x, h, y).project(this.camera);
    return { x: (ndc.x * 0.5 + 0.5) * this.width, y: (-ndc.y * 0.5 + 0.5) * this.height, behind: ndc.z > 1 };
  }

  /**
   * Tile point (x, y) → CSS px to point at it from screen point (sx, sy): where
   * it is drawn, or, for a ground point behind the camera (far enough south of
   * the tilted rig: across a 96-tile map, or less zoomed in), a point far below
   * the screen on the ground line from (sx, sy) towards it. project() mirrors
   * such a point up past the horizon, i.e. north of the view.
   */
  toward(x: number, y: number, sx: number, sy: number): Pt {
    const p = this.project(x, y);
    if (!p.behind) return { x: p.x, y: p.y };
    const g = this.ground(sx, sy);
    const c = this.camera;
    c.getWorldDirection(tmp);
    const depth = (px: number, pz: number) =>
      (px - c.position.x) * tmp.x - c.position.y * tmp.y + (pz - c.position.z) * tmp.z;
    const d0 = depth(g.x, g.y);
    const d1 = depth(x, y);
    // (past the far plane rather than behind: project() has the direction right)
    if (d1 >= d0) return { x: p.x, y: p.y };
    // walk from g towards (x, y) until a tile in front of the camera
    const k = (d0 - 1) / (d0 - d1);
    const q = this.project(g.x + (x - g.x) * k, g.y + (y - g.y) * k);
    return { x: q.x, y: q.y };
  }

  /** CSS px → the ground point (tiles) under it, on the plane at height h. */
  ground(sx: number, sy: number, h = 0): Pt {
    const c = this.camera;
    ndc.set((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1, 0.5).unproject(c);
    dir.copy(ndc).sub(c.position).normalize();
    // (always looking down; guard the horizon anyway)
    const dy = Math.min(-0.02, dir.y);
    const t = (h - c.position.y) / dy;
    return { x: c.position.x + dir.x * t, y: c.position.z + dir.z * t };
  }

  /** World units spanned by one CSS px at tile point (x, y). */
  worldPerPx(x: number, y: number, h = 0): number {
    tmp.set(x, h, y);
    const d = Math.max(0.5, tmp.distanceTo(this.camera.position));
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / this.height;
  }

  /** Is tile point (x, y) on screen (with `pad` CSS px of slack)? */
  onScreen(x: number, y: number, pad = 0, h = 0): boolean {
    const s = this.project(x, y, h);
    return !s.behind && s.x >= -pad && s.x <= this.width + pad && s.y >= -pad && s.y <= this.height + pad;
  }

  /** The ground under the four screen corners (tiles): TL, TR, BR, BL. */
  viewQuad(): Pt[] {
    return [
      this.ground(0, 0),
      this.ground(this.width, 0),
      this.ground(this.width, this.height),
      this.ground(0, this.height)
    ];
  }

  /** Bounding box of the visible ground (tiles). */
  viewRect(): { x0: number; y0: number; x1: number; y1: number } {
    const q = this.viewQuad();
    return {
      x0: Math.min(...q.map((p) => p.x)),
      y0: Math.min(...q.map((p) => p.y)),
      x1: Math.max(...q.map((p) => p.x)),
      y1: Math.max(...q.map((p) => p.y))
    };
  }

  /** Move the look-at point so tile (x, y) sits under screen point (sx, sy). */
  placeAt(x: number, y: number, sx: number, sy: number): void {
    const t = this.targetFor(x, y, sx, sy);
    this.x = t.x;
    this.y = t.y;
    this.apply();
  }

  /** The look-at point that would put tile (x, y) under screen point (sx, sy). */
  targetFor(x: number, y: number, sx: number, sy: number): Pt {
    const keep = { x: this.x, y: this.y };
    this.x = x;
    this.y = y;
    this.apply();
    for (let i = 0; i < 3; i++) {
      const g = this.ground(sx, sy);
      this.x += x - g.x;
      this.y += y - g.y;
      this.apply();
    }
    const out = { x: this.x, y: this.y };
    this.x = keep.x;
    this.y = keep.y;
    this.apply();
    return out;
  }

  /** Drag the map: the ground under the finger follows it by (dx, dy) CSS px. */
  pan(dx: number, dy: number): void {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const a = this.ground(cx, cy);
    const b = this.ground(cx - dx, cy - dy);
    this.x += b.x - a.x;
    this.y += b.y - a.y;
    this.apply();
  }

  /** Zoom to `zoom`, keeping the ground under screen point (sx, sy) fixed. */
  zoomAround(zoom: number, sx: number, sy: number): void {
    if (zoom === this.zoom) return;
    const a = this.ground(sx, sy);
    this.zoom = zoom;
    this.apply();
    const b = this.ground(sx, sy);
    this.x += a.x - b.x;
    this.y += a.y - b.y;
    this.apply();
  }

  /** Camera shake: `intensity` is a fraction of the viewport, like Phaser's. */
  shake(ms: number, intensity: number): void {
    if (this.shakeT < this.shakeDur && intensity < this.shakeK) return;
    this.shakeT = 0;
    this.shakeDur = ms;
    this.shakeK = intensity;
  }

  /** Per frame (real ms): advance the shake. */
  update(dtMs: number): void {
    if (this.shakeT < this.shakeDur) {
      this.shakeT += dtMs;
      const k = Math.max(0, 1 - this.shakeT / this.shakeDur);
      const amp = this.shakeK * this.width * this.worldPerPx(this.x, this.y) * (0.4 + 0.6 * k);
      this.offset.set((Math.random() * 2 - 1) * amp, (Math.random() * 2 - 1) * amp * 0.7, 0);
    } else this.offset.set(0, 0, 0);
    this.apply();
  }
}

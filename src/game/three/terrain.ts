import * as THREE from "three";
import { ECONOMY } from "../../sim/balance";
import { Vis } from "../../sim/fog";
import { Terrain, type Biome, type Faction, type World } from "../../sim/types";
import { Canopy } from "./canopy";
import { canopyMat, fogged, fowUniforms, modelMat } from "./materials";
import { patchCrag, patchGround, patchLiquid, type GroundUniforms, type LiquidUniforms, type RockUniforms } from "./terrain-glsl";
import { bridgeGeometry, type DeckSpan } from "./terrain-bridges";
import { cragGeometry, crystalGeos, hash, scrapGeos, treeGeos, type CragSpot } from "./terrain-props";
import { PaintedColors, terrainNoise, textureMean } from "./terrain-tex";
import { cloudTexture } from "./textures";

/**
 * The 3D battlefield. The map grid becomes a heightfield — rock outcrops
 * rise into craggy mesas, rivers and lava cut real channels, fords dip under
 * a shallow skin of water, rough ground buckles — and the painted terrain
 * art is draped over it as the albedo, so every map keeps its hand-painted
 * look with real relief, lighting and shadows; where the outcrops rise
 * steeply the paint would smear, so their cliff walls show the biome's rock
 * material (the same stone the painter used) projected onto them. On top:
 * animated water (or lava, or an icy sea), bridges, instanced trees per
 * biome, rock crags in that stone, coloured from the painted rock beneath,
 * scrap heaps and glowing crystal clusters that shrink as they're mined,
 * drifting cloud shadows and the fog of war. Past the map's edge the land
 * carries on as a skirt: the map mirrored for a tile or two, easing within
 * a few tiles into the biome's open ground, dimmed so the bounds read, and
 * fading into the sky colour, so the world never ends in a void.
 */

/** Height of the water / lava surface. */
export const WATER_LEVEL = -0.12;
/** Lattice resolution: height samples per tile. */
const RES = 3;
/** How far the skirt runs past the map's edge (tiles); it has faded out by there. */
const SKIRT = 20;
/** Past this (tiles out) the skirt is open ground: no mirrored paint, relief or water. */
const NEAR = 6;
/** The mirrored relief has eased flat this far out (tiles); mirrored water and lava stop here. */
const FLAT = 4;
/** Near-skirt grid lines past the lattice-fine first tile: coarser as it flattens. */
const NEAR_LINES = [1.5, 2, 2.5, 3, FLAT, 5, NEAR];

const TILE_H: Record<number, number> = {
  [Terrain.Ground]: 0,
  [Terrain.Road]: -0.02,
  [Terrain.Scrap]: 0.02,
  [Terrain.Crystal]: 0.02,
  [Terrain.Forest]: 0.03,
  [Terrain.Rough]: 0.05,
  [Terrain.Rock]: 0.95,
  [Terrain.Water]: -0.55,
  [Terrain.Bridge]: -0.55,
  [Terrain.Shallows]: -0.2,
  // the open sea falls away past the coastal shelf (the water shader darkens it with depth)
  [Terrain.Deep]: -1.3
};
/** Extra noise relief by terrain (rock is craggy, rough ground lumpy). */
const TILE_NOISE: Record<number, number> = {
  [Terrain.Rock]: 0.55,
  [Terrain.Rough]: 0.07,
  [Terrain.Forest]: 0.04,
  [Terrain.Ground]: 0.025,
  [Terrain.Water]: 0.08,
  [Terrain.Deep]: 0.12
};

/** Flat colours per terrain, used only if the painted art is missing. */
const FALLBACK: Record<number, number> = {
  [Terrain.Ground]: 0x5b6b3a, [Terrain.Rock]: 0x55565c, [Terrain.Scrap]: 0x4b4234,
  [Terrain.Water]: 0x1f4f6b, [Terrain.Road]: 0x6b6962, [Terrain.Rough]: 0x5a4a35,
  [Terrain.Forest]: 0x2f4a24, [Terrain.Crystal]: 0x3f5a44, [Terrain.Bridge]: 0x7a6a55,
  [Terrain.Shallows]: 0x3f7a8a, [Terrain.Deep]: 0x123a55
};

interface BiomeLook {
  shallow: number;
  deep: number;
  /** The open sea past the coastal shelf (Terrain.Deep); default: `deep` darkened. */
  abyss?: number;
  /** The world past the map's edge is open sea (the skirt eases into `abyss`), not the biome's ground. */
  farSea?: boolean;
  /** 0 water, 1 lava, 2 icy sea. */
  liquid: number;
  rock: number;
  bridge: number;
  /** Steel bridge decks (else timber). */
  steel: boolean;
  /** Ground grain contrast, the grain's north-west emboss, sharpening of the paint. */
  detail: [number, number, number];
  stone: StoneLook;
}

/** How the biome's rock material (art/textures.py) sits on the cliff walls and crags. */
interface StoneLook {
  /** Tiles per repeat of the texture on the cliff walls and on the crags. */
  wall: number;
  crag: number;
  /** Detail contrast (1 = the texture's own). */
  contrast: number;
  /** The walls' colour against the painted rock around them, and how much darker their foot is. */
  lift: number;
  foot: number;
  /** The crags' roughness (obsidian glints). */
  rough: number;
}

/**
 * Mip bias of the rock material on the walls and on the crags: one isotropic level for the footprint's long
 * axis (no anisotropic filtering), so the walls, foreshortened up their height, go a little under it.
 */
const ROCK_LOD_BIAS = { wall: -0.35, crag: 0 };
/** How far the walls' local colour keeps the painted rock's own brightness (else the map's average). */
const ROCK_TINT_LUM = 0.5;

const LOOK: Record<Biome, BiomeLook> = {
  temperate: {
    shallow: 0x4fa8b8, deep: 0x123f5c, liquid: 0, rock: 0x7c7b77, bridge: 0x8a7a64, steel: false, detail: [0.22, 2.6, 0.55],
    stone: { wall: 5, crag: 4, contrast: 1.5, lift: 1.15, foot: 0.35, rough: 0.75 }
  },
  desert: {
    shallow: 0x5fd8d0, deep: 0x147a8a, liquid: 0, rock: 0xa45a3a, bridge: 0x9a8058, steel: false, detail: [0.2, 3.4, 0.7],
    stone: { wall: 4.5, crag: 4, contrast: 2.0, lift: 1.15, foot: 0.35, rough: 0.75 }
  },
  arctic: {
    shallow: 0x9fd0ea, deep: 0x0f2a44, liquid: 2, rock: 0x8a929e, bridge: 0x7c8590, steel: false, detail: [0.08, 1.8, 0.45],
    stone: { wall: 5, crag: 4, contrast: 1.15, lift: 0.8, foot: 0.35, rough: 0.7 }
  },
  volcanic: {
    shallow: 0xffd060, deep: 0xff4a10, liquid: 1, rock: 0x2e2b2a, bridge: 0x6c6660, steel: true, detail: [0.22, 2.6, 0.55],
    stone: { wall: 5, crag: 4, contrast: 1.8, lift: 0.85, foot: 0.35, rough: 0.45 }
  },
  // turquoise lagoons over coral sand, falling away past the reef into sapphire open sea
  tropical: {
    shallow: 0x46e0d2, deep: 0x0b6f86, abyss: 0x062a48, farSea: true, liquid: 0, rock: 0xb4b0a2, bridge: 0x8a735a, steel: false,
    detail: [0.2, 2.8, 0.6],
    stone: { wall: 4.5, crag: 3.5, contrast: 1.4, lift: 1.2, foot: 0.5, rough: 0.85 }
  }
};

function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const s = (t: number) => t * t * (3 - 2 * t);
  const h = (i: number, j: number) => hash(i * 157 + j * 311, 7);
  const a = h(x0, y0);
  const b = h(x0 + 1, y0);
  const c = h(x0, y0 + 1);
  const d = h(x0 + 1, y0 + 1);
  return a + (b - a) * s(fx) + (c - a) * s(fy) + (a - b - c + d) * s(fx) * s(fy);
}

function fbm(x: number, y: number): number {
  return valueNoise(x * 1.3, y * 1.3) * 0.55 + valueNoise(x * 2.9, y * 2.9) * 0.3 + valueNoise(x * 6.1, y * 6.1) * 0.15;
}

/** Reflect a coordinate back into [0, L] across the map's edge. */
const mirror = (v: number, L: number) => Math.min(L, Math.max(0, v < 0 ? -v : v > L ? 2 * L - v : v));

export interface TerrainArt {
  /** Painted chunks [row][col] (null = failed to load). */
  chunks: (THREE.Texture | null)[][];
  /** The biome's tileable rock material for the cliff walls and crags (null = failed: they go untextured). */
  rock: THREE.Texture | null;
  /** Painted px per tile and chunk size (px). */
  pxPerTile: number;
  chunk: number;
}

interface Pile {
  tile: number;
  mesh: THREE.InstancedMesh;
  slot: number;
  matrix: THREE.Matrix4;
  base: number;
  crystal: boolean;
  lastRatio: number;
  x: number;
  y: number;
  h: number;
  rot: number;
}

/** A scattered prop: ground position, scale, turn and geometry variant (and how far it sinks in). */
interface Spot {
  x: number;
  y: number;
  s: number;
  r: number;
  v: number;
  sink?: number;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Terrain3D {
  readonly group = new THREE.Group();
  private W: number;
  private H: number;
  /** Height lattice, (W*RES+1) × (H*RES+1). */
  private lat: Float32Array;
  private latW: number;
  private fogTex: THREE.DataTexture;
  private fogCur: Float32Array;
  private fogBlur: Float32Array;
  private fogData: Uint8Array;
  private fogAcc = 0;
  private piles: Pile[] = [];
  /** The trees, thinned over squads in the woods (null: no woods). */
  private canopy: Canopy | null = null;
  /** The bridges' main decks (they reach a little past their tiles onto the banks). */
  private spans: DeckSpan[] = [];
  private waterTime = { value: 0 };
  /** Shared by the ground and liquid shaders: noise, and the sky colour the skirt fades into. */
  private edge = {
    uTNoise: { value: terrainNoise() as THREE.Texture | null },
    uFarColor: { value: new THREE.Color(0x070a10) },
    uSkirt: { value: SKIRT },
    uNear: { value: NEAR }
  };
  private cloud = new THREE.Vector2();
  private time = 0;
  readonly look: BiomeLook;
  /**
   * The rock material on the cliff walls and on the crags (null: no texture, so neither is textured), and
   * the walls' colour per rock tile (linear rgb, W×H): the painted rock there.
   */
  private stone: { walls: RockUniforms; crags: RockUniforms; tints: Float32Array } | null;

  constructor(private world: World, private player: Faction, art: TerrainArt | null) {
    this.W = world.width;
    this.H = world.height;
    this.look = LOOK[world.biome];
    this.latW = this.W * RES + 1;
    this.lat = new Float32Array(this.latW * (this.H * RES + 1));
    this.buildLattice();
    const painted = art ? new PaintedColors(this.W, this.H, art.chunks, art.pxPerTile, art.chunk) : null;
    this.stone = art?.rock ? this.stoneUniforms(art.rock, painted) : null;
    this.buildGround(art, painted);
    this.buildWater();
    this.buildBridges();
    this.buildTrees();
    this.buildRocks(painted);
    this.buildPiles();

    // fog: one texel per tile (plus a border), linearly filtered into soft edges
    const fw = this.W + 2;
    const fh = this.H + 2;
    this.fogData = new Uint8Array(fw * fh).fill(255);
    this.fogCur = new Float32Array(fw * fh).fill(1);
    this.fogBlur = new Float32Array(fw * fh);
    this.fogTex = new THREE.DataTexture(this.fogData, fw, fh, THREE.RedFormat, THREE.UnsignedByteType);
    this.fogTex.magFilter = THREE.LinearFilter;
    this.fogTex.minFilter = THREE.LinearFilter;
    this.fogTex.needsUpdate = true;
    fowUniforms.uFowMap.value = this.fogTex;
    fowUniforms.uFowSize.value.set(fw, fh);
    const clouds = cloudTexture();
    fowUniforms.uCloudMap.value = clouds;
    fowUniforms.uCloudK.value =
      world.biome === "volcanic" ? 0.4 : world.biome === "arctic" ? 0.22 : world.biome === "tropical" ? 0.32 : 0.3;
  }

  // ---------------------------------------------------------- heights --

  private tile(tx: number, ty: number): number {
    const x = Math.min(this.W - 1, Math.max(0, tx));
    const y = Math.min(this.H - 1, Math.max(0, ty));
    return this.world.terrain[y * this.W + x]!;
  }

  /** The analytic height: tile heights blended over ~a tile, plus terrain-weighted noise. */
  private heightFn(x: number, z: number): number {
    const R = 0.95;
    let sum = 0;
    let wsum = 0;
    let noise = 0;
    const tx0 = Math.floor(x - R - 0.5);
    const ty0 = Math.floor(z - R - 0.5);
    for (let ty = ty0; ty <= Math.floor(z + R); ty++)
      for (let tx = tx0; tx <= Math.floor(x + R); tx++) {
        const d = Math.hypot(tx + 0.5 - x, ty + 0.5 - z);
        if (d >= R) continue;
        const w = (1 - d / R) * (1 - d / R);
        const t = this.tile(tx, ty);
        sum += (TILE_H[t] ?? 0) * w;
        noise += (TILE_NOISE[t] ?? 0.02) * w;
        wsum += w;
      }
    if (wsum <= 0) return 0;
    const base = sum / wsum;
    const amp = noise / wsum;
    return base + (fbm(x, z) - 0.45) * amp * 2;
  }

  private buildLattice(): void {
    const rows = this.H * RES + 1;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < this.latW; i++) this.lat[j * this.latW + i] = this.heightFn(i / RES, j / RES);
  }

  /** Terrain surface height at tile point (x, y) (bilinear on the lattice). */
  heightAt(x: number, y: number): number {
    const fx = Math.min(this.W, Math.max(0, x)) * RES;
    const fy = Math.min(this.H, Math.max(0, y)) * RES;
    const i = Math.min(this.latW - 2, Math.floor(fx));
    const j = Math.min(this.H * RES - 1, Math.floor(fy));
    const u = fx - i;
    const v = fy - j;
    const L = this.lat;
    const W = this.latW;
    const a = L[j * W + i]!;
    const b = L[j * W + i + 1]!;
    const c = L[(j + 1) * W + i]!;
    const d = L[(j + 1) * W + i + 1]!;
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /**
   * The land's height anywhere, the skirt past the edge included: the map mirrored
   * for about a tile, its relief then easing flat by FLAT tiles out (so mirrored
   * outcrops and river channels don't carry on as copies of the map).
   */
  private landAt(x: number, z: number): number {
    const h = this.heightAt(mirror(x, this.W), mirror(z, this.H));
    const ox = Math.max(0, -x, x - this.W);
    const oz = Math.max(0, -z, z - this.H);
    if (ox === 0 && oz === 0) return h;
    const t = Math.min(1, Math.max(0, (Math.hypot(ox, oz) - 1) / (FLAT - 1)));
    return h * (1 - t * t * (3 - 2 * t));
  }

  /** Whether (x, y) is on a bridge's main deck where it reaches onto the bank. */
  private onDeck(x: number, y: number): boolean {
    for (const s of this.spans) {
      const dx = x - s.cx;
      const dz = y - s.cz;
      if (Math.abs(dx * s.ux + dz * s.uz) <= s.hl && Math.abs(dz * s.ux - dx * s.uz) <= s.hw) return true;
    }
    return false;
  }

  /** Where a ground vehicle rides: the deck on bridges, else the terrain (fords sink a little). */
  groundAt(x: number, y: number, hover = false): number {
    const t = this.tile(Math.floor(x), Math.floor(y));
    if (t === Terrain.Bridge) return 0.02;
    const h = this.heightAt(x, y);
    if (h < 0.02 && this.spans.length && this.onDeck(x, y)) return 0.02;
    return hover ? Math.max(h, WATER_LEVEL) : h;
  }

  /** Height for things that sit ON the surface (decals, rings): water counts as a floor. */
  surfaceAt(x: number, y: number): number {
    const t = this.tile(Math.floor(x), Math.floor(y));
    if (t === Terrain.Bridge) return 0.02;
    const h = this.heightAt(x, y);
    if (h < 0.02 && this.spans.length && this.onDeck(x, y)) return 0.02;
    return Math.max(h, WATER_LEVEL);
  }

  // ----------------------------------------------------------- ground --

  /**
   * Grid lines along one axis of length L: the lattice inside the map, the near
   * skirt outside (fine at the edge, coarser as it flattens), plus the mirror
   * images of chunk seams there so no skirt cell straddles two painted chunks.
   */
  private lines(L: number, chunkTiles: number): number[] {
    const out: number[] = [];
    for (let i = 0; i <= L * RES; i++) out.push(i / RES);
    const far = [...Array.from({ length: RES }, (_, k) => (k + 1) / RES), ...NEAR_LINES];
    for (let s = chunkTiles; s < L; s += chunkTiles) far.push(s, L - s);
    for (const d of far)
      if (d > 0 && d <= NEAR) out.push(-d, L + d);
    out.sort((a, b) => a - b);
    return out.filter((v, i) => i === 0 || v - out[i - 1]! > 1e-4);
  }

  private buildGround(art: TerrainArt | null, painted: PaintedColors | null): void {
    const L = this.look;
    const uniforms: GroundUniforms = {
      ...this.edge,
      uDetail: { value: new THREE.Vector3(...L.detail) },
      uFarGround: { value: this.look.farSea ? new THREE.Color(this.look.abyss ?? this.look.deep) : this.openGround(painted) }
    };
    const walls = this.stone?.walls ?? null;
    const groundMat = <T extends THREE.Material>(m: T) =>
      fogged(m, { key: walls ? "groundRock" : "ground", also: (s) => patchGround(s, uniforms, walls) });
    const px = art?.pxPerTile ?? 48;
    const size = art ? art.chunk / px : Math.max(this.W, this.H); // tiles per chunk
    const nC = art ? art.chunks[0]?.length ?? 1 : 1;
    const nR = art ? art.chunks.length : 1;
    const xs = this.lines(this.W, size);
    const zs = this.lines(this.H, size);
    const NX = xs.length;

    // one mesh per painted chunk: its own cells, plus the near-skirt cells that mirror into it
    // (so its bounds grow only by the skirt nearby, and it still culls)
    interface Acc {
      idx: number[]; pos: number[]; nor: number[]; uv: number[]; col: number[]; stone: number[]; steep: number[];
      tex: THREE.Texture | null; x0: number; z0: number; w: number; h: number;
    }
    const accs: Acc[] = [];
    for (let r = 0; r < nR; r++)
      for (let c = 0; c < nC; c++) {
        const tex = art?.chunks[r]?.[c] ?? null;
        const img = tex?.image as { width: number; height: number } | undefined;
        accs.push({
          idx: [], pos: [], nor: [], uv: [], col: [], stone: [], steep: [], tex, x0: c * size, z0: r * size,
          w: img?.width ?? 1, h: img?.height ?? 1
        });
      }
    const st = new Float32Array(5);
    // heights and normals per grid point, worked out once however many meshes share the point
    const NV = NX * zs.length;
    const hgt = new Float32Array(NV * 4).fill(NaN);
    // each grid point's vertex in the mesh that last used it (a point on a mesh boundary is simply repeated)
    const slot = new Int32Array(NV);
    const owner = new Int32Array(NV).fill(-1);
    const fc = new THREE.Color();
    const e = 0.12;
    const vert = (a: Acc, ak: number, i: number, j: number): number => {
      const key = j * NX + i;
      if (owner[key] === ak) return slot[key]!;
      const k = a.pos.length / 3;
      owner[key] = ak;
      slot[key] = k;
      const x = xs[i]!;
      const z = zs[j]!;
      if (Number.isNaN(hgt[key * 4])) {
        const dx = this.landAt(x + e, z) - this.landAt(x - e, z);
        const dz = this.landAt(x, z + e) - this.landAt(x, z - e);
        const inv = 1 / Math.hypot(dx / (2 * e), 1, dz / (2 * e));
        hgt[key * 4] = this.landAt(x, z);
        hgt[key * 4 + 1] = (-dx / (2 * e)) * inv;
        hgt[key * 4 + 2] = inv;
        hgt[key * 4 + 3] = (-dz / (2 * e)) * inv;
      }
      a.pos.push(x, hgt[key * 4]!, z);
      a.nor.push(hgt[key * 4 + 1]!, hgt[key * 4 + 2]!, hgt[key * 4 + 3]!);
      const sx = mirror(x, this.W);
      const sz = mirror(z, this.H);
      if (walls) {
        this.stoneAt(sx, sz, hgt[key * 4 + 1]!, hgt[key * 4 + 3]!, st);
        a.stone.push(st[0]!, st[1]!, st[2]!, st[3]!);
        a.steep.push(st[4]!);
      }
      if (a.tex) a.uv.push(((sx - a.x0) * px) / a.w, 1 - ((sz - a.z0) * px) / a.h);
      else {
        const t = this.tile(Math.floor(sx), Math.floor(sz));
        fc.setHex(FALLBACK[t] ?? 0x555555).multiplyScalar(0.92 + hash(Math.floor(sx) * 977 + Math.floor(sz), 3) * 0.16);
        a.col.push(fc.r, fc.g, fc.b);
      }
      return k;
    };
    for (let j = 0; j < zs.length - 1; j++)
      for (let i = 0; i < NX - 1; i++) {
        // which chunk the cell's (mirrored) source lies in — past the far edges not always the last
        // chunk, which can be narrower than the near skirt (a 108-tile map's is 1⅓ tiles wide): its
        // paint would clamp out there, streaking the skirt
        const mx = (xs[i]! + xs[i + 1]!) / 2;
        const mz = (zs[j]! + zs[j + 1]!) / 2;
        const c = Math.min(nC - 1, Math.floor(mirror(mx, this.W) / size));
        const r = Math.min(nR - 1, Math.floor(mirror(mz, this.H) / size));
        const ak = r * nC + c;
        const a = accs[ak]!;
        const v00 = vert(a, ak, i, j);
        const v10 = vert(a, ak, i + 1, j);
        const v01 = vert(a, ak, i, j + 1);
        const v11 = vert(a, ak, i + 1, j + 1);
        a.idx.push(v00, v01, v10, v10, v01, v11);
      }
    const mats = accs.map(({ tex }) => {
      if (!tex) return groundMat(new THREE.MeshLambertMaterial({ vertexColors: true }));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = 8;
      tex.needsUpdate = true;
      return groundMat(new THREE.MeshLambertMaterial({ map: tex }));
    });
    const mesh = (g: THREE.BufferGeometry, mat: THREE.Material) => {
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      this.group.add(m);
    };
    accs.forEach((a, ak) => {
      if (a.idx.length === 0) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(a.pos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(a.nor, 3));
      if (a.tex) g.setAttribute("uv", new THREE.Float32BufferAttribute(a.uv, 2));
      else g.setAttribute("color", new THREE.Float32BufferAttribute(a.col, 3));
      if (walls) {
        g.setAttribute("aStone", new THREE.Float32BufferAttribute(a.stone, 4));
        g.setAttribute("aSteep", new THREE.Float32BufferAttribute(a.steep, 1));
      }
      g.setIndex(a.idx);
      mesh(g, mats[ak]!);
    });

    // the far skirt: flat open ground out to SKIRT, a quad along each side, each culled on its own (the
    // shader paints it — the biome's ground fading into the sky — so any chunk's material will do)
    const fi = Math.max(0, accs.findIndex((a) => a.tex));
    const farMat = mats[fi]!;
    const fa = accs[fi]!;
    const W = this.W;
    const H = this.H;
    for (const [x0, z0, x1, z1] of [
      [-SKIRT, -SKIRT, W + SKIRT, -NEAR], [-SKIRT, H + NEAR, W + SKIRT, H + SKIRT],
      [-SKIRT, -NEAR, -NEAR, H + NEAR], [W + NEAR, -NEAR, W + SKIRT, H + NEAR]
    ] as const) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute([x0, 0, z0, x1, 0, z0, x0, 0, z1, x1, 0, z1], 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      if (fa.tex) g.setAttribute("uv", new THREE.Float32BufferAttribute([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 2));
      else g.setAttribute("color", new THREE.Float32BufferAttribute(new Array(12).fill(1), 3));
      if (walls) {
        g.setAttribute("aStone", new THREE.Float32BufferAttribute(new Float32Array(16), 4));
        g.setAttribute("aSteep", new THREE.Float32BufferAttribute(new Float32Array(4), 1));
      }
      g.setIndex([0, 2, 1, 1, 2, 3]);
      mesh(g, farMat);
    }
  }

  /**
   * The rock material's uniforms: laid on as detail around its own average (read back once), and the
   * walls' colour per rock tile, the painted rock's, so the walls and crags are the same stone as the
   * painted tops. Null if the texture can't be read back.
   */
  private stoneUniforms(
    tex: THREE.Texture,
    painted: PaintedColors | null
  ): { walls: RockUniforms; crags: RockUniforms; tints: Float32Array } | null {
    const mean = textureMean(tex);
    if (!mean) return null;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    // (sampled at an explicit mip level, which anisotropic filtering wouldn't touch anyway)
    tex.anisotropy = 1;
    tex.needsUpdate = true;
    const S = this.look.stone;
    const norm = new THREE.Color(1 / Math.max(1e-4, mean.r), 1 / Math.max(1e-4, mean.g), 1 / Math.max(1e-4, mean.b));
    const size = Math.log2((tex.image as { width: number }).width);
    const u = (tiles: number, bias: number): RockUniforms => ({
      uRock: { value: tex },
      uRockNorm: { value: norm },
      uRockK: { value: new THREE.Vector4(1 / tiles, S.contrast, S.foot, size + bias) }
    });
    return { walls: u(S.wall, ROCK_LOD_BIAS.wall), crags: u(S.crag, ROCK_LOD_BIAS.crag), tints: this.rockTints(painted, mean) };
  }

  /**
   * The cliff walls' colour on each rock tile (linear rgb, W×H, lifted): the painted rock there (its
   * lichen, its snow), its brightness pulled part way to the map's average, since the paint's own
   * hillshade darkens or lights a tile on an outcrop's flank; without paint, the texture's average.
   */
  private rockTints(painted: PaintedColors | null, mean: THREE.Color): Float32Array {
    const out = new Float32Array(this.W * this.H * 3);
    const c = new THREE.Color();
    const sum = new THREE.Color(0, 0, 0);
    const rock: number[] = [];
    const w = this.world;
    for (let i = 0; i < w.terrain.length; i++) {
      if (w.terrain[i] !== Terrain.Rock) continue;
      const tx = i % this.W;
      const ty = Math.floor(i / this.W);
      // (the tile's four texels of the coarse read-back)
      let r = 0;
      let g = 0;
      let b = 0;
      let ok = !!painted;
      for (let k = 0; k < 4 && ok; k++) {
        ok = !!painted?.at(tx + 0.25 + (k & 1) * 0.5, ty + 0.25 + (k >> 1) * 0.5, c, 0);
        r += c.r / 4;
        g += c.g / 4;
        b += c.b / 4;
      }
      if (!ok) [r, g, b] = [mean.r, mean.g, mean.b];
      out[i * 3] = r;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = b;
      sum.r += r;
      sum.g += g;
      sum.b += b;
      rock.push(i);
    }
    if (!rock.length) return out;
    const lum = (r: number, g: number, b: number) => r * 0.3 + g * 0.59 + b * 0.11;
    const avg = lum(sum.r, sum.g, sum.b) / rock.length;
    const lift = this.look.stone.lift;
    for (const i of rock) {
      const k = i * 3;
      const l = Math.max(1e-4, lum(out[k]!, out[k + 1]!, out[k + 2]!));
      const f = lift * Math.pow(avg / l, 1 - ROCK_TINT_LUM);
      for (let j = k; j < k + 3; j++) out[j] = out[j]! * f;
    }
    return out;
  }

  /**
   * The cliff walls' per-vertex inputs at map point (x, z) with normal (nx, ·, nz), into `out`:
   * - 0–2: the painted rock's colour there (else the nearest rock's, so it holds up to the rock's edge);
   * - 3: the rock share of the tiles the point lies on: 1 inside a rock tile, 1/2 on its straight edge, 0
   *   inside any other (on the 1/3-tile lattice the walls stop at the rock's edge, so the slope's foot and
   *   the pockets and notches in an outcrop keep their paint);
   * - 4: 1 if the land here is steep enough that a wall could start (its normal more than 0.3 from
   *   upright), else 0: a triangle with none of them, like a flat rock top, skips the walls for nothing.
   */
  private stoneAt(x: number, z: number, nx: number, nz: number, out: Float32Array): void {
    const tints = this.stone!.tints;
    const e = 1e-3;
    let n = 0;
    let m = 0;
    let c = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    const add = (tx: number, tz: number, share: boolean) => {
      const i = Math.min(this.H - 1, Math.max(0, tz)) * this.W + Math.min(this.W - 1, Math.max(0, tx));
      if (share) n++;
      if (this.world.terrain[i] !== Terrain.Rock) return;
      if (share) m++;
      c++;
      r += tints[i * 3]!;
      g += tints[i * 3 + 1]!;
      b += tints[i * 3 + 2]!;
    };
    const x0 = Math.floor(x - e);
    const x1 = Math.floor(x + e);
    const z0 = Math.floor(z - e);
    const z1 = Math.floor(z + e);
    for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) add(tx, tz, true);
    if (m === 0) for (let tz = z0 - 1; tz <= z1 + 1; tz++) for (let tx = x0 - 1; tx <= x1 + 1; tx++) add(tx, tz, false);
    out.fill(0);
    if (!c) return;
    out[0] = r / c;
    out[1] = g / c;
    out[2] = b / c;
    out[3] = m / n;
    out[4] = Math.hypot(nx, nz) > 0.3 ? 1 : 0;
  }

  /** The biome's open ground (linear): the painted ground tiles' average, else the flat fallback. */
  private openGround(painted: PaintedColors | null): THREE.Color {
    const out = new THREE.Color(FALLBACK[Terrain.Ground]!);
    if (!painted) return out;
    const c = new THREE.Color();
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const w = this.world;
    for (let i = 0; i < w.terrain.length; i++) {
      if (w.terrain[i] !== Terrain.Ground) continue;
      if (!painted.at((i % this.W) + 0.5, Math.floor(i / this.W) + 0.5, c)) return out;
      r += c.r;
      g += c.g;
      b += c.b;
      n++;
    }
    return n ? out.setRGB(r / n, g / n, b / n) : out;
  }

  // ------------------------------------------------------------ water --

  private buildWater(): void {
    const step = 0.5;
    const pos: number[] = [];
    const depth: number[] = [];
    const idx: number[] = [];
    const keyOf = new Map<number, number>();
    const vert = (x: number, z: number) => {
      const key = Math.round((x + FLAT) * 2) * 10007 + Math.round((z + FLAT) * 2);
      let k = keyOf.get(key);
      if (k === undefined) {
        k = pos.length / 3;
        keyOf.set(key, k);
        pos.push(x, WATER_LEVEL, z);
        depth.push(WATER_LEVEL - this.landAt(x, z));
      }
      return k;
    };
    // which cells of the map hold water...
    const cw = Math.round(this.W / step);
    const ch = Math.round(this.H / step);
    const wet = new Uint8Array(cw * ch);
    for (let j = 0; j < ch; j++)
      for (let i = 0; i < cw; i++) {
        const x = i * step;
        const z = j * step;
        const lo = Math.min(
          this.heightAt(x, z), this.heightAt(x + step, z), this.heightAt(x, z + step), this.heightAt(x + step, z + step),
          this.heightAt(x + step / 2, z + step / 2)
        );
        wet[j * cw + i] = lo < WATER_LEVEL - 0.005 ? 1 : 0;
      }
    // ...and the rivers carry on into the skirt (a skirt cell is wet if the cell it mirrors is) until
    // its flattening land rises over them, FLAT tiles out; the shader thins them away before that
    const cell = (k: number, n: number) => (k < 0 ? -k - 1 : k >= n ? 2 * n - k - 1 : k);
    const sk = Math.round(FLAT / step);
    for (let j = -sk; j < ch + sk; j++)
      for (let i = -sk; i < cw + sk; i++) {
        if (!wet[cell(j, ch) * cw + cell(i, cw)]) continue;
        const x = i * step;
        const z = j * step;
        const a = vert(x, z);
        const b = vert(x + step, z);
        const c = vert(x, z + step);
        const d = vert(x + step, z + step);
        idx.push(a, c, b, b, c, d);
      }
    if (idx.length === 0) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aDepth", new THREE.Float32BufferAttribute(depth, 1));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const L = this.look;
    const lava = L.liquid === 1;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: lava ? 0.92 : L.liquid === 2 ? 0.34 : 0.24,
      metalness: 0,
      transparent: !lava,
      depthWrite: lava
    });
    const uniforms: LiquidUniforms = {
      ...this.edge,
      uShallow: { value: new THREE.Color(L.shallow) },
      uDeep: { value: new THREE.Color(L.deep) },
      uAbyss: { value: L.abyss !== undefined ? new THREE.Color(L.abyss) : new THREE.Color(L.deep).multiplyScalar(0.55) },
      uMode: { value: L.liquid },
      uWT: this.waterTime
    };
    const water = fogged(mat, { key: `water${L.liquid}`, clouds: !lava, also: (s) => patchLiquid(s, uniforms) });
    const m = new THREE.Mesh(g, water);
    m.receiveShadow = !lava;
    m.renderOrder = 2;
    this.group.add(m);
  }

  // ---------------------------------------------------------- bridges --

  /** Every bridge, one merged model mesh (see terrain-bridges.ts). */
  private buildBridges(): void {
    const { geo, spans } = bridgeGeometry(this.world, this.look.bridge, this.look.steel);
    this.spans = spans;
    if (!geo) return;
    const m = new THREE.Mesh(geo, modelMat("normal"));
    m.userData.model = true;
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
  }

  // ------------------------------------------------------------ props --

  /** Instanced copies of a few geometry variants at (x, y, scale, rot) spots: each variant's mesh and its spots, slot by slot. */
  private scatter<S extends Spot>(geos: THREE.BufferGeometry[], spots: S[], mat: THREE.Material = modelMat("normal"), shadows = true): { mesh: THREE.InstancedMesh; spots: S[] }[] {
    const out: { mesh: THREE.InstancedMesh; spots: S[] }[] = [];
    geos.forEach((geo, v) => {
      const mine = spots.filter((p) => p.v % geos.length === v);
      if (mine.length === 0) return;
      const mesh = new THREE.InstancedMesh(geo, mat, mine.length);
      const m = new THREE.Matrix4();
      mine.forEach((p, i) => {
        _quat.setFromAxisAngle(UP, p.r);
        m.compose(_pos.set(p.x, this.heightAt(p.x, p.y) - (p.sink ?? 0.02), p.y), _quat, _scale.set(p.s, p.s, p.s));
        mesh.setMatrixAt(i, m);
      });
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      out.push({ mesh, spots: mine });
    });
    return out;
  }

  private buildTrees(): void {
    const spots: Spot[] = [];
    const w = this.world;
    for (let i = 0; i < w.terrain.length; i++) {
      if (w.terrain[i] !== Terrain.Forest) continue;
      const tx = i % this.W;
      const ty = Math.floor(i / this.W);
      const n = 2 + (hash(i, 1) < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        spots.push({
          x: tx + 0.2 + hash(i, 10 + k) * 0.6,
          y: ty + 0.2 + hash(i, 20 + k) * 0.6,
          s: 0.75 + hash(i, 30 + k) * 0.45,
          r: hash(i, 40 + k) * Math.PI * 2,
          v: Math.floor(hash(i, 50 + k) * 6)
        });
      }
    }
    // (thinned over squads in the woods: see thinCanopy)
    if (spots.length) this.canopy = new Canopy(this.W, this.H, this.scatter(treeGeos(this.world.biome), spots, canopyMat()));
  }

  /**
   * Thin the trees over squads on show at `points` (x, y pairs, tiles; `n` of
   * them) so they aren't lost under the canopy, for a camera pitched at
   * `cot` (see Canopy.thin). Call every frame, with no points to let the
   * woods grow back.
   */
  thinCanopy(points: ArrayLike<number>, n: number, cot: number, dtMs: number): void {
    this.canopy?.thin(points, n, cot, dtMs);
  }

  /**
   * Rock crags over the outcrops (bigger in their hearts, smaller at the
   * rims) and a few loose boulders on open ground, all one merged mesh in
   * the biome's rock material, coloured from the painted rock under each so
   * they belong to the art.
   */
  private buildRocks(painted: PaintedColors | null): void {
    const w = this.world;
    const spots: CragSpot[] = [];
    const rockCol = new THREE.Color(this.look.rock);
    const tmp = new THREE.Color();
    const isRock = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < this.W && ty < this.H && w.terrain[ty * this.W + tx] === Terrain.Rock;
    const low = (x: number, y: number, r: number) =>
      Math.min(this.heightAt(x, y), this.heightAt(x + r, y), this.heightAt(x - r, y), this.heightAt(x, y + r), this.heightAt(x, y - r));
    // a crag stands between the lowest point under it and its middle: proud of the craggy paint (on a
    // narrow ridge, seated on the lowest point, all but its cap would drown in the heightfield)
    const seat = (x: number, y: number, r: number) => (low(x, y, r) + this.heightAt(x, y)) / 2;
    // the share of rock tiles that get a crag, in the outcrops' hearts and at their rims (with the rock
    // material on the cliff walls carrying the outcrop, fewer: accents, not a rubble field)
    const [inHeart, atRim] = this.stone ? [0.4, 0.3] : [0.55, 0.4];
    for (let i = 0; i < w.terrain.length; i++) {
      const t = w.terrain[i];
      const tx = i % this.W;
      const ty = Math.floor(i / this.W);
      if (t === Terrain.Rock) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && isRock(tx + dx, ty + dy)) n++;
        const heart = n >= 7;
        if (hash(i, 2) < 1 - (heart ? inHeart : atRim)) continue;
        // each crag crowns the highest of a few spots in its tile, so it stands on the outcrop's peaks
        // rather than drowning in a hollow of its craggy heightfield
        let x = tx + 0.5;
        let y = ty + 0.5;
        for (let k = 0; k < 5; k++) {
          const cx = tx + 0.5 + (hash(i, 3 + k * 7) - 0.5) * 0.6;
          const cy = ty + 0.5 + (hash(i, 4 + k * 7) - 0.5) * 0.6;
          if (k === 0 || this.heightAt(cx, cy) > this.heightAt(x, y)) {
            x = cx;
            y = cy;
          }
        }
        const s = heart ? 0.5 + hash(i, 5) * 0.35 : 0.34 + hash(i, 5) * 0.22;
        const k = hash(i, 7);
        spots.push({
          x, y, s, rot: hash(i, 6) * Math.PI * 2,
          h: seat(x, y, s * 0.45) - 0.05,
          tint: painted?.at(x, y, tmp, 0.75)?.clone() ?? rockCol.clone(),
          kind: k < 0.5 ? 0 : k < 0.82 ? 1 : 2,
          seed: i
        });
      } else if ((t === Terrain.Rough || t === Terrain.Ground) && hash(i, 8) < 0.012) {
        // a few loose boulders: the biome's stone, warmed by the ground they sit in
        const x = tx + 0.5;
        const y = ty + 0.5;
        const s = 0.24 + hash(i, 9) * 0.22;
        const tint = rockCol.clone();
        const under = painted?.at(x, y, tmp, 1);
        if (under) tint.lerp(under, 0.35);
        spots.push({ x, y, s, rot: hash(i, 6) * 6, h: low(x, y, s * 0.45) - 0.04, tint, kind: 3, seed: i });
      }
    }
    const stone = this.stone?.crags ?? null;
    const geo = cragGeometry(spots, w.biome, !!stone);
    if (!geo) return;
    // textured: stone, not painted metal — matte (obsidian a little glassy), lit and fogged like the rest
    const mat = stone
      ? fogged(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: this.look.stone.rough, metalness: 0 }), {
          key: "crag",
          also: (s) => patchCrag(s, stone)
        })
      : modelMat("normal");
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
  }

  private buildPiles(): void {
    const w = this.world;
    const scrap = scrapGeos();
    const crystal = crystalGeos();
    const groups = new Map<THREE.BufferGeometry, number[]>();
    for (let i = 0; i < w.terrain.length; i++) {
      const t = w.terrain[i];
      if (t !== Terrain.Scrap && t !== Terrain.Crystal) continue;
      const set = t === Terrain.Crystal ? crystal : scrap;
      const geo = set[Math.floor(hash(i, 5) * set.length)]!;
      const list = groups.get(geo) ?? [];
      list.push(i);
      groups.set(geo, list);
    }
    for (const [geo, tiles] of groups) {
      const mesh = new THREE.InstancedMesh(geo, modelMat("normal"), tiles.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      tiles.forEach((i, slot) => {
        const tx = i % this.W;
        const ty = Math.floor(i / this.W);
        const x = tx + 0.5 + (hash(i, 1) - 0.5) * 0.25;
        const y = ty + 0.5 + (hash(i, 2) - 0.5) * 0.25;
        const p: Pile = {
          tile: i, mesh, slot, matrix: new THREE.Matrix4(), base: 0.95 + hash(i, 4) * 0.25,
          crystal: w.terrain[i] === Terrain.Crystal, lastRatio: -1,
          x, y, h: this.heightAt(x, y), rot: hash(i, 6) * Math.PI * 2
        };
        this.piles.push(p);
        this.setPile(p, 1);
      });
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
  }

  private setPile(p: Pile, ratio: number): void {
    const s = ratio > 0 ? p.base * (0.45 + 0.55 * Math.sqrt(ratio)) : 0.0001;
    p.matrix.compose(
      _pos.set(p.x, p.h - (ratio > 0 ? 0 : 1), p.y),
      _quat.setFromAxisAngle(UP, p.rot),
      _scale.set(s, s * (0.6 + 0.4 * Math.sqrt(Math.max(0, ratio))), s)
    );
    p.mesh.setMatrixAt(p.slot, p.matrix);
    p.mesh.instanceMatrix.needsUpdate = true;
  }

  // -------------------------------------------------------- per frame --

  update(dtMs: number, showFog: boolean): void {
    this.time += dtMs;
    const w = this.world;
    for (const p of this.piles) {
      const i = p.tile;
      const full = p.crystal ? ECONOMY.crystalPerTile : ECONOMY.scrapPerTile;
      const ratio = w.scrap[i]! / full;
      if (Math.abs(ratio - p.lastRatio) > 0.02 || (ratio === 0 && p.lastRatio !== 0)) {
        p.lastRatio = ratio;
        this.setPile(p, ratio);
      }
    }
    // the skirt fades into whatever the sky is (in the final, sRGB-encoded colour)
    const bg = (this.group.parent as THREE.Scene | null)?.background;
    if (bg instanceof THREE.Color) this.edge.uFarColor.value.copy(bg).convertLinearToSRGB();
    this.waterTime.value = this.time / 1000;
    fowUniforms.uTime.value = this.time / 1000;
    this.cloud.x -= dtMs * 0.0000125;
    this.cloud.y -= dtMs * 0.000005;
    fowUniforms.uCloudOffset.value.copy(this.cloud);
    fowUniforms.uFowOn.value = showFog ? 1 : 0;
    if (showFog) this.updateFog(dtMs);
  }

  private updateFog(dtMs: number): void {
    this.fogAcc += dtMs;
    if (this.fogAcc < 40) return; // ~25 Hz is plenty for a soft fade
    const step = Math.min(1, this.fogAcc / 250);
    this.fogAcc = 0;
    const w = this.world;
    const vis = w.fog[this.player].vis;
    const FW = this.W + 2;
    for (let y = 0; y < this.H + 2; y++)
      for (let x = 0; x < FW; x++) {
        const tx = x - 1;
        const ty = y - 1;
        const inside = tx >= 0 && ty >= 0 && tx < this.W && ty < this.H;
        const v = inside ? vis[ty * this.W + tx] : Vis.Unexplored;
        const target = v === Vis.Visible ? 0 : v === Vis.Explored ? 0.5 : 0.94;
        const i = y * FW + x;
        const cur = this.fogCur[i]!;
        this.fogCur[i] = cur + (target - cur) * step;
      }
    // a soft 3×3 blur on the CPU (a few thousand texels) keeps the shader to one fog lookup
    const FH = this.H + 2;
    const c = this.fogCur;
    const b = this.fogBlur;
    for (let y = 0; y < FH; y++)
      for (let x = 0; x < FW; x++) {
        let sum = 0;
        let wsum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= FH) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= FW) continue;
            const wgt = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
            sum += c[yy * FW + xx]! * wgt;
            wsum += wgt;
          }
        }
        b[y * FW + x] = sum / wsum;
      }
    for (let i = 0; i < b.length; i++) this.fogData[i] = Math.round(b[i]! * 255);
    this.fogTex.needsUpdate = true;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.fogTex.dispose();
    fowUniforms.uFowMap.value = null;
  }
}

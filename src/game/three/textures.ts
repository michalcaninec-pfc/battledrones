import * as THREE from "three";

/**
 * Procedural textures drawn once with the 2D canvas API: the particle atlas
 * (glow, smoke, spark, rings, glint, scorch, debris, flame, lit smoke,
 * shock ring, muzzle flare, shards), the drifting cloud shadows and the
 * soft disc under light pools.
 */

/** Cells of the 4×4 particle atlas. */
export const TEX = {
  glow: 0,
  smoke: 1,
  spark: 2,
  ring: 3,
  select: 4,
  glint: 5,
  scorch: 6,
  debris: 7,
  /** A ragged flame puff, hot (white) core to dimmer edges: tinted for fireballs and flames. */
  fire: 8,
  /** Billowing smoke lit from the upper left, the sun's side (two variants): keep their rotation small. */
  puff: 9,
  puff2: 10,
  /** A soft shock ring with a bright leading edge (lies on the ground). */
  shock: 11,
  /** A ragged muzzle-flash burst. */
  flare: 12,
  /** A shaded shard: lit facet, dark rim. */
  chunk: 13,
  /** A plump heart, lit from the upper left with a soft rim (Robot Love). */
  heart: 14
} as const;
export type TexCell = (typeof TEX)[keyof typeof TEX];

const CELL = 128;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** Deterministic PRNG for repeatable textures. */
function prng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Smooth 2D value noise in [0, 1] over a wrapping 16² lattice, three octaves. */
function fbm(seed: number): (x: number, y: number) => number {
  const rnd = prng(seed);
  const N = 16;
  const g = new Float32Array(N * N);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const at = (i: number, j: number) => g[(j & (N - 1)) * N + (i & (N - 1))]!; // (N is a power of two)
  const one = (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
  return (x, y) => (one(x, y) * 0.55 + one(x * 2.1 + 7.3, y * 2.1 + 1.7) * 0.3 + one(x * 4.3 + 3.1, y * 4.3 + 9.2) * 0.15);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Fill atlas cell `i` pixel by pixel: `f(u, v)` gets coordinates in −1…1
 * (v up, so the upper left is the sun's side) and returns [grey, alpha].
 * Soft cells are worked out at a lower resolution `res` and scaled up
 * smoothly, which costs a quarter of the start-up time and looks the same.
 */
function pixelCell(ctx: CanvasRenderingContext2D, i: number, f: (u: number, v: number) => [number, number], res = CELL): void {
  const [tmp, tctx] = res === CELL ? [null, ctx] : canvas(res, res);
  const img = tctx.createImageData(res, res);
  const d = img.data;
  const border = (2 * res) / CELL;
  for (let y = 0; y < res; y++)
    for (let x = 0; x < res; x++) {
      // a 2 px clear border so mipmaps don't bleed between cells
      const u = ((x + 0.5) / res) * 2 - 1;
      const v = 1 - ((y + 0.5) / res) * 2;
      // and every cell is round: nothing to compute outside the circle
      const edge = x < border || y < border || x >= res - border || y >= res - border || u * u + v * v > 0.95;
      const [l, a] = edge ? [0, 0] : f(u * 1.03, v * 1.03);
      const k = (y * res + x) * 4;
      const g = Math.round(Math.min(1, Math.max(0, l)) * 255);
      d[k] = d[k + 1] = d[k + 2] = g;
      d[k + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
    }
  const cx = (i % 4) * CELL;
  const cy = Math.floor(i / 4) * CELL;
  if (!tmp) return ctx.putImageData(img, cx, cy);
  tctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(tmp, cx, cy, CELL, CELL);
  ctx.restore();
}

/** A cauliflower of lit spheres: soft-edged billowing smoke. */
function puffCell(seed: number): (u: number, v: number) => [number, number] {
  const rnd = prng(seed);
  const n = fbm(seed + 3);
  const blobs: [number, number, number][] = [[0, -0.02, 0.56]];
  const count = 7;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rnd() * 0.6;
    const d = 0.34 + rnd() * 0.12;
    blobs.push([Math.cos(a) * d, Math.sin(a) * d * 0.9, 0.3 + rnd() * 0.12]);
  }
  // light from the upper left and a little in front
  const L = [-0.55, 0.6, 0.58];
  const ll = Math.hypot(L[0]!, L[1]!, L[2]!);
  return (u, v) => {
    let dens = 0;
    let shade = 0;
    let wsum = 0;
    for (const [bx, by, br] of blobs) {
      const dx = (u - bx) / br;
      const dy = (v - by) / br;
      const t2 = dx * dx + dy * dy;
      if (t2 >= 1) continue;
      const fall = (1 - t2) * (1 - t2);
      dens += fall;
      const nz = Math.sqrt(1 - t2);
      const lam = Math.max(0, (dx * L[0]! + dy * L[1]! + nz * L[2]!) / ll);
      const w = fall * fall;
      shade += (0.5 + 0.5 * lam) * w;
      wsum += w;
    }
    if (dens <= 0) return [0, 0];
    const tex = n(u * 3 + 4, v * 3 + 4);
    const l = (wsum > 0 ? shade / wsum : 0.5) * (0.82 + 0.3 * tex);
    const a = smooth(0.02, 0.6, dens * (0.8 + 0.4 * tex));
    return [l, a * 0.95];
  };
}

/** The atlas is painted once per session (the pixel cells cost real start-up time); each scene wraps it in its own texture. */
let atlasCanvas: HTMLCanvasElement | null = null;

export function particleAtlas(): THREE.CanvasTexture {
  atlasCanvas ??= paintAtlas();
  const tex = new THREE.CanvasTexture(atlasCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function paintAtlas(): HTMLCanvasElement {
  const [c, ctx] = canvas(CELL * 4, CELL * 4);
  const cell = (i: number, draw: (ctx: CanvasRenderingContext2D, r: number) => void) => {
    ctx.save();
    ctx.translate((i % 4) * CELL + CELL / 2, Math.floor(i / 4) * CELL + CELL / 2);
    ctx.beginPath();
    ctx.rect(-CELL / 2, -CELL / 2, CELL, CELL);
    ctx.clip();
    draw(ctx, CELL / 2 - 2);
    ctx.restore();
  };
  const radial = (ctx: CanvasRenderingContext2D, r: number, stops: [number, string][], x = 0, y = 0) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    for (const [o, col] of stops) g.addColorStop(o, col);
    ctx.fillStyle = g;
    ctx.fillRect(-CELL / 2, -CELL / 2, CELL, CELL);
  };
  cell(TEX.glow, (ctx, r) =>
    radial(ctx, r, [
      [0, "rgba(255,255,255,1)"],
      [0.22, "rgba(255,255,255,0.6)"],
      [0.55, "rgba(255,255,255,0.14)"],
      [1, "rgba(255,255,255,0)"]
    ])
  );
  cell(TEX.smoke, (ctx, r) => {
    const rnd = prng(11);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rnd();
      const d = r * (0.18 + rnd() * 0.22);
      radial(ctx, r * (0.45 + rnd() * 0.2), [
        [0, "rgba(255,255,255,0.42)"],
        [1, "rgba(255,255,255,0)"]
      ], Math.cos(a) * d, Math.sin(a) * d);
    }
    radial(ctx, r * 0.8, [
      [0, "rgba(255,255,255,0.55)"],
      [1, "rgba(255,255,255,0)"]
    ]);
  });
  cell(TEX.spark, (ctx, r) =>
    radial(ctx, r * 0.6, [
      [0, "rgba(255,255,255,1)"],
      [0.35, "rgba(255,236,180,0.95)"],
      [1, "rgba(255,170,60,0)"]
    ])
  );
  cell(TEX.ring, (ctx, r) => {
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(0, 0, r - 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 5;
    ctx.stroke();
  });
  cell(TEX.select, (ctx, r) => {
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(0, 0, r - 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.lineWidth = 6;
    ctx.stroke();
  });
  cell(TEX.glint, (ctx, r) => {
    radial(ctx, r * 0.4, [
      [0, "rgba(255,255,255,1)"],
      [1, "rgba(255,255,255,0)"]
    ]);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    for (const [w, h] of [[4, r * 0.95], [r * 0.95, 4]] as const) {
      ctx.beginPath();
      ctx.moveTo(-w, 0);
      ctx.lineTo(0, -h);
      ctx.lineTo(w, 0);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();
    }
  });
  cell(TEX.debris, (ctx, r) => {
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, -r * 0.3);
    ctx.lineTo(r * 0.2, -r * 0.55);
    ctx.lineTo(r * 0.55, r * 0.1);
    ctx.lineTo(r * 0.05, r * 0.5);
    ctx.lineTo(-r * 0.45, r * 0.25);
    ctx.closePath();
    ctx.fill();
  });

  // flame: a ragged, noisy puff whose hot core tints near white
  const fn = fbm(21);
  pixelCell(ctx, TEX.fire, (u, v) => {
    const r = Math.hypot(u, v);
    const n = fn(u * 2.6 + 3, v * 2.6 + 3);
    const d = r / (0.5 + 0.42 * n);
    const a = 1 - smooth(0.55, 1, d);
    const detail = fn(u * 5.5 + 11, v * 5.5 + 2);
    const l = 0.5 + 0.5 * (1 - smooth(0.05, 0.85, d)) + 0.18 * (detail - 0.5);
    return [l, a * (0.78 + 0.3 * detail)];
  }, CELL / 2);
  pixelCell(ctx, TEX.puff, puffCell(31), CELL / 2);
  pixelCell(ctx, TEX.puff2, puffCell(57), CELL / 2);
  // shock ring: a sharp bright front with a soft wake inside it
  pixelCell(ctx, TEX.shock, (u, v) => {
    const r = Math.hypot(u, v);
    const front = 0.82;
    const w = r < front ? 0.14 : 0.05;
    return [1, Math.exp(-(((r - front) / w) ** 2))];
  });
  // scorch: a charred, ragged blot with soft rays blown out of it
  const sn = fbm(5);
  pixelCell(ctx, TEX.scorch, (u, v) => {
    const r = Math.hypot(u, v);
    const th = Math.atan2(v, u);
    const n = sn(u * 3 + 2, v * 3 + 2);
    const core = (1 - smooth(0.3, 0.72 + 0.24 * n, r)) * (0.75 + 0.25 * sn(u * 7, v * 7));
    const ray = Math.max(0, Math.sin(th * 5 + n * 5)) ** 3 * smooth(0.3, 0.55, r) * (1 - smooth(0.55, 0.92, r)) * 0.25;
    return [1, Math.min(1, core + ray)];
  }, CELL / 2);
  // muzzle flare: a hot, ragged burst of uneven tongues (not a symmetric twinkle, which reads as loot)
  pixelCell(ctx, TEX.flare, (u, v) => {
    const r = Math.hypot(u, v);
    const th = Math.atan2(v, u);
    let s = 0;
    const tongues = [[0.15, 0.98], [1.2, 0.58], [2.05, 0.74], [3.0, 0.5], [3.85, 0.82], [4.7, 0.46], [5.45, 0.66]];
    for (const [a, len] of tongues) {
      const along = r * Math.cos(th - a!);
      if (along <= 0 || r >= len!) continue;
      const perp = Math.abs(r * Math.sin(th - a!));
      const k = 1 - r / len!;
      s = Math.max(s, Math.exp(-((perp / (0.04 + 0.16 * k)) ** 2)) * k ** 1.1);
    }
    const core = Math.exp(-((r / 0.26) ** 2));
    const halo = 0.3 * Math.exp(-((r / 0.5) ** 2));
    return [0.85 + 0.15 * core, Math.min(1, core + s * 0.9 + halo)];
  });
  cell(TEX.chunk, (ctx, r) => {
    const g = ctx.createLinearGradient(-r * 0.5, -r * 0.5, r * 0.5, r * 0.5);
    g.addColorStop(0, "rgb(235,235,235)");
    g.addColorStop(0.5, "rgb(150,150,150)");
    g.addColorStop(1, "rgb(80,80,80)");
    ctx.fillStyle = g;
    ctx.strokeStyle = "rgb(40,40,40)";
    ctx.lineWidth = 6;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(-r * 0.62, -r * 0.18);
    ctx.lineTo(-r * 0.1, -r * 0.62);
    ctx.lineTo(r * 0.58, -r * 0.34);
    ctx.lineTo(r * 0.36, r * 0.42);
    ctx.lineTo(-r * 0.3, r * 0.56);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // a bent seam across the plate
    ctx.strokeStyle = "rgba(60,60,60,0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-r * 0.4, -r * 0.3);
    ctx.lineTo(r * 0.1, r * 0.1);
    ctx.lineTo(r * 0.3, r * 0.4);
    ctx.stroke();
  });
  cell(TEX.heart, (ctx, r) => {
    const heart = (k: number) => {
      const s = r * k;
      ctx.beginPath();
      ctx.moveTo(0, s * 0.82);
      ctx.bezierCurveTo(-s * 0.18, s * 0.6, -s * 0.92, s * 0.18, -s * 0.9, -s * 0.28);
      ctx.bezierCurveTo(-s * 0.88, -s * 0.74, -s * 0.24, -s * 0.86, 0, -s * 0.42);
      ctx.bezierCurveTo(s * 0.24, -s * 0.86, s * 0.88, -s * 0.74, s * 0.9, -s * 0.28);
      ctx.bezierCurveTo(s * 0.92, s * 0.18, s * 0.18, s * 0.6, 0, s * 0.82);
      ctx.closePath();
    };
    // a soft dark rim (it reads on snow and sand), the body shaded from the upper left, a glossy highlight
    heart(0.98);
    ctx.fillStyle = "rgba(40,0,20,0.35)";
    ctx.fill();
    heart(0.88);
    const g = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
    g.addColorStop(0, "rgb(255,255,255)");
    g.addColorStop(0.55, "rgb(225,225,225)");
    g.addColorStop(1, "rgb(150,150,150)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.ellipse(-r * 0.42, -r * 0.42, r * 0.16, r * 0.1, -0.6, 0, Math.PI * 2);
    ctx.fill();
  });
  return c;
}

/** Soft blobs wrapped around the edges so the texture tiles seamlessly (R = shadow). */
export function cloudTexture(): THREE.CanvasTexture {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, S, S);
  const rnd = prng(7);
  for (let i = 0; i < 22; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 20 + rnd() * 60;
    for (const ox of [-S, 0, S])
      for (const oy of [-S, 0, S]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, "rgba(255,255,255,0.5)");
        g.addColorStop(0.6, "rgba(255,255,255,0.22)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

let disc: THREE.CanvasTexture | null = null;
/** A soft round glow (white; tinted by the material) for light pools on the ground. */
export function discTexture(): THREE.CanvasTexture {
  if (disc) return disc;
  const [c, ctx] = canvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 63);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  disc = new THREE.CanvasTexture(c);
  disc.colorSpace = THREE.SRGBColorSpace;
  return disc;
}

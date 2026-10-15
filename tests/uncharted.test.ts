/**
 * Uncharted, in the match: a generated map played blind. The engine-free
 * halves — the 3D shroud's fog texels (src/game/three/terrain.ts), the
 * minimap's solid shroud (src/ui/hud.ts shroudRects) and the end screen's
 * reveal; the DOM and WebGL halves are checked in a browser.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Vis, tickFog } from "../src/sim/fog";
import { createMapWorld, mapById } from "../src/sim/maps";
import { FOG_TARGET, Terrain3D } from "../src/game/three/terrain";
import { fowUniforms } from "../src/game/three/materials";
import { gameMode, unchartedMatch } from "../src/game/mode";
import { mapThumbUrl } from "../src/game/assets";
import { pauseMapHtml, revealHtml, shroudRects } from "../src/ui/hud";

// The terrain builds headless (see terrain-art.test.ts): a do-nothing canvas stands in for the DOM.
const noop: unknown = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : noop), apply: () => noop });
(globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => noop, style: {} }) };

const ID = "random-temperate-k3x9a";

/** The fog texture a fresh terrain settles to (one full fade step) for blue: (W+2)×(H+2) bytes, a border round the map. */
function fogBytes(uncharted: boolean): { data: Uint8Array; W: number; H: number; vis: Uint8Array } {
  const w = createMapWorld(ID, { seed: 1, objectives: true });
  tickFog(w);
  const t = new Terrain3D(w, "blue", null, { uncharted });
  t.update(250, true);
  const tex = fowUniforms.uFowMap.value as THREE.DataTexture;
  const data = (tex.image as { data: Uint8Array }).data.slice();
  t.dispose();
  return { data, W: w.width, H: w.height, vis: w.fog.blue.vis as unknown as Uint8Array };
}

describe("Uncharted: the 3D shroud", () => {
  const plain = fogBytes(false);
  const blind = fogBytes(true);
  const FW = plain.W + 2;
  const at = (b: { data: Uint8Array }, x: number, y: number) => b.data[(y + 1) * FW + x + 1]!;
  /** Unexplored tiles with nothing but unexplored ground (and the border) within a tile: the blur leaves them whole. */
  const deepUnexplored = (b: { vis: Uint8Array; W: number; H: number }) => {
    const out: [number, number][] = [];
    for (let y = 0; y < b.H; y++)
      for (let x = 0; x < b.W; x++) {
        let all = true;
        for (let dy = -1; dy <= 1 && all; dy++)
          for (let dx = -1; dx <= 1 && all; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < b.W && yy < b.H && b.vis[yy * b.W + xx] !== Vis.Unexplored) all = false;
          }
        if (all) out.push([x, y]);
      }
    return out;
  };

  it("is opaque over unexplored ground, where a normal match keeps its usual shroud", () => {
    const deep = deepUnexplored(blind);
    expect(deep.length).toBeGreaterThan(blind.W * blind.H * 0.5); // most of the map is unknown at the start
    for (const [x, y] of deep) {
      expect(at(blind, x, y)).toBe(255);
      expect(at(plain, x, y)).toBe(Math.round(FOG_TARGET.unexplored * 255));
    }
  });

  it("covers the border too, which the skirt past the map's edge reads through its mirrored lookup", () => {
    // (the border texels are what the fog lookup clamps to past the edge, next to the mirrored edge tiles)
    const corner = blind.data[0]!;
    expect(corner).toBe(255);
    expect(blind.data[blind.data.length - 1]).toBe(255);
    expect(plain.data[0]).toBe(Math.round(FOG_TARGET.unexplored * 255));
  });

  it("leaves what's in sight exactly as in a normal match", () => {
    let seen = 0;
    for (let y = 0; y < blind.H; y++)
      for (let x = 0; x < blind.W; x++) {
        if (blind.vis[y * blind.W + x] !== Vis.Visible) continue;
        seen++;
        // (a visible tile ringed by visible tiles: no blur from the shroud)
        let ring = true;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) if (blind.vis[(y + dy) * blind.W + x + dx] !== Vis.Visible) ring = false;
        if (ring) {
          expect(at(blind, x, y)).toBe(0);
          expect(at(plain, x, y)).toBe(0);
        }
      }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("Uncharted: the minimap", () => {
  /** Paint the rects into an S×S coverage grid. */
  const raster = (r: number[], S: number) => {
    const g = new Uint8Array(S * S);
    for (let i = 0; i < r.length; i += 4) {
      const [x, y, w, h] = [r[i]!, r[i + 1]!, r[i + 2]!, r[i + 3]!];
      expect([x, y, w, h].every(Number.isInteger)).toBe(true); // whole pixels: an opaque fill leaves no seams
      for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) if (px >= 0 && py >= 0 && px < S && py < S) g[py * S + px] = 1;
    }
    return g;
  };

  for (const [W, S] of [
    [108, 256],
    [64, 256],
    [7, 20]
  ] as const)
    it(`covers every pixel an unexplored tile touches, and shows the scouted ground (${W} tiles on ${S} px)`, () => {
      // a scouted blob in one corner and a scattering of known tiles: the rest unexplored
      const vis = new Uint8Array(W * W);
      for (let y = 0; y < W; y++)
        for (let x = 0; x < W; x++)
          vis[y * W + x] = x + y < W * 0.6 ? Vis.Visible : (x * 7 + y * 13) % 5 === 0 ? Vis.Explored : Vis.Unexplored;
      const g = raster(shroudRects(vis, W, W, S), S);
      const k = S / W;
      let shown = 0;
      for (let py = 0; py < S; py++)
        for (let px = 0; px < S; px++) {
          // the tiles this pixel overlaps
          let unexplored = false;
          for (let ty = Math.floor(py / k); ty < W && ty * k < py + 1; ty++)
            for (let tx = Math.floor(px / k); tx < W && tx * k < px + 1; tx++) if (vis[ty * W + tx] === Vis.Unexplored) unexplored = true;
          if (unexplored) expect(g[py * S + px]).toBe(1);
          else if (!g[py * S + px]) shown++;
        }
      expect(shown).toBeGreaterThan(S * S * 0.15); // the scouted ground isn't shrouded with it
    });

  it("draws nothing once it's all scouted", () => {
    expect(shroudRects(new Uint8Array(108 * 108).fill(Vis.Explored), 108, 108, 256)).toEqual([]);
  });
});

describe("the pause menu's map line", () => {
  it("gives a generated map's seed code (to replay or report it), but not its name played blind", () => {
    const def = mapById(ID);
    const seen = pauseMapHtml(ID, false);
    expect(seen).toContain(def.name);
    expect(seen).toContain(def.biome);
    expect(seen).toContain(`#${def.random!.code}`);
    const blind = pauseMapHtml(ID, true);
    expect(blind).toContain(`#${def.random!.code}`);
    expect(blind).toContain("Uncharted");
    expect(blind).not.toContain(def.name);
  });

  it("names a built-in map", () => {
    expect(pauseMapHtml("riverlands", false)).toContain(mapById("riverlands").name);
  });
});

describe("Uncharted: the reveal", () => {
  it("names the map, its share code and shows its whole thumbnail at the end", () => {
    const def = mapById(ID);
    const html = revealHtml(ID);
    expect(html).toContain(def.name);
    expect(html).toContain(`#${def.random!.code}`);
    expect(html).toContain(mapThumbUrl(ID));
    expect(html).toContain("🎲");
  });

  it("only applies to a generated map the player plays (not watched AI vs AI)", () => {
    const saved = { ...gameMode };
    try {
      Object.assign(gameMode, { uncharted: true, mapId: ID, spectator: false, op: null, daily: null });
      expect(unchartedMatch()).toBe(true);
      Object.assign(gameMode, { spectator: true });
      expect(unchartedMatch()).toBe(false);
      Object.assign(gameMode, { spectator: false, mapId: "riverlands" });
      expect(unchartedMatch()).toBe(false);
    } finally {
      Object.assign(gameMode, saved);
    }
  });
});

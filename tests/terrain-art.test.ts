/**
 * The painted terrain: where its chunks are fetched from (and cached), and how
 * the 3D ground lays them on (src/game/map-art.ts, src/game/three/terrain.ts).
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { TERRAIN_CHUNK, TERRAIN_PX, terrainChunks } from "../src/game/assets";
import { MAP_ART, terrainChunkUrl } from "../src/game/map-art";
import { Terrain3D } from "../src/game/three/terrain";
import { MAPS, createMapWorld } from "../src/sim/maps";

// The terrain builds headless: a real scene graph, no WebGL. Its cloud shadows and the read-back of the
// paint want a 2D canvas: a do-nothing canvas stands in for the DOM.
const noop: unknown = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : noop), apply: () => noop });
(globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => noop, style: {} }) };

describe("terrain chunk URLs", () => {
  const site = "https://simonw.github.io/battledrones/";

  it("carry the map's revision, so a repainted map isn't served from the cache-first map cache", () => {
    const url = terrainChunkUrl("archipelago", 4, 0, { archipelago: "b023922a2cb0" });
    expect(url).toBe("assets/maps/archipelago/t_4_0.webp?v=b023922a2cb0");
    expect(terrainChunkUrl("archipelago", 4, 0, { archipelago: "0123456789ab" })).not.toBe(url);
    // (a map with no revision, as in these tests, asks for the plain file)
    expect(terrainChunkUrl("riverlands", 0, 0, {})).toBe("assets/maps/riverlands/t_0_0.webp");
  });

  it("are all cached by the service worker's map rule, revision or not", () => {
    for (const revs of [{ archipelago: "b023922a2cb0" }, {}] as Record<string, string>[])
      expect(MAP_ART.test(new URL(terrainChunkUrl("archipelago", 5, 5, revs), site).href)).toBe(true);
    expect(MAP_ART.test(new URL("assets/maps/archipelago/thumb.webp", site).href)).toBe(true);
    expect(MAP_ART.test(new URL("assets/textures/rock-tropical.webp", site).href)).toBe(false);
  });
});

describe("the painted ground", () => {
  /** A stand-in for each chunk the painter writes: its size is all the ground reads. */
  const chunksFor = (size: number) => {
    const n = terrainChunks(size);
    const span = (i: number) => Math.min(TERRAIN_CHUNK, size * TERRAIN_PX - i * TERRAIN_CHUNK);
    return Array.from({ length: n }, (_, r) =>
      Array.from({ length: n }, (_, c) => new THREE.Texture({ width: span(c), height: span(r) } as unknown as HTMLImageElement))
    );
  };

  // A 108-tile map's last chunk is only 1⅓ tiles wide, a 48-tile map's 5⅓: both narrower than the
  // mirrored skirt past the map's edge, which once took its paint from the last chunk and streaked.
  for (const def of MAPS)
    it(`${def.name} (${def.size}²): every vertex samples inside its chunk's paint, past the far edges too`, () => {
      const chunks = chunksFor(def.size);
      const painted = new Set<THREE.Texture | null>(chunks.flat());
      const t = new Terrain3D(createMapWorld(def.id), "blue", { chunks, rock: null, pxPerTile: TERRAIN_PX, chunk: TERRAIN_CHUNK });
      let meshes = 0;
      let worst = 0;
      for (const m of t.group.children) {
        if (!(m instanceof THREE.Mesh) || !painted.has((m.material as THREE.MeshLambertMaterial).map)) continue;
        meshes++;
        const uv = m.geometry.getAttribute("uv");
        for (let i = 0; i < uv.count; i++)
          worst = Math.max(worst, -uv.getX(i), uv.getX(i) - 1, -uv.getY(i), uv.getY(i) - 1);
      }
      // a mesh per chunk, and the far skirt's four quads (one texel each: the shader paints them as open ground)
      expect(meshes).toBe(terrainChunks(def.size) ** 2 + 4);
      expect(worst).toBeLessThan(1e-4);
    });
});

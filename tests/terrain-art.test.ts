/**
 * The painted terrain: where its chunks are fetched from (and cached), and how
 * the 3D ground lays them on (src/game/map-art.ts, src/game/three/terrain.ts).
 */
import { describe, expect, it } from "vitest";
import { MAP_ART, terrainChunkUrl } from "../src/game/map-art";

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

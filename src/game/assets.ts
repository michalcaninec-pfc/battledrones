import * as THREE from "three";
import type { Biome, BuildingKind, UnitKind } from "../sim/types";
import { terrainChunkUrl } from "./map-art";
import type { TerrainArt } from "./three/terrain";

export { mapAssetBase } from "./map-art";

/** Painted terrain images: 48 px per tile, split into 1024 px chunks. */
export const TERRAIN_PX = 48;
export const TERRAIN_CHUNK = 1024;

export const UNIT_KINDS: UnitKind[] = [
  "harvester", "scout", "stinger", "flak-crawler", "mortar", "mastodon", "lancer",
  "wasp", "raptor", "hornet", "mender", "trooper", "rocket-squad", "sniper", "condor", "goliath"
];
export const BUILDING_KINDS: BuildingKind[] = [
  "hq", "fab-plant", "airpad", "tech-lab", "depot", "turret", "sam-site", "radar", "assembly-bay", "gantry"
];

/** Terrain chunk grid for a map (chunks per side). */
export function terrainChunks(mapSize: number): number {
  return Math.ceil((mapSize * TERRAIN_PX) / TERRAIN_CHUNK);
}

/** A biome's rock material (art/textures.py): the 3D cliffs and crags are textured with it. */
export function rockTextureUrl(biome: Biome): string {
  return `assets/textures/rock-${biome}.webp`;
}

/**
 * Load a map's painted terrain chunks (draped over the 3D heightfield) and
 * its biome's rock material. A missing chunk loads as null — the terrain
 * falls back to flat colours there — and a missing rock texture leaves the
 * rocks untextured, so a bad network never stalls the boot.
 */
export async function loadTerrainArt(
  mapId: string,
  mapSize: number,
  biome: Biome,
  progress?: (k: number) => void
): Promise<TerrainArt> {
  const n = terrainChunks(mapSize);
  const loader = new THREE.TextureLoader();
  let done = 0;
  const total = n * n + 1;
  const chunks: (THREE.Texture | null)[][] = [];
  let rock: THREE.Texture | null = null;
  const jobs: Promise<void>[] = [
    loader
      .loadAsync(rockTextureUrl(biome))
      .then((tex) => {
        rock = tex;
      })
      .catch(() => console.warn("rock texture failed:", biome))
      .finally(() => progress?.(++done / total))
  ];
  for (let r = 0; r < n; r++) {
    const row: (THREE.Texture | null)[] = [];
    chunks.push(row);
    for (let c = 0; c < n; c++) {
      row.push(null);
      jobs.push(
        loader
          .loadAsync(terrainChunkUrl(mapId, c, r))
          .then((tex) => {
            row[c] = tex;
          })
          .catch(() => console.warn("terrain chunk failed:", mapId, c, r))
          .finally(() => progress?.(++done / total))
      );
    }
  }
  await Promise.all(jobs);
  return { chunks, rock, pxPerTile: TERRAIN_PX, chunk: TERRAIN_CHUNK };
}

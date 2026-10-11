/**
 * Where a map's painted art is served from, and how the service worker caches
 * it (vite.config.ts reads MAP_ART for its cache rule). Engine-free.
 *
 * Map art is served cache-first (a few MB per map, so it isn't downloaded
 * again every game), which only works if a repainted map comes from new URLs:
 * the terrain chunks carry their map's revision, a hash of its chunks taken at
 * build time. Unversioned, a returning player was handed the old chunks on a
 * new layout (the Archipelago's 96-tile paint on its 108-tile grid).
 */

/** Each map's terrain revision (vite.config.ts); not defined outside a Vite build (the tests). */
declare const __TERRAIN_REVS__: Record<string, string> | undefined;
const TERRAIN_REVS: Record<string, string> = typeof __TERRAIN_REVS__ === "undefined" ? {} : __TERRAIN_REVS__;

/** Requests for map art, revision query and all: the service worker serves them cache-first. */
export const MAP_ART = /\/assets\/maps\/.*\.webp(\?|$)/;

export function mapAssetBase(mapId: string): string {
  return `assets/maps/${mapId}`;
}

/** A painted terrain chunk (column c, row r) of a map, at its current revision. */
export function terrainChunkUrl(mapId: string, c: number, r: number, revs: Record<string, string> = TERRAIN_REVS): string {
  const rev = revs[mapId];
  return `${mapAssetBase(mapId)}/t_${c}_${r}.webp${rev ? `?v=${rev}` : ""}`;
}

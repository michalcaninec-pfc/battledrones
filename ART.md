# Battle Drones — Art

Every image in the game — units, buildings, terrain materials, decorations,
scrap and crystals, explosions, the menu key art and the app icon — was
generated with OpenAI's **`gpt-image-2.5-sunburst`** (released 2026-09-08,
described by OpenAI as its most capable image generation and editing
model), then processed deterministically in Python into the assets the
engine loads.

> **The battlefield is now 3D (three.js).** Units, buildings, objectives,
> trees, rocks, scrap and crystals are procedural low-poly models built in
> code (`src/game/three/models.ts`, `three/terrain.ts`) in the same style
> contract — gunmetal, royal-blue/crimson team panels, amber lights — and
> particle textures are drawn at runtime (`src/game/three/textures.ts`).
> The painted **terrain** (section 3) is draped over the 3D heightfield as
> its albedo, and the five painted **rock materials** become small tileable
> textures (`art/textures.py` → `public/assets/textures/rock-<biome>.webp`,
> 512², seamless) that texture the outcrops' cliff walls and crags, so they
> are the same stone as the painted tops. The generated **unit and building art** still provides the
> HUD portraits (`public/assets/icons/`), and the key art and icons are
> unchanged. The sprite atlas (`public/assets/sprites/`) is still produced
> by `process.py` but is no longer loaded by the game.

The pipeline lives in `art/` (Python 3.10+, Pillow ≥ 10.1, numpy, scipy,
and the `openai` package for generation):

```bash
python3 art/generate.py            # generate any missing raws (needs OPENAI_API_KEY)
python3 art/generate.py 'tex-*' --force   # regenerate matching assets
python3 art/generate.py --list     # what exists
python3 art/process.py             # raws -> sprite atlas, icons, key art, PWA icons
python3 art/process.py --icons-only   # just the HUD portraits
npx vite-node tools/export-maps.ts # map grids -> art/maps/*.json
python3 art/terrain.py [map ids]   # paint each map's terrain (and refresh the rock textures)
python3 art/textures.py            # the biome rock textures alone (Pillow + numpy only)
```

## 1. Generation — `art/catalog.py`, `art/generate.py`, `art/imagegen.py`

`catalog.py` is the single source of truth for every prompt. Prompts are
built from shared *style contracts* so the whole set reads as one game:

- **STYLE** — strictly top-down orthographic, semi-realistic hand-painted
  sci-fi military, crisp edges, readable silhouettes at phone size, soft
  light from the upper left, weathered gunmetal with **royal-blue team
  panels** — and blue *only* on team panels (lights and glass are amber),
  so the red faction can be derived by hue-shifting. No text or logos.
- **ISOLATED** — native transparent background (`background="transparent"`,
  PNG), generous margins, no ground, shadows, glows or frames. The model
  supports true alpha, so no chroma keying is needed.
- **FACING** — every vehicle points north; the engine rotates sprites.
- **PAIR** — for turreted vehicles and turret buildings, one image shows the
  hull (with an empty turret ring) and the turret side by side at the same
  scale. Generating both parts in one image keeps them perfectly matched.
- **TEXTURE** — opaque, flat-lit, tileable top-down ground materials.
- **DOODADS** — 3×3 sheets of decorations per biome.

`generate.py` runs jobs concurrently (8 workers) with retry/backoff and
stores each raw as `art/raw/<name>.webp` (lossy colour, lossless alpha —
small enough to commit, faithful enough to reprocess). Sprites use
`quality="high"` at 1024² or 1536×1024; textures `quality="medium"`.

Inventory (74 raws): 15 units, 9 buildings, rubble, decals, scrap piles,
crystal clusters, an 8-frame explosion, 7 materials × 5 biomes (ground,
ground2, rough, rock, liquid, road, forest canopy; for temperate, desert,
arctic, volcanic and tropical), a doodad sheet per biome, portrait and
landscape key art, the icon, and the two map
objectives: the `uplink` relay (a round platform + its rotating dish, as a
PAIR) and the `supply-crate`. Those use a **NEUTRAL** contract instead of
STYLE — gunmetal with hazard-yellow stripes and amber lights, no blue or red
at all — because they belong to no side: the engine draws the holder's
colour as a ring, so they get no red variant.

The robot infantry and its kit came after the move to 3D, so they exist only
as HUD portraits, painted to match their in-game models (blocky robots with
big blue shoulder pads and amber visors): `trooper` (five rifle robots in a
wedge), `rocket-squad` (three heavy robots with shoulder tubes), `sniper` (two
cloaked robots with rail rifles), all drawn from a shared **SQUAD** clause
(straight overhead, every robot facing north); the `condor` dropship (open
troop bay, two wingtip ducted fans); and the 2×2 `assembly-bay`.

## 2. Sprites — `art/process.py`

Deterministic (same raws → byte-identical output). It:

1. Splits multi-part images into parts via connected components on
   thresholded alpha (tiny satellites such as rotor discs are attached to
   the nearest part); rotates the Mender and Scout 180° (drawn facing south).
2. Scales each unit so its longest side matches a per-unit size in tiles
   (e.g. Scout 0.85, Titan 1.45, Hornet 1.5); turrets share their hull's
   scale; buildings fill their footprint.
3. Measures pivots: hull centre of mass; the empty **turret ring** on each
   hull by a gradient circle search + sub-pixel circle fit; the **turret
   pivot** as the centroid of the turret body after removing the barrel by
   morphological opening.
4. Derives the **red faction** by shifting saturated blue hues to crimson,
   leaving amber, green, grey and rust untouched.
5. Packs everything into one power-of-two page (mipmaps need POT) with 8 px
   padding, zeroes RGB under transparent pixels, and writes a Phaser
   multiatlas.

Outputs and the contract the engine relies on:

| File | Contents |
|---|---|
| `public/assets/sprites/game.json` + `game-0.webp` | 2048² multiatlas (~1.3 MB WebP) |
| `public/assets/sprites/meta.json` | `pxPerTile` (128), per-frame `origin` pivots, turret/head `mounts` (tiles, hull facing north), unit `sizes` |
| `public/assets/icons/<kind>.webp` | 128 px HUD portraits (blue, turrets composited; content fit to 112 px) |
| `public/assets/ui/keyart-{portrait,landscape}.webp` | Menu backgrounds |
| `public/icons/icon-{192,512}.png` | PWA icons |
| `art/previews/atlas-preview.png` | QA contact sheet |

Frame names: `u/<faction>/<unit>` (hull or body), `u/<faction>/<unit>-turret`,
`u/<faction>/harvester-full`, `b/<faction>/<building>`,
`b/<faction>/<turret|sam-site|radar>-head`, `rubble/0-3`, `decal/0-5`,
`scrap/0-5`, `crystal/0-5`, `explosion/0-7`, and the neutral
`obj/uplink` (2.25 tiles across), `obj/uplink-head` (pivot on its hub; its
mount offset is `mounts.uplink`) and `obj/crate` (0.85 tiles). Art is authored at 128 texture
px per tile; the world is 64 px per tile, so sprites draw at 0.5×.

## 3. Terrain — `art/terrain.py`

Each map's grid (exported from `src/sim/maps.ts` by
`tools/export-maps.ts`) is painted into a full-map image at **48 px per
tile**, written as 1024 px WebP chunks (`public/assets/maps/<id>/t_<c>_<r>.webp`)
plus `meta.json` and a 256 px `thumb.webp` (map picker and minimap). The
game asks for the chunks with a hash of them on their URLs (`vite.config.ts`),
so a repainted map reaches players past the service worker's cache with
nothing to bump by hand. It:

- makes the generated materials tile seamlessly and hides repetition with
  large-scale noise variation, blending in a secondary ground material;
- blends materials with noise-perturbed soft masks that stay within about
  a third of a tile of the true boundary, so passability stays readable;
- builds a height field for rock, hillshades it from the upper left, casts
  soft shadows and ambient occlusion;
- paints water with depth gradients, wet banks and shore foam — lava with a
  glow bleeding onto nearby ground — shallows as see-through fords, and the
  open sea (Deep) falling away past the coastal shelf (below);
- draws bridges as built decks with railings and shadows, oriented along
  each bridge's principal axis;
- scatters tree-crown doodads through and over forest edges and other
  decorations sparsely (big ones only on unbuildable ground, never near an
  HQ), each with a soft drop shadow;
- chooses the highest WebP quality that keeps each map near 1.5 MB (the
  budget scales with area past 64×64 tiles: the 108-tile Archipelago's 36
  chunks get ~4.3 MB and come out at ~3.7 MB, q78).

`python3 art/terrain.py --debug` also writes a grid-overlay QA image.

Painting the 108-tile Archipelago takes about 4 minutes and ~9 GB of RAM,
so paint just the map you changed (`python3 art/terrain.py archipelago`).

### The tropical set and the open sea (Archipelago)

The fifth biome, **tropical** (the Coral Archipelago, midday), has its own
7 materials — pale sun-bleached sandy turf (ground), warm white coral beach
sand (ground2), a dark mangrove mudflat (rough), pale pitted limestone karst
(rock), a clear turquoise lagoon (liquid), a silver-grey timber boardwalk of
lengthwise planks (road; its grain is turned to run along each road) and an
emerald rainforest canopy with palm crowns (forest) — and a doodad sheet: a
coconut palm, a rainforest crown and a mangrove crown (the trees), then a
limestone boulder, coral rubble and shells, a driftwood log, a sea-grape bush,
a beached landing craft and crates under a tarp. Its `BIOMES["tropical"]`
config turns on a few painter features no other biome uses (each is a config
key, off by default, so the other maps paint exactly as before):

- **beach**: ground2 is forced up into a band ~1.1 tiles wide along every
  wet edge (from the wet SDF), so every coast and island gets a white beach
  ring; its inland edge wobbles and follows the texture detail like the
  other ground2 patches.
- **Deep sea** (Terrain.Deep, `a` in the exported grid): painted as water
  that keeps getting deeper, with a second drop-off at the Water→Deep edge
  (the reef crest) into the `abyss` colour — `abyss_mix` within
  `abyss_reach` tiles (open sea, ~#0a3f66) and `abyss_far` on toward the
  abyss (~#062a48) far from any shore. A bridge's span out over the sea
  counts as sea, so no shelf colour rings the deck. **surf** paints a broken
  white line of breaking surf just past the reef crest, a fainter second
  line behind it and spray thrown back onto the reef; **coral** faint pink,
  ochre and olive coral heads under the film near the drop; **swell** broad
  light and dark patches and long swell streaks (white noise blurred far
  more along one direction than across it) over the open sea.
- **trestle**: the timber plank decks show their bents' cap beams past each
  side every 1.5 tiles; **bridge_reach** lets a deck run up to 24 tiles
  either side of its centre (each Archipelago bridge spans ~20 tiles).
- smaller touches: straighter boardwalk edges (`road_blur`, `road_wobble`),
  a dark wave-cut notch where limestone stands in the sea (`rock_notch`),
  smoother mudflat edges (`rough_soft`), mangroves standing in the mudflats
  (`rough_big_mul` and the `mangrove` big doodad), coral rubble only near
  the water (`small_shore`), and per-channel `forest_mul`, `ground2_tint`
  and `tree_tint` to pull the canopy toward jade and the sand toward white.

Scrap piles and crystals are *not* painted into the terrain — the game draws
them as sprites so they visibly shrink as they're mined.

## Changing art

- Tweak a prompt in `catalog.py`, then `generate.py <name> --force`,
  `process.py`, and rebuild. View `art/previews/*` before shipping.
- New kinds now only need a HUD portrait: add a catalog entry, add the kind to
  `PORTRAIT_ONLY` in `process.py` (all parts of the raw are kept, so a squad
  of separate robots works), then `generate.py <kind>` and
  `process.py --icons-only`. These get no atlas frames.
- A kind that also needs atlas frames takes a size in `process.py`
  (`UNIT_SIZES` / `BUILDING_SIZES`) instead, and its frame names follow
  automatically.
- Changing a map in `src/sim/maps.ts` requires re-exporting and re-painting
  its terrain (`npm run maps && npm run art:terrain -- <id>`).

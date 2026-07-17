# imagegen — AI-generated sprite experiments

Experiment in generating game sprites with OpenAI's image models, following
the technique documented in `notes/animated-sprite-imagegen-notes.md`
(distilled from openai/codex's imagegen sample and openai/skills' hatch-pet
skill). Subjects so far: the 6-frame explosion FX sprite, the 3-state
HQ building, and five units — harvester (2 states × 8 directions),
stinger, flak-crawler, wasp and raptor (8 directions each) — from ART.md.

## Explosion pipeline

1. `generate_explosion.py` — one `images/generations` call (`gpt-image-2`,
   1536×1024, quality high). Asks for a 2×3 grid of six 512×512 animation
   frames on a flat pure-magenta chroma-key background. The API's ~3:1
   aspect-ratio limit rules out a true 6×1 strip, hence the grid.
   Transparency is deliberately NOT requested from the model — it's removed
   deterministically afterwards. Requires `OPENAI_API_KEY`.
2. `process_explosion.py` — chroma-keys the magenta out (distance threshold
   plus a magenta-dominant despill pass for anti-aliased edge pixels),
   slices the grid into frames, recentres each frame on its content
   bounding box, saves high-res transparent frames, then nearest-neighbour
   downscales to 32×32 and assembles the 192×32 sheet matching the ART.md
   contract for `fx/explosion.png` (frames 0–3 fireball, 4–5 smoke).

Dependencies: `pip install pillow requests`.

## HQ pipeline (identity anchoring)

1. `generate_hq.py` — three API calls: `images/generations` produces the
   canonical **idle** HQ (blue faction, 1024×1024, magenta background),
   then two `images/edits` calls attach that idle image as the identity
   anchor and ask for the **damaged** and **rubble** states while keeping
   viewpoint, scale, position and silhouette identical.
2. `process_hq.py` — same chroma-key + despill, but the three states are
   cropped with a single **shared bounding box** (union of the three
   content boxes) so the building keeps the same scale and registration
   across frames — per-frame bbox fitting would render the rubble pile
   larger than the intact building. Downscaled to 90×90 inside a 96×96
   frame (ART.md's ~3px building margin), assembled into the 288×96
   idle/damaged/rubble sheet.

## Harvester pipeline (unit: states × rotations)

1. `generate_harvester.py` — two API calls: `images/generations` for the
   canonical North-facing empty harvester, one `images/edits` call (idle
   image attached) to heap the cargo bay with teal scrap. The 8 direction
   frames per state are NOT generated: ART.md's direction convention is
   pure rotation, so they're derived programmatically.
2. `process_harvester.py` — chroma-key + despill, shared bbox across both
   states, then per direction: rotate the HIGH-RES image (bicubic),
   **de-res** to 32×32 (premultiplied-alpha BOX downscale so transparent
   pixels don't darken edges, hard alpha threshold for crisp borders),
   and finally quantize all 16 frames against ONE shared 24-color palette
   so rotation frames don't shimmer against each other. Content is scaled
   so its bounding-box diagonal is <32px — no clipping at any rotation
   angle. Output: the 256×64 sheet (row 0 empty, row 1 loaded).

## Batch units pipeline (stinger, flak-crawler, wasp, raptor)

1. `generate_units.py` — one `images/generations` call per unit, all four
   fired concurrently with a thread pool (each call takes a minute-plus,
   so parallelism is nearly a 4× wall-clock win). Single art state each;
   no edits calls needed.
2. `process_units.py` — the harvester de-res pipeline generalized, plus
   two refinements: a despeckle pass that drops disconnected alpha
   components under 3px, and a tunable de-res alpha threshold (default
   96, raptor 48) so thin features — the wasp's rotor stub arms, the
   raptor's tail boom — stay connected to the hull instead of leaving
   their rotor pods floating as debris. Connectivity is verified by
   connected-component counting per frame.

## Outputs (`output/`)

| File | What |
|---|---|
| `explosion-raw.png` | Raw model output (1536×1024, magenta background) |
| `frames/frame-{0..5}.png` | High-res transparent frames (512×512), kept for future use |
| `explosion.png` | Game-ready 192×32 sheet, drop-in replacement for `public/assets/sprites/fx/explosion.png` |
| `explosion-preview.gif` | 4× upscaled animation preview |
| `hq-raw-{idle,damaged,rubble}.png` | Raw model outputs (1024×1024, magenta background) |
| `hq-frames/{idle,damaged,rubble}.png` | High-res transparent states (917×917) |
| `hq.png` | Game-ready 288×96 sheet for `public/assets/sprites/buildings/blue/hq.png` |
| `hq-preview.png` | 2× side-by-side preview of the three states |
| `harvester-raw-{empty,loaded}.png` | Raw model outputs (1024×1024, magenta background) |
| `harvester-frames/{empty,loaded}.png` | High-res transparent North-facing states |
| `harvester.png` | Game-ready 256×64 sheet for `public/assets/sprites/units/blue/harvester.png` |
| `harvester-preview.gif` | 4× preview cycling the 8 directions |
| `{stinger,flak-crawler,wasp,raptor}-raw.png` | Raw model outputs (1024×1024, magenta background) |
| `unit-frames/<unit>.png` | High-res transparent North-facing sprites |
| `{stinger,flak-crawler,wasp,raptor}.png` | Game-ready 256×32 sheets for `public/assets/sprites/units/blue/` |
| `<unit>-preview.gif` | 4× previews cycling the 8 directions |

## Notes / learnings

- `gpt-image-2` nailed the grid layout, frame ordering, animation arc, and
  the flat key background in a single attempt — no retries needed.
- The despill pass matters: anti-aliased edges blend sprite and key color
  and survive a pure distance threshold, showing up as magenta fringe
  after downscaling. Magenta-dominance (`r` and `b` both well above `g`)
  is a safe second test for fire (low blue) and smoke (balanced channels).
- Per-frame recentring fixes small placement drift between grid cells;
  fine for radially symmetric FX, but would need a stable-baseline
  approach (see the notes file) for walking characters.
- Identity anchoring via `images/edits` works extremely well: the damaged
  HQ is unmistakably the same building (same dome, banner, corner
  emplacements, bay door) with cracks, scorch and a shattered dome, and
  the rubble stays inside the same footprint. No retries were needed for
  any of the five API calls made so far.
- The shared-crop-box trick is the still-image analogue of hatch-pet's
  "stable slots": whenever multiple generated images are frames of one
  sheet, never fit each frame to its own content — pick one viewport and
  apply it to all of them.
- This was generated for the blue faction only. Red should be produced by
  programmatic palette swap, not regeneration, to guarantee the matched
  silhouettes ART.md requires.
- Naive nearest-neighbour downscaling of dense high-res art to 32×32
  produces speckle noise — every output pixel samples one arbitrary
  source pixel. The fix that made the harvester readable: area-average
  (BOX) downscale in premultiplied alpha, hard alpha threshold, then one
  shared adaptive palette across all frames. Rotating at high resolution
  before de-res beats rotating 32px art (the placeholder generator's
  approach) on diagonal frames.

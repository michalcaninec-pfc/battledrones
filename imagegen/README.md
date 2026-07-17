# imagegen — AI-generated sprite experiments

Experiment in generating game sprites with OpenAI's image models, following
the technique documented in `notes/animated-sprite-imagegen-notes.md`
(distilled from openai/codex's imagegen sample and openai/skills' hatch-pet
skill). First subject: the 6-frame explosion FX sprite from ART.md.

## Pipeline

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

## Outputs (`output/`)

| File | What |
|---|---|
| `explosion-raw.png` | Raw model output (1536×1024, magenta background) |
| `frames/frame-{0..5}.png` | High-res transparent frames (512×512), kept for future use |
| `explosion.png` | Game-ready 192×32 sheet, drop-in replacement for `public/assets/sprites/fx/explosion.png` |
| `explosion-preview.gif` | 4× upscaled animation preview |

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

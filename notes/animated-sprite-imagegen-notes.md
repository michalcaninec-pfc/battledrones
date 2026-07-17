# Creating Animated Sprites for a 2D Game with OpenAI's Imagegen Models

Technical notes extracted from two OpenAI-authored sources:

- **Source A — the `imagegen` sample skill** (`/tmp/codex/codex-rs/skills/src/assets/samples/imagegen/`): documents the raw model/API surface (models, endpoints, parameters, transparency handling, the `image_gen.py` CLI, and the `remove_chroma_key.py` post-processor).
- **Source B — the `hatch-pet` curated skill** (`/tmp/skills/skills/.curated/hatch-pet/`): a full production pipeline for **animated sprite sheets** (9 animation states, 8x9 atlas). Everything pet-specific has been generalized here to any 2D game subject (drone, character, enemy, explosion, pickup, etc.).

The core technique in one sentence: **generate one canonical "base" image of the subject on a flat chroma-key background; then, for each animation, generate one horizontal strip image containing N evenly-spaced frames, using an image-edit/reference call that attaches the base image (identity lock) plus a synthetic layout-guide image (geometry lock); finally chroma-key, slice, validate, and assemble the frames deterministically with Python/PIL.**

---

## 1. Models, endpoints, and parameters

### Models (GPT Image family)

| Model | Quality values | Transparency | Sizes | Use for |
| --- | --- | --- | --- | --- |
| `gpt-image-2` | `low`, `medium`, `high`, `auto` | **Does NOT support `background=transparent`** — use chroma-key workflow | `auto` or flexible `WIDTHxHEIGHT` (constraints below) | Default for new work: best quality, edits, references. Image inputs always high fidelity (do not set `input_fidelity`). |
| `gpt-image-1.5` | same | **Supports `background=transparent`** (requires `output_format` png/webp) | `1024x1024`, `1536x1024`, `1024x1536`, `auto` | The true-native-transparency fallback. Supports `input_fidelity: low|high`; preserves first 5 input images with higher fidelity. |
| `gpt-image-1` | same | supports transparent | same fixed sizes | Legacy. |
| `gpt-image-1-mini` | same | supports transparent | same fixed sizes | Cheap drafts/batches. |

`gpt-image-2` size constraints (validated in `image_gen.py`):
- max edge <= 3840 px
- **both edges must be multiples of 16 px**
- long:short ratio <= 3:1
- total pixels between 655,360 and 8,294,400
- popular sizes: `1024x1024` (fastest), `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `auto`

Note the 3:1 ratio cap matters for animation strips: an 8-frame strip of 192x208 cells is 1536x208 natively (7.4:1), which is illegal. In practice you generate the strip at a legal aspect (e.g. `1536x1024` or a 3:1-ish size like `1536x512`) with the frames laid out inside it, or at higher per-frame resolution, and let the slicing step crop/scale each frame down to the cell size. The hatch-pet pipeline never trusts generated geometry anyway ("Do not rely on generated images for exact atlas geometry; use deterministic image scripts").

### Endpoints

- Generate: `POST /v1/images/generations` → Python SDK `client.images.generate(...)`
- Edit / referenced generation: `POST /v1/images/edits` → `client.images.edit(...)`
  - `image`: 1–16 input images (each < 50 MB) — this is how you attach the base reference + layout guide
  - `mask`: optional PNG with alpha (same size as first image; prompt-guided, not pixel-exact)

Core request parameters:
- `prompt`, `model`, `n` (1–10 variants of one prompt — NOT for distinct assets), `size`, `quality`
- `background`: `transparent` | `opaque` | `auto` (output alpha; not the visual backdrop)
- `output_format`: `png` (default) | `jpeg` | `webp`; `output_compression` 0–100 (jpeg/webp)
- `moderation`: `auto` (default) | `low`

Response: `data[]` with `b64_json` per image. Decode with `base64.b64decode(item.b64_json)` and write bytes to file.

Minimal Python calls:

```python
from openai import OpenAI
client = OpenAI()  # reads OPENAI_API_KEY

# generation
r = client.images.generate(model="gpt-image-2", prompt=..., size="1024x1024",
                           quality="medium", output_format="png")

# referenced generation / edit (identity-locked frame strip)
r = client.images.edit(model="gpt-image-2", prompt=...,
                       image=[open("base.png","rb"), open("layout-guide.png","rb")],
                       size="1536x1024", quality="high", output_format="png")

open("out.png","wb").write(base64.b64decode(r.data[0].b64_json))
```

The bundled reference CLI (`imagegen/scripts/image_gen.py`) wraps exactly these calls with subcommands `generate`, `edit`, `generate-batch`:

```bash
python image_gen.py generate --prompt "..." --size 1024x1024 --quality low --out out/draft.png
python image_gen.py edit --image base.png --image guide.png --prompt "..." --quality high --out out/strip.png
python image_gen.py generate --model gpt-image-1.5 --prompt "..." --background transparent --output-format png --out out/cutout.png
```

`generate-batch` takes a JSONL file (one job per line, per-job overrides for `size`, `quality`, `n`, `model`, `out`, etc.), `--concurrency` (default 5, max 25), `--max-attempts` (retry transient/429 errors with exponential backoff, honoring Retry-After), `--fail-fast`, `--dry-run` (prints the payload without calling).

Quality/cost guidance from the source: `quality=low` for fast drafts and iteration; `medium`/`high` for final assets; square 1024x1024 is fastest; large sizes + high quality increase latency and cost.

## 2. Authentication and setup

- `export OPENAI_API_KEY=...` — required for any live API call (create at https://platform.openai.com/api-keys). The CLI hard-fails without it (except `--dry-run`).
- Dependencies: `pip install openai pillow` (source repos prefer `uv pip install openai pillow`). Pillow is needed for all post-processing (chroma removal, slicing, atlas, GIF previews).
- In sandboxed agent environments, note that suppressing approval prompts does not grant network; network access is a separate setting.
- The Codex skill also has a "built-in `image_gen` tool" mode that needs no key; for standalone use, the CLI/API path above is the one to replicate.

## 3. The animation technique: strips + identity locking + deterministic slicing

The hatch-pet pipeline is the definitive recipe. Its shape, generalized:

### 3.1 Target format: fixed sprite atlas

The consuming app reads a fixed grid atlas (hatch-pet's numbers, adaptable to any game):

- Atlas: **8 columns x 9 rows**, cell **192x208 px** → **1536x1872** total, PNG or lossless WebP, transparent background.
- One row per animation state; each row uses its first N columns and the rest of the row **must be fully transparent**.
- Row table (frame counts + per-frame durations, directly reusable as a template for a generic character):

| Row | State | Frames | Durations (ms) |
| --- | --- | ---: | --- |
| 0 | idle | 6 | 280, 110, 110, 140, 140, 320 |
| 1 | move-right | 8 | 120 x7, final 220 |
| 2 | move-left | 8 | 120 x7, final 220 |
| 3 | wave/greet | 4 | 140 x3, final 280 |
| 4 | jump | 5 | 140 x4, final 280 |
| 5 | fail/hurt | 8 | 140 x7, final 240 |
| 6 | waiting | 6 | 150 x5, final 260 |
| 7 | working/attack | 6 | 120 x5, final 220 |
| 8 | inspect/special | 6 | 150 x5, final 280 |

For a simple game you might only need 2–4 rows (e.g. drone: idle, fly-left, fly-right, explode) — the technique is identical per row.

### 3.2 Why strips, not per-frame generation and not one giant atlas

- **One image per animation row** ("horizontal animation strip"): all N frames of one animation are generated in a *single* image so the model keeps the subject identical across frames (same lighting, palette, proportions) — the single most important consistency trick.
- **Not one call per frame**: independent calls drift in identity/scale even with references.
- **Not the whole 9-row atlas in one image**: too many cells for reliable layout; a bad row would force full regeneration. Per-row generation lets you repair the smallest failing scope (rule: "Repair the failed row, not the whole sheet"; escalation ladder is single frame → one row → full atlas only if identity is broadly broken).
- The generated strip is treated as *approximate*: exact geometry is always re-derived by local slicing code.

### 3.3 Frame-to-frame and row-to-row consistency: the three locks

1. **Canonical base image (identity lock).** First generate ONE full-body reference sprite of the subject on a flat chroma background (this is the only prompt-only job). Save it as `references/canonical-base.png`. Every subsequent row job attaches this base as an input image to the edits endpoint ("canonical identity reference"). Rule from the skill: "Treat any row generation without attached grounding images as invalid."
2. **Layout guide image (geometry lock).** For each row, programmatically draw (PIL) a guide image: N cells of 192x208, `#f7f7f7` background, 2px black cell borders, an inner blue "safe area" rectangle (18px horizontal / 16px vertical margins), and dashed gray center crosshairs per cell. Attach it to the row job with the role "layout guide for N frame slots; use for spacing only, do not copy guide lines". The prompt says to use it "only for slot count, spacing, centering, and padding; do not draw the guide." This is how you get exactly N evenly spaced, non-overlapping, unclipped poses. (See `prepare_pet_run.py::create_layout_guide`.)
3. **Prompt-level identity restatement.** Every row prompt re-lists the identity invariants verbatim ("Preserve silhouette, face, proportions, markings, palette, material, style, and props") plus the animation-continuity constraint ("keep apparent scale and baseline stable within the row... Move the pose within the slot instead of redrawing the subject larger or smaller frame to frame"). Repeating invariants every call is a general imagegen best practice ("For edits, repeat invariants every iteration to reduce drift").

Job-dependency ordering (from `imagegen-jobs.json` produced by `prepare_pet_run.py`): `base` first → then `idle` + `move-right` as the **identity and gait check** → only after those look right, the remaining rows (parallelizable). `move-left` may be **derived deterministically** by mirroring `move-right` (see §5), never generated speculatively before `move-right` is approved.

### 3.4 Chroma key instead of native transparency

Frames need transparent backgrounds but the best model (`gpt-image-2`) doesn't support `background=transparent`. So:

- Generate everything on a **perfectly flat solid chroma-key color**, then remove it locally.
- **Choose a key color absent from the subject.** Default `#00ff00`; use `#ff00ff` for green subjects. hatch-pet automates this: it samples pixels from the reference images and scores candidate keys (`magenta #FF00FF, cyan #00FFFF, yellow #FFFF00, blue #0000FF, orange #FF7F00, green #00FF00`) by the 1st-percentile color distance to subject pixels, picking the farthest — i.e. the key least likely to eat the sprite. Store the chosen key in the run manifest and use the *same key for every row*.
- Prompt must forbid the key color inside the subject ("Keep #00ff00 and close colors out of the subject, props, highlights, and effects").
- Alternative when you truly need model-native alpha: `gpt-image-1.5 --background transparent --output-format png` (treated as a downgrade path in the source; use for complex edges — but game sprites with crisp edges chroma-key fine).

### 3.5 Slicing the strip into frames (`extract_strip_frames.py`)

Three extraction methods, in preference order:

1. **`components` (default via `auto`)**: chroma-key the strip to RGBA (Euclidean RGB distance to key <= threshold 96 → fully transparent), then find **connected alpha components** (flood fill on alpha > 16). Take the N largest components as frame seeds (seed threshold: >= max(120 px, 20% of largest component's area)), sort by center-x, and attach small satellite components (attached effects, etc.; noise floor max(12, 0.2% of largest)) to the nearest seed. Each group is cropped with 4px padding, then **fit to the 192x208 cell**: scale down (never up) to fit within cell minus 10px, centered. This tolerates uneven spacing in the generated strip.
2. **`slots`**: fallback — cut the strip into N equal-width vertical slices and fit each to the cell. Used when component detection can't find N sprites (e.g. touching poses).
3. **`stable-slots`**: a deliberate QA correction, not the default. Per-frame fit-to-cell causes "size popping" / baseline jumps in playback when frame bounding boxes differ (a crouched frame gets scaled bigger than a stretched one). `stable-slots` computes one **shared viewport** across the whole row (shared top/bottom, max component width) and scales every frame by the same factor, preserving relative scale and baseline. Use when previews pop but the source strip itself was stable.

A `frames-manifest.json` records which method each row used, so validation can flag slot-fallback rows for visual inspection.

## 4. Prompt patterns (generalized, key language verbatim)

### 4.1 Base/reference sprite prompt (from `prepare_pet_run.py::base_pet_prompt`, generalized)

```text
Create one clean full-body reference sprite for <SubjectName>.

Subject identity: <one-sentence stable description, e.g. "a compact quad-rotor scout drone with a single cyclopean lens">.
Style: <style contract, see below>

Place a single centered pose on a perfectly flat pure <key-name> <#RRGGBB> chroma-key background.
Keep the full subject visible, compact, readable at 192x208, and easy to animate.
No scenery, text, borders, checkerboard transparency, shadows, glows, detached effects, or extra props.
Keep <#RRGGBB> and close colors out of the subject, props, highlights, and effects.
```

Why each clause matters:
- "**perfectly flat pure ... chroma-key background**" — any gradient/shadow breaks distance-threshold keying.
- "**single centered pose**", "**full subject visible**" — prevents crops and multi-subject sheets.
- "**readable at 192x208, easy to animate**" — biases toward chunky silhouettes that survive downscaling.
- "**no checkerboard transparency**" — models otherwise literally paint the Photoshop checkerboard.
- "**Keep <key> ... out of the subject**" — otherwise keying punches holes in the sprite.

The transparent-cutout phrasing from Source A (use for any one-off transparent asset):

```text
Create the requested subject on a perfectly flat solid #00ff00 chroma-key background for background removal.
The background must be one uniform color with no shadows, gradients, texture, reflections, floor plane, or lighting variation.
Keep the subject fully separated from the background with crisp edges and generous padding.
Do not use #00ff00 anywhere in the subject.
No cast shadow, no contact shadow, no reflection, no watermark, and no text unless explicitly requested.
```

### 4.2 Row-strip prompt template (from `row_prompt`, generalized — this is the core animation prompt)

Send to the **edits endpoint** with the canonical base + layout guide attached:

```text
Create one horizontal animation strip for <subject-id>, state `<state>`.

Use the attached canonical base for identity. Use the attached layout guide only for slot
count, spacing, centering, and padding; do not draw the guide.

Output exactly <N> full-body frames in one left-to-right row on flat pure <key-name> <#RRGGBB>.
Treat the row as <N> invisible equal-width slots: one centered complete pose per slot, evenly
spaced, with no overlap, clipping, empty slots, labels, or borders.

Identity: same subject in every frame: <subject description>. Preserve silhouette, face,
proportions, markings, palette, material, style, and props.
Style: <style contract>
Animation continuity: keep apparent subject scale and baseline stable within the row unless the
state itself intentionally changes vertical position, such as `jumping`. Move the pose within
the slot instead of redrawing the subject larger or smaller frame to frame.

State action: <one-sentence action description>

State requirements:
- <bullet list of state-specific dos/don'ts>

Clean extraction: crisp opaque edges, safe padding, no scenery, text, guide marks, checkerboard,
shadows, glows, motion blur, speed lines, dust, detached effects, stray pixels, or chroma-key
colors inside the subject.
```

Load-bearing phrases:
- "**exactly N full-body frames in one left-to-right row**" + "**N invisible equal-width slots: one centered complete pose per slot**" — enforces countable, sliceable frames; "invisible slots" stops the model drawing grid lines.
- "**same subject in every frame ... Preserve silhouette, face, proportions, markings, palette, material, style, and props**" — the anti-drift identity lock.
- "**keep apparent subject scale and baseline stable within the row ... Move the pose within the slot instead of redrawing the subject larger or smaller**" — prevents size popping at playback.
- The "**Clean extraction**" negative list — every listed artifact (motion blur, speed lines, dust, shadows, glows, detached sparkles) is something that either survives keying as garbage pixels or becomes a stray connected component that breaks component slicing.
- "**do not draw the guide**" — layout guides are construction references; copied guide pixels = failed row.

### 4.3 Per-state action prompts (verbatim from `STATE_PROMPTS`, trivially re-themable)

- idle: "Calm low-distraction resting loop: subtle breathing, tiny blink, slight head/body bob, and only quiet persona-preserving motion."
- running-right/-left: "Dragging-right loop: show directional movement to the right through body and limb poses only." (mirror for left)
- waving: "Greeting loop: paw or limb down, raised, tilted, and returning in a friendly attention gesture."
- jumping: "Hover jump loop: anticipation, lift, airborne peak, descent, and settle through body height."
- failed: "Blocked/failed loop: slumped or deflated reaction with sad or closed eyes."
- waiting: "Needs-input loop: expectant asking pose."
- running (working): "Working loop: focused active-task processing ... not literal foot-running."
- review: "Ready-review loop: focused inspection ... with lean, blink, narrowed eyes, head tilt."

Useful state-requirement patterns worth copying for any subject:
- Idle: "The first and last frames should be very close visually so the loop feels calm and does not pop." / "do not repeat effectively identical copies across the loop" (loops must close AND actually animate).
- Directional movement: "The row must unmistakably face and travel right." / "The movement cadence must alternate visibly across the 8 frames instead of repeating one nearly static stride."
- Jump: "Show the jump through pose and vertical body position only" — no ground shadows/dust/landing marks (they key badly).
- Effects (e.g. an explosion attached to a hit enemy): allowed only if "attached to or overlapping the subject silhouette and kept inside the same frame slot", opaque, hard-edged, non-key-colored. Forbidden by default: motion arcs, speed lines, afterimages, blur, detached stars/sparkles/smoke, cast/contact/drop shadows, glow, halo, soft transparent effects.

There's also a compacted **retry prompt** variant per row (same constraints, shorter) generated up front; used once if the API returns a transport-level Bad Request.

### 4.4 Style contracts

Prefix every prompt's style with a "sprite-safe" contract, then a preset. Verbatim base (generalized):

> "Sprite-safe: compact full-body subject, readable in a 192x208 cell, clear silhouette, simple face/front, stable palette/materials, and crisp edges for chroma-key extraction."

Presets from the source (pick one, keep it identical across ALL rows): `pixel` ("Pixel-art-adjacent digital mascot with a chunky silhouette, simple dark outline, limited palette, flat cel shading, and visible stepped edges"), `flat-vector`, `sticker`, `clay`, `plush`, `3d-toy`, `painterly`, `brand-inspired`, or `auto` (infer from references and "keep that exact style consistent across every row").

### 4.5 Character-consistency edit pattern (Source A, for one-off extra poses)

```text
Use case: identity-preserve
Input images: Image 1: previous character anchor illustration
Primary request: continue with the same character in a new scene and action
Constraints: do not redesign the character; preserve facial features, proportions, outfit,
color palette, and personality; no text; no watermark
```

Label every input image by index and role in the prompt (`Image 1: canonical identity reference`, `Image 2: layout guide`); image order is meaningful.

## 5. Post-processing pipeline (all Python/PIL, all deterministic)

Order of operations (from hatch-pet's Default Workflow):

1. **Chroma removal + slicing** — `extract_strip_frames.py` (see §3.5). Simple hard keying: Euclidean RGB distance to key <= 96 → pixel becomes `(0,0,0,0)`. For higher-fidelity one-off cutouts, Source A's `remove_chroma_key.py` is more sophisticated: `--auto-key border|corners` (samples median border color instead of assuming the exact hex — robust to slight tinting by the model), `--soft-matte` (smoothstep alpha ramp between `--transparent-threshold 12` and `--opaque-threshold 220` for antialiased edges), `--despill` (clamps key-channel spill on edge pixels), `--edge-contract 1` (MinFilter erosion for lingering fringe), `--edge-feather 0.25` (Gaussian alpha blur, only for stair-stepped edges). Recommended invocation:
   ```bash
   python remove_chroma_key.py --input src.png --out final.png \
     --auto-key border --soft-matte --transparent-threshold 12 --opaque-threshold 220 --despill
   ```
   For flat pixel-art, plain hard tolerance keying is fine ("hard tolerance-only removal is mainly for flat pixel-art").
2. **Frame inspection** — `inspect_frames.py` writes `qa/review.json` (see §6).
3. **Mirroring (optional deterministic derivation)** — `derive_running_left_from_running_right.py`: the ONLY row derived rather than generated. Crucial detail: it mirrors **each frame slot in place** (`ImageOps.mirror` per slot, composited back at the same x) so temporal frame order is preserved — mirroring the whole strip would reverse the animation. Gate it behind explicit visual approval (`--confirm-appropriate-mirror --decision-note "..."`) because mirroring flips asymmetric props/markings/text. States with distinct semantics must never be derived from each other.
4. **Atlas composition** — `compose_atlas.py`: creates a transparent 1536x1872 RGBA canvas, pastes each row's frames centered into their cells (thumbnail-downscale if oversized), then **zeroes RGB on all fully transparent pixels** (`clear_transparent_rgb`) so no hidden color residue survives, and saves PNG plus **lossless WebP** (`lossless=True, quality=100, method=6, exact=True` — `exact=True` preserves RGB of transparent pixels through WebP encoding).
5. **Validation** — `validate_atlas.py` (see §6).
6. **Contact sheet** — `make_contact_sheet.py`: scales atlas 0.5x, renders every cell over a drawn checkerboard (so transparency is visible), labels each row with name + frame count and outlines used cells green / unused red. This is the single image a human (or VLM) reviews.
7. **Motion previews** — `render_animation_previews.py`: per-row animated GIF from the sliced frames using the exact per-frame durations table, `loop=0, disposal=2` (disposal=2 = restore-to-background, required for transparent GIFs so frames don't stack). These previews are how size popping, wrong facing, reversed cadence, and inert idle loops get caught.
8. **Packaging** — copy `spritesheet.webp` plus a small JSON manifest (`{id, displayName, description, spritesheetPath}`) into the install folder. The consuming app animates via CSS background-position over the fixed grid — equally applicable to any engine that takes (sheet, cellW, cellH, row, frameCount, durations).

## 6. Validation, QA, and retries

Three layers — deterministic checks, targeted retries, and visual QA — with the explicit rule that "deterministic validation is necessary but not sufficient."

**Deterministic per-frame checks (`inspect_frames.py`):**
- exact frame count per row; every frame exactly 192x208
- non-transparent pixel count >= 400 (empty/sparse frame ⇒ error)
- edge check: > 24 non-transparent pixels within 2 px of the cell border ⇒ warning (likely clipped pose)
- chroma-adjacent check: > 800 visible pixels within color distance 150 of the key ⇒ error (keying failure / spill)
- size-outlier check vs row median area: < 0.35x or > 2.75x ⇒ warning (size popping / wrong subject)
- `--require-components`: fail rows that fell back to slot slicing (unless `--allow-stable-slots` after visual review)

**Deterministic atlas checks (`validate_atlas.py`):**
- exact 1536x1872, PNG/WebP, has alpha, not fully opaque
- every used cell >= 50 non-transparent pixels; **every unused cell has exactly 0**
- used cell > 95% opaque ⇒ error "usually means the sprite has a non-transparent background"
- zero fully-transparent pixels with non-zero RGB residue

**API-level retries:** transient errors (429/timeout) retried with exponential backoff capped at 60s, honoring Retry-After (`image_gen.py`). Transport-level Bad Request on a row ⇒ retry once with the pre-generated compact retry prompt, same attached images; if it fails again, stop and report rather than silently switching models.

**Visual QA (a human or a vision-model pass over contact sheet + preview GIFs):** block acceptance if any row changes body type, face, markings, palette, material, prop design, style, or silhouette; or shows missing/blank frames, copied guide marks, white/opaque cell backgrounds, cropped bodies, slot overlap, detached effects, shadows/glows/smears/dust, chroma artifacts, motion not matching the state, unintended size popping, wrong facing direction, reversed/non-alternating gait, or an "effectively static" idle loop. QA workers return a compact verdict (`visual_qa=pass|fail`, `repair_rows=...`, `repair_notes=...`).

**Repair policy:** regenerate the smallest failing scope — single frame → one row → full atlas only when identity is broadly broken. For identity repairs, re-ground on the canonical base + the specific failure note. For extraction-induced popping, don't regenerate — re-slice with `stable-slots` first.

## 7. Pitfalls and tips (as noted in the sources)

- **Models paint transparency literally.** Never ask for "transparent background" from `gpt-image-2` — you'll get a checkerboard. Always chroma-key.
- **Key-color collision** eats the sprite. Pick the key farthest from the subject's palette (auto-score against reference pixels if possible); rule: "The chroma key must be visually absent from the character. If extraction removes character regions, choose a different key and regenerate."
- **Shadows/gradients under the subject** become darker key-colored patches that survive keying as gray blobs — explicitly forbid cast/contact/floor shadows in every prompt.
- **Soft effects (blur, glow, speed lines, smoke) key terribly** and create stray connected components that break slicing. Show motion through *pose only*; allow effects only when opaque, hard-edged, and attached to the silhouette.
- **Size popping**: per-frame tight-crop-and-scale normalizes away intentional size differences and amplifies unintentional ones. Prompt for stable in-row scale/baseline; fix residual popping with shared-viewport (`stable-slots`) slicing, not regeneration.
- **Mirroring reverses time** if done on the whole strip — mirror per-slot in place. And mirroring flips asymmetric details, so gate it on visual approval.
- **Identity drift compounds**: always regenerate rows from the same canonical base, never from another generated row; re-state invariants in every prompt.
- **Trap detections**: reject sheets where "every used frame is just the reference image with small geometric transforms" (fake animation), contact sheets showing "cropped tiles from a larger reference image", or repeated identical idle frames (inert loop).
- **`n` is for variants of one prompt, not distinct assets** — each animation row is its own call/job.
- Lossless WebP with `exact=True` (or PNG) for the final sheet; lossy encoding smears alpha edges and reintroduces RGB residue.
- Square-ish sizes generate fastest; draft at `quality=low`, finalize at `medium`/`high`.
- Zero the RGB of fully transparent pixels before shipping — some renderers bleed hidden RGB at bilinear-filtered edges.
- Prompt loops to close: "first and last frames should be very close visually so the loop does not pop."
- Keep the model out of geometry: generated pixels are creative input; all measurements (cell size, spacing, atlas layout) come from local code.

## 8. End-to-end recipe: "animated sprite of X" → usable frames

Assume: subject X (e.g. "a small hostile battle drone"), style `pixel`, states `idle` (4 frames), `fly-right` (6), `fly-left` (6, mirrored), `explode` (6, non-looping). `OPENAI_API_KEY` set; `pip install openai pillow`.

1. **Pick a chroma key** not in X's palette (drone is gunmetal/red → use `#00FF00`).
2. **Generate the canonical base** (generations endpoint, prompt from §4.1). Draft at `quality=low`, redo the winner at `medium/high`. Save as `base.png`. Eyeball it: centered, full body, flat key background, no shadow.
3. **Draw layout guides** per state with PIL (§3.3, item 2): N bordered cells + safe-area boxes + center crosshairs on light gray.
4. **Generate each row strip** via the *edits* endpoint, attaching `base.png` + that state's guide, with the §4.2 prompt (exact frame count, invisible slots, identity-preserve list, stable scale/baseline, state action, clean-extraction negative list). One call per state; retry once on Bad Request with a compacted prompt.
5. **Mirror** `fly-left` from an approved `fly-right` per-slot (preserving frame order), or generate it normally if the drone is asymmetric.
6. **Slice**: chroma-key each strip (distance threshold ~96), connected-component grouping → N frames → fit each into the cell (use shared-viewport mode if playback pops).
7. **Inspect** frames programmatically (counts, sparseness, edge clipping, chroma residue, size outliers), then **assemble** the atlas (or export loose frames / per-row strips for your engine), zeroing RGB under transparent pixels; save PNG + lossless WebP.
8. **Preview**: build per-state GIFs with your duration tables; view a checkerboard contact sheet. Reject and regenerate individual bad rows only.
9. **Ship** to the engine: fixed cell size + row/frame-count/durations table (e.g. the §3.1 table) is all any 2D engine (or CSS background-position animation) needs.

### Minimal adapted script (condensed from `image_gen.py` + hatch-pet scripts)

```python
#!/usr/bin/env python3
"""Animated sprite of SUBJECT via gpt-image-2: base -> strips -> frames -> GIF."""
import base64, math
from pathlib import Path
from openai import OpenAI
from PIL import Image, ImageDraw

SUBJECT = "a compact hostile battle drone with twin rotors and a single red sensor eye"
STYLE = ("Sprite-safe: compact full-body subject, readable in a 192x208 cell, clear "
         "silhouette, stable palette, crisp edges for chroma-key extraction. Style `pixel`: "
         "chunky silhouette, simple dark outline, limited palette, flat cel shading.")
KEY, KEY_NAME = "#00FF00", "green"
CELL_W, CELL_H = 192, 208
STATES = {  # state: (frames, action, durations_ms)
    "idle":      (4, "Calm hover loop: subtle bobbing and rotor spin only; first and last "
                     "frames nearly identical so the loop does not pop.", [180,140,140,220]),
    "fly-right": (6, "Flight to the right shown through body tilt and rotor pose only; must "
                     "unmistakably face and travel right; cadence must vary across frames.",
                  [120]*5+[200]),
    "explode":   (6, "Destruction sequence: impact, break-apart, opaque hard-edged flame burst "
                     "attached to the hull, debris shrinking, near-empty final frame.",
                  [90]*5+[160]),
}
OUT = Path("out"); OUT.mkdir(exist_ok=True)
client = OpenAI()

def gen(prompt, out, images=None, size="1024x1024", quality="medium"):
    kw = dict(model="gpt-image-2", prompt=prompt, size=size, quality=quality, output_format="png")
    if images:
        handles = [open(p, "rb") for p in images]
        try: r = client.images.edit(image=handles, **kw)
        finally: [h.close() for h in handles]
    else:
        r = client.images.generate(**kw)
    out.write_bytes(base64.b64decode(r.data[0].b64_json)); return out

def layout_guide(n, out):
    img = Image.new("RGB", (n*CELL_W, CELL_H), "#f7f7f7"); d = ImageDraw.Draw(img)
    for i in range(n):
        x = i*CELL_W
        d.rectangle((x, 0, x+CELL_W-1, CELL_H-1), outline="#111111", width=2)
        d.rectangle((x+18, 16, x+CELL_W-19, CELL_H-17), outline="#2f80ed", width=2)
    img.save(out); return out

def key_out(strip_png, threshold=96):
    kr, kg, kb = (int(KEY[i:i+2], 16) for i in (1, 3, 5))
    img = Image.open(strip_png).convert("RGBA"); px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if math.dist((r, g, b), (kr, kg, kb)) <= threshold: px[x, y] = (0, 0, 0, 0)
    return img

def slice_strip(strip, n):  # equal slots; swap in component grouping for uneven spacing
    frames, sw = [], strip.width / n
    for i in range(n):
        crop = strip.crop((round(i*sw), 0, round((i+1)*sw), strip.height))
        cell = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
        bbox = crop.getbbox()
        if bbox:
            s = crop.crop(bbox)
            sc = min((CELL_W-10)/s.width, (CELL_H-10)/s.height, 1.0)
            if sc < 1.0: s = s.resize((round(s.width*sc), round(s.height*sc)), Image.LANCZOS)
            cell.alpha_composite(s, ((CELL_W-s.width)//2, (CELL_H-s.height)//2))
        frames.append(cell)
    return frames

# 1) canonical base (identity lock)
base = gen(
    f"Create one clean full-body reference sprite of {SUBJECT}.\nStyle: {STYLE}\n"
    f"Place a single centered pose on a perfectly flat pure {KEY_NAME} {KEY} chroma-key "
    f"background. Keep the full subject visible, compact, readable at {CELL_W}x{CELL_H}, and "
    f"easy to animate. No scenery, text, borders, checkerboard transparency, shadows, glows, "
    f"or detached effects. Keep {KEY} and close colors out of the subject.",
    OUT / "base.png")

# 2) one strip per state, grounded on base + layout guide
for state, (n, action, durs) in STATES.items():
    guide = layout_guide(n, OUT / f"guide-{state}.png")
    gen(
        f"Create one horizontal animation strip for this subject, state `{state}`.\n"
        f"Use the attached canonical base for identity. Use the attached layout guide only for "
        f"slot count, spacing, centering, and padding; do not draw the guide.\n"
        f"Output exactly {n} full-body frames in one left-to-right row on flat pure "
        f"{KEY_NAME} {KEY}. Treat the row as {n} invisible equal-width slots: one centered "
        f"complete pose per slot, evenly spaced, no overlap, clipping, empty slots, labels, or "
        f"borders.\nIdentity: same subject in every frame: {SUBJECT}. Preserve silhouette, "
        f"proportions, markings, palette, material, style, and props.\nStyle: {STYLE}\n"
        f"Animation continuity: keep apparent scale and baseline stable within the row; move "
        f"the pose within the slot instead of redrawing the subject larger or smaller.\n"
        f"State action: {action}\n"
        f"Clean extraction: crisp opaque edges, safe padding, no scenery, text, guide marks, "
        f"checkerboard, shadows, glows, motion blur, speed lines, dust, detached effects, "
        f"stray pixels, or chroma-key colors inside the subject.",
        OUT / f"strip-{state}.png", images=[base, guide], size="1536x1024", quality="high")

    frames = slice_strip(key_out(OUT / f"strip-{state}.png"), n)
    fdir = OUT / "frames" / state; fdir.mkdir(parents=True, exist_ok=True)
    for i, f in enumerate(frames):
        assert sum(f.getchannel("A").histogram()[1:]) >= 400, f"{state} frame {i} empty"
        f.save(fdir / f"{i:02d}.png")
    frames[0].save(OUT / f"preview-{state}.gif", save_all=True, append_images=frames[1:],
                   duration=durs, loop=0, disposal=2)
print("Review the preview GIFs; regenerate only bad rows.")
```

To also emit an engine sprite sheet: paste `frames/<state>/*.png` row-by-row onto a transparent `(max_frames*CELL_W) x (len(STATES)*CELL_H)` RGBA canvas, zero RGB on transparent pixels, and save PNG + WebP (`lossless=True, exact=True`).

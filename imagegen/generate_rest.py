#!/usr/bin/env python3
"""Generate everything still missing from the blue sprite set.

Eleven independent chains run in parallel; steps inside a chain are
sequential because later steps attach an earlier result via images/edits
(damage states, scrap depletion). Terrain tiles and the app icon are
generated FULL-BLEED (no magenta) — tiles must reach the frame edges and
the icon has its own dark background.

Usage: OPENAI_API_KEY=... python3 generate_rest.py
Writes: output/<name>-raw.png for each step name
"""

import base64
import os
import sys
import time
import io
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

OUT = Path(__file__).parent / "output"
MODELS = ["gpt-image-2", "gpt-image-1.5", "gpt-image-1"]
SIZE = "1024x1024"
QUALITY = "high"

STYLE = """\
Style: retro 16-bit pixel-art, crisp hard-edged clusters of large square
pixels, flat shading, no outlines, no anti-aliasing look. The entire
background is one perfectly flat, uniform, pure magenta (#FF00FF)
everywhere. No gradients, no glow, no soft edges, no drop shadows, no
ground, no grid lines, no borders, no text, no labels, no watermarks.
"""

TILE_STYLE = """\
Style: retro 16-bit pixel-art texture, crisp hard-edged square pixel
clusters, flat overhead lighting, muted palette. The texture fills the
ENTIRE image edge to edge and is seamlessly tileable: features run off
every edge and wrap, no border, no vignette, no framing, no darkened
corners, no text, no watermarks.
"""

# Each chain: list of steps; a step with "attach" uses images/edits with
# the named earlier step's output as the anchor image.
CHAINS = [
    [dict(name="scout", prompt=f"""\
A single retro 16-bit pixel-art sprite of a tiny fragile reconnaissance
quadcopter drone for a top-down 2D real-time strategy game, viewed
directly from above, front pointing straight up (north). A minimal
X-shaped frame of four thin grey arms with a small rotor ring at each
corner, and one big round blue sensor-eye lens dominating the tiny
central body. Light, cheap and flimsy-looking — the smallest drone in
the army. The drone is centered and fills most of the canvas.

{STYLE}""")],
    [dict(name="turret-head", prompt=f"""\
A single retro 16-bit pixel-art sprite of the rotating HEAD of an
automated defense turret for a top-down 2D game, viewed directly from
above, pointing straight up (north). A compact round armored gun housing
with a blue center, and TWO long parallel gun barrels extending straight
up (north) from the housing, with dark muzzle tips. No base platform, no
ground — the head only, as it sits on a separate mount. Centered,
filling most of the canvas vertically.

{STYLE}""")],
    [dict(name="turret-base", prompt=f"""\
A single retro 16-bit pixel-art sprite of a static circular defense
turret base platform for a top-down 2D game, viewed directly from above.
A round armored mounting platform: dark grey outer ring with visible
bolts, lighter grey center plate, and a thin blue faction accent ring.
Completely flat, no gun, no turret head — just the empty mount platform.
Centered, filling most of the canvas.

{STYLE}""")],
    [dict(name="muzzle", prompt=f"""\
A single retro 16-bit pixel-art muzzle-flash sprite for a top-down 2D
game: a small bright four-pointed star burst of white-hot yellow flame,
brightest at the center, drawn with flat hard-edged pixel clusters.
Centered, compact, occupying about half the canvas.

{STYLE}""")],
    [dict(name="bolt", prompt=f"""\
A single retro 16-bit pixel-art projectile sprite for a top-down 2D
game: a narrow elongated energy bolt pointing straight up (north) — a
vertical plasma dart with a bright white-hot core and cyan-blue edges,
drawn with flat hard-edged pixel clusters, clearly longer than it is
wide, tapered at the top. Centered vertically and horizontally.

{STYLE}""")],
    [dict(name="tile-ground", prompt=f"""\
A seamless tileable top-down pixel-art terrain texture of dry cracked
wasteland dirt: uniform brown-grey packed earth with subtle darker
cracks, small pebbles and faint tonal variation. Calm and low-contrast —
this is background filler terrain that units drive over.

{TILE_STYLE}""")],
    [dict(name="tile-rock", prompt=f"""\
A seamless tileable top-down pixel-art terrain texture of impassable
rocky ground: large chunky grey boulders and rock outcrops tightly
covering dry brown dirt, with clear highlights and shadows so the rocks
read as tall solid obstacles vehicles cannot cross.

{TILE_STYLE}""")],
    [
        dict(name="tile-scrap-full", prompt=f"""\
A seamless tileable top-down pixel-art terrain texture: a dense pile of
salvageable teal-green scrap metal (broken plates, gears, twisted
fragments, a few pale highlights) generously covering dry brown dirt
ground.

{TILE_STYLE}"""),
        dict(name="tile-scrap-half", attach="tile-scrap-full", prompt=f"""\
Edit this top-down pixel-art scrap-field texture: remove about HALF of
the teal scrap metal pieces, leaving the remaining pieces exactly where
they are and exposing patches of the same dry brown dirt ground between
them. Same palette, same lighting, still edge-to-edge and tileable.

{TILE_STYLE}"""),
        dict(name="tile-scrap-empty", attach="tile-scrap-half", prompt=f"""\
Edit this top-down pixel-art scrap-field texture: remove almost ALL of
the remaining teal scrap metal, leaving bare dry brown dirt with only a
few tiny scattered teal flecks and faint dark stains where the piles
used to be. Same palette, same lighting, still edge-to-edge and
tileable.

{TILE_STYLE}"""),
    ],
    [
        dict(name="fab-idle", prompt=f"""\
A single retro 16-bit pixel-art sprite of an industrial drone
fabrication plant building for a top-down 2D real-time strategy game,
viewed directly from above (pure top-down plan view). A square factory
building filling most of the canvas: grey armored walls, a roof of three
parallel ridged panel rows, a bright blue faction accent stripe along
the north roof edge, a large dark vehicle assembly door on the south
side with a yellow hazard strip, vents and small greebles.

{STYLE}"""),
        dict(name="fab-damaged", attach="fab-idle", prompt=f"""\
Edit this top-down pixel-art factory building sprite: show the SAME
building heavily battle-damaged at half health. Keep the identical
viewpoint, scale, position, silhouette, footprint and palette. Add dark
cracks across the roof panels, one large black scorch mark, a few bent
and broken roof ridges showing dark interior. No flames, no smoke, no
debris outside the footprint.

{STYLE}"""),
        dict(name="fab-rubble", attach="fab-idle", prompt=f"""\
Edit this top-down pixel-art factory building sprite: show the SAME
building completely destroyed — a collapsed ruin of broken grey concrete
chunks, twisted roof panels and girders, all contained inside the
original square footprint. Almost no faction color left. No fire, no
smoke.

{STYLE}"""),
    ],
    [
        dict(name="airpad-idle", prompt=f"""\
A single retro 16-bit pixel-art sprite of a drone landing pad building
for a top-down 2D real-time strategy game, viewed directly from above.
A flat square dark-tarmac platform filling most of the canvas, with a
thick bright blue circular landing ring painted in the center, a small
white drone glyph in the middle of the ring, thin armored grey edges,
and small yellow corner marker lights. Mostly flat and open — aircraft
land on it.

{STYLE}"""),
        dict(name="airpad-damaged", attach="airpad-idle", prompt=f"""\
Edit this top-down pixel-art landing pad sprite: show the SAME pad
heavily battle-damaged at half health. Keep the identical viewpoint,
scale, position, silhouette, footprint and palette. Add dark cracks
across the tarmac, one black scorch mark, chipped paint on the landing
ring, one broken corner light. No flames, no smoke, no debris outside
the footprint.

{STYLE}"""),
        dict(name="airpad-rubble", attach="airpad-idle", prompt=f"""\
Edit this top-down pixel-art landing pad sprite: show the SAME pad
completely destroyed — the tarmac shattered into broken slabs and
craters, the landing ring barely recognizable in fragments, debris all
contained inside the original square footprint. Almost no faction color
left. No fire, no smoke.

{STYLE}"""),
    ],
    [dict(name="icon", prompt="""\
A square app icon for a retro pixel-art real-time strategy game called
Battle Drones. Very dark navy-blue background filling the whole square
edge to edge. Centered in the middle 80% of the canvas: a bold stylized
bright-blue quadcopter battle drone seen from directly above — round
core with a lens, four arms with rotor rings — inside a thin blue ring.
Retro 16-bit pixel-art style, flat shading, hard-edged square pixel
clusters, high contrast, instantly readable at small sizes. No text, no
letters, no border, no vignette, no watermarks.""")],
]


def call(step: dict) -> bytes:
    key = os.environ["OPENAI_API_KEY"]
    last_err = None
    for model in MODELS:
        for attempt in range(3):
            if "attach" in step:
                anchor = (OUT / f"{step['attach']}-raw.png").read_bytes()
                resp = requests.post(
                    "https://api.openai.com/v1/images/edits",
                    headers={"Authorization": f"Bearer {key}"},
                    data={"model": model, "prompt": step["prompt"], "size": SIZE,
                          "quality": QUALITY, "n": 1},
                    files={"image": ("anchor.png", io.BytesIO(anchor), "image/png")},
                    timeout=300,
                )
            else:
                resp = requests.post(
                    "https://api.openai.com/v1/images/generations",
                    headers={"Authorization": f"Bearer {key}"},
                    json={"model": model, "prompt": step["prompt"], "size": SIZE,
                          "quality": QUALITY, "n": 1, "output_format": "png"},
                    timeout=300,
                )
            if resp.status_code == 200:
                return base64.b64decode(resp.json()["data"][0]["b64_json"])
            last_err = f"HTTP {resp.status_code}: {resp.text[:300]}"
            if resp.status_code in (400, 403, 404):
                break
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f"{step['name']}: {last_err}")


def run_chain(chain: list) -> str:
    done = []
    for step in chain:
        target = OUT / f"{step['name']}-raw.png"
        png = call(step)
        target.write_bytes(png)
        done.append(step["name"])
    return "ok: " + ", ".join(done)


def main() -> None:
    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY is not set")
    OUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=len(CHAINS)) as pool:
        futures = [pool.submit(run_chain, c) for c in CHAINS]
        failed = False
        for f in futures:
            try:
                print(f.result())
            except Exception as e:
                print(f"FAILED: {e}", file=sys.stderr)
                failed = True
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()

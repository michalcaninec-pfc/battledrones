#!/usr/bin/env python3
"""Generate the three HQ building states with the OpenAI image API.

Unlike the explosion (one grid image), this exercises identity anchoring:
  1. images/generations -> canonical idle HQ on flat magenta
  2. images/edits with the idle image attached -> damaged state
  3. images/edits with the idle image attached -> rubble state
The edits endpoint keeps silhouette/scale/position consistent across
states, which the ART.md contract requires (idle / damaged / rubble are
frames of one sheet).

Usage: OPENAI_API_KEY=... python3 generate_hq.py
Writes: output/hq-raw-{idle,damaged,rubble}.png
"""

import base64
import io
import os
import sys
import time
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
ground texture, no grid lines, no borders, no text, no labels, no
watermarks.
"""

IDLE_PROMPT = f"""\
A single retro 16-bit pixel-art sprite of a sci-fi drone-army command
headquarters building for a top-down 2D real-time strategy game, viewed
directly from above (pure top-down plan view, no perspective).

The building has a square footprint that fills most of the canvas with a
small margin on every side. Heavy armored grey metal plating with panel
lines, a large central glass-domed command center, bright blue faction
accent stripes and a blue banner strip along the north edge, a dark
vehicle bay door in the south-west corner, small yellow warning lights on
two corners, vents and greebles on the roof.

{STYLE}"""

DAMAGED_PROMPT = f"""\
Edit this top-down pixel-art headquarters building sprite: show the SAME
building heavily battle-damaged at half health. Keep the identical
viewpoint, scale, position, silhouette, footprint and color palette.

Add: dark cracks zig-zagging across the roof plating, two large black
scorch marks, a dented and partially shattered glass dome, a few broken
panels showing dark interior. Do NOT add flames, smoke plumes, or any
debris outside the building's original footprint.

{STYLE}"""

RUBBLE_PROMPT = f"""\
Edit this top-down pixel-art headquarters building sprite: show the SAME
building completely destroyed. Keep the identical viewpoint, scale and
position, and keep all debris inside the building's original square
footprint.

The building is now a collapsed ruin: a flattened pile of broken grey
concrete chunks, twisted metal plates and girders, with cracks and ash.
The dome is gone. Almost all faction color is gone — at most one or two
tiny faded blue fragments. No fire, no smoke, no embers.

{STYLE}"""


def _decode(resp):
    return base64.b64decode(resp.json()["data"][0]["b64_json"])


def post(url, *, data, files=None):
    key = os.environ["OPENAI_API_KEY"]
    last_err = None
    for model in MODELS:
        payload = dict(data, model=model)
        for attempt in range(3):
            if files:
                resp = requests.post(url, headers={"Authorization": f"Bearer {key}"},
                                     data=payload, files=files, timeout=300)
            else:
                resp = requests.post(url, headers={"Authorization": f"Bearer {key}"},
                                     json=payload, timeout=300)
            if resp.status_code == 200:
                print(f"ok with model={model}")
                return _decode(resp)
            last_err = f"{model}: HTTP {resp.status_code}: {resp.text[:400]}"
            if resp.status_code in (400, 403, 404):
                print(f"{model}: {resp.status_code}, trying next model", file=sys.stderr)
                break
            wait = 2 ** (attempt + 1)
            print(f"transient {resp.status_code}, retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"all models failed; last: {last_err}")


def main() -> None:
    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY is not set")
    OUT.mkdir(parents=True, exist_ok=True)

    print("generating idle HQ...")
    idle = post("https://api.openai.com/v1/images/generations",
                data={"prompt": IDLE_PROMPT, "size": SIZE, "quality": QUALITY,
                      "n": 1, "output_format": "png"})
    (OUT / "hq-raw-idle.png").write_bytes(idle)
    print("wrote hq-raw-idle.png")

    for state, prompt in [("damaged", DAMAGED_PROMPT), ("rubble", RUBBLE_PROMPT)]:
        print(f"editing idle -> {state}...")
        png = post("https://api.openai.com/v1/images/edits",
                   data={"prompt": prompt, "size": SIZE, "quality": QUALITY, "n": 1},
                   files={"image": ("idle.png", io.BytesIO(idle), "image/png")})
        (OUT / f"hq-raw-{state}.png").write_bytes(png)
        print(f"wrote hq-raw-{state}.png")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Generate the raw explosion sprite strip with the OpenAI image API.

Asks for a single image containing a 2x3 grid of 6 animation frames on a
flat magenta chroma-key background (the API's ~3:1 aspect limit rules out a
true 6x1 strip). Transparency is NOT requested from the model — the key
color is removed deterministically in process_explosion.py.

Usage: OPENAI_API_KEY=... python3 generate_explosion.py
Writes: output/explosion-raw.png
"""

import base64
import os
import sys
import time
from pathlib import Path

import requests

OUT = Path(__file__).parent / "output"

# Newest first; fall back if the account doesn't have access.
MODELS = ["gpt-image-2", "gpt-image-1.5", "gpt-image-1"]
SIZE = "1536x1024"  # 3 cols x 2 rows of 512x512 cells
QUALITY = "high"

PROMPT = """\
Retro 16-bit pixel-art sprite sheet of an explosion for a top-down 2D game.

Divide the image into an invisible grid of exactly 6 equal cells: 2 rows and
3 columns, each cell 512x512. Each cell contains exactly one animation frame
of the same explosion, centered in its cell and staying well inside the cell
edges. Frames read left to right, top to bottom.

Frame 1 (top-left): a small, bright yellow-white ignition burst.
Frame 2: an expanding orange fireball with a white-hot core and chunky
jagged flame edges.
Frame 3: the fireball at maximum size, deep orange and red with a smaller
yellow core, edges breaking into square flame chunks.
Frame 4: the fire collapsing and darkening to red, gaps opening up, first
puffs of dark grey smoke around it.
Frame 5: no more fire — a thick ring of medium grey smoke puffs.
Frame 6 (bottom-right): only a few thin light-grey smoke wisps, almost
fully dissipated.

Style for every frame: crisp hard-edged clusters of large square pixels,
flat shading, limited palette of yellows, oranges, reds and greys, no
outlines. The animation must read as one continuous explosion: each frame
is the same explosion a moment later, centered on the same point.

The entire background of the whole image is one perfectly flat, uniform,
pure magenta (#FF00FF) everywhere. No background variation, no gradients,
no glow, no soft edges, no motion blur, no drop shadows, no grid lines, no
cell borders, no frames, no text, no labels, no numbers, no watermarks.
"""


def generate(api_key: str) -> bytes:
    last_err = None
    for model in MODELS:
        for attempt in range(3):
            resp = requests.post(
                "https://api.openai.com/v1/images/generations",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": model,
                    "prompt": PROMPT,
                    "size": SIZE,
                    "quality": QUALITY,
                    "n": 1,
                    "output_format": "png",
                },
                timeout=300,
            )
            if resp.status_code == 200:
                print(f"generated with model={model}")
                return base64.b64decode(resp.json()["data"][0]["b64_json"])
            last_err = f"{model}: HTTP {resp.status_code}: {resp.text[:500]}"
            # Unknown model / no access -> try next model, don't retry this one.
            if resp.status_code in (400, 403, 404):
                print(f"{model} unavailable ({resp.status_code}), trying next", file=sys.stderr)
                break
            wait = 2 ** (attempt + 1)
            print(f"transient error ({resp.status_code}), retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"all models failed; last error: {last_err}")


def main() -> None:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is not set")
    OUT.mkdir(parents=True, exist_ok=True)
    png = generate(api_key)
    raw = OUT / "explosion-raw.png"
    raw.write_bytes(png)
    print(f"wrote {raw} ({len(png)} bytes)")


if __name__ == "__main__":
    main()

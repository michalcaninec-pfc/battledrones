#!/usr/bin/env python3
"""Generate the two harvester states (empty / loaded) with the OpenAI API.

Same identity-anchoring approach as the HQ: images/generations produces
the canonical North-facing empty harvester, then one images/edits call
with that image attached fills the cargo bay with scrap. The 8 rotation
frames per state are NOT generated — ART.md's direction convention is
pure rotation, so process_harvester.py derives them programmatically.

Usage: OPENAI_API_KEY=... python3 generate_harvester.py
Writes: output/harvester-raw-{empty,loaded}.png
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
ground, no grid lines, no borders, no text, no labels, no watermarks.
"""

EMPTY_PROMPT = f"""\
A single retro 16-bit pixel-art sprite of a chunky industrial scrap-hauler
drone vehicle for a top-down 2D real-time strategy game, viewed directly
from above (pure top-down plan view, no perspective), with the FRONT of
the vehicle pointing straight up (north).

The vehicle is a heavy tracked hauler: wide grey armored hull, two dark
caterpillar tracks running along the left and right sides, a bright blue
faction accent stripe across the cab at the front, a blue intake scoop at
the very front, and a large open-top rectangular cargo bay in the middle
of the hull that is EMPTY — its dark metal floor is visible. Small
industrial greebles: bolts, vents, hydraulics. The vehicle fills most of
the canvas with a margin on every side, longer than it is wide.

{STYLE}"""

LOADED_PROMPT = f"""\
Edit this top-down pixel-art hauler vehicle sprite: show the SAME vehicle
with its cargo bay now heaped full of salvaged scrap metal. Keep the
identical viewpoint, scale, position, orientation, silhouette, hull and
color palette. The ONLY change: the open cargo bay is filled with a pile
of chunky teal-green scrap metal pieces (broken plates, gears, twisted
fragments) with a few lighter highlights, heaped slightly above the bay
rim but never spilling outside the bay opening.

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

    print("generating empty harvester...")
    empty = post("https://api.openai.com/v1/images/generations",
                 data={"prompt": EMPTY_PROMPT, "size": SIZE, "quality": QUALITY,
                       "n": 1, "output_format": "png"})
    (OUT / "harvester-raw-empty.png").write_bytes(empty)
    print("wrote harvester-raw-empty.png")

    print("editing empty -> loaded...")
    loaded = post("https://api.openai.com/v1/images/edits",
                  data={"prompt": LOADED_PROMPT, "size": SIZE, "quality": QUALITY, "n": 1},
                  files={"image": ("empty.png", io.BytesIO(empty), "image/png")})
    (OUT / "harvester-raw-loaded.png").write_bytes(loaded)
    print("wrote harvester-raw-loaded.png")


if __name__ == "__main__":
    main()

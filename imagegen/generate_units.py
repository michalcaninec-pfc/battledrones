#!/usr/bin/env python3
"""Generate four single-state unit sprites concurrently.

Each unit is one images/generations call (no edits needed — single art
state, and the 8 direction frames are derived by rotation afterwards).
The four requests run in parallel since each call takes a while.

Usage: OPENAI_API_KEY=... python3 generate_units.py
Writes: output/{stinger,flak-crawler,wasp,raptor}-raw.png
"""

import base64
import os
import sys
import time
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

COMMON = """\
A single retro 16-bit pixel-art sprite of a {desc} for a top-down 2D
real-time strategy game, viewed directly from above (pure top-down plan
view, no perspective), with the FRONT pointing straight up (north). The
vehicle is centered and fills most of the canvas with a margin on every
side.

{detail}

"""

UNITS = {
    "stinger": dict(
        desc="cheap mass-produced tracked gun drone",
        detail="""\
Compact boxy grey armored hull, two dark caterpillar tracks running along
the left and right sides, a small central turret ring, and a single long
thin gun barrel extending forward past the front of the hull. A bright
blue faction accent stripe across the hull and a blue tip on the turret
ring. Simple and utilitarian — minimal greebles, a few bolts and vents.""",
    ),
    "flak-crawler": dict(
        desc="squat tracked anti-aircraft flak platform drone",
        detail="""\
Wide squat grey armored chassis, slightly wider than long, two chunky
dark caterpillar tracks along the sides, a central rotating mount with
TWO parallel anti-air gun barrels pointing forward, and a small round
yellow-ringed radar dish mounted beside the barrels. Bright blue faction
accent stripes on the hull corners. Industrial and heavy-looking.""",
    ),
    "wasp": dict(
        desc="aggressive dart-shaped aerial strike drone (flying, seen from above)",
        detail="""\
Narrow angular dart-shaped fuselage with a sharp pointed nose spike at
the front like a wasp's sting, painted bright blue at the tip. Swept
angular mid-body with a small dark cockpit sensor window, two small
rotor pods on short stub arms at the left and right with thin spinning
rotor rings, and a short tapered tail with blue faction accent fins.
Sleek, fast and menacing.""",
    ),
    "raptor": dict(
        desc="sleek air-superiority interceptor drone (flying, seen from above)",
        detail="""\
Arrowhead-shaped fuselage with strongly swept-back wings like a delta
fighter jet, a sharp nose, a blue faction accent chevron on the nose and
blue wingtip stripes, a small dark canopy sensor strip, a thin central
tail boom ending in two small rear rotor rings. Elegant and predatory —
the fastest-looking machine in the army.""",
    ),
}


def generate(name: str, cfg: dict) -> str:
    key = os.environ["OPENAI_API_KEY"]
    prompt = COMMON.format(**cfg) + STYLE
    last_err = None
    for model in MODELS:
        for attempt in range(3):
            resp = requests.post(
                "https://api.openai.com/v1/images/generations",
                headers={"Authorization": f"Bearer {key}"},
                json={"model": model, "prompt": prompt, "size": SIZE,
                      "quality": QUALITY, "n": 1, "output_format": "png"},
                timeout=300,
            )
            if resp.status_code == 200:
                png = base64.b64decode(resp.json()["data"][0]["b64_json"])
                (OUT / f"{name}-raw.png").write_bytes(png)
                return f"{name}: ok (model={model}, {len(png)} bytes)"
            last_err = f"HTTP {resp.status_code}: {resp.text[:300]}"
            if resp.status_code in (400, 403, 404):
                break
            time.sleep(2 ** (attempt + 1))
    return f"{name}: FAILED ({last_err})"


def main() -> None:
    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY is not set")
    OUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=len(UNITS)) as pool:
        results = list(pool.map(lambda kv: generate(*kv), UNITS.items()))
    ok = True
    for r in results:
        print(r)
        ok = ok and "FAILED" not in r
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()

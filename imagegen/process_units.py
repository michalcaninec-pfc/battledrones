#!/usr/bin/env python3
"""Turn the four raw unit generations into game-ready 256x32 sheets.

Per unit: chroma-key + despill, crop to content, derive the 8 direction
frames by high-res rotation (frame i faces i*45 degrees clockwise from
North), de-res each to 32x32 (premultiplied BOX downscale + hard alpha
threshold), and quantize the unit's 8 frames against one shared palette.
Content is scaled so its bbox diagonal stays under 30px — no clipping at
any rotation angle.

Usage: python3 process_units.py [unit ...]   (default: all four)
Reads:  output/<unit>-raw.png
Writes: output/unit-frames/<unit>.png (high-res transparent, North),
        output/<unit>.png (256x32 sheet), output/<unit>-preview.gif
"""

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).parent / "output"
ALL_UNITS = ["stinger", "flak-crawler", "wasp", "raptor"]
FRAME = 32
MAX_DIAG = 30.0

KEY = (255, 0, 255)
TOLERANCE = 120


def chroma_key(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    px = img.load()
    tol2 = TOLERANCE * TOLERANCE
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, _ = px[x, y]
            d2 = (r - KEY[0]) ** 2 + (g - KEY[1]) ** 2 + (b - KEY[2]) ** 2
            if d2 <= tol2 or (r > g + 30 and b > g + 30):
                px[x, y] = (0, 0, 0, 0)
    return img


def deres(img: Image.Image, size: tuple) -> Image.Image:
    a = np.asarray(img, dtype=np.float32)
    alpha = a[..., 3:4] / 255.0
    pre = np.concatenate([a[..., :3] * alpha, a[..., 3:4]], axis=-1)
    small = np.asarray(
        Image.fromarray(pre.astype(np.uint8)).resize(size, Image.BOX), dtype=np.float32
    )
    sa = small[..., 3:4]
    rgb = np.where(sa > 0, small[..., :3] * 255.0 / np.maximum(sa, 1e-6), 0)
    out = np.concatenate([np.clip(rgb, 0, 255), np.where(sa >= 128, 255, 0)], axis=-1)
    return Image.fromarray(out.astype(np.uint8), "RGBA")


def quantize_shared(frames: list) -> list:
    strip = Image.new("RGBA", (sum(f.width for f in frames), frames[0].height))
    x = 0
    for f in frames:
        strip.paste(f, (x, 0))
        x += f.width
    flat = strip.convert("RGB").quantize(colors=24, method=Image.MEDIANCUT).convert("RGB")
    out = []
    x = 0
    for f in frames:
        piece = flat.crop((x, 0, x + f.width, f.height)).convert("RGBA")
        piece.putalpha(f.getchannel("A"))
        out.append(piece)
        x += f.width
    return out


def process(unit: str) -> None:
    keyed = chroma_key(Image.open(OUT / f"{unit}-raw.png"))
    box = keyed.getbbox()
    left, top, right, bottom = box
    w, h = right - left, bottom - top
    scale = MAX_DIAG / math.hypot(w, h)
    print(f"{unit}: bbox {box}, content {w}x{h}, "
          f"downscaled {round(w * scale)}x{round(h * scale)}")

    frames_dir = OUT / "unit-frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    content = keyed.crop(box)
    content.save(frames_dir / f"{unit}.png")

    side = math.ceil(math.hypot(w, h))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(content, ((side - w) // 2, (side - h) // 2))

    frames = []
    small_side = max(1, round(side * scale))
    for i in range(8):
        rot = canvas.rotate(-45 * i, resample=Image.BICUBIC)
        small = deres(rot, (small_side, small_side))
        frame = Image.new("RGBA", (FRAME, FRAME), (0, 0, 0, 0))
        frame.alpha_composite(small, ((FRAME - small_side) // 2, (FRAME - small_side) // 2))
        frames.append(frame)
    frames = quantize_shared(frames)

    sheet = Image.new("RGBA", (8 * FRAME, FRAME), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        sheet.paste(f, (i * FRAME, 0))
    sheet.save(OUT / f"{unit}.png")
    print(f"{unit}: wrote {unit}.png ({sheet.width}x{sheet.height})")

    preview = []
    for f in frames:
        big = f.resize((FRAME * 4, FRAME * 4), Image.NEAREST)
        bg = Image.new("RGBA", big.size, (24, 26, 32, 255))
        bg.alpha_composite(big)
        preview.append(bg.convert("P", palette=Image.ADAPTIVE))
    preview[0].save(OUT / f"{unit}-preview.gif", save_all=True,
                    append_images=preview[1:], duration=180, loop=0)
    print(f"{unit}: wrote {unit}-preview.gif")


def main() -> None:
    units = sys.argv[1:] or ALL_UNITS
    for unit in units:
        process(unit)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Turn the two raw harvester states into the game-ready 256x64 sheet.

Steps:
  1. chroma-key + despill both states
  2. shared bounding box across both states (same registration/scale)
  3. derive the 8 direction frames per state by rotating the HIGH-RES
     image (frame i faces i*45 degrees clockwise from North, ART.md),
     then nearest-neighbour downscale each rotated frame to 32x32 —
     high-res-first rotation avoids the ragged diagonals you get from
     rotating 32px pixel art directly
  4. scale so the content's bounding circle fits inside the 32x32 frame
     at every rotation angle (no clipping on diagonals)
  5. assemble the 256x64 sheet: row 0 = empty, row 1 = loaded

Usage: python3 process_harvester.py
Reads:  output/harvester-raw-{empty,loaded}.png
Writes: output/harvester-frames/{empty,loaded}.png, output/harvester.png,
        output/harvester-preview.gif
"""

import math
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).parent / "output"
STATES = ["empty", "loaded"]
FRAME = 32
# Content bounding-box diagonal after downscale; 30 < 32 guarantees the
# sprite stays inside the frame at every rotation angle.
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
            # Despill is safe: hull greys are balanced, blue accents have
            # low red, teal scrap has low red.
            d2 = (r - KEY[0]) ** 2 + (g - KEY[1]) ** 2 + (b - KEY[2]) ** 2
            if d2 <= tol2 or (r > g + 30 and b > g + 30):
                px[x, y] = (0, 0, 0, 0)
    return img


def deres(img: Image.Image, size: tuple) -> Image.Image:
    """Downscale to pixel-art size: premultiplied area-average (BOX), so
    transparent pixels' RGB doesn't darken edges, then a hard alpha
    threshold for crisp edges."""
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
    """Quantize all frames with ONE adaptive palette so rotation frames
    don't shimmer against each other. Transparency is kept as-is."""
    strip = Image.new("RGBA", (sum(f.width for f in frames), frames[0].height))
    x = 0
    for f in frames:
        strip.paste(f, (x, 0))
        x += f.width
    pal = strip.convert("RGB").quantize(colors=24, method=Image.MEDIANCUT)
    flat = pal.convert("RGB")
    out = []
    x = 0
    for f in frames:
        piece = flat.crop((x, 0, x + f.width, f.height)).convert("RGBA")
        piece.putalpha(f.getchannel("A"))
        out.append(piece)
        x += f.width
    return out


def main() -> None:
    keyed = {s: chroma_key(Image.open(OUT / f"harvester-raw-{s}.png")) for s in STATES}

    boxes = {s: img.getbbox() for s, img in keyed.items()}
    for s, b in boxes.items():
        print(f"{s}: bbox {b}")
    left = min(b[0] for b in boxes.values())
    top = min(b[1] for b in boxes.values())
    right = max(b[2] for b in boxes.values())
    bottom = max(b[3] for b in boxes.values())
    w, h = right - left, bottom - top
    print(f"shared content {w}x{h}")

    frames_dir = OUT / "harvester-frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    # Scale factor so the downscaled content diagonal fits MAX_DIAG.
    scale = MAX_DIAG / math.hypot(w, h)
    target_w = max(1, round(w * scale))
    target_h = max(1, round(h * scale))
    print(f"downscaled content {target_w}x{target_h} "
          f"(diag {math.hypot(target_w, target_h):.1f})")

    # High-res square working canvas, content centred, big enough that
    # rotation never clips (side = content diagonal).
    side = math.ceil(math.hypot(w, h))

    frames = []
    for s in STATES:
        content = keyed[s].crop((left, top, right, bottom))
        content.save(frames_dir / f"{s}.png")
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(content, ((side - w) // 2, (side - h) // 2))
        for i in range(8):
            # PIL rotates counter-clockwise; facing i*45deg clockwise
            # needs rotate(-45*i). Rotate at high res, downscale after.
            rot = canvas.rotate(-45 * i, resample=Image.BICUBIC)
            small_side = max(1, round(side * scale))
            small = deres(rot, (small_side, small_side))
            frame = Image.new("RGBA", (FRAME, FRAME), (0, 0, 0, 0))
            frame.alpha_composite(small, ((FRAME - small_side) // 2, (FRAME - small_side) // 2))
            frames.append(frame)

    frames = quantize_shared(frames)
    sheet = Image.new("RGBA", (8 * FRAME, len(STATES) * FRAME), (0, 0, 0, 0))
    for n, frame in enumerate(frames):
        sheet.paste(frame, ((n % 8) * FRAME, (n // 8) * FRAME))
    gif_frames = frames[:8]

    sheet_path = OUT / "harvester.png"
    sheet.save(sheet_path)
    print(f"wrote {sheet_path} ({sheet.width}x{sheet.height})")

    # Preview GIF: empty harvester spinning through the 8 directions, 4x.
    preview = []
    for f in gif_frames:
        big = f.resize((FRAME * 4, FRAME * 4), Image.NEAREST)
        bg = Image.new("RGBA", big.size, (24, 26, 32, 255))
        bg.alpha_composite(big)
        preview.append(bg.convert("P", palette=Image.ADAPTIVE))
    gif_path = OUT / "harvester-preview.gif"
    preview[0].save(gif_path, save_all=True, append_images=preview[1:], duration=180, loop=0)
    print(f"wrote {gif_path}")


if __name__ == "__main__":
    main()

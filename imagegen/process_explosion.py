#!/usr/bin/env python3
"""Turn the raw model output into game-ready explosion sprites.

Pipeline (see ../notes/animated-sprite-imagegen-notes.md):
  1. chroma-key: remove the flat magenta background
  2. slice: 2x3 grid of 512x512 cells -> frames 0..5 (left-right, top-bottom)
  3. high-res frames: transparent 512x512 PNGs, kept for future use
  4. contract sheet: nearest-neighbour downscale to 32x32 per frame,
     assembled into the 192x32 strip required by ART.md (fx/explosion.png)
  5. preview GIF so the loop can be eyeballed

Usage: python3 process_explosion.py
Reads:  output/explosion-raw.png
Writes: output/frames/frame-{0..5}.png, output/explosion.png,
        output/explosion-preview.gif
"""

from pathlib import Path

from PIL import Image

OUT = Path(__file__).parent / "output"
COLS, ROWS = 3, 2
FRAME = 32  # contract frame size (ART.md)

# Chroma key: pure magenta, with tolerance for model color drift.
KEY = (255, 0, 255)
TOLERANCE = 120  # euclidean RGB distance


def chroma_key(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    px = img.load()
    tol2 = TOLERANCE * TOLERANCE
    removed = 0
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, _ = px[x, y]
            d2 = (r - KEY[0]) ** 2 + (g - KEY[1]) ** 2 + (b - KEY[2]) ** 2
            # Despill: magenta-dominant edge pixels (fire has low blue,
            # smoke has r==g==b, so this can only hit key-color bleed).
            if d2 <= tol2 or (r > g + 30 and b > g + 30):
                px[x, y] = (0, 0, 0, 0)
                removed += 1
    print(f"chroma-key removed {100 * removed / (img.width * img.height):.1f}% of pixels")
    return img


def recenter(cell: Image.Image) -> Image.Image:
    """Shift the opaque content so its bounding box is centred in the cell."""
    bbox = cell.getbbox()
    if bbox is None:
        return cell
    dx = (cell.width - (bbox[0] + bbox[2])) // 2
    dy = (cell.height - (bbox[1] + bbox[3])) // 2
    out = Image.new("RGBA", cell.size, (0, 0, 0, 0))
    out.paste(cell, (dx, dy))
    return out


def main() -> None:
    raw = Image.open(OUT / "explosion-raw.png")
    print(f"raw image {raw.width}x{raw.height}")
    keyed = chroma_key(raw)

    cell_w = keyed.width // COLS
    cell_h = keyed.height // ROWS

    frames_dir = OUT / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    sheet = Image.new("RGBA", (6 * FRAME, FRAME), (0, 0, 0, 0))
    small_frames = []
    for n in range(COLS * ROWS):
        cx = (n % COLS) * cell_w
        cy = (n // COLS) * cell_h
        cell = keyed.crop((cx, cy, cx + cell_w, cy + cell_h))
        # centre-crop to square in case cells aren't (1536x1024 -> 512x512 already is)
        side = min(cell.size)
        left = (cell.width - side) // 2
        top = (cell.height - side) // 2
        cell = recenter(cell.crop((left, top, left + side, top + side)))
        cell.save(frames_dir / f"frame-{n}.png")

        opaque = sum(1 for _, _, _, a in cell.getdata() if a > 0)
        print(f"frame {n}: {100 * opaque / (side * side):.1f}% opaque")

        small = cell.resize((FRAME, FRAME), Image.NEAREST)
        small_frames.append(small)
        sheet.paste(small, (n * FRAME, 0))

    sheet_path = OUT / "explosion.png"
    sheet.save(sheet_path)
    print(f"wrote {sheet_path} ({sheet.width}x{sheet.height})")

    # Preview GIF: 4x upscaled frames on a dark background, ~10 fps.
    preview = []
    for f in small_frames:
        big = f.resize((FRAME * 4, FRAME * 4), Image.NEAREST)
        bg = Image.new("RGBA", big.size, (24, 26, 32, 255))
        bg.alpha_composite(big)
        preview.append(bg.convert("P", palette=Image.ADAPTIVE))
    gif_path = OUT / "explosion-preview.gif"
    preview[0].save(gif_path, save_all=True, append_images=preview[1:], duration=100, loop=0)
    print(f"wrote {gif_path}")


if __name__ == "__main__":
    main()

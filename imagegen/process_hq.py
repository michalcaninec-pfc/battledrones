#!/usr/bin/env python3
"""Turn the three raw HQ states into the game-ready 288x96 sheet.

Same chroma-key + despill as the explosion, with one difference in the
geometry handling: all three states are cropped with a SINGLE shared
bounding box (the union of their content boxes) so the building keeps the
same scale and registration across frames — per-frame bbox fitting would
make the rubble pile render larger than the intact building.

Usage: python3 process_hq.py
Reads:  output/hq-raw-{idle,damaged,rubble}.png
Writes: output/hq-frames/{idle,damaged,rubble}.png, output/hq.png,
        output/hq-preview.png
"""

from pathlib import Path

from PIL import Image

OUT = Path(__file__).parent / "output"
STATES = ["idle", "damaged", "rubble"]
FRAME = 96      # contract frame size (ART.md: hq.png is 288x96, 96x96 frames)
MARGIN = 3      # "buildings should visually fill their frame minus a ~3px margin"

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
            # Magenta-dominant despill for anti-aliased edges. Safe here:
            # the HQ's blue accents have low red, greys have balanced
            # channels, yellow lights have low blue.
            if d2 <= tol2 or (r > g + 30 and b > g + 30):
                px[x, y] = (0, 0, 0, 0)
    return img


def main() -> None:
    keyed = {s: chroma_key(Image.open(OUT / f"hq-raw-{s}.png")) for s in STATES}

    # Shared bounding box across all states preserves scale/registration.
    boxes = {s: img.getbbox() for s, img in keyed.items()}
    for s, b in boxes.items():
        print(f"{s}: bbox {b}")
    left = min(b[0] for b in boxes.values())
    top = min(b[1] for b in boxes.values())
    right = max(b[2] for b in boxes.values())
    bottom = max(b[3] for b in boxes.values())
    # Pad to square so downscaling doesn't distort aspect.
    w, h = right - left, bottom - top
    side = max(w, h)
    cx, cy = (left + right) // 2, (top + bottom) // 2
    box = (cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side)
    print(f"shared crop box {box} ({side}x{side})")

    frames_dir = OUT / "hq-frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    inner = FRAME - 2 * MARGIN
    sheet = Image.new("RGBA", (len(STATES) * FRAME, FRAME), (0, 0, 0, 0))
    small_frames = []
    for n, s in enumerate(STATES):
        cell = keyed[s].crop(box)
        cell.save(frames_dir / f"{s}.png")
        small = Image.new("RGBA", (FRAME, FRAME), (0, 0, 0, 0))
        small.paste(cell.resize((inner, inner), Image.NEAREST), (MARGIN, MARGIN))
        small_frames.append(small)
        sheet.paste(small, (n * FRAME, 0))

    sheet_path = OUT / "hq.png"
    sheet.save(sheet_path)
    print(f"wrote {sheet_path} ({sheet.width}x{sheet.height})")

    # Side-by-side 2x preview on a dark background.
    scale = 2
    preview = Image.new("RGBA", (len(STATES) * FRAME * scale, FRAME * scale), (24, 26, 32, 255))
    for n, f in enumerate(small_frames):
        big = f.resize((FRAME * scale, FRAME * scale), Image.NEAREST)
        preview.alpha_composite(big, (n * FRAME * scale, 0))
    preview_path = OUT / "hq-preview.png"
    preview.save(preview_path)
    print(f"wrote {preview_path}")


if __name__ == "__main__":
    main()

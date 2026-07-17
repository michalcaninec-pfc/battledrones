#!/usr/bin/env python3
"""Process the remaining raw generations into game-ready sheets.

Reuses the shared helpers from process_units (chroma-key + despill,
premultiplied-BOX de-res, despeckle, shared-palette quantize) and adds:
  - scout: standard unit pipeline, smaller MAX_DIAG so the scout keeps
    its tiny-fragile personality relative to the 32px frame
  - turret-head: unit-style rotation, but pivoted on the gun HOUSING
    (detected as the rows near full content width), not the bbox centre —
    the engine spins the head in place on the base, so the housing must
    sit at the frame centre in every direction frame
  - turret-base / muzzle / bolt: single-frame de-res
  - terrain: 8 full-bleed 32x32 tiles (3 ground crops from one texture,
    2 rock crops, 3 scrap depletion states), one shared palette
  - fab-plant / airpad: HQ-style 3-state sheets at 64x64 (shared crop box
    across states, ~3px margin)
  - icon: plain BOX downscale to 512 and 192 (full-bleed, no keying)

Usage: python3 process_rest.py
"""

import math
from pathlib import Path

from PIL import Image

from process_units import FRAME, chroma_key, deres, despeckle, quantize_shared

OUT = Path(__file__).parent / "output"


def rotation_frames(content: Image.Image, pivot: tuple, max_r: float,
                    alpha_thresh: int = 96) -> list:
    """8 direction frames rotating `content` about `pivot` (content-local
    coords), scaled so the farthest content point stays inside 32x32."""
    w, h = content.size
    r_hi = max(math.hypot(x - pivot[0], y - pivot[1])
               for x in (0, w) for y in (0, h))
    scale = max_r / r_hi
    side = math.ceil(2 * r_hi)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(content, (round(side / 2 - pivot[0]), round(side / 2 - pivot[1])))
    small_side = max(1, round(side * scale))
    frames = []
    for i in range(8):
        rot = canvas.rotate(-45 * i, resample=Image.BICUBIC)
        small = deres(rot, (small_side, small_side), alpha_thresh)
        frame = Image.new("RGBA", (FRAME, FRAME), (0, 0, 0, 0))
        frame.alpha_composite(small, ((FRAME - small_side) // 2, (FRAME - small_side) // 2))
        frames.append(despeckle(frame))
    return quantize_shared(frames)


def save_sheet(frames: list, path: Path, cols: int = None) -> None:
    cols = cols or len(frames)
    rows = math.ceil(len(frames) / cols)
    sheet = Image.new("RGBA", (cols * FRAME, rows * FRAME), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        sheet.paste(f, ((i % cols) * FRAME, (i // cols) * FRAME))
    sheet.save(path)
    print(f"wrote {path.name} ({sheet.width}x{sheet.height})")


def save_gif(frames: list, path: Path, duration: int = 180) -> None:
    preview = []
    for f in frames:
        big = f.resize((f.width * 4, f.height * 4), Image.NEAREST)
        bg = Image.new("RGBA", big.size, (24, 26, 32, 255))
        bg.alpha_composite(big)
        preview.append(bg.convert("P", palette=Image.ADAPTIVE))
    preview[0].save(path, save_all=True, append_images=preview[1:],
                    duration=duration, loop=0)
    print(f"wrote {path.name}")


def do_scout() -> None:
    keyed = chroma_key(Image.open(OUT / "scout-raw.png"))
    content = keyed.crop(keyed.getbbox())
    content.save(OUT / "unit-frames" / "scout.png")
    frames = rotation_frames(content, (content.width / 2, content.height / 2),
                             max_r=12.0)  # tiny on purpose (24px diagonal)
    save_sheet(frames, OUT / "scout.png")
    save_gif(frames, OUT / "scout-preview.gif")


def do_turret_head() -> None:
    keyed = chroma_key(Image.open(OUT / "turret-head-raw.png"))
    content = keyed.crop(keyed.getbbox())
    content.save(OUT / "unit-frames" / "turret-head.png")
    # Housing = rows at least 60% of the widest row; pivot on their centre.
    a = content.getchannel("A")
    widths = []
    for y in range(content.height):
        row = [x for x in range(content.width) if a.getpixel((x, y)) > 0]
        widths.append((row[-1] - row[0] + 1) if row else 0)
    wmax = max(widths)
    housing_rows = [y for y, wd in enumerate(widths) if wd >= 0.6 * wmax]
    pivot_y = sum(housing_rows) / len(housing_rows)
    frames = rotation_frames(content, (content.width / 2, pivot_y), max_r=15.0)
    save_sheet(frames, OUT / "turret-head.png")
    save_gif(frames, OUT / "turret-head-preview.gif")


def do_single(name: str, fit: int) -> None:
    keyed = chroma_key(Image.open(OUT / f"{name}-raw.png"))
    content = keyed.crop(keyed.getbbox())
    w, h = content.size
    scale = fit / max(w, h)
    small = deres(content, (max(1, round(w * scale)), max(1, round(h * scale))))
    small = despeckle(small)
    frame = Image.new("RGBA", (FRAME, FRAME), (0, 0, 0, 0))
    frame.alpha_composite(small, ((FRAME - small.width) // 2, (FRAME - small.height) // 2))
    frame = quantize_shared([frame])[0]
    frame.save(OUT / f"{name}.png")
    print(f"wrote {name}.png (32x32)")


def do_tiles() -> None:
    def tile_from(img: Image.Image, box=None) -> Image.Image:
        if box:
            img = img.crop(box)
        return img.convert("RGB").resize((FRAME, FRAME), Image.BOX)

    ground = Image.open(OUT / "tile-ground-raw.png")
    rock = Image.open(OUT / "tile-rock-raw.png")
    tiles = [
        tile_from(ground, (0, 0, 680, 680)),
        tile_from(ground, (344, 172, 1024, 852)),
        tile_from(ground, (86, 344, 766, 1024)),
        tile_from(rock, (0, 0, 768, 768)),
        tile_from(rock, (256, 256, 1024, 1024)),
        tile_from(Image.open(OUT / "tile-scrap-full-raw.png")),
        tile_from(Image.open(OUT / "tile-scrap-half-raw.png")),
        tile_from(Image.open(OUT / "tile-scrap-empty-raw.png")),
    ]
    strip = Image.new("RGB", (8 * FRAME, FRAME))
    for i, t in enumerate(tiles):
        strip.paste(t, (i * FRAME, 0))
    strip = strip.quantize(colors=32, method=Image.MEDIANCUT).convert("RGB")
    strip.save(OUT / "tiles.png")
    print(f"wrote tiles.png ({strip.width}x{strip.height})")


def do_building(name: str, out_name: str = None, frame: int = 64, margin: int = 3) -> None:
    out_name = out_name or name
    states = ["idle", "damaged", "rubble"]
    keyed = {s: chroma_key(Image.open(OUT / f"{name}-{s}-raw.png")) for s in states}
    boxes = [img.getbbox() for img in keyed.values()]
    left = min(b[0] for b in boxes)
    top = min(b[1] for b in boxes)
    right = max(b[2] for b in boxes)
    bottom = max(b[3] for b in boxes)
    w, h = right - left, bottom - top
    side = max(w, h)
    cx, cy = (left + right) // 2, (top + bottom) // 2
    box = (cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side)

    frames_dir = OUT / f"{out_name}-frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    inner = frame - 2 * margin
    out_frames = []
    for s in states:
        cell = keyed[s].crop(box)
        cell.save(frames_dir / f"{s}.png")
        small = deres(cell, (inner, inner))
        f = Image.new("RGBA", (frame, frame), (0, 0, 0, 0))
        f.alpha_composite(small, (margin, margin))
        out_frames.append(f)
    out_frames = quantize_shared(out_frames)
    sheet = Image.new("RGBA", (3 * frame, frame), (0, 0, 0, 0))
    for n, f in enumerate(out_frames):
        sheet.paste(f, (n * frame, 0))
    sheet.save(OUT / f"{out_name}.png")
    print(f"wrote {out_name}.png ({sheet.width}x{sheet.height})")


def do_icon() -> None:
    raw = Image.open(OUT / "icon-raw.png").convert("RGB")
    for size in (512, 192):
        raw.resize((size, size), Image.BOX).save(OUT / f"icon-{size}.png")
        print(f"wrote icon-{size}.png")


def main() -> None:
    (OUT / "unit-frames").mkdir(parents=True, exist_ok=True)
    do_scout()
    do_turret_head()
    do_single("turret-base", fit=30)
    do_single("muzzle", fit=24)
    do_single("bolt", fit=28)
    do_tiles()
    do_building("fab", out_name="fab-plant")
    do_building("airpad")
    do_icon()


if __name__ == "__main__":
    main()

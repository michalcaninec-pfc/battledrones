#!/usr/bin/env python3
"""Turn the raw generated art in art/raw/ into game-ready assets.

Usage:
    python3 art/process.py            # everything (takes ~1-2 min)
    python3 art/process.py --no-preview
    python3 art/process.py --icons-only     # only public/assets/icons/*.webp (no atlas/ui)

Needs Python 3.10+, Pillow (>= 10.1), numpy, scipy (pip install scipy).
Deterministic: same raws -> byte-identical output.

Inputs  (art/raw/*.webp, RGBA, blue team colours, everything "facing north"):
    units      harvester (L empty / R full), scout, wasp, raptor, hornet, mender
               (mender is drawn facing south -> rotated 180 degrees), and hull+turret
               pairs (L hull with empty turret ring / R turret): stinger,
               flak-crawler, mortar, titan, lancer
    buildings  hq, fab-plant, airpad, tech-lab, depot, and base+head pairs
               (L base with empty mount / R rotating head): turret, sam-site, radar
    sheets     rubble (2x2), decals (3x2), scrap (3x2), crystal (3x2),
               explosion (4x2 animation, row-major)
    menu       keyart-portrait, keyart-landscape, icon
    portraits  trooper, rocket-squad, sniper (squads: several robots in one image),
               condor, assembly-bay -- HUD icons only, no atlas frames (the 3D game
               builds every model in code and no longer loads the atlas)
    (tex-* and doodads-* are handled elsewhere)

Outputs:
    public/assets/sprites/game.json + game-N.webp  Phaser 3 multiatlas (POT pages)
    public/assets/sprites/meta.json                 pivots, turret mounts, sizes
    public/assets/icons/<kind>.webp                 128px HUD icons (blue, composited)
    public/assets/ui/keyart-{portrait,landscape}.webp
    public/icons/icon-{192,512}.png                 PWA icons
    public/icons/apple-touch-icon.png               180px iOS Home Screen icon
    art/previews/atlas-preview.png                  QA contact sheet

Conventions:
    * 64 world px per tile, textures authored at 2x => PX_PER_TILE = 128 texture
      px per tile (the engine draws sprites at scale 0.5).
    * Frame names: u/<faction>/<unit>[-full|-turret], b/<faction>/<building>[-head],
      rubble/N, decal/N, scrap/N, crystal/N, explosion/N.  Factions: blue, red.
    * Frames are untrimmed.  Every unit, turret and building-head frame gets a
      measured rotation pivot: written as a TexturePacker-style "pivot" in
      game.json (Phaser 3 applies it as the sprite's default origin) and as
      "origin" in meta.json "frames".  Buildings/sheets use the centre (0.5, 0.5).
    * meta.json "mounts": where a turret/head pivot sits, as an offset in TILES
      from the hull/base origin (x right, y down, hull facing north).

Pipeline per raw:
    1. Split into parts: connected components of alpha > 24, tiny specks dropped,
       small satellites attached to the nearest big part (pairs) or grouped by
       grid cell (sheets).  Every pixel then goes to its nearest part if it lies
       within a few px of it (keeps soft anti-aliased edges, drops stray noise).
    2. Measure in raw space: content bbox, alpha centroid (hull pivot), empty
       turret-ring centre (gradient circle search + sub-pixel circle fit to the
       rim edge), turret pivot (barrels removed by a morphological opening, then
       centroid of the body; radar dish: circle fit to the hub silhouette).
    3. Resample each frame straight from raw with an exact, shared scale factor
       (premultiplied float Lanczos via PIL box-resize), so hull and turret keep
       their relative size and all measured points map exactly into the frame.
    4. Red faction = blue frames with the team-colour hue band (~185-265 deg,
       chroma-gated so grey metal is untouched) rotated to crimson.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "art" / "raw"
OUT_SPRITES = ROOT / "public" / "assets" / "sprites"
OUT_ICONS = ROOT / "public" / "assets" / "icons"
OUT_UI = ROOT / "public" / "assets" / "ui"
OUT_PWA = ROOT / "public" / "icons"
OUT_PREVIEW = ROOT / "art" / "previews"

PX_PER_TILE = 128
ALPHA_T = 24  # "solid" alpha threshold used for segmentation / bboxes
MIN_SPECK = 8  # components smaller than this (px, at raw res) are noise
FRAME_MARGIN = 3  # transparent px kept around sprite content inside a frame
ATLAS_PAD = 8  # transparent px between frames on an atlas page
ATLAS_MAX = 2048
FACTIONS = ("blue", "red")
RAW_PAD = 480  # transparent border added around raws so resample boxes never clip

# Longest side of the (hull / single) sprite, in tiles.
UNIT_SIZES = {
    "harvester": 1.15,
    "scout": 0.85,
    "stinger": 0.95,
    "flak-crawler": 1.0,
    "mortar": 1.15,
    "titan": 1.45,
    "lancer": 1.05,
    "wasp": 1.0,
    "raptor": 1.15,
    "hornet": 1.5,
    "mender": 0.85,
}
SINGLE_UNITS = ["scout", "wasp", "raptor", "hornet", "mender"]
TURRET_UNITS = ["stinger", "flak-crawler", "mortar", "titan", "lancer"]
UNIT_ORDER = [
    "harvester", "scout", "stinger", "flak-crawler", "mortar", "titan", "lancer",
    "wasp", "raptor", "hornet", "mender",
]
ROTATE_180 = {"mender", "scout"}  # drawn facing south (mender arms, scout camera eye)
# (scout is ambiguous: its camera eye sits at the south end of the pod; add it
#  here if it should fly eye-first.)

# Footprint in tiles.
BUILDING_SIZES = {
    "hq": 3, "fab-plant": 2, "airpad": 2, "tech-lab": 2, "depot": 2,
    "turret": 1, "sam-site": 1, "radar": 1,
}
SINGLE_BUILDINGS = ["hq", "fab-plant", "airpad", "tech-lab", "depot"]
HEAD_BUILDINGS = ["turret", "sam-site", "radar"]
BUILDING_INSET = 6  # content fits (size*128 - 6) px, centred in the size*128 frame
# Added after the move to 3D: they only get a HUD portrait (all parts of the raw
# composited, like any single-image unit), never atlas frames.
PORTRAIT_ONLY = ["trooper", "rocket-squad", "sniper", "condor", "assembly-bay"]
# Map objectives (neutral, drawn by the engine with the owner's ring): longest side in tiles.
OBJECTIVE_SIZES = {"uplink": 2.25, "supply-crate": 0.85}

# Where to look for the empty ring, as fractions of the hull/base bbox
# (x0, x1, y0, y1) for the ring CENTRE.
RING_SEARCH = {
    "mortar": (0.3, 0.7, 0.45, 0.95),  # mount is at the rear
}
RING_SEARCH_DEFAULT = (0.3, 0.7, 0.1, 0.9)


# ------------------------------------------------------------------ raw parts


@dataclass
class Part:
    """One isolated sprite part in (padded) raw pixel space."""

    rgba: np.ndarray  # H x W x 4 uint8, straight alpha, other parts removed
    name: str

    def __post_init__(self) -> None:
        a = self.rgba[..., 3].astype(np.float32)
        self.alpha = a
        self.solid = a > ALPHA_T
        self._f: list[Image.Image] | None = None

    def bbox(self, thresh: int = ALPHA_T) -> tuple[float, float, float, float]:
        """Content bbox in continuous coords (pixel i spans [i, i+1))."""
        ys, xs = np.nonzero(self.alpha > thresh)
        return float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)

    def centroid(self) -> tuple[float, float]:
        """Alpha-weighted centroid in continuous coords."""
        a = self.alpha
        ys, xs = np.nonzero(a > 0)
        w = a[ys, xs]
        return float((xs * w).sum() / w.sum() + 0.5), float((ys * w).sum() / w.sum() + 0.5)

    def channels(self) -> list[Image.Image]:
        """Premultiplied float channels (R, G, B, A) as PIL 'F' images."""
        if self._f is None:
            a = self.alpha / 255.0
            prem = self.rgba[..., :3].astype(np.float32) * a[..., None]
            self._f = [Image.fromarray(np.ascontiguousarray(prem[..., c]), "F") for c in range(3)]
            self._f.append(Image.fromarray(np.ascontiguousarray(self.alpha), "F"))
        return self._f


def load_raw(name: str, rot180: bool = False) -> np.ndarray:
    im = np.array(Image.open(RAW / f"{name}.webp").convert("RGBA"))
    if rot180:
        im = np.ascontiguousarray(im[::-1, ::-1])
    return im


def split_parts(name: str, layout, soft: float = 4.0, rot180: bool = False) -> list[Part]:
    """Separate a raw into parts.

    layout: "single" | "pair" (left, right) | ("grid", cols, rows) (row-major).
    soft:   how far (raw px) beyond the solid core faint pixels are kept.
    """
    rgba = load_raw(name, rot180)
    h, w = rgba.shape[:2]
    alpha = rgba[..., 3]
    lab, n = ndi.label(alpha > ALPHA_T)
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    comps = [i for i in range(1, n + 1) if sizes[i] >= MIN_SPECK]
    cents = dict(zip(comps, ndi.center_of_mass(np.ones_like(lab), lab, comps)))

    if layout == "single":
        groups = [comps]
    elif layout == "pair":
        seeds = sorted(sorted(comps, key=lambda i: -sizes[i])[:2], key=lambda i: cents[i][1])
        seed_d = [ndi.distance_transform_edt(lab != s) for s in seeds]
        groups = [[s] for s in seeds]
        for c in comps:
            if c in seeds:
                continue
            m = lab == c
            j = int(np.argmin([d[m].min() for d in seed_d]))
            groups[j].append(c)
    else:
        _, cols, rows = layout
        groups = [[] for _ in range(cols * rows)]
        for c in comps:
            cy, cx = cents[c]
            col = min(cols - 1, int(cx / (w / cols)))
            row = min(rows - 1, int(cy / (h / rows)))
            groups[row * cols + col].append(c)

    # Pixel ownership: nearest group core, within `soft` px.
    dists = []
    for g in groups:
        core = np.isin(lab, g)
        dists.append(ndi.distance_transform_edt(~core))
    dists = np.stack(dists)
    owner = np.argmin(dists, 0)
    near = dists.min(0) <= soft
    parts = []
    for k in range(len(groups)):
        keep = (owner == k) & near & (alpha >= 3)
        out = np.zeros_like(rgba)
        out[keep] = rgba[keep]
        out = np.pad(out, ((RAW_PAD, RAW_PAD), (RAW_PAD, RAW_PAD), (0, 0)))
        parts.append(Part(out, f"{name}[{k}]"))
    return parts


# ------------------------------------------------------------------ resampling


def resample(part: Part, s: float, bx: float, by: float, W: int, H: int) -> np.ndarray:
    """Render part into a W x H frame: raw point u maps to (u - (bx, by)) * s."""
    box = (bx, by, bx + W / s, by + H / s)
    ch = [np.asarray(c.resize((W, H), Image.Resampling.LANCZOS, box=box)) for c in part.channels()]
    a = np.clip(ch[3], 0, 255)
    prem = np.stack([np.clip(c, 0, None) for c in ch[:3]], -1)
    prem = np.minimum(prem, a[..., None])
    rgb = np.where(a[..., None] > 1e-3, prem * 255.0 / np.maximum(a[..., None], 1e-3), 0)
    out = np.zeros((H, W, 4), np.uint8)
    a8 = np.round(a).astype(np.uint8)
    a8[a8 < 2] = 0
    # Lanczos ringing leaves detached specks of alpha <= ~5 just outside edges:
    # drop every 8-connected blob that never gets above alpha 8.
    lab, n = ndi.label(a8 > 0, structure=np.ones((3, 3), bool))
    if n:
        peak = ndi.maximum(a8, lab, np.arange(1, n + 1))
        a8[np.isin(lab, 1 + np.nonzero(peak <= 8)[0])] = 0
    out[..., 3] = a8
    out[..., :3] = np.clip(np.round(rgb), 0, 255).astype(np.uint8)
    out[a8 == 0, :3] = 0
    return out


@dataclass
class Frame:
    name: str
    img: np.ndarray  # H x W x 4 uint8
    origin: tuple[float, float] | None = None  # normalised pivot; None = centre


def fit_frame(part: Part, s: float, bbox, margin: int = FRAME_MARGIN,
              size: tuple[int, int] | None = None, center: tuple[float, float] | None = None):
    """Frame geometry around bbox (or a fixed size around a centre). Returns (bx, by, W, H)."""
    if size is None:
        x0, y0, x1, y1 = bbox
        W = int(math.ceil((x1 - x0) * s)) + 2 * margin
        H = int(math.ceil((y1 - y0) * s)) + 2 * margin
    else:
        W, H = size
    cx, cy = center if center is not None else ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
    return cx - W / (2 * s), cy - H / (2 * s), W, H


def to_frame(pt, geo, s):
    bx, by, W, H = geo
    return ((pt[0] - bx) * s, (pt[1] - by) * s)


# ------------------------------------------------------------------ measurements


def luminance(part: Part) -> np.ndarray:
    c = part.rgba[..., :3].astype(np.float32)
    return (0.299 * c[..., 0] + 0.587 * c[..., 1] + 0.114 * c[..., 2]) * (part.alpha / 255.0)


def fit_circle(x: np.ndarray, y: np.ndarray):
    A = np.c_[2 * x, 2 * y, np.ones_like(x)]
    c, *_ = np.linalg.lstsq(A, x * x + y * y, rcond=None)
    return c[0], c[1], math.sqrt(c[2] + c[0] ** 2 + c[1] ** 2)


def detect_ring(part: Part, search=RING_SEARCH_DEFAULT) -> tuple[float, float, float]:
    """Centre (continuous coords) and radius of the empty circular turret mount.

    The mount is a dark recess inside a lighter rim, i.e. brightness rises going
    outward across its edge.  Coarse: exhaustive search (1/4 res) for the circle
    with the strongest mean outward-positive radial gradient.  Fine: sample the
    edge position along 720 rays and least-squares fit a circle with iterative
    outlier rejection (notches/tabs in the rim are rejected).
    """
    L = ndi.gaussian_filter(luminance(part), 1.5)
    gy, gx = ndi.sobel(L, 0), ndi.sobel(L, 1)
    x0, y0, x1, y1 = part.bbox()
    f = 4
    Lc = ndi.gaussian_filter(L, 2)[::f, ::f]
    cgy, cgx = ndi.sobel(Lc, 0), ndi.sobel(Lc, 1)
    w, h = (x1 - x0) / f, (y1 - y0) / f
    ang = np.linspace(0, 2 * np.pi, 128, endpoint=False)
    ca, sa = np.cos(ang), np.sin(ang)
    rr = np.arange(max(6.0, 0.08 * min(w, h)), 0.45 * min(w, h), 1.0)[:, None]
    best = (-1.0, 0.0, 0.0, 0.0)
    Hc, Wc = Lc.shape
    cxs = np.arange(x0 / f + search[0] * w, x0 / f + search[1] * w, 1.0)[:, None, None]
    for cy in np.arange(y0 / f + search[2] * h, y0 / f + search[3] * h, 1.0):
        # all centres of this row at once: (cx, radius, angle)
        xi = np.clip(np.round(cxs + rr * ca).astype(int), 0, Wc - 1)
        yi = np.clip(np.round(cy + rr * sa + 0 * cxs).astype(int), 0, Hc - 1)
        g = np.clip(cgx[yi, xi] * ca + cgy[yi, xi] * sa, 0, None).mean(2)
        i, j = np.unravel_index(int(np.argmax(g)), g.shape)
        if g[i, j] > best[0]:
            best = (g[i, j], cxs[i, 0, 0] * f, cy * f, rr[j, 0] * f)
    _, cx, cy, r = best
    ang = np.linspace(0, 2 * np.pi, 720, endpoint=False)
    ca, sa = np.cos(ang), np.sin(ang)
    for _ in range(3):
        rs = np.arange(r * 0.85, r * 1.15, 0.25)[:, None]
        X, Y = cx + rs * ca, cy + rs * sa
        g = ndi.map_coordinates(gx, [Y, X], order=1) * ca + ndi.map_coordinates(gy, [Y, X], order=1) * sa
        j = np.argmax(g, 0)
        gm = g[j, np.arange(len(ang))]
        er = rs[j, 0]
        ex, ey = cx + er * ca, cy + er * sa
        keep = gm > np.percentile(gm, 30)
        for _ in range(5):
            fcx, fcy, fr = fit_circle(ex[keep], ey[keep])
            res = np.abs(np.hypot(ex - fcx, ey - fcy) - fr)
            keep &= res < max(1.5, float(np.percentile(res[keep], 70)))
        cx, cy, r = fcx, fcy, fr
    # pixel-index coords -> continuous coords
    return cx + 0.5, cy + 0.5, r


def body_pivot(part: Part, frac: float = 0.5) -> tuple[float, float]:
    """Pivot of a turret / head: centre of its main body, ignoring barrels.

    Opening with a disk of radius frac * (largest inscribed radius) erases every
    feature thinner than the body (barrels, lenses, antennae); the pivot is the
    centroid of the largest remaining blob.  (Opening done with distance
    transforms, which is exact for a Euclidean disk and fast.)
    """
    m = ndi.binary_fill_holes(part.solid)
    d = ndi.distance_transform_edt(m)
    r = max(2.0, frac * d.max())
    o = ndi.distance_transform_edt(~(d > r)) <= r  # opening = dilate(erode(m, r), r)
    lab, n = ndi.label(o)
    big = 1 + int(np.argmax(ndi.sum(o, lab, range(1, n + 1))))
    cy, cx = ndi.center_of_mass(lab == big)
    return cx + 0.5, cy + 0.5


def hub_pivot(part: Part) -> tuple[float, float]:
    """Radar head: circle fitted to the silhouette of the round hub below the dish."""
    m = ndi.binary_fill_holes(part.solid)
    rows = np.nonzero(m.any(1))[0]
    widths = m.sum(1)
    top = int(np.argmax(widths))
    hub_rows = [y for y in rows if y > top and widths[y] < 0.55 * widths[top]]
    hub_rows = hub_rows[4:]  # skip the dish/hub junction
    xs, ys = [], []
    for y in hub_rows:
        on = np.nonzero(m[y])[0]
        xs += [on.min(), on.max() + 1]
        ys += [y + 0.5, y + 0.5]
    xs, ys = np.array(xs, float), np.array(ys, float)
    keep = np.ones(len(xs), bool)
    for _ in range(5):
        cx, cy, r = fit_circle(xs[keep], ys[keep])
        res = np.abs(np.hypot(xs - cx, ys - cy) - r)
        keep &= res < max(1.5, float(np.percentile(res[keep], 80)))
    return cx, cy


# ------------------------------------------------------------------ recolour


def to_red(img: np.ndarray) -> np.ndarray:
    """Blue team colour -> crimson.  Only saturated blue hues move."""
    rgb = img[..., :3].astype(np.float32) / 255.0
    mx, mn = rgb.max(-1), rgb.min(-1)
    chroma = mx - mn
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    safe = np.maximum(chroma, 1e-6)
    h = np.where(mx == r, ((g - b) / safe) % 6, np.where(mx == g, (b - r) / safe + 2, (r - g) / safe + 4)) * 60.0
    h = np.where(chroma > 1e-6, h, 0)

    def ramp(x, a, b_):
        t = np.clip((x - a) / (b_ - a), 0, 1)
        return t * t * (3 - 2 * t)

    w_h = ramp(h, 180, 198) * (1 - ramp(h, 252, 268))
    w_c = ramp(chroma, 0.07, 0.16)
    w = (w_h * w_c)[..., None]

    # new hue ~ 0-5 deg keeps a little of the original hue variation
    nh = (2.0 + (h - 222.0) * 0.12) % 360.0
    v = mx
    sat = np.where(mx > 1e-6, chroma / np.maximum(mx, 1e-6), 0)
    sat = np.clip(sat * 1.05, 0, 1)
    v = np.clip(v * 1.02, 0, 1)
    hh = nh / 60.0
    i = np.floor(hh).astype(int) % 6
    fr = hh - np.floor(hh)
    p, q, t = v * (1 - sat), v * (1 - sat * fr), v * (1 - sat * (1 - fr))
    sel = [
        np.stack([v, t, p], -1), np.stack([q, v, p], -1), np.stack([p, v, t], -1),
        np.stack([p, q, v], -1), np.stack([t, p, v], -1), np.stack([v, p, q], -1),
    ]
    red = np.zeros_like(rgb)
    for k in range(6):
        red = np.where((i == k)[..., None], sel[k], red)
    out = rgb * (1 - w) + red * w
    res = img.copy()
    res[..., :3] = np.clip(np.round(out * 255), 0, 255).astype(np.uint8)
    res[res[..., 3] == 0, :3] = 0
    return res


# ------------------------------------------------------------------ building the frames


def r4(v: float) -> float:
    return round(float(v), 4) + 0.0  # + 0.0 turns -0.0 into 0.0


class Builder:
    def __init__(self) -> None:
        self.frames: list[Frame] = []  # blue + neutral
        self.mounts: dict[str, list[float]] = {}
        self.sizes: dict[str, float] = {}
        # raw-space data for icons / previews
        self.icon_src: dict[str, list[tuple[Part, tuple[float, float] | None, tuple[float, float] | None]]] = {}
        self.composites: dict[str, dict] = {}  # kind -> hull/turret frame names

    def add(self, name: str, img: np.ndarray, origin=None) -> None:
        if origin is not None:
            origin = (r4(origin[0] / img.shape[1]), r4(origin[1] / img.shape[0]))
        self.frames.append(Frame(name, img, origin))

    # ---- units
    def units(self) -> None:
        # harvester: empty / full, identical scale
        empty, full = split_parts("harvester", "pair")
        s = UNIT_SIZES["harvester"] * PX_PER_TILE / max_side(empty)
        for part, nm in ((empty, "harvester"), (full, "harvester-full")):
            geo = fit_frame(part, s, part.bbox())
            self.add(f"u/blue/{nm}", resample(part, s, *geo), to_frame(part.centroid(), geo, s))
        self.sizes["harvester"] = UNIT_SIZES["harvester"]
        self.icon_src["harvester"] = [(full, None, None)]

        for k in SINGLE_UNITS:
            (part,) = split_parts(k, "single", rot180=k in ROTATE_180)
            s = UNIT_SIZES[k] * PX_PER_TILE / max_side(part)
            geo = fit_frame(part, s, part.bbox())
            self.add(f"u/blue/{k}", resample(part, s, *geo), to_frame(part.centroid(), geo, s))
            self.sizes[k] = UNIT_SIZES[k]
            self.icon_src[k] = [(part, None, None)]

        for k in TURRET_UNITS:
            hull, tur = split_parts(k, "pair")
            s = UNIT_SIZES[k] * PX_PER_TILE / max_side(hull)
            hc = hull.centroid()
            rx, ry, rr = detect_ring(hull, RING_SEARCH.get(k, RING_SEARCH_DEFAULT))
            tp = body_pivot(tur)
            hgeo = fit_frame(hull, s, hull.bbox())
            tgeo = fit_frame(tur, s, tur.bbox())
            self.add(f"u/blue/{k}", resample(hull, s, *hgeo), to_frame(hc, hgeo, s))
            self.add(f"u/blue/{k}-turret", resample(tur, s, *tgeo), to_frame(tp, tgeo, s))
            self.mounts[k] = [r4((rx - hc[0]) * s / PX_PER_TILE), r4((ry - hc[1]) * s / PX_PER_TILE)]
            self.sizes[k] = UNIT_SIZES[k]
            self.icon_src[k] = [(hull, None, None), (tur, tp, (rx, ry))]
            self.composites[k] = dict(base=f"u/blue/{k}", top=f"u/blue/{k}-turret")
            print(f"  {k:13s} ring=({rx:.1f},{ry:.1f}) r={rr:.1f} turret pivot=({tp[0]:.1f},{tp[1]:.1f}) mount={self.mounts[k]}")

    # ---- buildings
    def buildings(self) -> None:
        for k in SINGLE_BUILDINGS + HEAD_BUILDINGS:
            if k in HEAD_BUILDINGS:
                base, head = split_parts(k, "pair")
            else:
                (base,) = split_parts(k, "single")
                head = None
            S = BUILDING_SIZES[k] * PX_PER_TILE
            s = (S - BUILDING_INSET) / max_side(base)
            geo = fit_frame(base, s, base.bbox(), size=(S, S))
            self.add(f"b/blue/{k}", resample(base, s, *geo))
            self.icon_src[k] = [(base, None, None)]
            if head is None:
                continue
            rx, ry, rr = detect_ring(base)
            hp = hub_pivot(head) if k == "radar" else body_pivot(head)
            hgeo = fit_frame(head, s, head.bbox())
            self.add(f"b/blue/{k}-head", resample(head, s, *hgeo), to_frame(hp, hgeo, s))
            fx, fy = to_frame((rx, ry), geo, s)
            self.mounts[k] = [r4((fx - S / 2) / PX_PER_TILE), r4((fy - S / 2) / PX_PER_TILE)]
            self.icon_src[k].append((head, hp, (rx, ry)))
            self.composites[k] = dict(base=f"b/blue/{k}", top=f"b/blue/{k}-head")
            print(f"  {k:13s} ring=({rx:.1f},{ry:.1f}) r={rr:.1f} head pivot=({hp[0]:.1f},{hp[1]:.1f}) mount={self.mounts[k]}")

    # ---- map objectives (neutral frames: no red variant; the engine draws the owner)
    def objectives(self) -> None:
        base, head = split_parts("uplink", "pair")
        S = round(OBJECTIVE_SIZES["uplink"] * PX_PER_TILE)
        s = (S - BUILDING_INSET) / max_side(base)
        geo = fit_frame(base, s, base.bbox(), size=(S, S))
        self.add("obj/uplink", resample(base, s, *geo))
        rx, ry, rr = detect_ring(base)
        hp = hub_pivot(head)
        hgeo = fit_frame(head, s, head.bbox())
        self.add("obj/uplink-head", resample(head, s, *hgeo), to_frame(hp, hgeo, s))
        fx, fy = to_frame((rx, ry), geo, s)
        self.mounts["uplink"] = [r4((fx - S / 2) / PX_PER_TILE), r4((fy - S / 2) / PX_PER_TILE)]
        self.icon_src["uplink"] = [(base, None, None), (head, hp, (rx, ry))]
        print(f"  uplink        ring=({rx:.1f},{ry:.1f}) r={rr:.1f} head pivot=({hp[0]:.1f},{hp[1]:.1f}) mount={self.mounts['uplink']}")
        (crate,) = split_parts("supply-crate", "single")
        S = round(OBJECTIVE_SIZES["supply-crate"] * PX_PER_TILE)
        s = (S - 2 * FRAME_MARGIN) / max_side(crate)
        geo = fit_frame(crate, s, crate.bbox(), size=(S, S))
        self.add("obj/crate", resample(crate, s, *geo))
        self.icon_src["supply-crate"] = [(crate, None, None)]

    # ---- HUD portraits without atlas frames
    def portraits(self) -> None:
        for k in PORTRAIT_ONLY:
            (part,) = split_parts(k, "single")
            self.icon_src[k] = [(part, None, None)]

    # ---- neutral sheets
    def sheets(self) -> None:
        for i, p in enumerate(split_parts("rubble", ("grid", 2, 2), soft=6)):
            s = (384 - 2 * 4) / max_side(p)
            geo = fit_frame(p, s, p.bbox(), size=(384, 384))
            self.add(f"rubble/{i}", resample(p, s, *geo))
        for i, p in enumerate(split_parts("decals", ("grid", 3, 2), soft=40)):
            bb = p.bbox(2)  # soft edges: include the faint fade-out
            s = (192 - 2 * FRAME_MARGIN) / max(bb[2] - bb[0], bb[3] - bb[1])
            geo = fit_frame(p, s, bb)
            self.add(f"decal/{i}", resample(p, s, *geo))
        for sheet, prefix in (("scrap", "scrap"), ("crystal", "crystal")):
            for i, p in enumerate(split_parts(sheet, ("grid", 3, 2), soft=6)):
                s = 120 / max_side(p)
                geo = fit_frame(p, s, p.bbox(), size=(128, 128))
                self.add(f"{prefix}/{i}", resample(p, s, *geo))
        # explosion: one scale for all 8 frames, each centred on its own centroid
        parts = split_parts("explosion", ("grid", 4, 2), soft=48)
        cents = [p.centroid() for p in parts]
        ext = []
        for p, (cx, cy) in zip(parts, cents):
            x0, y0, x1, y1 = p.bbox(6)
            ext.append(max(cx - x0, x1 - cx, cy - y0, y1 - cy))
        s = (128 - 4) / max(ext)
        for i, (p, c) in enumerate(zip(parts, cents)):
            geo = fit_frame(p, s, None, size=(256, 256), center=c)
            self.add(f"explosion/{i}", resample(p, s, *geo))
        print(f"  explosion scale {s:.4f} (raw extents {[round(e) for e in ext]})")


def max_side(p: Part) -> float:
    x0, y0, x1, y1 = p.bbox()
    return max(x1 - x0, y1 - y0)


# ------------------------------------------------------------------ atlas packing


class MaxRects:
    """MaxRects bin packer (best short side fit), no rotation."""

    def __init__(self, w: int, h: int) -> None:
        self.w, self.h = w, h
        self.free = [(0, 0, w, h)]

    def insert(self, w: int, h: int):
        best = None
        for fx, fy, fw, fh in self.free:
            if w <= fw and h <= fh:
                short = min(fw - w, fh - h)
                long_ = max(fw - w, fh - h)
                key = (short, long_, fy, fx)
                if best is None or key < best[0]:
                    best = (key, fx, fy)
        if best is None:
            return None
        _, x, y = best
        self._split(x, y, w, h)
        return x, y

    def _split(self, x, y, w, h) -> None:
        new = []
        for fx, fy, fw, fh in self.free:
            if x >= fx + fw or x + w <= fx or y >= fy + fh or y + h <= fy:
                new.append((fx, fy, fw, fh))
                continue
            if x > fx:
                new.append((fx, fy, x - fx, fh))
            if x + w < fx + fw:
                new.append((x + w, fy, fx + fw - x - w, fh))
            if y > fy:
                new.append((fx, fy, fw, y - fy))
            if y + h < fy + fh:
                new.append((fx, y + h, fw, fy + fh - y - h))
        # prune contained rects
        pruned = []
        for i, a in enumerate(new):
            contained = False
            for j, b in enumerate(new):
                if i != j and a[0] >= b[0] and a[1] >= b[1] and a[0] + a[2] <= b[0] + b[2] and a[1] + a[3] <= b[1] + b[3]:
                    if a != b or i > j:
                        contained = True
                        break
            if not contained:
                pruned.append(a)
        self.free = pruned


def pack(frames: list[Frame]) -> list[tuple[int, int, list[tuple[Frame, int, int]]]]:
    """Pack into as few pages as possible; each page shrunk to the smallest POT that fits."""
    order = sorted(frames, key=lambda f: (-max(f.img.shape[:2]), -f.img.shape[0] * f.img.shape[1], f.name))
    pages = []
    todo = order
    while todo:
        bins = MaxRects(ATLAS_MAX, ATLAS_MAX)
        placed, rest = [], []
        for f in todo:
            h, w = f.img.shape[:2]
            pos = bins.insert(w + ATLAS_PAD, h + ATLAS_PAD)
            if pos is None:
                rest.append(f)
            else:
                placed.append((f, pos[0] + ATLAS_PAD // 2, pos[1] + ATLAS_PAD // 2))
        if not placed:
            raise SystemExit("frame larger than an atlas page")
        # shrink: try smaller POT sizes for this page's contents
        pw, ph = ATLAS_MAX, ATLAS_MAX
        items = [f for f, _, _ in placed]
        for area, sw, sh in sorted(
            (w * h, w, h) for w in (256, 512, 1024, 2048) for h in (256, 512, 1024, 2048)
        ):
            if area >= ATLAS_MAX * ATLAS_MAX or max(sw, sh) / min(sw, sh) > 2:
                continue
            b = MaxRects(sw, sh)
            trial = []
            for f in items:
                h, w = f.img.shape[:2]
                pos = b.insert(w + ATLAS_PAD, h + ATLAS_PAD)
                if pos is None:
                    break
                trial.append((f, pos[0] + ATLAS_PAD // 2, pos[1] + ATLAS_PAD // 2))
            if len(trial) == len(items):
                pw, ph, placed = sw, sh, trial
                break
        pages.append((pw, ph, placed))
        todo = rest
    return pages


def write_atlas(frames: list[Frame]) -> tuple[list[tuple[int, int, int]], dict]:
    OUT_SPRITES.mkdir(parents=True, exist_ok=True)
    for old in [*OUT_SPRITES.glob("game-*.png"), *OUT_SPRITES.glob("game-*.webp")]:
        old.unlink()
    pages = pack(frames)
    textures, info = [], []
    for i, (pw, ph, placed) in enumerate(pages):
        page = np.zeros((ph, pw, 4), np.uint8)
        fr_json = []
        for f, x, y in sorted(placed, key=lambda t: t[0].name):
            h, w = f.img.shape[:2]
            page[y:y + h, x:x + w] = f.img
            entry = {
                "filename": f.name,
                "rotated": False,
                "trimmed": False,
                "frame": {"x": x, "y": y, "w": w, "h": h},
                "spriteSourceSize": {"x": 0, "y": 0, "w": w, "h": h},
                "sourceSize": {"w": w, "h": h},
            }
            if f.origin is not None:
                entry["pivot"] = {"x": f.origin[0], "y": f.origin[1]}
            fr_json.append(entry)
        page[page[..., 3] == 0, :3] = 0
        # lossy WebP colour + lossless alpha: ~4x smaller than PNG, visually identical
        fn = f"game-{i}.webp"
        Image.fromarray(page, "RGBA").save(OUT_SPRITES / fn, quality=90, method=6, alpha_quality=100)
        textures.append({
            "image": fn, "format": "RGBA8888", "size": {"w": pw, "h": ph}, "scale": 1, "frames": fr_json,
        })
        info.append((pw, ph, (OUT_SPRITES / fn).stat().st_size))
    atlas = {
        "textures": textures,
        "meta": {"app": "art/process.py", "version": "1", "pxPerTile": PX_PER_TILE},
    }
    (OUT_SPRITES / "game.json").write_text(json.dumps(atlas, indent=1) + "\n")
    return info, atlas


# ------------------------------------------------------------------ compositing helpers


def over(dst: np.ndarray, src: np.ndarray) -> np.ndarray:
    """Premultiplied float 'over' (both H x W x 4, 0..1 premultiplied)."""
    return src + dst * (1 - src[..., 3:4])


def premul(img: np.ndarray) -> np.ndarray:
    f = img.astype(np.float32) / 255.0
    f[..., :3] *= f[..., 3:4]
    return f


def unpremul(f: np.ndarray) -> np.ndarray:
    a = f[..., 3:4]
    rgb = np.where(a > 1e-4, f[..., :3] / np.maximum(a, 1e-4), 0)
    out = np.concatenate([rgb, a], -1)
    out = np.clip(np.round(out * 255), 0, 255).astype(np.uint8)
    out[out[..., 3] == 0, :3] = 0
    return out


def place(canvas: np.ndarray, img: np.ndarray, origin_px, pos, angle_deg: float, scale: float = 1.0) -> None:
    """Draw img (uint8 RGBA) onto canvas (premultiplied float) like a Phaser sprite:
    origin_px of img lands on pos, rotated clockwise by angle_deg about it."""
    H, W = canvas.shape[:2]
    th = math.radians(angle_deg)
    c, s_ = math.cos(th), math.sin(th)
    # inverse map: canvas (X,Y) -> img (x,y)
    # forward: X = pos + R * scale * (x - o)
    a, b = c / scale, s_ / scale
    ox, oy = origin_px
    px, py = pos
    coeffs = (a, b, ox - a * px - b * py, -b, a, oy + b * px - a * py)
    src = Image.fromarray(img, "RGBA").convert("RGBa")
    t = src.transform((W, H), Image.Transform.AFFINE, coeffs, resample=Image.Resampling.BICUBIC)
    f = np.asarray(t).astype(np.float32) / 255.0  # already premultiplied
    canvas[:] = over(canvas, f)


def checker(w: int, h: int, s: int = 8, c1=(0.78, 0.78, 0.78), c2=(0.62, 0.62, 0.62)) -> np.ndarray:
    y, x = np.mgrid[0:h, 0:w]
    m = ((x // s + y // s) % 2).astype(bool)
    out = np.ones((h, w, 4), np.float32)
    out[..., :3] = np.where(m[..., None], c2, c1)
    return out


# ------------------------------------------------------------------ icons / ui


def make_icon(src: list, size: int = 128, fit: int = 112) -> np.ndarray:
    """Composite raw parts (turret pivot on ring centre) and fit into a size^2 icon."""
    base = src[0][0]
    H, W = base.rgba.shape[:2]
    acc = premul(base.rgba)
    for part, pivot, mount in src[1:]:
        dx, dy = mount[0] - pivot[0], mount[1] - pivot[1]
        shifted = Image.fromarray(part.rgba, "RGBA").convert("RGBa").transform(
            (W, H), Image.Transform.AFFINE, (1, 0, -dx, 0, 1, -dy), resample=Image.Resampling.BICUBIC
        )
        acc = over(acc, np.asarray(shifted).astype(np.float32) / 255.0)
    comp = Part(unpremul(acc), "icon")
    x0, y0, x1, y1 = comp.bbox()
    s = fit / max(x1 - x0, y1 - y0)
    geo = fit_frame(comp, s, (x0, y0, x1, y1), size=(size, size))
    return resample(comp, s, *geo)


def write_icons(b: Builder) -> list[Path]:
    OUT_ICONS.mkdir(parents=True, exist_ok=True)
    out = []
    for k, src in b.icon_src.items():
        img = make_icon(src)
        p = OUT_ICONS / f"{k}.webp"
        Image.fromarray(img, "RGBA").save(p, quality=90, method=6, exact=False)
        out.append(p)
    return out


def write_ui() -> list[Path]:
    OUT_UI.mkdir(parents=True, exist_ok=True)
    OUT_PWA.mkdir(parents=True, exist_ok=True)
    out = []
    for n, lim in (("keyart-portrait", (1024, 1536)), ("keyart-landscape", (1536, 1024))):
        im = Image.open(RAW / f"{n}.webp").convert("RGB")
        if im.width > lim[0] or im.height > lim[1]:
            im.thumbnail(lim, Image.Resampling.LANCZOS)
        p = OUT_UI / f"{n}.webp"
        im.save(p, quality=82, method=6)
        out.append(p)
    icon = Image.open(RAW / "icon.webp").convert("RGB")
    for sz in (192, 512):
        p = OUT_PWA / f"icon-{sz}.png"
        icon.resize((sz, sz), Image.Resampling.LANCZOS).save(p, optimize=True)
        out.append(p)
    # iOS Home Screen: exactly 180 px, opaque, square corners (iOS rounds them)
    p = OUT_PWA / "apple-touch-icon.png"
    icon.resize((180, 180), Image.Resampling.LANCZOS).save(p, optimize=True)
    out.append(p)
    return out


# ------------------------------------------------------------------ preview


def write_preview(frames: dict[str, Frame], b: Builder, meta: dict) -> Path:
    """Contact sheet over a checkerboard: every atlas frame at on-screen size
    (1/2 texture res), then every turret/head composite at texture res, each
    at 4 (hull, turret) rotations: aligned 0/0 and 90/90, then independent."""
    W, gap, label_h = 2000, 8, 16
    angles = [(0, 0), (90, 90), (200, 245), (315, 255)]
    blocks: list[tuple[str | None, Image.Image]] = []
    for f in frames.values():
        h, w = f.img.shape[:2]
        im = Image.fromarray(f.img, "RGBA").convert("RGBa")
        im = im.resize((max(1, round(w / 2)), max(1, round(h / 2))), Image.Resampling.LANCZOS)
        blocks.append((None, im.convert("RGBA")))
    n_frames = len(blocks)
    for fac in FACTIONS:
        for k, c in b.composites.items():
            base = frames[c["base"].replace("/blue/", f"/{fac}/")]
            top = frames[c["top"].replace("/blue/", f"/{fac}/")]
            bh, bw = base.img.shape[:2]
            th_, tw = top.img.shape[:2]
            bo = base.origin or (0.5, 0.5)
            to = top.origin or (0.5, 0.5)
            mx, my = (v * PX_PER_TILE for v in meta["mounts"][k])
            reach_b = max(math.hypot((bo[0] - u) * bw, (bo[1] - v) * bh) for u in (0, 1) for v in (0, 1))
            reach_t = math.hypot(mx, my) + max(
                math.hypot((to[0] - u) * tw, (to[1] - v) * th_) for u in (0, 1) for v in (0, 1)
            )
            cell = int(math.ceil(2 * max(reach_b, reach_t))) + 4
            shots = []
            for ha, ta in angles:
                view = np.zeros((cell, cell, 4), np.float32)
                cx = cy = cell / 2
                place(view, base.img, (bo[0] * bw, bo[1] * bh), (cx, cy), ha)
                t = math.radians(ha)
                wx = cx + mx * math.cos(t) - my * math.sin(t)
                wy = cy + mx * math.sin(t) + my * math.cos(t)
                place(view, top.img, (to[0] * tw, to[1] * th_), (wx, wy), ta)
                ys, xs = np.nonzero(view[..., 3] > 0.01)
                shots.append(view[max(0, ys.min() - 3):ys.max() + 4, max(0, xs.min() - 3):xs.max() + 4])
            gh = max(v.shape[0] for v in shots)
            group = np.zeros((gh, sum(v.shape[1] for v in shots) + 10 * (len(shots) - 1), 4), np.float32)
            x = 0
            for v in shots:
                oy = (gh - v.shape[0]) // 2
                group[oy:oy + v.shape[0], x:x + v.shape[1]] = v
                x += v.shape[1] + 10
            blocks.append((f"{fac} {k}", Image.fromarray(unpremul(group), "RGBA")))

    # shelf layout (composites start on a fresh shelf)
    pos, x, y, row_h = [], 0, 0, 0
    for i, (label, im) in enumerate(blocks):
        bh_ = im.height + (label_h if label else 0)
        if x + im.width > W or i == n_frames:
            x, y, row_h = 0, y + row_h + gap, 0
        pos.append((x, y))
        x += im.width + gap
        row_h = max(row_h, bh_)
    total_h = y + row_h
    canvas = checker(W, total_h)
    for (label, im), (px, py) in zip(blocks, pos):
        oy = py + (label_h if label else 0)
        f = premul(np.asarray(im))
        h, w = f.shape[:2]
        canvas[oy:oy + h, px:px + w] = over(canvas[oy:oy + h, px:px + w], f)
    img = Image.fromarray(unpremul(canvas)).convert("RGB")
    d = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=13)
    for (label, _), (px, py) in zip(blocks, pos):
        if label:
            d.rectangle([px, py, px + d.textlength(label, font=font) + 6, py + label_h - 2], fill=(20, 20, 20))
            d.text((px + 3, py + 1), label, fill=(255, 255, 255), font=font)
    OUT_PREVIEW.mkdir(parents=True, exist_ok=True)
    p = OUT_PREVIEW / "atlas-preview.png"
    img.save(p, optimize=True)
    if p.stat().st_size > 1_450_000:
        img.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(p, optimize=True)
    return p


# ------------------------------------------------------------------ main


def dump_meta(meta: dict) -> str:
    """JSON with one line per frame / mount / size entry."""
    out = ["{", f' "pxPerTile": {meta["pxPerTile"]},']
    for key in ("frames", "mounts", "sizes"):
        items = [f"  {json.dumps(k)}: {json.dumps(v)}" for k, v in meta[key].items()]
        out.append(f' "{key}": {{')
        out.append(",\n".join(items))
        out.append(" }," if key != "sizes" else " }")
    out.append("}")
    return "\n".join(out) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--no-preview", action="store_true")
    ap.add_argument("--icons-only", action="store_true", help="write only the HUD icons")
    args = ap.parse_args()

    b = Builder()
    print("units")
    b.units()
    print("buildings")
    b.buildings()
    print("objectives")
    b.objectives()
    print("portraits")
    b.portraits()
    if args.icons_only:
        print(f"{len(write_icons(b))} icons")
        return
    print("sheets")
    b.sheets()

    # red faction
    frames: dict[str, Frame] = {}
    for f in b.frames:
        frames[f.name] = f
    for f in list(b.frames):
        if "/blue/" in f.name:
            n = f.name.replace("/blue/", "/red/")
            frames[n] = Frame(n, to_red(f.img), f.origin)

    meta = {
        "pxPerTile": PX_PER_TILE,
        "frames": {n: {"origin": list(f.origin)} for n, f in sorted(frames.items()) if f.origin is not None},
        "mounts": dict(sorted(b.mounts.items())),
        "sizes": {k: b.sizes[k] for k in UNIT_ORDER},
    }
    OUT_SPRITES.mkdir(parents=True, exist_ok=True)
    (OUT_SPRITES / "meta.json").write_text(dump_meta(meta))

    info, _ = write_atlas(list(frames.values()))
    for i, (w, h, n) in enumerate(info):
        print(f"game-{i}.webp {w}x{h} {n / 1e6:.2f} MB")
    print(f"atlas total {sum(n for *_, n in info) / 1e6:.2f} MB, {len(frames)} frames")

    icons = write_icons(b)
    print(f"{len(icons)} icons")
    ui = write_ui()
    print("ui:", ", ".join(p.name for p in ui))
    if not args.no_preview:
        p = write_preview(frames, b, meta)
        print(f"preview {p} {p.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()

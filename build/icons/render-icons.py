#!/usr/bin/env python3
"""Render the NEXT HMI application icon into the packaged binary's icon assets.

Run from the repo root after changing the logo:

    python build/icons/render-icons.py

Writes nexthmi.ico (Windows EXE), nexthmi.icns (macOS) and nexthmi-<n>.png
(Linux hicolor) next to this file. The results are committed so a release build
needs nothing but PyInstaller.

The artwork mirrors frontend/public/favicon.svg — the same mark the browser tab
and the LogoMark component draw. It is re-drawn here with Pillow rather than
rasterised from that file because every SVG rasteriser available to Python
needs a native library (cairo) that the build hosts do not all carry, and the
mark is four primitives. Keep GEOMETRY in the SVG's own 48-unit viewBox
coordinates so the two can be diffed by eye; if the logo changes, both change.

Only the light-scheme branch of the favicon is baked. Its
prefers-color-scheme:dark rule exists so the mark survives a dark browser tab
bar, but a desktop icon is a fixed raster — the dark tile reads on light and
dark desktops alike, while the inverted cream tile would disappear on one.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

VIEWBOX = 48.0

TILE = "#17160f"
MARK = "#faf9f6"
ACCENT = "#7b72ee"

TILE_RADIUS = 11.0
SQUARE = 14.0
SQUARE_RADIUS = 3.5

MARK_SQUARES = [(26.0, 8.0), (8.0, 26.0)]
ACCENT_SQUARES = [(26.0, 26.0)]
ACCENT_CHEVRON = [
    (14.42, 8.0),
    (22.0, 15.0),
    (14.42, 22.0),
    (8.0, 22.0),
    (15.58, 15.0),
    (8.0, 8.0),
]

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
ICNS_SIZES = [32, 64, 128, 256, 512, 1024]
PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]


def render(size: int) -> Image.Image:
    # Supersample to ~1024px before downsampling: at 16px the chevron's diagonals
    # alias into mush if drawn at final scale.
    factor = max(4, math.ceil(1024 / size))
    working = size * factor
    scale = working / VIEWBOX

    canvas = Image.new("RGBA", (working, working), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    def box(x: float, y: float, side: float) -> list[tuple[float, float]]:
        return [(x * scale, y * scale), ((x + side) * scale - 1, (y + side) * scale - 1)]

    draw.rounded_rectangle(box(0, 0, VIEWBOX), radius=TILE_RADIUS * scale, fill=TILE)
    for x, y in MARK_SQUARES:
        draw.rounded_rectangle(box(x, y, SQUARE), radius=SQUARE_RADIUS * scale, fill=MARK)
    for x, y in ACCENT_SQUARES:
        draw.rounded_rectangle(box(x, y, SQUARE), radius=SQUARE_RADIUS * scale, fill=ACCENT)
    draw.polygon([(x * scale, y * scale) for x, y in ACCENT_CHEVRON], fill=ACCENT)

    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = Path(__file__).resolve().parent
    renders = {size: render(size) for size in sorted({*ICO_SIZES, *ICNS_SIZES, *PNG_SIZES})}

    for size in PNG_SIZES:
        renders[size].save(out / f"nexthmi-{size}.png")

    # Both writers match append_images by exact size, so each frame is its own
    # render rather than a downscale of the largest.
    largest_ico = max(ICO_SIZES)
    renders[largest_ico].save(
        out / "nexthmi.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=[renders[s] for s in ICO_SIZES if s != largest_ico],
    )

    largest_icns = max(ICNS_SIZES)
    renders[largest_icns].save(
        out / "nexthmi.icns",
        format="ICNS",
        append_images=[renders[s] for s in ICNS_SIZES if s != largest_icns],
    )

    print(f"[icons] wrote {len(PNG_SIZES)} png, nexthmi.ico, nexthmi.icns to {out}")


if __name__ == "__main__":
    main()

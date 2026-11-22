#!/usr/bin/env python3
"""Generate optimised icon assets from assets/favicon.png (one-off maintenance script)."""
from PIL import Image
from pathlib import Path

SRC = Path("assets/favicon.png")
OUT = Path("assets")

# name -> (width, height, quantised colours)
TARGETS = {
    "favicon-64.png": (64, 64, 256),
    "icon-192.png": (192, 192, 256),
    "icon-512.png": (512, 512, 256),
    "apple-touch-icon.png": (180, 180, 256),
}

img = Image.open(SRC)
print("source:", img.size, img.mode)

for name, (w, h, colors) in TARGETS.items():
    # The source is not square; crop to the centre square before resizing.
    side = min(img.size)
    left = (img.width - side) // 2
    top = (img.height - side) // 2
    square = img.crop((left, top, left + side, top + side))
    out = square.resize((w, h), Image.Resampling.LANCZOS)
    # Preserve alpha while quantising (alpha dithering off keeps edges clean).
    out = out.quantize(colors=colors, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    path = OUT / name
    out.save(path, "PNG", optimize=True)
    print(name, path.stat().st_size, "bytes")

total = sum((OUT / n).stat().st_size for n in TARGETS)
print("total:", total, "bytes")

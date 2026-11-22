#!/usr/bin/env python3
"""Generate the optimised icon set from the versioned source asset.

Source of truth: ``assets/icon-source.png`` (512x512, committed to the repo).
Every icon referenced by ``index.html``/``manifest.json`` is derived from that
file, so regenerating on any machine with Pillow installed reproduces the
committed PNGs deterministically (same Pillow version assumed).

Usage:
    pip install pillow  # once
    python3 scripts/make-icons.py

After changing the source or this script, regenerate, then commit the updated
PNGs together with the script change (see README "Assets").
"""
from PIL import Image
from pathlib import Path

SRC = Path("assets/icon-source.png")
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
    # The source is square; resize directly to the target size.
    out = img.resize((w, h), Image.Resampling.LANCZOS)
    # Preserve alpha while quantising (alpha dithering off keeps edges clean).
    out = out.quantize(colors=colors, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    path = OUT / name
    out.save(path, "PNG", optimize=True)
    print(name, path.stat().st_size, "bytes")

total = sum((OUT / n).stat().st_size for n in TARGETS)
print("total:", total, "bytes")

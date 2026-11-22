#!/usr/bin/env python3
"""Compose the preview contact sheets (plain Python 3 + Pillow).

  python3 scripts/make_sheets.py
Reads previews/<name>_{front,34,side,back,face}.png, references/<name>.png and the browser-test
screenshots in previews/viewer/, writes previews/<name>_sheet.png, <name>_vs_reference.png,
animations.png and expressions.png.
"""

import os

from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
P = os.path.join(ROOT, "previews")
BG = (23, 24, 28)


def row(paths, h):
    ims = [Image.open(p).convert("RGB") for p in paths]
    ims = [im.resize((int(im.width * h / im.height), h)) for im in ims]
    s = Image.new("RGB", (sum(i.width for i in ims), h), BG)
    x = 0
    for im in ims:
        s.paste(im, (x, 0))
        x += im.width
    return s


def grid(items, cols, cell, crop, label=True):
    rows = (len(items) + cols - 1) // cols
    s = Image.new("RGB", (cols * cell[0], rows * (cell[1] + 20)), BG)
    d = ImageDraw.Draw(s)
    for i, (name, path) in enumerate(items):
        im = Image.open(path).convert("RGB").crop(crop).resize(cell)
        x, y = (i % cols) * cell[0], (i // cols) * (cell[1] + 20)
        s.paste(im, (x, y + 20))
        if label:
            d.text((x + 8, y + 4), name, fill=(230, 230, 235))
    return s


for c in ("male", "female"):
    views = [os.path.join(P, f"{c}_{v}.png") for v in ("front", "34", "side", "back", "face")]
    if not all(map(os.path.exists, views)):
        continue
    row(views, 600).save(os.path.join(P, f"{c}_sheet.png"))
    ref = Image.open(os.path.join(ROOT, "references", f"{c}.png")).convert("RGB")
    ref = ref.resize((int(ref.width * 600 / ref.height), 600))
    ours = row([views[0], views[1], views[4]], 600)
    s = Image.new("RGB", (ref.width + ours.width, 600), BG)
    s.paste(ref, (0, 0))
    s.paste(ours, (ref.width, 0))
    s.save(os.path.join(P, f"{c}_vs_reference.png"))

V = os.path.join(P, "viewer")
clips = ["Idle", "Walk", "Run", "Wave", "Sit", "Talk", "Dance", "Greet"]
if all(os.path.exists(os.path.join(V, f"clip_{c}.png")) for c in clips):
    grid([(c, os.path.join(V, f"clip_{c}.png")) for c in clips], 4, (400, 304), (140, 40, 1140, 800)).save(
        os.path.join(P, "animations.png"))
faces = ["Smile", "Excited", "Surprised", "Thinking", "Wink", "Blink", "MouthOpen"]
if all(os.path.exists(os.path.join(V, f"face_{c}.png")) for c in faces):
    grid([(c, os.path.join(V, f"face_{c}.png")) for c in faces], 4, (400, 180), (240, 200, 1040, 560)).save(
        os.path.join(P, "expressions.png"))
print("sheets written to", P)

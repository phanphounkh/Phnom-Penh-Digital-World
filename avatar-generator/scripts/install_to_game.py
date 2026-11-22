#!/usr/bin/env python3
"""Copy the game-quality avatars into the web game (plain Python 3).

  python3 scripts/install_to_game.py
→ frontend/static/models/characters/realistic/{male,female}.glb and manifest.json, which
  frontend/src/lib/game/avatar/realistic.ts reads (palette cells, base colours, clips, morphs).
Run after export (and meshopt compression) — build_all.sh does.
"""

import json
import os
import shutil

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "output")
DEST = os.path.abspath(os.path.join(ROOT, "..", "frontend", "static", "models", "characters", "realistic"))


def main():
    os.makedirs(DEST, exist_ok=True)
    manifest = {"version": 1, "characters": {}}
    for kind in ("male", "female"):
        glb = os.path.join(OUT, f"{kind}_avatar_game.glb")
        meta = os.path.join(OUT, f"{kind}_avatar_game.json")
        if not (os.path.exists(glb) and os.path.exists(meta)):
            raise SystemExit(f"missing {glb} or {meta}: run the build first")
        shutil.copyfile(glb, os.path.join(DEST, f"{kind}.glb"))
        with open(meta) as f:
            m = json.load(f)
        m["file"] = f"{kind}.glb"
        manifest["characters"][kind] = m
        print(f"installed {kind}.glb ({os.path.getsize(glb) / 1e6:.2f} MB)")
    with open(os.path.join(DEST, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("→", DEST)


if __name__ == "__main__":
    main()

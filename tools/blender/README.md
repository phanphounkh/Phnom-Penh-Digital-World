# Blender asset pipeline

| Script | Output | Notes |
|---|---|---|
| `generate_avatars.py` | `frontend/static/models/characters/avatar.glb` | Modular player avatar (Phnom Penh Digital World) |
| `generate_assets.py` | `frontend/static/models/**` (29 GLBs) | Original CampusEats characters, food, equipment and food court |

```bash
blender --background --python-use-system-env --python tools/blender/generate_avatars.py
blender --background --python tools/blender/generate_assets.py   # CAMPUSEATS_ASSET_FILTER=characters/ for a subset
```

Built with Blender 4.3.2. The glTF exporter needs NumPy in Blender's Python. If yours lacks it:
`uv pip install --python /usr/bin/python3.13 --target /tmp/blender-deps numpy`, then add
`PYTHONPATH=/tmp/blender-deps`.

## Avatar contract (relied on by the web client and tests)

* **Rig:** `BodyRoot` → `Left/RightLeg` → `Knee` → `Ankle`; `Left/RightArm` → `Elbow` → `Wrist`.
  It matches the CampusEats rig, so `PlayerAnimations.js` drives it unchanged.
* **Recolourable materials:** `Skin`, `Hair`, `Top`, `Bottom`, `Shoes`, `Accent`, `AccentDark`.
* **Optional parts:** `opt__<group>-<value>__<part>`, for example `opt__hair-bun__bun`. The client
  keeps the parts that match the player's choices. Groups and values: `body-a|b`,
  `top-hoodie|tee`, `bottom-trousers|shorts`, `hair-short|long|bun|buzz`,
  `acc-cap|glasses|backpack|krama`.
* `frontend/src/lib/game/avatar/avatar.test.ts` fails if any offered option is missing from the GLB.

All models are original, built from primitives and tailored surfaces; licence CC0. They are
stylised low-poly, **not** photorealistic. City buildings are generated at runtime from OSM
footprints, not modelled in Blender. Landmark models and street furniture are Phase 2 work.

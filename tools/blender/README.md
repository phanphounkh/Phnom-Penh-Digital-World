# Blender asset pipeline

| Script | Output | Notes |
|---|---|---|
| `generate_avatars.py` | `frontend/static/models/characters/avatar.glb` | Modular player avatar (Phnom Penh Digital World) |
| `generate_city_assets.py` | `frontend/static/models/city/*.glb`, `landmarks/*.glb` | Rain tree, ornamental tree, sugar palm, double-arm lamp, traffic signal, sign post; Phsar Thmei dome (real scale), Khmer stupa |
| `compress_glb.mjs` | (in place) | Meshopt compression of the Phnom Penh Digital World GLBs (`cd frontend && npm run assets:compress`) |
| `generate_assets.py` | `frontend/static/models/**` (29 GLBs) | Original CampusEats characters, food, equipment and food court |

```bash
blender --background --python-use-system-env --python tools/blender/generate_avatars.py
blender --background --python-use-system-env --python tools/blender/generate_city_assets.py
(cd frontend && npm run assets:compress)      # Meshopt; the client decodes with MeshoptDecoder
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

## City asset contract (relied on by `frontend/src/lib/game/city/props.ts` and `assemble.ts`)

* Units are metres, Y is up after export, and the origin is at ground level, centred on the footprint.
* Semantic material names, shared by name at runtime: `Bark`, `Leaves`, `Metal`, `Lamp`
  (glows at night), `Signal*`, `Stucco`, `Gold`, `Concrete`, `Louvre`, `Glass`.
* Street furniture is instanced by the hundred: keep it low-poly.
* The landmark models are built at real scale and fitted to OSM footprints at runtime: the dome
  is 23 m in radius and 16 m tall; the stupa has a 10.4 m plinth and is 16.9 m tall.
* Preview everything at **`/dev/assets`** (dev server only).

All models are original, built from primitives and tailored surfaces; licence CC0. They are
stylised low-poly, **not** photorealistic. City buildings are generated at runtime from OSM
footprints, not modelled in Blender.

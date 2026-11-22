# Blender asset pipeline

| Script | Output | Notes |
|---|---|---|
| `generate_avatars.py` | `frontend/static/models/characters/avatar.glb` | Modular player avatar (Phnom Penh Digital World) |
| `generate_city_assets.py` | `frontend/static/models/city/*.glb`, `landmarks/*.glb` | Rain tree, ornamental tree, sugar palm, shrub (crowns of leaf clumps with bent normals and baked vertex-colour occlusion, clamped to ≤ 1), double-arm lamp, traffic signal, sign post; Phsar Thmei dome (real scale), Khmer stupa. Regenerate one family with `PPW_ASSET_FILTER=city/tree` |
| `generate_shop_assets.py` | `frontend/static/models/shop/*.glb` | Shop shelf, island table, awning, generic product models (Phase 4) |
| `generate_vehicle_assets.py` | `frontend/static/models/vehicles/*.glb` | Step-through city bicycle with basket, generic underbone motorbike (Phase 5) |
| `generate_house.py` | `frontend/static/models/buildings/house-riverside.{glb,json}`, `house-riverside-light{,-night}.webp` | The enterable house: walls with real door and window openings, a hinged door, a furnished room, and a lightmap baked with Cycles on the CPU (about 6 min at the default 256 samples; `PPW_BAKE_SAMPLES=16` for a quick draft, `PPW_HOUSE_PREVIEW=/tmp/house` writes Cycles stills) |
| `compress_glb.mjs` | (in place) | Meshopt compression of the Phnom Penh Digital World GLBs (`cd frontend && npm run assets:compress`) |
| `generate_assets.py` | `frontend/static/models/**` (29 GLBs) | Original CampusEats characters, food, equipment and food court |

```bash
blender --background --python-use-system-env --python tools/blender/generate_avatars.py
blender --background --python-use-system-env --python tools/blender/generate_city_assets.py
blender --background --python-use-system-env --python tools/blender/generate_shop_assets.py
blender --background --python-use-system-env --python tools/blender/generate_vehicle_assets.py
blender --background --python-use-system-env --python tools/blender/generate_house.py
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

## Vehicle contract (relied on by `frontend/src/lib/game/vehicles/VehicleModels.ts` and `Rider.ts`)

* Metres, Y up, origin on the ground midway between the wheels; the vehicle faces **+Z** after
  export (Blender −Y), like the avatar.
* Nodes: `Body` (static), `Steer` (empty at the steering head; rotate about Y), `WheelFront`
  (child of `Steer`) and `WheelRear` (origins at the hubs; spin about X).
* Anchor empties for the rider: `Seat`, `GripL`/`GripR`, `PegL`/`PegR` (`L` = −X, the side of the
  rig's `LeftArm`/`LeftLeg`); the bicycle also has `Crank` (the pedals turn about it).
* Materials: `Paint` and `PaintDark` are recoloured per vehicle; `Light` and `TailLight` glow at
  night; `Plate` is the (virtual) number plate.
* Both models are generic: no real make or model is reproduced.

## Enterable building contract (relied on by `frontend/src/lib/game/buildings/`)

* Metres, Y up, origin at ground level in the centre of the footprint, front door facing **+Z**.
* Nodes: `Exterior` (PBR, lit by the game's sun and shadows), `Interior` (made unlit by the client
  and multiplied by the lightmap on `TEXCOORD_1`), `Glass`, `Door` (origin on the hinge axis; opens
  by `+rotation.y`), `Fan` (origin on its axis; turns about Y).
* Plain-coloured faces are merged into one vertex-coloured material per node (`Ext_Painted`,
  `Int_Painted`), so the house costs about 16 draw calls instead of one per colour. `Int_Bulb` and
  `Int_LampShade` glow at full brightness.
* The JSON spec next to the GLB holds what the game cannot read from a mesh: wall rectangles
  (the doorway is a gap between them), the lintel (blocks the camera above the door only), door
  hinge/width/swing, porch and step heights, furniture footprints, seats (hip position, facing,
  stand-up spot), the interior volume and ceiling, and the lightmap's scale.

All models are original, built from primitives and tailored surfaces; licence CC0. They are
stylised low-poly, **not** photorealistic. City buildings are generated at runtime from OSM
footprints, not modelled in Blender, except the enterable house, which is placed on open land.

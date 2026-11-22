"""An enterable Phnom Penh house for Phnom Penh Digital World (original work, CC0).

Run:  blender --background --python-use-system-env --python tools/blender/generate_house.py
      (PPW_BAKE_SAMPLES=32 for a quick, noisier bake)
Writes, in frontend/static/models/buildings/:
  house-riverside.glb        the model (meshopt-compress it with `npm run assets:compress`)
  house-riverside-light.webp the interior lightmaps, day and night (-night: lamps only),
                             baked here with Cycles on the CPU
  house-riverside.json       the building spec the game reads: walls, door, furniture blockers,
                             floor, seats, interior volume (src/lib/game/buildings/spec.ts)

A single-storey rendered-brick house of the kind found along Phnom Penh's side streets:
ochre plaster, louvred teal shutters, window grilles, a terracotta hip roof, a tiled porch with a
concrete canopy, and one furnished living room: sofa, armchair, coffee table on a rug, a dining
corner, a sideboard, a floor lamp, a ceiling fan with a bulb, a painting, a clock and plants.
The floor is encaustic cement tile, the classic Phnom Penh pattern.

Conventions (game coordinates are used throughout and converted for Blender by B()):
* Metres; the game's X is east-west in the model, Z points out of the front door (+Z), Y is up.
  Blender is Z-up with the front facing -Y; glTF export turns that back into the game's frame.
* The origin is at ground level in the centre of the footprint. The floor is FLOOR above it.
* Node names the client relies on: Exterior (lit by the game), Interior (unlit, lightmapped on
  TEXCOORD_1), Glass, Door (origin on the hinge axis; opens by +rotation.y), Fan (origin on the
  rotation axis). Interior material names start with "Int_".
"""

import json
import math
import os
import random
import tempfile

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.abspath(os.environ.get("PPW_MODEL_OUTPUT", os.path.join(os.path.dirname(__file__), "../../frontend/static/models/buildings")))
NAME = "house-riverside"
SAMPLES = int(os.environ.get("PPW_BAKE_SAMPLES", "256"))
LIGHTMAP_SIZE = int(os.environ.get("PPW_LIGHTMAP_SIZE", "1024"))
TMP = tempfile.mkdtemp(prefix="ppw-house-")  # generated textures (packed into the GLB)
random.seed(855)

# ── Dimensions (metres, game frame) ──────────────────────────────────────────────────────
W, D = 8.0, 6.6  # outer footprint: X width, Z depth
T = 0.2  # wall thickness
FLOOR = 0.15  # floor top above the ground
WALL_TOP = FLOOR + 3.0
CEIL = FLOOR + 2.85  # ceiling underside
IX, IZ = W / 2 - T, D / 2 - T  # inner half extents
DOOR_X, DOOR_W, DOOR_H = -1.6, 1.0, 2.2  # centre, opening width and height (above the floor)
DOOR_TOP = FLOOR + DOOR_H
LEAF_W, LEAF_T = DOOR_W - 0.04, 0.045
HINGE = (DOOR_X - DOOR_W / 2 + 0.02, D / 2 - T / 2)  # left jamb seen from the street, mid-wall
# Windows: (wall, centre along the wall, width, height, sill above the floor)
WINDOWS = [("front", 1.6, 1.4, 1.35, 0.9), ("back", 1.8, 1.2, 1.3, 0.95), ("left", 1.6, 1.2, 1.3, 0.95), ("right", -1.0, 1.2, 1.3, 0.95)]
PORCH = (DOOR_X - 1.3, DOOR_X + 1.3, D / 2, D / 2 + 1.5)  # x0, x1, z0, z1
STEP = (PORCH[0], PORCH[1], PORCH[3], PORCH[3] + 0.35)
ROOF_OVERHANG, ROOF_PITCH = 0.55, math.radians(26)


def B(x, z, y=0.0):
    """Game (x, z, y-up) → Blender location."""
    return Vector((x, -z, y))


# ── Textures (Pillow, original drawings) ─────────────────────────────────────────────────
def hexrgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def tex_floor(path):
    """Encaustic cement tiles, 4 x 4 tiles of 20 cm: a star-and-octagon motif."""
    n, px = 4, 128
    img = Image.new("RGB", (n * px, n * px), hexrgb("#e9e1cf"))
    g = ImageDraw.Draw(img)
    red, teal, ochre, cream = hexrgb("#a8452f"), hexrgb("#2f6b66"), hexrgb("#c9953d"), hexrgb("#efe7d6")
    for i in range(n):
        for j in range(n):
            x0, y0 = i * px, j * px
            c = (x0 + px / 2, y0 + px / 2)
            g.rectangle([x0, y0, x0 + px - 1, y0 + px - 1], fill=cream)
            # quarter circles in the corners join into rings across four tiles
            for cx, cy in ((x0, y0), (x0 + px, y0), (x0, y0 + px), (x0 + px, y0 + px)):
                g.ellipse([cx - 34, cy - 34, cx + 34, cy + 34], fill=teal)
                g.ellipse([cx - 22, cy - 22, cx + 22, cy + 22], fill=cream)
            star = []
            for k in range(16):
                r = 46 if k % 2 == 0 else 20
                a = k * math.pi / 8 + math.pi / 16
                star.append((c[0] + r * math.cos(a), c[1] + r * math.sin(a)))
            g.polygon(star, fill=red)
            g.ellipse([c[0] - 11, c[1] - 11, c[0] + 11, c[1] + 11], fill=ochre)
            g.line([x0, y0, x0 + px, y0], fill=hexrgb("#cfc5b0"), width=2)
            g.line([x0, y0, x0, y0 + px], fill=hexrgb("#cfc5b0"), width=2)
    noise = (np.random.default_rng(3).normal(0, 6, (n * px, n * px, 1))).astype(np.int16)
    a = np.clip(np.asarray(img).astype(np.int16) + noise, 0, 255).astype(np.uint8)
    Image.fromarray(a).save(path)


def tex_roof(path):
    """Terracotta tile rows (one texture = 1 m x 1 m: 5 rows of 20 cm, 4 tiles of 25 cm)."""
    n = 512
    rng = np.random.default_rng(7)
    shade = rng.uniform(0.85, 1.1, (5, 4))
    y = np.arange(n)[:, None].repeat(n, 1)
    x = np.arange(n)[None, :].repeat(n, 0)
    row = np.minimum(4, y * 5 // n)
    t = (y * 5 / n) - row
    xs = x + (row % 2) * (n // 8)
    col = (xs // (n // 4)) % 4
    fx = (xs % (n // 4)) / (n // 4)
    curve = 0.78 + 0.32 * np.sin(np.pi * fx)  # rounded tile profile
    lip = np.where(t > 0.9, 0.62, 1.0)  # shadow under the next row's lip
    k = curve * lip * shade[row, col] * (0.92 + 0.12 * t)
    base = np.array(hexrgb("#b5552f"), dtype=float)
    a = np.clip(base[None, None, :] * k[..., None], 0, 255).astype(np.uint8)
    Image.fromarray(a).filter(ImageFilter.GaussianBlur(0.6)).save(path)


def tex_wood(path, color="#7a4a2b", seed=1):
    rng = np.random.default_rng(seed)
    w, h = 256, 256
    y = np.arange(h)[:, None]
    x = np.arange(w)[None, :]
    grain = np.sin((x * 0.09 + 6 * np.sin(y * 0.02 + rng.uniform(0, 6)) + rng.normal(0, 0.3, (h, w))) * 1.7)
    base = np.array(hexrgb(color), dtype=float)
    a = base[None, None, :] * (0.86 + 0.1 * grain[..., None])
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(path)


def tex_rug(path):
    """A woven rug with a Khmer-style border (original pattern)."""
    w, h = 512, 360
    img = Image.new("RGB", (w, h), hexrgb("#8e2f2a"))
    g = ImageDraw.Draw(img)
    g.rectangle([18, 18, w - 19, h - 19], outline=hexrgb("#e2b75c"), width=10)
    g.rectangle([40, 40, w - 41, h - 41], fill=hexrgb("#24324a"))
    for k in range(0, w, 32):
        g.polygon([(k, 6), (k + 16, 16), (k + 32, 6)], fill=hexrgb("#e2b75c"))
        g.polygon([(k, h - 7), (k + 16, h - 17), (k + 32, h - 7)], fill=hexrgb("#e2b75c"))
    cx, cy = w / 2, h / 2
    for r, col in ((120, "#b9893f"), (92, "#8e2f2a"), (60, "#e2b75c"), (30, "#24324a")):
        g.polygon([(cx - r * 1.4, cy), (cx, cy - r), (cx + r * 1.4, cy), (cx, cy + r)], fill=hexrgb(col))
    rng = np.random.default_rng(5)
    a = np.asarray(img).astype(np.int16) + rng.normal(0, 7, (h, w, 1)).astype(np.int16)
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(path)


def tex_painting(path):
    """A sunset over temple towers, painted in flat layers (original drawing)."""
    w, h = 512, 320
    img = Image.new("RGB", (w, h))
    g = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        g.line([0, y, w, y], fill=(int(250 - 60 * t), int(170 - 70 * t), int(90 + 40 * t)))
    g.ellipse([300, 120, 380, 200], fill=hexrgb("#ffd98a"))
    sil = hexrgb("#3b2a33")
    for cx, tw, th in ((150, 60, 170), (230, 80, 210), (330, 60, 165)):
        for k in range(5):
            ww, y0 = tw * (1 - k * 0.17), h - th * (k + 1) / 5
            g.rectangle([cx - ww / 2, y0, cx + ww / 2, h], fill=sil)
        g.polygon([(cx - tw * 0.16, h - th), (cx, h - th - 30), (cx + tw * 0.16, h - th)], fill=sil)
    g.rectangle([0, h - 40, w, h], fill=hexrgb("#2b3b33"))
    g.rectangle([0, 0, w - 1, h - 1], outline=hexrgb("#6b4a2a"), width=14)
    img.save(path)


# ── Materials ───────────────────────────────────────────────────────────────────────────
MATS: dict[str, bpy.types.Material] = {}


def mat(name, color="#ffffff", rough=0.85, metal=0.0, image=None, emission=0.0, alpha=1.0):
    if name in MATS:
        return MATS[name]
    rgb = tuple((v / 255) ** 2.2 for v in hexrgb(color))
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*rgb, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if image:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(image)
        t.name = "albedo"
        nt.links.new(t.outputs["Color"], p.inputs["Base Color"])
    if emission:
        p.inputs["Emission Color"].default_value = (*rgb, 1)
        p.inputs["Emission Strength"].default_value = emission
    if alpha < 1:
        p.inputs["Alpha"].default_value = alpha
        m.blend_method = "BLEND"
    m.diffuse_color = (*rgb, 1)
    MATS[name] = m
    return m


# ── Geometry helpers ─────────────────────────────────────────────────────────────────────
GROUPS: dict[str, list] = {"Exterior": [], "Interior": [], "Glass": [], "Door": [], "Fan": [], "Bake": []}


def put(o, group):
    GROUPS[group].append(o)
    return o


def apply_all(o):
    bpy.context.view_layer.objects.active = o
    for other in bpy.context.selected_objects:
        other.select_set(False)
    o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def box(name, x0, x1, z0, z1, y0, y1, material, group, bevel=0.0):
    """Axis-aligned box from game-frame extents."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=B((x0 + x1) / 2, (z0 + z1) / 2, (y0 + y1) / 2))
    o = bpy.context.object
    o.name = name
    o.scale = (x1 - x0, z1 - z0, y1 - y0)
    apply_all(o)
    o.data.materials.append(material)
    if bevel:
        mod = o.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return put(o, group)


def cyl(name, x, z, y0, y1, r, material, group, verts=12, r2=None):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r if r2 is None else r2, depth=y1 - y0, location=B(x, z, (y0 + y1) / 2))
    o = bpy.context.object
    o.name = name
    o.data.materials.append(material)
    for poly in o.data.polygons:
        poly.use_smooth = True
    return put(o, group)


def ball(name, x, z, y, r, material, group, scale=(1, 1, 1), sub=2):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=sub, radius=r, location=B(x, z, y))
    o = bpy.context.object
    o.name = name
    o.scale = scale
    apply_all(o)
    o.data.materials.append(material)
    for poly in o.data.polygons:
        poly.use_smooth = True
    return put(o, group)


def place(objs, x, z, yaw):
    """Rotate a set of objects (built around the origin, facing +Z) and move them to (x, z)."""
    m = Matrix.Translation(B(x, z)) @ Matrix.Rotation(yaw, 4, "Z")
    for o in objs:
        o.matrix_world = m @ o.matrix_world
        apply_all(o)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    return objs


def box_uv(o, scale=1.0, name="UVMap"):
    """Box-projected UVs in metres (x scale): textures tile at real-world size."""
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    uv = bm.loops.layers.uv.get(name) or bm.loops.layers.uv.new(name)
    mw = o.matrix_world
    for f in bm.faces:
        n = mw.to_3x3() @ f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for loop in f.loops:
            p = mw @ loop.vert.co
            u, v = ((p.y, p.z) if ax == 0 else (p.x, p.z) if ax == 1 else (p.x, p.y))
            loop[uv].uv = (u * scale, v * scale)
    bm.to_mesh(me)
    bm.free()


def boolean_cut(o, cutters):
    for c in cutters:
        mod = o.modifiers.new("cut", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "EXACT"
        mod.object = c
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=mod.name)
    for c in cutters:
        bpy.data.objects.remove(c, do_unlink=True)


def split_faces(o, index):
    """Move the faces using material slot `index` into a new object, which is returned."""
    for other in bpy.context.selected_objects:
        other.select_set(False)
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    o.active_material_index = index
    bpy.ops.object.material_slot_select()
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    return next(x for x in bpy.context.selected_objects if x != o)


def classify_wall_faces(o, ext, jamb, inner):
    """Faces looking into the room get the interior material, faces looking out the exterior
    one, faces inside openings (jambs, sills, lintels) the jamb material."""
    mats = o.data.materials
    mats.clear()
    for m in (ext, jamb, inner):
        mats.append(m)
    mw = o.matrix_world
    for poly in o.data.polygons:
        c = mw @ poly.center
        n = (mw.to_3x3() @ poly.normal).normalized()
        gx, gz = c.x, -c.y
        nx, nz = n.x, -n.y
        if abs(n.z) > 0.7:
            poly.material_index = 1
            continue
        px, pz = gx + nx * 0.05, gz + nz * 0.05
        inside = abs(px) < IX - 1e-3 and abs(pz) < IZ - 1e-3
        outside = abs(px) > W / 2 + 1e-3 or abs(pz) > D / 2 + 1e-3
        poly.material_index = 2 if inside else 0 if outside else 1


# ── The house ───────────────────────────────────────────────────────────────────────────
def build(tex):
    plaster = mat("Ext_Plaster", "#e2b968", 0.92)
    jamb = mat("Ext_Jamb", "#ecd29a", 0.9)
    plinth = mat("Ext_Plinth", "#8f8a80", 0.95)
    porch_tile = mat("Ext_PorchTile", "#b9a68a", 0.8)
    roof = mat("Ext_Roof", "#ffffff", 0.75, image=tex["roof"])
    soffit = mat("Ext_Soffit", "#efe6d2", 0.9)
    fascia = mat("Ext_Fascia", "#f3efe6", 0.8)
    shutter = mat("Ext_Shutter", "#2f7b72", 0.7)
    frame = mat("Ext_Frame", "#f4f1ea", 0.6)
    metal = mat("Ext_Metal", "#2a2c2e", 0.5, metal=0.6)
    concrete = mat("Ext_Concrete", "#d9d3c7", 0.9)
    wall_in = mat("Int_Wall", "#f1ead8", 0.95)
    dado = mat("Int_Dado", "#b9c9b5", 0.9)
    ceiling = mat("Int_Ceiling", "#fbf8f0", 0.95)
    floor = mat("Int_Floor", "#ffffff", 0.6, image=tex["floor"])
    wood = mat("Int_Wood", "#ffffff", 0.6, image=tex["wood"])
    wood_dark = mat("Int_WoodDark", "#ffffff", 0.55, image=tex["wood_dark"])
    fabric = mat("Int_Fabric", "#5b6f8a", 0.95)
    cushion = mat("Int_Cushion", "#d8b26a", 0.95)
    rug = mat("Int_Rug", "#ffffff", 0.95, image=tex["rug"])
    painting = mat("Int_Painting", "#ffffff", 0.7, image=tex["painting"])
    shade = mat("Int_LampShade", "#fff1d2", 0.8, emission=2.0)
    bulb = mat("Int_Bulb", "#fff6e0", 0.3, emission=6.0)
    leaves = mat("Int_Leaves", "#4e7a3a", 0.8)
    pot = mat("Int_Pot", "#a5583a", 0.85)
    ceramic = mat("Int_Ceramic", "#f2efe8", 0.4)
    int_metal = mat("Int_Metal", "#3a3c3e", 0.5, metal=0.5)
    int_frame = mat("Int_Frame", "#f6f3ec", 0.6)
    glass = mat("Glass", "#9fc2c8", 0.05, alpha=0.22)
    door_wood = mat("Door_Wood", "#ffffff", 0.55, image=tex["door"])
    door_metal = mat("Door_Metal", "#c8a24a", 0.35, metal=0.9)
    fan_wood = mat("Fan_Wood", "#5a3b26", 0.6)
    fan_metal = mat("Fan_Metal", "#e9e6df", 0.4, metal=0.6)

    # Plinth, floor, porch, steps.
    box("Plinth", -W / 2 - 0.06, W / 2 + 0.06, -D / 2 - 0.06, D / 2 + 0.06, -0.3, FLOOR - 0.005, plinth, "Exterior")
    f = box("Floor", -IX, IX, -IZ, IZ, FLOOR - 0.02, FLOOR, floor, "Interior")
    box_uv(f, 1 / 0.8)
    f["uv_done"] = True
    th = box("Threshold", DOOR_X - DOOR_W / 2, DOOR_X + DOOR_W / 2, IZ, D / 2 + 0.02, FLOOR - 0.02, FLOOR + 0.004, concrete, "Exterior")
    p = box("Porch", *PORCH, -0.3, FLOOR, porch_tile, "Exterior")
    box_uv(p, 2.5)
    p["uv_done"] = True
    box("Step", *STEP, -0.3, FLOOR / 2, porch_tile, "Exterior")

    # Walls with real openings.
    walls = [
        box("WallFront", -W / 2, W / 2, D / 2 - T, D / 2, FLOOR, WALL_TOP, plaster, "Exterior"),
        box("WallBack", -W / 2, W / 2, -D / 2, -D / 2 + T, FLOOR, WALL_TOP, plaster, "Exterior"),
        box("WallLeft", -W / 2, -W / 2 + T, -D / 2 + T, D / 2 - T, FLOOR, WALL_TOP, plaster, "Exterior"),
        box("WallRight", W / 2 - T, W / 2, -D / 2 + T, D / 2 - T, FLOOR, WALL_TOP, plaster, "Exterior"),
    ]
    by_name = {"front": walls[0], "back": walls[1], "left": walls[2], "right": walls[3]}
    cut = lambda x0, x1, z0, z1, y0, y1: box("cutter", x0, x1, z0, z1, y0, y1, plaster, "Bake")
    cutters = {"front": [cut(DOOR_X - DOOR_W / 2, DOOR_X + DOOR_W / 2, D / 2 - T - 0.2, D / 2 + 0.2, FLOOR - 0.01, DOOR_TOP)], "back": [], "left": [], "right": []}
    for wall, a, w, h, sill in WINDOWS:
        y0, y1 = FLOOR + sill, FLOOR + sill + h
        if wall in ("front", "back"):
            z = D / 2 - T / 2 if wall == "front" else -D / 2 + T / 2
            cutters[wall].append(cut(a - w / 2, a + w / 2, z - 0.3, z + 0.3, y0, y1))
        else:
            x = -W / 2 + T / 2 if wall == "left" else W / 2 - T / 2
            cutters[wall].append(cut(x - 0.3, x + 0.3, a - w / 2, a + w / 2, y0, y1))
    for name, o in by_name.items():
        GROUPS["Bake"] = [g for g in GROUPS["Bake"] if g not in cutters[name]]
        boolean_cut(o, cutters[name])
        classify_wall_faces(o, plaster, jamb, wall_in)
        box_uv(o, 1.0)
        o["uv_done"] = True
        inner = split_faces(o, 2)  # room-facing plaster is lightmapped with the interior
        inner.name = o.name + "Inner"
        inner["uv_done"] = True
        put(inner, "Interior")

    # Interior finishes: ceiling, a painted dado band, skirting.
    c = box("Ceiling", -IX, IX, -IZ, IZ, CEIL, CEIL + 0.02, ceiling, "Interior")
    for z0, z1, x0, x1 in ((IZ - 0.012, IZ, -IX, DOOR_X - DOOR_W / 2), (IZ - 0.012, IZ, DOOR_X + DOOR_W / 2, IX), (-IZ, -IZ + 0.012, -IX, IX)):
        box("Dado", x0, x1, z0, z1, FLOOR, FLOOR + 0.9, dado, "Interior")
        box("Skirting", x0, x1, z0 - 0.006 if z0 > 0 else z0, z1 + 0.006 if z0 < 0 else z1, FLOOR, FLOOR + 0.1, wood_dark, "Interior")
    for x0, x1 in ((-IX, -IX + 0.012), (IX - 0.012, IX)):
        box("Dado", x0, x1, -IZ, IZ, FLOOR, FLOOR + 0.9, dado, "Interior")
        box("Skirting", x0 - 0.006 if x0 < 0 else x0, x1 + 0.006 if x0 > 0 else x1, -IZ, IZ, FLOOR, FLOOR + 0.1, wood_dark, "Interior")
    # The dado must not cover window openings that come low: all sills are above 0.9 m.

    # Door frame (architraves) on both faces, and the door leaf on its hinge.
    for z, m, grp in ((D / 2 + 0.015, frame, "Exterior"), (IZ - 0.015, int_frame, "Interior")):
        zz0, zz1 = (z - 0.015, z + 0.015)
        box("Architrave", DOOR_X - DOOR_W / 2 - 0.1, DOOR_X - DOOR_W / 2, zz0, zz1, FLOOR, DOOR_TOP, m, grp)
        box("Architrave", DOOR_X + DOOR_W / 2, DOOR_X + DOOR_W / 2 + 0.1, zz0, zz1, FLOOR, DOOR_TOP, m, grp)
        box("Architrave", DOOR_X - DOOR_W / 2 - 0.1, DOOR_X + DOOR_W / 2 + 0.1, zz0, zz1, DOOR_TOP, DOOR_TOP + 0.1, m, grp)
    hx, hz = HINGE
    leaf = [
        box("Leaf", hx, hx + LEAF_W, hz - LEAF_T / 2, hz + LEAF_T / 2, FLOOR + 0.01, DOOR_TOP - 0.01, door_wood, "Door"),
    ]
    for y0, y1 in ((FLOOR + 0.18, FLOOR + 1.0), (FLOOR + 1.2, DOOR_TOP - 0.2)):
        for side in (1, -1):
            zz = hz + side * LEAF_T / 2
            leaf.append(box("Panel", hx + 0.14, hx + LEAF_W - 0.14, min(zz, zz + side * 0.012), max(zz, zz + side * 0.012), y0, y1, door_wood, "Door", bevel=0.006))
    for side in (1, -1):
        zz = hz + side * (LEAF_T / 2 + 0.035)
        leaf.append(box("Handle", hx + LEAF_W - 0.17, hx + LEAF_W - 0.06, zz - 0.012, zz + 0.012, FLOOR + 1.0, FLOOR + 1.03, door_metal, "Door"))
        leaf.append(box("Rose", hx + LEAF_W - 0.1, hx + LEAF_W - 0.06, min(zz, hz + side * LEAF_T / 2), max(zz, hz + side * LEAF_T / 2), FLOOR + 0.98, FLOOR + 1.05, door_metal, "Door"))
    for o in leaf:
        box_uv(o, 1.0)
        o["uv_done"] = True

    # Windows: frame, glass, inner sill, grille, louvred shutters folded open outside.
    for wall, a, w, h, sill in WINDOWS:
        y0, y1 = FLOOR + sill, FLOOR + sill + h
        front_back = wall in ("front", "back")
        out = 1 if wall in ("front", "right") else -1  # outward along the wall normal
        mid = (D / 2 - T / 2) * out if front_back else (W / 2 - T / 2) * out

        def wbox(name, a0, a1, n0, n1, yy0, yy1, m, grp, bevel=0.0):
            # a: along the wall, n: along the outward normal (relative to the wall centre line)
            if front_back:
                return box(name, a0, a1, mid + min(n0, n1) * out if out > 0 else mid - max(n0, n1), mid + max(n0, n1) * out if out > 0 else mid - min(n0, n1), yy0, yy1, m, grp, bevel)
            return box(name, mid + min(n0, n1) if out > 0 else mid - max(n0, n1), mid + max(n0, n1) if out > 0 else mid - min(n0, n1), a0, a1, yy0, yy1, m, grp, bevel)

        fw = 0.06
        wbox("WinFrame", a - w / 2, a - w / 2 + fw, -0.04, 0.04, y0 + fw, y1 - fw, frame, "Exterior")
        wbox("WinFrame", a + w / 2 - fw, a + w / 2, -0.04, 0.04, y0 + fw, y1 - fw, frame, "Exterior")
        wbox("WinFrame", a - w / 2, a + w / 2, -0.04, 0.04, y0, y0 + fw, frame, "Exterior")
        wbox("WinFrame", a - w / 2, a + w / 2, -0.04, 0.04, y1 - fw, y1, frame, "Exterior")
        wbox("WinFrame", a - 0.025, a + 0.025, -0.035, 0.035, y0 + fw, y1 - fw, frame, "Exterior")
        wbox("WinFrame", a - w / 2 + fw, a - 0.025, -0.035, 0.035, y0 + h * 0.62, y0 + h * 0.62 + 0.04, frame, "Exterior")
        wbox("WinFrame", a + 0.025, a + w / 2 - fw, -0.035, 0.035, y0 + h * 0.62, y0 + h * 0.62 + 0.04, frame, "Exterior")
        wbox("Pane", a - w / 2 + fw, a + w / 2 - fw, -0.004, 0.004, y0 + fw, y1 - fw, glass, "Glass")
        wbox("Sill", a - w / 2 - 0.06, a + w / 2 + 0.06, -T / 2 - 0.05, -T / 2 + 0.02, y0 - 0.04, y0, wood, "Interior")
        wbox("SillOut", a - w / 2 - 0.08, a + w / 2 + 0.08, T / 2 - 0.02, T / 2 + 0.08, y0 - 0.06, y0, concrete, "Exterior")
        for k in range(1, 6):  # grille bars in the opening, outside the glass
            aa = a - w / 2 + k * w / 6
            wbox("Grille", aa - 0.008, aa + 0.008, 0.06, 0.076, y0, y1, metal, "Exterior")
        wbox("Grille", a - w / 2, a + w / 2, 0.06, 0.076, y0 + h * 0.5 - 0.008, y0 + h * 0.5 + 0.008, metal, "Exterior")
        for side in (-1, 1):  # shutters folded open against the facade
            s0 = a + side * (w / 2 + 0.04)
            s1 = s0 + side * (w / 2)
            lo, hi = min(s0, s1), max(s0, s1)
            wbox("Shutter", lo, hi, T / 2 + 0.005, T / 2 + 0.035, y0 - 0.02, y1 + 0.02, shutter, "Exterior")
            for k in range(14):
                yy = y0 + 0.05 + k * (h - 0.06) / 14
                wbox("Louvre", lo + 0.04, hi - 0.04, T / 2 + 0.035, T / 2 + 0.05, yy, yy + 0.025, shutter, "Exterior")

    # Roof: a hip roof with a tile texture, fascia board and soffit underneath.
    o = ROOF_OVERHANG
    rise = (D / 2 + o) * math.tan(ROOF_PITCH)
    ex, ez, ridge = W / 2 + o, D / 2 + o, (W - D) / 2
    y0 = WALL_TOP - 0.02
    verts = [B(-ex, -ez, y0), B(ex, -ez, y0), B(ex, ez, y0), B(-ex, ez, y0), B(-ridge, 0, y0 + rise), B(ridge, 0, y0 + rise)]
    me = bpy.data.meshes.new("Roof")
    me.from_pydata([tuple(v) for v in verts], [], [(3, 2, 5, 4), (1, 0, 4, 5), (0, 3, 4), (2, 1, 5)])
    r = bpy.data.objects.new("Roof", me)
    bpy.context.collection.objects.link(r)
    r.data.materials.append(roof)
    r.data.materials.append(soffit)
    bm = bmesh.new()
    bm.from_mesh(me)
    uv = bm.loops.layers.uv.new("UVMap")
    for face in bm.faces:
        n = face.normal
        down = Vector((n.x, n.y, 0)).normalized()  # down-slope direction in plan
        along = Vector((-down.y, down.x, 0))
        for loop in face.loops:
            p = loop.vert.co
            slope = (p.z - y0) / math.sin(ROOF_PITCH)
            loop[uv].uv = (p.dot(along), slope)
    bm.to_mesh(me)
    bm.free()
    r["uv_done"] = True
    sol = r.modifiers.new("solid", "SOLIDIFY")
    sol.thickness = 0.12
    sol.offset = -1
    sol.material_offset = 1
    sol.material_offset_rim = 1
    bpy.context.view_layer.objects.active = r
    bpy.ops.object.modifier_apply(modifier=sol.name)
    put(r, "Exterior")
    for (x0, x1, z0, z1) in ((-ex, ex, ez - 0.03, ez + 0.02), (-ex, ex, -ez - 0.02, -ez + 0.03), (ex - 0.03, ex + 0.02, -ez, ez), (-ex - 0.02, -ex + 0.03, -ez, ez)):
        box("Fascia", x0, x1, z0, z1, y0 - 0.2, y0 + 0.02, fascia, "Exterior")
    # Boxed eaves: soffit boards from the wall face out to the fascia (never over the room).
    for (x0, x1, z0, z1) in ((-ex, ex, D / 2, ez), (-ex, ex, -ez, -D / 2), (-ex, -W / 2, -D / 2, D / 2), (W / 2, ex, -D / 2, D / 2)):
        box("Soffit", x0, x1, z0, z1, y0 - 0.2, y0 - 0.18, soffit, "Exterior")

    # Porch canopy on two posts.
    box("Canopy", PORCH[0] - 0.1, PORCH[1] + 0.1, D / 2, PORCH[3] + 0.1, FLOOR + 2.55, FLOOR + 2.68, concrete, "Exterior")
    for x in (PORCH[0] + 0.12, PORCH[1] - 0.12):
        box("Post", x - 0.08, x + 0.08, PORCH[3] - 0.2, PORCH[3] - 0.04, FLOOR, FLOOR + 2.55, frame, "Exterior")
    # Potted plants by the door.
    for x in (PORCH[0] + 0.35, PORCH[1] - 0.35):
        cyl("PlanterPot", x, D / 2 + 0.35, FLOOR, FLOOR + 0.42, 0.2, mat("Ext_Pot", "#a5583a", 0.85), "Exterior", r2=0.15)
        for k in range(6):
            ball("PlanterLeaf", x + random.uniform(-0.12, 0.12), D / 2 + 0.35 + random.uniform(-0.12, 0.12), FLOOR + 0.55 + random.uniform(0, 0.25), 0.16, mat("Ext_Leaves", "#4b7a36", 0.8), "Exterior", scale=(1, 1, 0.7), sub=1)

    furniture(locals())


def furniture(m):
    seats = []
    blockers = []

    def block(x0, x1, z0, z1, x, z, yaw):
        """A furniture blocker: a local rectangle, rotated and moved like the piece."""
        c, s = math.cos(yaw), math.sin(yaw)
        ring = []
        for lx, lz in ((x0, z0), (x1, z0), (x1, z1), (x0, z1)):
            # game yaw: rotation.y; maps local (x, z) to (x c + z s, -x s + z c)
            ring.append([round(x + lx * c + lz * s, 3), round(z - lx * s + lz * c, 3)])
        blockers.append(ring)

    def seat(sid, label, lx, lz, x, z, yaw, height=0.44):
        """A seat: the hips' spot on the cushion and where to stand up to, in front of it."""
        c, s = math.cos(yaw), math.sin(yaw)
        wx, wz = x + lx * c + lz * s, z - lx * s + lz * c
        fx, fz = math.sin(yaw), math.cos(yaw)  # facing (local +Z)
        seats.append({"id": sid, "label": label, "x": round(wx, 3), "z": round(wz, 3), "yaw": round(yaw, 4), "height": height,
                      "stand": [round(wx + fx * 0.62, 3), round(wz + fz * 0.62, 3)]})

    # Sofa against the back wall, facing the front (+Z).
    sx, sz = -1.0, -IZ + 0.45
    parts = [
        box("SofaBase", -1.0, 1.0, -0.42, 0.42, FLOOR + 0.1, FLOOR + 0.3, m["fabric"], "Interior", bevel=0.03),
        box("SofaBack", -1.0, 1.0, -0.42, -0.2, FLOOR + 0.3, FLOOR + 0.82, m["fabric"], "Interior", bevel=0.05),
        box("SofaArm", -1.0, -0.82, -0.42, 0.42, FLOOR + 0.3, FLOOR + 0.6, m["fabric"], "Interior", bevel=0.05),
        box("SofaArm", 0.82, 1.0, -0.42, 0.42, FLOOR + 0.3, FLOOR + 0.6, m["fabric"], "Interior", bevel=0.05),
        box("SofaCushion", -0.81, -0.01, -0.2, 0.4, FLOOR + 0.3, FLOOR + 0.44, m["cushion"], "Interior", bevel=0.04),
        box("SofaCushion", 0.01, 0.81, -0.2, 0.4, FLOOR + 0.3, FLOOR + 0.44, m["cushion"], "Interior", bevel=0.04),
        box("SofaPillow", -0.75, -0.4, -0.2, -0.08, FLOOR + 0.44, FLOOR + 0.78, m["rug"], "Interior", bevel=0.04),
    ]
    for lx in (-0.92, 0.92):
        for lz in (-0.34, 0.34):
            parts.append(box("SofaLeg", lx - 0.03, lx + 0.03, lz - 0.03, lz + 0.03, FLOOR, FLOOR + 0.1, m["wood_dark"], "Interior"))
    place(parts, sx, sz, 0.0)
    block(-1.0, 1.0, -0.42, 0.42, sx, sz, 0.0)
    seat("sofa-left", "sofa", -0.42, 0.06, sx, sz, 0.0)
    seat("sofa-right", "sofa", 0.42, 0.06, sx, sz, 0.0)

    # Rug and coffee table.
    rg = box("Rug", -1.25, 1.25, -0.85, 0.85, FLOOR, FLOOR + 0.008, m["rug"], "Interior")
    place([rg], -1.0, -1.25, 0.0)
    tbl = [box("TableTop", -0.55, 0.55, -0.3, 0.3, FLOOR + 0.4, FLOOR + 0.44, m["wood"], "Interior", bevel=0.01)]
    for lx in (-0.48, 0.48):
        for lz in (-0.23, 0.23):
            tbl.append(box("TableLeg", lx - 0.025, lx + 0.025, lz - 0.025, lz + 0.025, FLOOR + 0.008, FLOOR + 0.4, m["wood"], "Interior"))
    tbl.append(box("TableShelf", -0.48, 0.48, -0.23, 0.23, FLOOR + 0.12, FLOOR + 0.14, m["wood"], "Interior"))
    tbl.append(cyl("Teapot", 0.15, 0.02, FLOOR + 0.44, FLOOR + 0.56, 0.065, m["ceramic"], "Interior"))
    tbl.append(cyl("Cup", -0.12, 0.08, FLOOR + 0.44, FLOOR + 0.5, 0.03, m["ceramic"], "Interior"))
    tbl.append(cyl("Cup", -0.22, -0.06, FLOOR + 0.44, FLOOR + 0.5, 0.03, m["ceramic"], "Interior"))
    place(tbl, -1.0, -1.35, 0.0)
    block(-0.55, 0.55, -0.3, 0.3, -1.0, -1.35, 0.0)

    # The armchair: the chair to sit in, facing the coffee table (-X).
    ax_, az_, ayaw = 0.75, -1.35, -math.pi / 2
    chair = [
        box("ChairSeat", -0.33, 0.33, -0.3, 0.3, FLOOR + 0.3, FLOOR + 0.4, m["wood_dark"], "Interior", bevel=0.01),
        box("ChairCushion", -0.29, 0.29, -0.27, 0.3, FLOOR + 0.4, FLOOR + 0.47, m["cushion"], "Interior", bevel=0.03),
        box("ChairBack", -0.33, 0.33, -0.33, -0.27, FLOOR + 0.4, FLOOR + 0.95, m["wood_dark"], "Interior", bevel=0.01),
        box("ChairBackCushion", -0.27, 0.27, -0.27, -0.2, FLOOR + 0.5, FLOOR + 0.88, m["cushion"], "Interior", bevel=0.03),
    ]
    for side in (-1, 1):
        chair.append(box("ChairArm", side * 0.33 - 0.035, side * 0.33 + 0.035, -0.33, 0.28, FLOOR + 0.62, FLOOR + 0.66, m["wood_dark"], "Interior", bevel=0.01))
        chair.append(box("ChairArmPost", side * 0.33 - 0.025, side * 0.33 + 0.025, 0.2, 0.26, FLOOR + 0.4, FLOOR + 0.62, m["wood_dark"], "Interior"))
        for lz in (-0.26, 0.24):
            chair.append(box("ChairLeg", side * 0.29 - 0.025, side * 0.29 + 0.025, lz - 0.025, lz + 0.025, FLOOR, FLOOR + 0.3, m["wood_dark"], "Interior"))
    place(chair, ax_, az_, ayaw)
    block(-0.36, 0.36, -0.34, 0.3, ax_, az_, ayaw)
    seat("armchair", "armchair", 0.0, 0.04, ax_, az_, ayaw, 0.47)

    # Floor lamp beside the sofa.
    lx, lz = -2.35, -IZ + 0.35
    cyl("LampBase", lx, lz, FLOOR, FLOOR + 0.03, 0.15, m["int_metal"], "Interior")
    cyl("LampPole", lx, lz, FLOOR + 0.03, FLOOR + 1.45, 0.012, m["int_metal"], "Interior", verts=8)
    cyl("LampShade", lx, lz, FLOOR + 1.35, FLOOR + 1.6, 0.21, m["shade"], "Interior", verts=20, r2=0.14)
    blockers.append([[lx - 0.18, lz - 0.18], [lx + 0.18, lz - 0.18], [lx + 0.18, lz + 0.18], [lx - 0.18, lz + 0.18]])

    # Sideboard on the left wall with a plant, a photo and a radio.
    sb = [box("Sideboard", -0.8, 0.8, -0.22, 0.22, FLOOR + 0.1, FLOOR + 0.82, m["wood"], "Interior", bevel=0.01)]
    for k in (-0.4, 0.4):
        sb.append(box("SideboardDoor", k - 0.38, k + 0.38, 0.22, 0.235, FLOOR + 0.16, FLOOR + 0.76, m["wood_dark"], "Interior"))
        sb.append(box("SideboardKnob", k - (0.3 if k > 0 else -0.3) - 0.015, k - (0.3 if k > 0 else -0.3) + 0.015, 0.235, 0.25, FLOOR + 0.45, FLOOR + 0.48, m["int_metal"], "Interior"))
    for lxx in (-0.72, 0.72):
        sb.append(box("SideboardLeg", lxx - 0.03, lxx + 0.03, -0.16, 0.16, FLOOR, FLOOR + 0.1, m["wood_dark"], "Interior"))
    sb.append(cyl("VasePot", 0.5, 0.0, FLOOR + 0.82, FLOOR + 1.02, 0.09, m["pot"], "Interior", r2=0.07))
    for k in range(5):
        sb.append(ball("VaseLeaf", 0.5 + random.uniform(-0.08, 0.08), random.uniform(-0.06, 0.06), FLOOR + 1.1 + random.uniform(0, 0.15), 0.1, m["leaves"], "Interior", scale=(1, 1, 0.7), sub=1))
    sb.append(box("Photo", -0.3, -0.1, -0.03, 0.0, FLOOR + 0.82, FLOOR + 1.06, m["int_frame"], "Interior"))
    sb.append(box("Radio", -0.7, -0.42, -0.12, 0.08, FLOOR + 0.82, FLOOR + 0.98, m["wood_dark"], "Interior", bevel=0.01))
    place(sb, -IX + 0.23, -0.3, math.pi / 2)
    block(-0.8, 0.8, -0.23, 0.25, -IX + 0.23, -0.3, math.pi / 2)

    # Dining corner: a table and two chairs.
    dx, dz = 2.35, 1.3
    dt = [box("DiningTop", -0.45, 0.45, -0.45, 0.45, FLOOR + 0.72, FLOOR + 0.76, m["wood"], "Interior", bevel=0.01)]
    for lxx in (-0.4, 0.4):
        for lzz in (-0.4, 0.4):
            dt.append(box("DiningLeg", lxx - 0.03, lxx + 0.03, lzz - 0.03, lzz + 0.03, FLOOR, FLOOR + 0.72, m["wood"], "Interior"))
    dt.append(cyl("FruitBowl", 0, 0, FLOOR + 0.76, FLOOR + 0.84, 0.13, m["ceramic"], "Interior", r2=0.16))
    for k in range(4):
        dt.append(ball("Mango", random.uniform(-0.06, 0.06), random.uniform(-0.06, 0.06), FLOOR + 0.86, 0.045, mat("Int_Mango", "#e0a82e", 0.6), "Interior", scale=(1, 0.75, 0.75), sub=1))
    place(dt, dx, dz, 0.0)
    for side in (-1, 1):
        ch = [box("DChairSeat", -0.22, 0.22, -0.22, 0.22, FLOOR + 0.42, FLOOR + 0.46, m["wood_dark"], "Interior", bevel=0.01),
              box("DChairBack", -0.22, 0.22, -0.24, -0.2, FLOOR + 0.46, FLOOR + 0.95, m["wood_dark"], "Interior", bevel=0.01)]
        for lxx in (-0.18, 0.18):
            for lzz in (-0.2, 0.18):
                ch.append(box("DChairLeg", lxx - 0.02, lxx + 0.02, lzz - 0.02, lzz + 0.02, FLOOR, FLOOR + 0.42, m["wood_dark"], "Interior"))
        place(ch, dx, dz + side * 0.62, 0.0 if side < 0 else math.pi)
    block(-0.5, 0.5, -0.9, 0.9, dx, dz, 0.0)

    # A tall plant in the back-right corner.
    px_, pz_ = IX - 0.35, -IZ + 0.35
    cyl("PlantPot", px_, pz_, FLOOR, FLOOR + 0.45, 0.22, m["pot"], "Interior", r2=0.17)
    for k in range(12):
        a = k * 2.4
        rr = 0.12 + 0.03 * k
        ball("PlantLeaf", px_ + math.cos(a) * rr * 0.6, pz_ + math.sin(a) * rr * 0.6, FLOOR + 0.6 + k * 0.08, 0.17, m["leaves"], "Interior", scale=(1.2, 0.5, 0.35), sub=1)
    blockers.append([[px_ - 0.25, pz_ - 0.25], [px_ + 0.25, pz_ - 0.25], [px_ + 0.25, pz_ + 0.25], [px_ - 0.25, pz_ + 0.25]])

    # Painting above the sofa, a clock on the right wall.
    box("PaintingFrame", -1.0 - 0.62, -1.0 + 0.62, -IZ, -IZ + 0.03, FLOOR + 1.35, FLOOR + 2.15, m["wood_dark"], "Interior")
    pt = box("Painting", -1.0 - 0.56, -1.0 + 0.56, -IZ + 0.03, -IZ + 0.035, FLOOR + 1.41, FLOOR + 2.09, m["painting"], "Interior")
    bm = bmesh.new()
    bm.from_mesh(pt.data)
    uv = bm.loops.layers.uv.get("UVMap") or bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for loop in f.loops:
            p = loop.vert.co
            loop[uv].uv = ((p.x - (-1.56)) / 1.12, (p.z - (FLOOR + 1.41)) / 0.68)
    bm.to_mesh(pt.data)
    bm.free()
    pt["uv_done"] = True
    box("ClockFace", IX - 0.04, IX, 1.03, 1.37, FLOOR + 1.83, FLOOR + 2.17, m["int_frame"], "Interior", bevel=0.02)
    box("ClockHand", IX - 0.05, IX - 0.04, 1.19, 1.21, FLOOR + 1.98, FLOOR + 2.12, m["int_metal"], "Interior")
    box("ClockHand", IX - 0.05, IX - 0.04, 1.19, 1.3, FLOOR + 1.99, FLOOR + 2.01, m["int_metal"], "Interior")

    # Ceiling fan (rotates in the game) with a bulb under it.
    fan_y = CEIL - 0.42
    fan = [cyl("FanRod", 0, 0, fan_y, CEIL, 0.015, m["fan_metal"], "Fan", verts=8),
           cyl("FanHub", 0, 0, fan_y - 0.08, fan_y + 0.02, 0.1, m["fan_metal"], "Fan", verts=16)]
    for k in range(4):
        b = box("FanBlade", 0.12, 0.72, -0.06, 0.06, fan_y - 0.02, fan_y, m["fan_wood"], "Fan", bevel=0.005)
        b.matrix_world = Matrix.Rotation(k * math.pi / 2, 4, "Z") @ b.matrix_world
        apply_all(b)
        bpy.context.view_layer.objects.active = b
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
        fan.append(b)
    ball("Bulb", 0, 0, fan_y - 0.15, 0.08, m["bulb"], "Interior", sub=2)
    cyl("BulbCup", 0, 0, fan_y - 0.12, fan_y - 0.08, 0.09, m["fan_metal"], "Interior", r2=0.05)
    return seats, blockers, (lx, lz, FLOOR + 1.45), (0, 0, fan_y - 0.15)


SPEC: dict = {}


def furniture_capture(fn):
    def inner(m):
        seats, blockers, lamp, bulb = fn(m)
        SPEC.update(seats=seats, blockers=blockers, lamps=[{"x": lamp[0], "z": lamp[1], "y": lamp[2]}, {"x": bulb[0], "z": bulb[1], "y": bulb[2]}])
    return inner


furniture = furniture_capture(furniture)


def join(group, name):
    objs = [o for o in GROUPS[group] if o.name in bpy.data.objects]
    if not objs:
        return None
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.object
    o.name = name
    o.data.name = name
    return o


def flat_color(m):
    """The base colour of a plain material (no texture, opaque, not glowing), else None."""
    nt = m.node_tree
    p = nt.nodes.get("Principled BSDF")
    if p is None or p.inputs["Base Color"].is_linked or m.blend_method == "BLEND":
        return None
    if p.inputs["Emission Strength"].default_value > 0:
        return None
    if m.name.startswith("Ext_") and p.inputs["Metallic"].default_value > 0:
        return None  # keep real metal outside (reflections)
    return tuple(p.inputs["Base Color"].default_value)


def paint_flat(o, name, rough):
    """Plain-coloured faces become vertex colours on one shared material: one draw call
    instead of one per colour. Other faces keep their material (and a white vertex colour)."""
    me = o.data
    painted = bpy.data.materials.new(name)
    painted.use_nodes = True
    nt = painted.node_tree
    p = nt.nodes.get("Principled BSDF")
    p.inputs["Roughness"].default_value = rough
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    nt.links.new(attr.outputs["Color"], p.inputs["Base Color"])
    me.materials.append(painted)
    target = len(me.materials) - 1
    colors = {i: flat_color(m) for i, m in enumerate(me.materials) if m is not painted}
    col = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for poly in me.polygons:
        c = colors.get(poly.material_index)
        rgba = c if c else (1.0, 1.0, 1.0, 1.0)
        for li in poly.loop_indices:
            col.data[li].color = rgba
        if c:
            poly.material_index = target
    me.color_attributes.active_color = col
    me.color_attributes.render_color_index = me.color_attributes.find("Col")


def lights_for_bake():
    world = bpy.data.worlds.new("Sky")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.55, 0.68, 0.9, 1)
    bg.inputs["Strength"].default_value = 0.9
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 2.6
    sun.color = (1.0, 0.95, 0.86)
    sun.angle = math.radians(1.5)
    so = bpy.data.objects.new("Sun", sun)
    so.rotation_euler = Euler((math.radians(50), 0, math.radians(200)), "XYZ")
    bpy.context.collection.objects.link(so)
    for (x, z, y), power, radius in (((0, 0, CEIL - 0.6), 160, 0.07), ((-2.35, -IZ + 0.35, FLOOR + 1.47), 70, 0.08)):
        lt = bpy.data.lights.new("Lamp", "POINT")
        lt.energy = power
        lt.color = (1.0, 0.8, 0.58)
        lt.shadow_soft_size = radius
        lo = bpy.data.objects.new("Lamp", lt)
        lo.location = B(x, z, y)
        bpy.context.collection.objects.link(lo)
    # Ground around the house, for daylight bounce (not exported).
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, -0.001))
    g = bpy.context.object
    g.name = "BakeGround"
    g.data.materials.append(mat("BakeGround", "#9c9a7c", 0.95))


def bake_interior(interior):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = SAMPLES
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 6
    scene.cycles.diffuse_bounces = 4
    scene.render.bake.use_pass_direct = True
    scene.render.bake.use_pass_indirect = True
    scene.render.bake.use_pass_color = False
    scene.render.bake.margin = 6
    img = bpy.data.images.new("Lightmap", LIGHTMAP_SIZE, LIGHTMAP_SIZE, float_buffer=True)
    # Lightmap UVs: a second UV map, one island per flat region.
    me = interior.data
    if "Lightmap" not in me.uv_layers:
        me.uv_layers.new(name="Lightmap")
    me.uv_layers.active = me.uv_layers["Lightmap"]
    for o in bpy.context.selected_objects:
        o.select_set(False)
    interior.select_set(True)
    bpy.context.view_layer.objects.active = interior
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.006, area_weight=0.0, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    for m in me.materials:
        nt = m.node_tree
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = img
        node.name = "bake_target"
        uvn = nt.nodes.new("ShaderNodeUVMap")
        uvn.uv_map = "Lightmap"
        nt.links.new(uvn.outputs["UV"], node.inputs["Vector"])
        nt.nodes.active = node
    me.uv_layers.active = me.uv_layers["UVMap"]
    me.uv_layers["UVMap"].active_render = True
    print(f"baking the day lightmap: {LIGHTMAP_SIZE}² at {SAMPLES} samples (CPU)…", flush=True)
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, uv_layer="Lightmap", margin=6)
    day = np.array(img.pixels[:], dtype=np.float32).reshape(LIGHTMAP_SIZE, LIGHTMAP_SIZE, 4)[::-1, :, :3]
    # Night: the lamps only, under a faint moonlit sky (no sun patches on the floor at night).
    sun = bpy.data.objects["Sun"]
    sun.hide_render = True
    bg = bpy.context.scene.world.node_tree.nodes["Background"]
    strength = bg.inputs["Strength"].default_value
    bg.inputs["Color"].default_value = (0.25, 0.3, 0.45, 1)
    bg.inputs["Strength"].default_value = 0.04
    print("baking the night lightmap…", flush=True)
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, uv_layer="Lightmap", margin=6)
    night = np.array(img.pixels[:], dtype=np.float32).reshape(LIGHTMAP_SIZE, LIGHTMAP_SIZE, 4)[::-1, :, :3]
    sun.hide_render = False
    bg.inputs["Strength"].default_value = strength
    return day, night


def lightmap_scale(a):
    lum = a.mean(axis=2)
    covered = lum > 1e-5
    return float(np.percentile(lum[covered], 99.5)) if covered.any() else 1.0


def save_lightmap(a, path, scale):
    """Denoise lightly, normalise by `scale` and store sRGB-encoded 8-bit (the client
    multiplies back)."""
    img = Image.fromarray((np.clip(a / scale, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8))
    # A small median then blur removes Monte Carlo speckle; the lightmap is smooth by nature.
    img = img.filter(ImageFilter.MedianFilter(5)).filter(ImageFilter.GaussianBlur(1.8))
    img.save(path, quality=90, method=6)  # WebP: a smooth image compresses well


def preview(path_prefix):
    """Cycles stills from the street and inside the room (documentation and checks)."""
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = 960, 540
    scene.cycles.samples = 96
    scene.cycles.use_denoising = False  # this Blender build has no OpenImageDenoise
    scene.view_settings.view_transform = "AgX"
    shots = {"street": (B(7.5, 9.5, 2.2), B(-0.5, 0, 1.6), 50), "room": (B(3.2, 2.6, 1.65), B(-1.6, -2.4, 0.9), 22),
             "door": (B(-2.4, -1.4, 1.6), B(-1.6, 3.2, 1.2), 30)}
    for name, (eye, at, lens) in shots.items():
        cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
        bpy.context.collection.objects.link(cam)
        cam.location = eye
        cam.rotation_euler = (at - eye).to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = lens
        scene.camera = cam
        scene.render.filepath = f"{path_prefix}-{name}.png"
        bpy.ops.render.render(write_still=True)


def rect(x0, x1, z0, z1):
    return [[round(x0, 3), round(z0, 3)], [round(x1, 3), round(z0, 3)], [round(x1, 3), round(z1, 3)], [round(x0, 3), round(z1, 3)]]


def write_spec(path, light_scale):
    hx, hz = HINGE
    walls = [
        rect(-W / 2, DOOR_X - DOOR_W / 2, D / 2 - T, D / 2),
        rect(DOOR_X + DOOR_W / 2, W / 2, D / 2 - T, D / 2),
        rect(-W / 2, W / 2, -D / 2, -D / 2 + T),
        rect(-W / 2, -W / 2 + T, -D / 2 + T, D / 2 - T),
        rect(W / 2 - T, W / 2, -D / 2 + T, D / 2 - T),
    ]
    spec = {
        "version": 1,
        "name": NAME,
        "model": f"{NAME}.glb",
        "lightmap": f"{NAME}-light.webp",
        "lightmapNight": f"{NAME}-light-night.webp",
        "lightmapScale": round(light_scale, 4),
        "floor": FLOOR,
        "wallTop": WALL_TOP,
        "footprint": rect(-W / 2, W / 2, -D / 2, D / 2),
        "interior": {"min": [-IX, -IZ], "max": [IX, IZ], "ceiling": CEIL},
        "walls": walls,
        # Above the doorway: blocks the camera, not walking.
        "lintels": [{"ring": rect(DOOR_X - DOOR_W / 2, DOOR_X + DOOR_W / 2, D / 2 - T, D / 2), "base": DOOR_TOP}],
        "door": {"id": "front", "node": "Door", "hinge": [round(hx, 3), round(hz, 3)], "width": LEAF_W, "thickness": LEAF_T,
                 "height": DOOR_H, "openYaw": round(math.pi / 2, 4), "center": [DOOR_X, D / 2 - T / 2], "outward": [0, 1]},
        "steps": [{"ring": rect(*PORCH), "height": FLOOR}, {"ring": rect(*STEP), "height": FLOOR / 2}],
        "posts": [[round(x, 3), round(PORCH[3] - 0.12, 3), 0.12] for x in (PORCH[0] + 0.12, PORCH[1] - 0.12)]
                 + [[round(x, 3), round(D / 2 + 0.35, 3), 0.22] for x in (PORCH[0] + 0.35, PORCH[1] - 0.35)],
        "fan": {"node": "Fan", "rpm": 90},
        **SPEC,
    }
    with open(path, "w") as fh:
        json.dump(spec, fh, indent=1)


def main():
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    tex = {
        "floor": os.path.join(TMP, "floor_tiles.png"),
        "roof": os.path.join(TMP, "roof_tiles.png"),
        "wood": os.path.join(TMP, "wood.png"),
        "wood_dark": os.path.join(TMP, "wood_dark.png"),
        "door": os.path.join(TMP, "door_wood.png"),
        "rug": os.path.join(TMP, "rug.png"),
        "painting": os.path.join(TMP, "painting.png"),
    }
    tex_floor(tex["floor"])
    tex_roof(tex["roof"])
    tex_wood(tex["wood"], "#9a6a3e", 1)
    tex_wood(tex["wood_dark"], "#5a3824", 2)
    tex_wood(tex["door"], "#6e3f22", 3)
    tex_rug(tex["rug"])
    tex_painting(tex["painting"])
    build(tex)
    # Every other part gets real-world-size box UVs (primitives come with 0-1 cube UVs).
    for g in ("Exterior", "Interior", "Door", "Fan", "Glass"):
        for o in GROUPS[g]:
            if not o.get("uv_done"):
                box_uv(o, 1.0)
    exterior = join("Exterior", "Exterior")
    interior = join("Interior", "Interior")
    glass = join("Glass", "Glass")
    door = join("Door", "Door")
    fan = join("Fan", "Fan")
    paint_flat(exterior, "Ext_Painted", 0.88)
    paint_flat(interior, "Int_Painted", 0.9)
    paint_flat(fan, "Fan_Painted", 0.6)
    # Pivots: the door turns on its hinge, the fan on its rod.
    hx, hz = HINGE
    for o, pivot in ((door, B(hx, hz, 0)), (fan, B(0, 0, CEIL))):
        bpy.context.scene.cursor.location = pivot
        for s in bpy.context.selected_objects:
            s.select_set(False)
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    lights_for_bake()
    glass.hide_render = True  # daylight passes the windows during the bake
    fan.hide_render = True  # it turns in the game: no frozen blade shadows on the ceiling
    day, night = bake_interior(interior)
    scale = lightmap_scale(day)  # one scale for both, so night is darker by the real amount
    save_lightmap(day, os.path.join(OUT, f"{NAME}-light.webp"), scale)
    save_lightmap(night, os.path.join(OUT, f"{NAME}-light-night.webp"), scale)
    glass.hide_render = fan.hide_render = False
    # Export only the house (no lights, no bake ground); drop the bake image nodes.
    for m in interior.data.materials:
        for n in list(m.node_tree.nodes):
            if n.name.startswith("bake_target") or n.type == "UVMAP":
                m.node_tree.nodes.remove(n)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in (exterior, interior, glass, door, fan):
        o.select_set(True)
    target = os.path.join(OUT, f"{NAME}.glb")
    bpy.ops.export_scene.gltf(filepath=target + ".tmp.glb", export_format="GLB", export_yup=True, use_selection=True,
                              export_apply=True, export_texcoords=True, export_normals=True, export_lights=False,
                              export_vertex_color="ACTIVE",
                              export_image_format="WEBP", export_image_quality=88)
    os.replace(target + ".tmp.glb", target)
    write_spec(os.path.join(OUT, f"{NAME}.json"), scale)
    if os.environ.get("PPW_HOUSE_PREVIEW"):
        preview(os.environ["PPW_HOUSE_PREVIEW"])
    tris = sum(len(o.data.loop_triangles) for o in (exterior, interior, glass, door, fan) if o.data.calc_loop_triangles() is None)
    print("Wrote", target, "lightmap scale", round(scale, 3), "triangles", tris)


main()

"""An enterable Phnom Penh house for Phnom Penh Digital World (original work, CC0).

Run:  blender --background --python-use-system-env --python tools/blender/generate_house.py
      (PPW_BAKE_SAMPLES=16 for a quick, noisier draft; PPW_HOUSE_PREVIEW=/tmp/house for stills)
Writes, in frontend/static/models/buildings/:
  house-riverside.glb             the model (meshopt-compress it with `npm run assets:compress`)
  house-riverside-day.webp        interior light from the sun and sky (baked with Cycles, CPU)
  house-riverside-lamps.webp      interior light from each room's lamps, one per channel
                                  (R front room, G kitchen, B bedroom, A bathroom), so every
                                  room's lights can be switched on and off in the game
  house-riverside.json            the building spec the game reads (src/lib/game/buildings/spec.ts)

A single-storey rendered-brick house of the kind found along Phnom Penh's side streets: ochre
plaster, louvred teal shutters, window grilles, a terracotta hip roof, a tiled porch with a
concrete canopy. Inside: an open living and dining room (encaustic cement tiles), a kitchen
(terracotta tiles), a bedroom (wooden floor), a bathroom with a water jar (mosaic tiles) and a
small hall; the front door and the bedroom and bathroom doors open and close, the kitchen opens
through an arch. Furniture: sofa, armchair, coffee table and rug, TV, family altar, floor lamp,
dining table with four chairs, sideboard with family photos and a radio, kitchen counters with a
sink, gas stove, rice cooker and fridge, double bed with a krama blanket, wardrobe, desk, toilet,
sink and mirror, ceiling fans, light switches, plants, a painting and a clock.

Conventions (game coordinates throughout, converted for Blender by B()):
* Metres; X across the front, Z out of the front door (+Z), Y up. Blender is Z-up with the front
  facing -Y; the glTF export turns that back into the game's frame.
* The origin is at ground level in the centre of the footprint; the floor is FLOOR above it.
* Nodes the client relies on: Exterior (lit by the game), Interior (unlit, lightmapped on
  TEXCOORD_1), Glass, Door_<id> (origin on the hinge axis; opens by +rotation.y), Fan_<room>
  (origin on the axis), TVScreen, StoveFlame. Interior materials start with "Int_"; the bulbs and
  shades of light group N are Int_Bulb_N / Int_Shade_N.
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
SAMPLES = int(os.environ.get("PPW_BAKE_SAMPLES", "200"))
LIGHTMAP_SIZE = int(os.environ.get("PPW_LIGHTMAP_SIZE", "1024"))
TMP = tempfile.mkdtemp(prefix="ppw-house-")  # generated textures (packed into the GLB)
random.seed(855)

# ── Dimensions (metres, game frame) ──────────────────────────────────────────────────────
W, D = 10.4, 8.8  # outer footprint: X width, Z depth
T = 0.2  # outer wall thickness
P = 0.12  # partition thickness
FLOOR = 0.15  # floor top above the ground
WALL_TOP = FLOOR + 3.0
CEIL = FLOOR + 2.85  # ceiling underside
IX, IZ = W / 2 - T, D / 2 - T  # inner half extents (5.0, 4.2)
LEAF_T = 0.045
DOOR_H = 2.2
FRONT_DOOR = (-2.4, 1.0)  # centre x and width of the front door
# Partitions: (id, runs along, at, from, to). "x": along x at z = at; "z": along z at x = at.
PARTITIONS = [
    ("bedroom_front", "x", 0.3, -IX, -0.74),
    ("bed_bath", "z", -0.8, -IZ, 0.36),
    ("bath_kitchen", "z", 1.6, -IZ, 0.36),
    ("kitchen_front", "x", 0.3, 1.54, IX),
    ("bath_front", "x", -1.2, -0.74, 1.54),
]
# Openings in partitions: (partition, centre along it, width, height above the floor, door id)
OPENINGS = [
    ("bedroom_front", -2.0, 0.9, DOOR_H, "bedroom"),
    ("bath_front", 0.4, 0.8, DOOR_H, "bathroom"),
    ("kitchen_front", 3.3, 1.2, 2.4, None),  # an open arch into the kitchen
]
# Windows: (wall, centre along the wall, width, height, sill above the floor)
WINDOWS = [
    ("front", -0.6, 1.2, 1.3, 0.95),  # living room
    ("front", 2.8, 1.4, 1.35, 0.9),  # dining
    ("left", 2.3, 1.2, 1.3, 0.95),  # living room
    ("left", -2.0, 1.2, 1.3, 0.95),  # bedroom
    ("right", 2.3, 1.2, 1.3, 0.95),  # dining
    ("right", -2.2, 1.2, 1.0, 1.15),  # kitchen, above the counter
    ("back", -1.7, 1.0, 1.2, 1.0),  # bedroom
    ("back", 0.4, 0.6, 0.45, 1.75),  # bathroom: small and high
    ("back", 3.3, 1.2, 1.0, 1.15),  # kitchen, above the stove
]
# Rooms: id, name, floor rectangles (x0, x1, z0, z1) and light group (lightmap channel)
ROOMS = [
    ("living", "Living room", [(-IX, 0.6, 0.36, IZ)], 0),
    ("dining", "Dining room", [(0.6, IX, 0.36, IZ)], 0),
    ("hall", "Hall", [(-0.74, 1.54, -1.14, 0.36)], 0),
    ("kitchen", "Kitchen", [(1.66, IX, -IZ, 0.24)], 1),
    ("bedroom", "Bedroom", [(-IX, -0.86, -IZ, 0.24)], 2),
    ("bathroom", "Bathroom", [(-0.74, 1.54, -IZ, -1.26)], 3),
]
LIGHT_GROUPS = [("front", "Living and dining room"), ("kitchen", "Kitchen"), ("bedroom", "Bedroom"), ("bathroom", "Bathroom")]
FD_X, FD_W = FRONT_DOOR
PORCH = (FD_X - 1.3, FD_X + 1.3, D / 2, D / 2 + 1.5)  # x0, x1, z0, z1
STEP = (PORCH[0], PORCH[1], PORCH[3], PORCH[3] + 0.35)
ROOF_OVERHANG, ROOF_PITCH = 0.55, math.radians(26)
LAMP_COLOR = (1.0, 0.8, 0.58)


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
GROUPS: dict[str, list] = {"Exterior": [], "Interior": [], "Glass": [], "Bake": []}


def put(o, group):
    GROUPS.setdefault(group, []).append(o)
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




def tex_terracotta(path):
    """Kitchen floor: 30 cm terracotta squares with grout (one texture = 0.9 m)."""
    n, px = 3, 170
    rng = np.random.default_rng(11)
    img = np.zeros((n * px, n * px, 3), dtype=float)
    base = np.array(hexrgb("#b4643f"), dtype=float)
    for i in range(n):
        for j in range(n):
            img[j * px:(j + 1) * px, i * px:(i + 1) * px] = base * rng.uniform(0.86, 1.08)
    img += rng.normal(0, 7, img.shape[:2])[..., None]
    grout = np.array(hexrgb("#d9cbb6"), dtype=float)
    for k in range(n + 1):
        img[max(0, k * px - 3):k * px + 3, :] = grout
        img[:, max(0, k * px - 3):k * px + 3] = grout
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(path)


def tex_planks(path):
    """Bedroom floor: 12 cm wooden planks, staggered joints (one texture = 1 m)."""
    n = 512
    rng = np.random.default_rng(13)
    y = np.arange(n)[:, None].repeat(n, 1)
    x = np.arange(n)[None, :].repeat(n, 0)
    rows = 8
    row = y * rows // n
    offset = (rng.uniform(0, n, rows)).astype(int)
    tone = rng.uniform(0.85, 1.1, (rows, 4))
    seg = ((x + offset[row]) % n) * 4 // n
    grain = np.sin((x * 0.05 + 3 * np.sin(y * 0.11 + row)) * 2.0) * 0.06
    base = np.array(hexrgb("#8a5a36"), dtype=float)
    a = base[None, None, :] * (tone[row, seg] + grain)[..., None]
    a[(y % (n // rows)) < 2] *= 0.55  # gaps between planks
    a[((x + offset[row]) % (n // 4)) < 2] *= 0.6  # board ends
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(path)


def tex_mosaic(path, colors=("#e9eef0", "#7fb3b8", "#cfdfe2"), size=24, seed=17):
    """Bathroom floor: small square mosaic tiles."""
    n = 480
    rng = np.random.default_rng(seed)
    cols = [np.array(hexrgb(c), dtype=float) for c in colors]
    img = np.zeros((n, n, 3))
    for i in range(0, n, size):
        for j in range(0, n, size):
            img[j:j + size, i:i + size] = cols[rng.integers(0, len(cols))] * rng.uniform(0.94, 1.04)
    grout = np.array(hexrgb("#b9c2c4"), dtype=float)
    for k in range(0, n, size):
        img[k:k + 2, :] = grout
        img[:, k:k + 2] = grout
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(path)


def tex_wall_tiles(path):
    """Bathroom and kitchen wall tiles: 15 cm glossy white squares with a teal border row."""
    n, px = 4, 120
    img = np.full((n * px, n * px, 3), hexrgb("#f1f3f1"), dtype=float)
    rng = np.random.default_rng(19)
    for i in range(n):
        for j in range(n):
            img[j * px:(j + 1) * px, i * px:(i + 1) * px] *= rng.uniform(0.96, 1.02)
    img[:px // 3, :] = hexrgb("#4f9c9e")  # border row at the top of each repeat
    grout = np.array(hexrgb("#c9cfcf"), dtype=float)
    for k in range(n + 1):
        img[max(0, k * px - 2):k * px + 2, :] = grout
        img[:, max(0, k * px - 2):k * px + 2] = grout
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(path)


def tex_krama(path):
    """The red-and-white checked krama, as a blanket (original pattern)."""
    n = 256
    x = np.arange(n)[None, :].repeat(n, 0)
    y = np.arange(n)[:, None].repeat(n, 1)
    band = lambda v: ((v // 16) % 4 == 0) | ((v // 4) % 16 == 1)
    red, white, dark = np.array(hexrgb("#b0262c"), float), np.array(hexrgb("#f3ece0"), float), np.array(hexrgb("#6e1418"), float)
    img = np.where((band(x) & band(y))[..., None], white, np.where((band(x) | band(y))[..., None], (red + white) / 2, red))
    img = np.where(((x // 64) % 4 == 3)[..., None] & ((y % 8) < 2)[..., None], dark, img)
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(path)


def tex_photo(path):
    """A family photo at a pagoda gate (simple original drawing)."""
    w, h = 256, 192
    img = Image.new("RGB", (w, h), hexrgb("#d8c9a8"))
    g = ImageDraw.Draw(img)
    g.rectangle([0, 0, w, 110], fill=hexrgb("#9fc0d6"))
    g.polygon([(60, 110), (128, 30), (196, 110)], fill=hexrgb("#c79a3a"))  # gate roof
    g.rectangle([70, 100, 186, 150], fill=hexrgb("#e8dcc0"))
    for k, (x, hh, col) in enumerate(((48, 70, "#2b3550"), (82, 82, "#7a2a2a"), (118, 60, "#e0b040"), (150, 88, "#2f5f3a"), (186, 74, "#5a3a6a"), (212, 50, "#d06030"))):
        g.ellipse([x - 9, h - 22 - hh - 18, x + 9, h - 22 - hh], fill=hexrgb("#8a5a3c"))
        g.rectangle([x - 12, h - 22 - hh, x + 12, h - 10], fill=hexrgb(col))
    g.rectangle([0, 0, w - 1, h - 1], outline=hexrgb("#f4efe4"), width=10)
    img.save(path)


def join(group, name):
    objs = list(GROUPS[group])
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




# ── The shell: walls, partitions, floors, finishes, doors, windows, roof, porch ──────────
M: dict = {}  # materials by short name
SPEC: dict = {"seats": [], "blockers": [], "items": [], "toggles": [], "tables": [], "switches": [[] for _ in LIGHT_GROUPS], "doors": [], "fans": []}


def materials(tex):
    M.update(
        plaster=mat("Ext_Plaster", "#e2b968", 0.92), jamb=mat("Ext_Jamb", "#ecd29a", 0.9), plinth=mat("Ext_Plinth", "#8f8a80", 0.95),
        porch_tile=mat("Ext_PorchTile", "#b9a68a", 0.8), roof=mat("Ext_Roof", "#ffffff", 0.75, image=tex["roof"]),
        soffit=mat("Ext_Soffit", "#efe6d2", 0.9), fascia=mat("Ext_Fascia", "#f3efe6", 0.8), shutter=mat("Ext_Shutter", "#2f7b72", 0.7),
        frame=mat("Ext_Frame", "#f4f1ea", 0.6), metal=mat("Ext_Metal", "#2a2c2e", 0.5, metal=0.6), concrete=mat("Ext_Concrete", "#d9d3c7", 0.9),
        ext_pot=mat("Ext_Pot", "#a5583a", 0.85), ext_leaves=mat("Ext_Leaves", "#4b7a36", 0.8),
        wall=mat("Int_Wall", "#f1ead8", 0.95), dado_green=mat("Int_DadoGreen", "#b9c9b5", 0.9), dado_blue=mat("Int_DadoBlue", "#b5c3d4", 0.9),
        ceiling=mat("Int_Ceiling", "#fbf8f0", 0.95), floor=mat("Int_Floor", "#ffffff", 0.6, image=tex["floor"]),
        terracotta=mat("Int_Terracotta", "#ffffff", 0.7, image=tex["terracotta"]), planks=mat("Int_Planks", "#ffffff", 0.6, image=tex["planks"]),
        mosaic=mat("Int_Mosaic", "#ffffff", 0.4, image=tex["mosaic"]), tiles=mat("Int_Tiles", "#ffffff", 0.3, image=tex["tiles"]),
        wood=mat("Int_Wood", "#ffffff", 0.6, image=tex["wood"]), wood_dark=mat("Int_WoodDark", "#ffffff", 0.55, image=tex["wood_dark"]),
        fabric=mat("Int_Fabric", "#5b6f8a", 0.95), cushion=mat("Int_Cushion", "#d8b26a", 0.95), rug=mat("Int_Rug", "#ffffff", 0.95, image=tex["rug"]),
        krama=mat("Int_Krama", "#ffffff", 0.95, image=tex["krama"]), linen=mat("Int_Linen", "#efe9df", 0.95),
        painting=mat("Int_Painting", "#ffffff", 0.7, image=tex["painting"]), photo=mat("Int_Photo", "#ffffff", 0.6, image=tex["photo"]),
        leaves=mat("Int_Leaves", "#4e7a3a", 0.8), pot=mat("Int_Pot", "#a5583a", 0.85), ceramic=mat("Int_Ceramic", "#f2efe8", 0.4),
        int_metal=mat("Int_Metal", "#3a3c3e", 0.5, metal=0.5), steel=mat("Int_Steel", "#b8bcbf", 0.4, metal=0.5), int_frame=mat("Int_Frame", "#f6f3ec", 0.6),
        gold=mat("Int_Gold", "#d4a63f", 0.4), red=mat("Int_Red", "#a8322c", 0.7), white=mat("Int_White", "#f4f4f2", 0.5),
        black=mat("Int_Black", "#1d1e20", 0.4), fridge=mat("Int_Fridge", "#e6ebe8", 0.4), jar=mat("Int_Jar", "#6b4a2e", 0.35),
        blue=mat("Int_Blue", "#3e6fa3", 0.6), mirror=mat("Int_Mirror", "#c9d6dc", 0.1),
        glass=mat("Glass", "#9fc2c8", 0.05, alpha=0.22), door_wood=mat("Door_Wood", "#ffffff", 0.55, image=tex["door"]),
        door_light=mat("Door_Light", "#ffffff", 0.55, image=tex["door_light"]), door_metal=mat("Door_Metal", "#c8a24a", 0.35, metal=0.9),
        fan_wood=mat("Fan_Wood", "#5a3b26", 0.6), fan_metal=mat("Fan_Metal", "#e9e6df", 0.4, metal=0.6),
        screen=mat("TV_Screen", "#0b0c0e", 0.15), flame=mat("Stove_Flame", "#4f8dff", 0.3, emission=4.0),
    )
    for g in range(len(LIGHT_GROUPS)):
        M[f"bulb{g}"] = mat(f"Int_Bulb_{g}", "#fff6e0", 0.3, emission=6.0)
        M[f"shade{g}"] = mat(f"Int_Shade_{g}", "#fff1d2", 0.8, emission=2.0)


def segments(a0, a1, gaps):
    """[a0, a1] minus the gaps."""
    out, s = [], a0
    for g0, g1 in sorted(gaps):
        if g0 > s:
            out.append((s, min(g0, a1)))
        s = max(s, g1)
    if s < a1:
        out.append((s, a1))
    return [(x0, x1) for x0, x1 in out if x1 - x0 > 0.02]


def strip(name, axis, at, facing, a0, a1, y0, y1, depth, material, uv=None):
    """A thin box on a wall face (skirting, dado band, tiles), protruding `depth` into the room."""
    lo, hi = sorted((at, at + facing * depth))
    o = box(name, a0, a1, lo, hi, y0, y1, material, "Interior") if axis == "x" else box(name, lo, hi, a0, a1, y0, y1, material, "Interior")
    if uv:
        box_uv(o, uv)
        o["uv_done"] = True
    return o


# Room-facing wall faces: (runs along, at, facing into the room, from, to, finish, gaps)
FACES = [
    ("x", IZ, -1, -IX, IX, "dado_green", [(FD_X - FD_W / 2, FD_X + FD_W / 2)]),
    ("x", -IZ, 1, -IX, -0.86, "dado_blue", []),
    ("x", -IZ, 1, -0.74, 1.54, "tiles", []),
    ("x", -IZ, 1, 1.66, IX, None, []),
    ("z", -IX, 1, -IZ, 0.24, "dado_blue", []),
    ("z", -IX, 1, 0.36, IZ, "dado_green", []),
    ("z", IX, -1, -IZ, 0.24, None, []),
    ("z", IX, -1, 0.36, IZ, "dado_green", []),
    ("x", 0.36, 1, -IX, -0.74, "dado_green", [(-2.45, -1.55)]),
    ("x", 0.24, -1, -IX, -0.86, "dado_blue", [(-2.45, -1.55)]),
    ("z", -0.86, -1, -IZ, 0.24, "dado_blue", []),
    ("z", -0.74, 1, -IZ, -1.26, "tiles", []),
    ("z", -0.74, 1, -1.14, 0.36, "dado_green", []),
    ("z", 1.54, -1, -IZ, -1.26, "tiles", []),
    ("z", 1.54, -1, -1.14, 0.36, "dado_green", []),
    ("z", 1.66, 1, -IZ, 0.24, None, []),
    ("x", 0.36, 1, 1.54, IX, "dado_green", [(2.7, 3.9)]),
    ("x", 0.24, -1, 1.66, IX, None, [(2.7, 3.9)]),
    ("x", -1.14, 1, -0.74, 1.54, "dado_green", [(0.0, 0.8)]),
    ("x", -1.26, -1, -0.74, 1.54, "tiles", [(0.0, 0.8)]),
]


def leaf(door_id, hinge, width, material, group):
    """A panelled door leaf from the hinge along +X (closed), in the wall's middle."""
    hx, hz = hinge
    parts = [box("Leaf", hx, hx + width, hz - LEAF_T / 2, hz + LEAF_T / 2, FLOOR + 0.01, FLOOR + DOOR_H - 0.01, material, group)]
    for y0, y1 in ((FLOOR + 0.18, FLOOR + 1.0), (FLOOR + 1.2, FLOOR + DOOR_H - 0.2)):
        for side in (1, -1):
            zz = hz + side * LEAF_T / 2
            parts.append(box("Panel", hx + 0.13, hx + width - 0.13, min(zz, zz + side * 0.012), max(zz, zz + side * 0.012), y0, y1, material, group, bevel=0.006))
    for side in (1, -1):
        zz = hz + side * (LEAF_T / 2 + 0.035)
        parts.append(box("Handle", hx + width - 0.17, hx + width - 0.06, zz - 0.012, zz + 0.012, FLOOR + 1.0, FLOOR + 1.03, M["door_metal"], group))
        parts.append(box("Rose", hx + width - 0.1, hx + width - 0.06, min(zz, hz + side * LEAF_T / 2), max(zz, hz + side * LEAF_T / 2), FLOOR + 0.98, FLOOR + 1.05, M["door_metal"], group))
    for o in parts:
        box_uv(o, 1.0)
        o["uv_done"] = True
    return parts


def architrave(cx, width, top, z_face, facing, material, group):
    """Door frame trim on one face of a wall running along x."""
    z0, z1 = sorted((z_face, z_face + facing * 0.03))
    box("Architrave", cx - width / 2 - 0.09, cx - width / 2, z0, z1, FLOOR, top, material, group)
    box("Architrave", cx + width / 2, cx + width / 2 + 0.09, z0, z1, FLOOR, top, material, group)
    box("Architrave", cx - width / 2 - 0.09, cx + width / 2 + 0.09, z0, z1, top, top + 0.09, material, group)


def shell():
    # Plinth, floors (one finish per room), thresholds, porch and steps.
    box("Plinth", -W / 2 - 0.06, W / 2 + 0.06, -D / 2 - 0.06, D / 2 + 0.06, -0.3, FLOOR - 0.005, M["plinth"], "Exterior")
    for rect, m, scale in (((-IX, IX, 0.36, IZ), "floor", 1 / 0.8), ((-0.74, 1.54, -1.14, 0.36), "floor", 1 / 0.8),
                           ((-IX, -0.86, -IZ, 0.24), "planks", 1.0), ((1.66, IX, -IZ, 0.24), "terracotta", 1 / 0.9),
                           ((-0.74, 1.54, -IZ, -1.26), "mosaic", 1.0)):
        f = box("Floor", *rect, FLOOR - 0.02, FLOOR, M[m], "Interior")
        box_uv(f, scale)
        f["uv_done"] = True
    for rect in ((-2.45, -1.55, 0.24, 0.36), (0.0, 0.8, -1.26, -1.14), (2.7, 3.9, 0.24, 0.36)):
        box("Threshold", *rect, FLOOR - 0.02, FLOOR + 0.003, M["wood_dark"], "Interior")
    box("Threshold", FD_X - FD_W / 2, FD_X + FD_W / 2, IZ, D / 2 + 0.02, FLOOR - 0.02, FLOOR + 0.004, M["concrete"], "Exterior")
    p = box("Porch", *PORCH, -0.3, FLOOR, M["porch_tile"], "Exterior")
    box_uv(p, 2.5)
    p["uv_done"] = True
    box("Step", *STEP, -0.3, FLOOR / 2, M["porch_tile"], "Exterior")

    # Outer walls with real openings.
    walls = {
        "front": box("WallFront", -W / 2, W / 2, D / 2 - T, D / 2, FLOOR, WALL_TOP, M["plaster"], "Exterior"),
        "back": box("WallBack", -W / 2, W / 2, -D / 2, -D / 2 + T, FLOOR, WALL_TOP, M["plaster"], "Exterior"),
        "left": box("WallLeft", -W / 2, -W / 2 + T, -D / 2 + T, D / 2 - T, FLOOR, WALL_TOP, M["plaster"], "Exterior"),
        "right": box("WallRight", W / 2 - T, W / 2, -D / 2 + T, D / 2 - T, FLOOR, WALL_TOP, M["plaster"], "Exterior"),
    }
    cut = lambda x0, x1, z0, z1, y0, y1: box("cutter", x0, x1, z0, z1, y0, y1, M["plaster"], "Bake")
    cutters = {k: [] for k in walls}
    cutters["front"].append(cut(FD_X - FD_W / 2, FD_X + FD_W / 2, D / 2 - T - 0.2, D / 2 + 0.2, FLOOR - 0.01, FLOOR + DOOR_H))
    for wall, a, w, h, sill in WINDOWS:
        y0, y1 = FLOOR + sill, FLOOR + sill + h
        if wall in ("front", "back"):
            z = D / 2 - T / 2 if wall == "front" else -D / 2 + T / 2
            cutters[wall].append(cut(a - w / 2, a + w / 2, z - 0.3, z + 0.3, y0, y1))
        else:
            x = -W / 2 + T / 2 if wall == "left" else W / 2 - T / 2
            cutters[wall].append(cut(x - 0.3, x + 0.3, a - w / 2, a + w / 2, y0, y1))
    for name, o in walls.items():
        GROUPS["Bake"] = [g for g in GROUPS["Bake"] if g not in cutters[name]]
        boolean_cut(o, cutters[name])
        classify_wall_faces(o, M["plaster"], M["jamb"], M["wall"])
        box_uv(o, 1.0)
        o["uv_done"] = True
        inner = split_faces(o, 2)  # room-facing plaster is lightmapped with the interior
        inner.name = o.name + "Inner"
        inner["uv_done"] = True
        put(inner, "Interior")

    # Partitions (room-facing on both sides), with doorways and the kitchen arch.
    for pid, axis, at, a0, a1 in PARTITIONS:
        if axis == "x":
            o = box("Partition", a0, a1, at - P / 2, at + P / 2, FLOOR, CEIL + 0.02, M["wall"], "Interior")
        else:
            o = box("Partition", at - P / 2, at + P / 2, a0, a1, FLOOR, CEIL + 0.02, M["wall"], "Interior")
        cs = []
        for part, centre, width, height, _ in OPENINGS:
            if part == pid:
                cs.append(cut(centre - width / 2, centre + width / 2, at - 0.3, at + 0.3, FLOOR - 0.01, FLOOR + height))
        GROUPS["Bake"] = [g for g in GROUPS["Bake"] if g not in cs]
        boolean_cut(o, cs)
        o.data.materials.clear()
        o.data.materials.append(M["wall"])
        for poly in o.data.polygons:
            poly.material_index = 0
        box_uv(o, 1.0)
        o["uv_done"] = True

    # Skirting everywhere; painted dado bands; tiles in the bathroom.
    for axis, at, facing, a0, a1, finish, gaps in FACES:
        for s0, s1 in segments(a0, a1, gaps):
            strip("Skirting", axis, at, facing, s0, s1, FLOOR, FLOOR + 0.1, 0.018, M["wood_dark"])
            if finish == "tiles":
                strip("WallTiles", axis, at, facing, s0, s1, FLOOR, FLOOR + 1.5, 0.012, M["tiles"], uv=1 / 0.6)
            elif finish:
                strip("Dado", axis, at, facing, s0, s1, FLOOR + 0.1, FLOOR + 0.9, 0.01, M[finish])
    box("Ceiling", -IX, IX, -IZ, IZ, CEIL, CEIL + 0.02, M["ceiling"], "Interior")

    # Doors: the front door and two interior doors, each on its own node, hinged on the left.
    doors = [("front", FD_X, FD_W, D / 2 - T / 2, M["door_wood"])] + [
        (did, centre, width, at, M["door_light"]) for (pid, centre, width, _h, did) in OPENINGS if did for (qid, axis, at, _a0, _a1) in PARTITIONS if qid == pid
    ]
    for did, cx, width, wz, material in doors:
        hinge = (cx - width / 2 + 0.02, wz)
        GROUPS[f"Door_{did}"] = []
        leaf(did, hinge, width - 0.04, material, f"Door_{did}")
        half = (T if did == "front" else P) / 2
        top = FLOOR + DOOR_H
        if did == "front":
            architrave(cx, width, top, D / 2, 1, M["frame"], "Exterior")
        else:
            architrave(cx, width, top, wz + half, 1, M["int_frame"], "Interior")
        architrave(cx, width, top, wz - half, -1, M["int_frame"], "Interior")
        SPEC["doors"].append({"id": did, "node": f"Door_{did}", "hinge": [round(hinge[0], 3), round(hinge[1], 3)], "width": round(width - 0.04, 3),
                              "thickness": LEAF_T, "height": DOOR_H, "openYaw": round(math.pi / 2, 4), "center": [round(cx, 3), round(wz, 3)], "outward": [0, 1],
                              "label": {"front": "Door", "bedroom": "Bedroom Door", "bathroom": "Bathroom Door"}[did]})
    # The kitchen arch: a frame.
    architrave(3.3, 1.2, FLOOR + 2.4, 0.36, 1, M["int_frame"], "Interior")
    architrave(3.3, 1.2, FLOOR + 2.4, 0.24, -1, M["int_frame"], "Interior")

    windows()
    roof_and_porch()


def windows():
    for wall, a, w, h, sill in WINDOWS:
        y0, y1 = FLOOR + sill, FLOOR + sill + h
        front_back = wall in ("front", "back")
        out = 1 if wall in ("front", "right") else -1
        mid = (D / 2 - T / 2) * out if front_back else (W / 2 - T / 2) * out

        def wbox(name, a0, a1, n0, n1, yy0, yy1, m, grp, bevel=0.0):
            lo = mid + min(n0, n1) if out > 0 else mid - max(n0, n1)
            hi = mid + max(n0, n1) if out > 0 else mid - min(n0, n1)
            return box(name, a0, a1, lo, hi, yy0, yy1, m, grp, bevel) if front_back else box(name, lo, hi, a0, a1, yy0, yy1, m, grp, bevel)

        fw = 0.06
        small = w < 0.8
        wbox("WinFrame", a - w / 2, a - w / 2 + fw, -0.04, 0.04, y0 + fw, y1 - fw, M["frame"], "Exterior")
        wbox("WinFrame", a + w / 2 - fw, a + w / 2, -0.04, 0.04, y0 + fw, y1 - fw, M["frame"], "Exterior")
        wbox("WinFrame", a - w / 2, a + w / 2, -0.04, 0.04, y0, y0 + fw, M["frame"], "Exterior")
        wbox("WinFrame", a - w / 2, a + w / 2, -0.04, 0.04, y1 - fw, y1, M["frame"], "Exterior")
        if not small:
            wbox("WinFrame", a - 0.025, a + 0.025, -0.035, 0.035, y0 + fw, y1 - fw, M["frame"], "Exterior")
            wbox("WinFrame", a - w / 2 + fw, a - 0.025, -0.035, 0.035, y0 + h * 0.62, y0 + h * 0.62 + 0.04, M["frame"], "Exterior")
            wbox("WinFrame", a + 0.025, a + w / 2 - fw, -0.035, 0.035, y0 + h * 0.62, y0 + h * 0.62 + 0.04, M["frame"], "Exterior")
        wbox("Pane", a - w / 2 + fw, a + w / 2 - fw, -0.004, 0.004, y0 + fw, y1 - fw, M["glass"], "Glass")
        wbox("Sill", a - w / 2 - 0.06, a + w / 2 + 0.06, -T / 2 - 0.05, -T / 2 + 0.02, y0 - 0.04, y0, M["wood"], "Interior")
        wbox("SillOut", a - w / 2 - 0.08, a + w / 2 + 0.08, T / 2 - 0.02, T / 2 + 0.08, y0 - 0.06, y0, M["concrete"], "Exterior")
        bars = 3 if small else 5
        for k in range(1, bars + 1):
            aa = a - w / 2 + k * w / (bars + 1)
            wbox("Grille", aa - 0.008, aa + 0.008, 0.06, 0.076, y0, y1, M["metal"], "Exterior")
        wbox("Grille", a - w / 2, a + w / 2, 0.06, 0.076, y0 + h * 0.5 - 0.008, y0 + h * 0.5 + 0.008, M["metal"], "Exterior")
        if small:
            continue
        for side in (-1, 1):  # shutters folded open against the facade
            s0 = a + side * (w / 2 + 0.04)
            s1 = s0 + side * (w / 2)
            lo, hi = min(s0, s1), max(s0, s1)
            wbox("Shutter", lo, hi, T / 2 + 0.005, T / 2 + 0.035, y0 - 0.02, y1 + 0.02, M["shutter"], "Exterior")
            for k in range(14):
                yy = y0 + 0.05 + k * (h - 0.06) / 14
                wbox("Louvre", lo + 0.04, hi - 0.04, T / 2 + 0.035, T / 2 + 0.05, yy, yy + 0.025, M["shutter"], "Exterior")


def roof_and_porch():
    o = ROOF_OVERHANG
    rise = (D / 2 + o) * math.tan(ROOF_PITCH)
    ex, ez, ridge = W / 2 + o, D / 2 + o, (W - D) / 2
    y0 = WALL_TOP - 0.02
    verts = [B(-ex, -ez, y0), B(ex, -ez, y0), B(ex, ez, y0), B(-ex, ez, y0), B(-ridge, 0, y0 + rise), B(ridge, 0, y0 + rise)]
    me = bpy.data.meshes.new("Roof")
    me.from_pydata([tuple(v) for v in verts], [], [(3, 2, 5, 4), (1, 0, 4, 5), (0, 3, 4), (2, 1, 5)])
    r = bpy.data.objects.new("Roof", me)
    bpy.context.collection.objects.link(r)
    r.data.materials.append(M["roof"])
    r.data.materials.append(M["soffit"])
    bm = bmesh.new()
    bm.from_mesh(me)
    uv = bm.loops.layers.uv.new("UVMap")
    for face in bm.faces:
        n = face.normal
        down = Vector((n.x, n.y, 0)).normalized()
        along = Vector((-down.y, down.x, 0))
        for loop in face.loops:
            p = loop.vert.co
            loop[uv].uv = (p.dot(along), (p.z - y0) / math.sin(ROOF_PITCH))
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
        box("Fascia", x0, x1, z0, z1, y0 - 0.2, y0 + 0.02, M["fascia"], "Exterior")
    for (x0, x1, z0, z1) in ((-ex, ex, D / 2, ez), (-ex, ex, -ez, -D / 2), (-ex, -W / 2, -D / 2, D / 2), (W / 2, ex, -D / 2, D / 2)):
        box("Soffit", x0, x1, z0, z1, y0 - 0.2, y0 - 0.18, M["soffit"], "Exterior")
    box("Canopy", PORCH[0] - 0.1, PORCH[1] + 0.1, D / 2, PORCH[3] + 0.1, FLOOR + 2.55, FLOOR + 2.68, M["concrete"], "Exterior")
    for x in (PORCH[0] + 0.12, PORCH[1] - 0.12):
        box("Post", x - 0.08, x + 0.08, PORCH[3] - 0.2, PORCH[3] - 0.04, FLOOR, FLOOR + 2.55, M["frame"], "Exterior")
    for x in (PORCH[0] + 0.35, PORCH[1] - 0.35):
        cyl("PlanterPot", x, D / 2 + 0.35, FLOOR, FLOOR + 0.42, 0.2, M["ext_pot"], "Exterior", r2=0.15)
        for k in range(6):
            ball("PlanterLeaf", x + random.uniform(-0.12, 0.12), D / 2 + 0.35 + random.uniform(-0.12, 0.12), FLOOR + 0.55 + random.uniform(0, 0.25), 0.16, M["ext_leaves"], "Exterior", scale=(1, 1, 0.7), sub=1)


# ── Furniture and interactive things ─────────────────────────────────────────────────────
LAMPS: list = []  # (light group, x, z, y, watts, radius) for the bake


def local(x, z, yaw, lx, lz):
    """A point in a piece's local frame (facing +Z) → model space (game rotation.y)."""
    c, s = math.cos(yaw), math.sin(yaw)
    return x + lx * c + lz * s, z - lx * s + lz * c


def block(x0, x1, z0, z1, x, z, yaw=0.0):
    ring = [[round(v, 3) for v in local(x, z, yaw, lx, lz)] for lx, lz in ((x0, z0), (x1, z0), (x1, z1), (x0, z1))]
    SPEC["blockers"].append(ring)


def seat(sid, label, lx, lz, x, z, yaw, height=0.46, stand=(0.0, 0.6)):
    """Where the hips go on a seat, the direction the sitter faces, and where to stand before
    sitting and after getting up (local to the seat: default 0.6 m in front)."""
    wx, wz = local(x, z, yaw, lx, lz)
    sx, sz = local(x, z, yaw, lx + stand[0], lz + stand[1])
    SPEC["seats"].append({"id": sid, "label": label, "x": round(wx, 3), "z": round(wz, 3), "yaw": round(yaw, 4), "height": height, "stand": [round(sx, 3), round(sz, 3)]})


def item(iid, label, title, text, x, z, y):
    SPEC["items"].append({"id": iid, "label": label, "title": title, "text": text, "x": round(x, 3), "z": round(z, 3), "y": round(y, 3)})


def switch(group, axis, at, facing, a, y=FLOOR + 1.3):
    """A light switch on a wall face; E near it switches the group's lights."""
    if axis == "x":
        lo, hi = sorted((at, at + facing * 0.012))
        box("Switch", a - 0.04, a + 0.04, lo, hi, y - 0.06, y + 0.06, M["white"], "Interior")
        box("SwitchKey", a - 0.012, a + 0.012, *sorted((at, at + facing * 0.02)), y - 0.02, y + 0.02, M["int_frame"], "Interior")
        x, z = a, at + facing * 0.05
    else:
        lo, hi = sorted((at, at + facing * 0.012))
        box("Switch", lo, hi, a - 0.04, a + 0.04, y - 0.06, y + 0.06, M["white"], "Interior")
        box("SwitchKey", *sorted((at, at + facing * 0.02)), a - 0.012, a + 0.012, y - 0.02, y + 0.02, M["int_frame"], "Interior")
        x, z = at + facing * 0.05, a
    SPEC["switches"][group].append([round(x, 3), round(z, 3), round(y, 3)])


def fan(room, x, z, group):
    """A ceiling fan (its own node, turned by the game) with a bulb of `group` under it."""
    fy = CEIL - 0.42
    g = f"Fan_{room}"
    GROUPS[g] = []
    cyl("FanRod", x, z, fy, CEIL, 0.015, M["fan_metal"], g, verts=8)
    cyl("FanHub", x, z, fy - 0.08, fy + 0.02, 0.1, M["fan_metal"], g, verts=16)
    for k in range(4):
        b = box("FanBlade", 0.12, 0.72, -0.06, 0.06, fy - 0.02, fy, M["fan_wood"], g, bevel=0.005)
        b.matrix_world = Matrix.Translation(B(x, z)) @ Matrix.Rotation(k * math.pi / 2, 4, "Z") @ b.matrix_world
        apply_all(b)
        bpy.context.view_layer.objects.active = b
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    ball("Bulb", x, z, fy - 0.15, 0.08, M[f"bulb{group}"], "Interior", sub=2)
    cyl("BulbCup", x, z, fy - 0.12, fy - 0.08, 0.09, M["steel"], "Interior", r2=0.05)
    SPEC["fans"].append({"node": g, "rpm": 90, "pivot": [x, z]})
    LAMPS.append((group, x, z, fy - 0.2, 150, 0.07))


def bulb(x, z, group, drop=0.25, watts=110):
    cyl("Cord", x, z, CEIL - drop, CEIL, 0.006, M["black"], "Interior", verts=6)
    ball("Bulb", x, z, CEIL - drop - 0.06, 0.07, M[f"bulb{group}"], "Interior", sub=2)
    cyl("BulbCup", x, z, CEIL - drop - 0.02, CEIL - drop + 0.02, 0.06, M["white"], "Interior", r2=0.03)
    LAMPS.append((group, x, z, CEIL - drop - 0.12, watts, 0.06))


def living():
    # Sofa against the bedroom partition, facing the TV on the front wall.
    sx, sz = -3.7, 0.36 + 0.43
    parts = [
        box("SofaBase", -1.0, 1.0, -0.42, 0.42, FLOOR + 0.1, FLOOR + 0.3, M["fabric"], "Interior", bevel=0.03),
        box("SofaBack", -1.0, 1.0, -0.42, -0.2, FLOOR + 0.3, FLOOR + 0.82, M["fabric"], "Interior", bevel=0.05),
        box("SofaArm", -1.0, -0.82, -0.42, 0.42, FLOOR + 0.3, FLOOR + 0.6, M["fabric"], "Interior", bevel=0.05),
        box("SofaArm", 0.82, 1.0, -0.42, 0.42, FLOOR + 0.3, FLOOR + 0.6, M["fabric"], "Interior", bevel=0.05),
        box("SofaCushion", -0.81, -0.01, -0.2, 0.4, FLOOR + 0.3, FLOOR + 0.44, M["cushion"], "Interior", bevel=0.04),
        box("SofaCushion", 0.01, 0.81, -0.2, 0.4, FLOOR + 0.3, FLOOR + 0.44, M["cushion"], "Interior", bevel=0.04),
        box("SofaPillow", -0.75, -0.4, -0.2, -0.08, FLOOR + 0.44, FLOOR + 0.78, M["krama"], "Interior", bevel=0.04),
        box("SofaPillow", 0.4, 0.75, -0.2, -0.08, FLOOR + 0.44, FLOOR + 0.78, M["rug"], "Interior", bevel=0.04),
    ]
    for lx in (-0.92, 0.92):
        for lz in (-0.34, 0.34):
            parts.append(box("SofaLeg", lx - 0.03, lx + 0.03, lz - 0.03, lz + 0.03, FLOOR, FLOOR + 0.1, M["wood_dark"], "Interior"))
    place(parts, sx, sz, 0.0)
    block(-1.0, 1.0, -0.42, 0.42, sx, sz)
    seat("sofa-left", "sofa", -0.42, 0.06, sx, sz, 0.0, 0.44, stand=(0.0, 0.55))
    seat("sofa-right", "sofa", 0.42, 0.06, sx, sz, 0.0, 0.44, stand=(0.0, 0.55))
    # Rug and coffee table with tea.
    place([box("Rug", -1.3, 1.3, -0.95, 0.95, FLOOR, FLOOR + 0.008, M["rug"], "Interior")], -3.7, 2.1, 0.0)
    tbl = [box("TableTop", -0.45, 0.45, -0.25, 0.25, FLOOR + 0.4, FLOOR + 0.44, M["wood"], "Interior", bevel=0.01)]
    for lx in (-0.39, 0.39):
        for lz in (-0.19, 0.19):
            tbl.append(box("TableLeg", lx - 0.025, lx + 0.025, lz - 0.025, lz + 0.025, FLOOR + 0.008, FLOOR + 0.4, M["wood"], "Interior"))
    tbl.append(box("TableShelf", -0.39, 0.39, -0.19, 0.19, FLOOR + 0.12, FLOOR + 0.14, M["wood"], "Interior"))
    tbl.append(cyl("Teapot", 0.12, 0.0, FLOOR + 0.44, FLOOR + 0.56, 0.065, M["ceramic"], "Interior"))
    for cx_, cz_ in ((-0.1, 0.08), (-0.2, -0.06)):
        tbl.append(cyl("Cup", cx_, cz_, FLOOR + 0.44, FLOOR + 0.5, 0.03, M["ceramic"], "Interior"))
    place(tbl, -3.55, 2.0, 0.0)
    block(-0.45, 0.45, -0.25, 0.25, -3.55, 2.0)
    # Armchair by the left wall, facing the room (+X).
    ax_, az_, ayaw = -4.6, 2.85, math.pi / 2
    chair = [
        box("ChairSeat", -0.33, 0.33, -0.3, 0.3, FLOOR + 0.3, FLOOR + 0.4, M["wood_dark"], "Interior", bevel=0.01),
        box("ChairCushion", -0.29, 0.29, -0.27, 0.3, FLOOR + 0.4, FLOOR + 0.47, M["cushion"], "Interior", bevel=0.03),
        box("ChairBack", -0.33, 0.33, -0.33, -0.27, FLOOR + 0.4, FLOOR + 0.95, M["wood_dark"], "Interior", bevel=0.01),
        box("ChairBackCushion", -0.27, 0.27, -0.27, -0.2, FLOOR + 0.5, FLOOR + 0.88, M["cushion"], "Interior", bevel=0.03),
    ]
    for side in (-1, 1):
        chair.append(box("ChairArm", side * 0.33 - 0.035, side * 0.33 + 0.035, -0.33, 0.28, FLOOR + 0.62, FLOOR + 0.66, M["wood_dark"], "Interior", bevel=0.01))
        chair.append(box("ChairArmPost", side * 0.33 - 0.025, side * 0.33 + 0.025, 0.2, 0.26, FLOOR + 0.4, FLOOR + 0.62, M["wood_dark"], "Interior"))
        for lz in (-0.26, 0.24):
            chair.append(box("ChairLeg", side * 0.29 - 0.025, side * 0.29 + 0.025, lz - 0.025, lz + 0.025, FLOOR, FLOOR + 0.3, M["wood_dark"], "Interior"))
    place(chair, ax_, az_, ayaw)
    block(-0.36, 0.36, -0.34, 0.3, ax_, az_, ayaw)
    seat("armchair", "armchair", 0.0, 0.04, ax_, az_, ayaw, 0.47)
    # TV unit on the front wall; the screen is its own node (TVScreen, turned on in the game).
    tv = [box("TVUnit", -0.75, 0.75, -0.22, 0.22, FLOOR + 0.1, FLOOR + 0.55, M["wood"], "Interior", bevel=0.01)]
    for k in (-0.37, 0.37):
        tv.append(box("TVUnitDoor", k - 0.35, k + 0.35, 0.22, 0.232, FLOOR + 0.15, FLOOR + 0.5, M["wood_dark"], "Interior"))
    for lx in (-0.68, 0.68):
        tv.append(box("TVUnitLeg", lx - 0.03, lx + 0.03, -0.16, 0.16, FLOOR, FLOOR + 0.1, M["wood_dark"], "Interior"))
    tv.append(box("TVStand", -0.12, 0.12, -0.08, 0.04, FLOOR + 0.55, FLOOR + 0.58, M["black"], "Interior"))
    tv.append(box("TVNeck", -0.03, 0.03, -0.05, -0.01, FLOOR + 0.58, FLOOR + 0.66, M["black"], "Interior"))
    tv.append(box("TVBody", -0.46, 0.46, -0.06, -0.02, FLOOR + 0.64, FLOOR + 1.17, M["black"], "Interior", bevel=0.005))
    place(tv, -3.7, IZ - 0.23, math.pi)
    GROUPS["TVScreen"] = []
    scr = place([box("TVScreen", -0.43, 0.43, -0.022, -0.016, FLOOR + 0.67, FLOOR + 1.14, M["screen"], "TVScreen")], -3.7, IZ - 0.23, math.pi)[0]
    # u runs left to right as seen from the room (facing +Z, the viewer's left is +X).
    bm = bmesh.new()
    bm.from_mesh(scr.data)
    uvl = bm.loops.layers.uv.get("UVMap") or bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for loop in f.loops:
            p = loop.vert.co
            loop[uvl].uv = ((-3.7 + 0.43 - p.x) / 0.86, (p.z - (FLOOR + 0.67)) / 0.47)
    bm.to_mesh(scr.data)
    bm.free()
    scr["uv_done"] = True
    block(-0.78, 0.78, -0.25, 0.25, -3.7, IZ - 0.23, math.pi)
    tx, tz = -3.7, IZ - 0.35
    SPEC["toggles"].append({"id": "tv", "label": "TV", "node": "TVScreen", "kind": "tv", "x": tx, "z": round(tz, 3), "y": FLOOR + 0.9})
    # Floor lamp in the corner, a tall plant, the family altar high on the left wall.
    lx, lz = -4.68, IZ - 0.32
    cyl("LampBase", lx, lz, FLOOR, FLOOR + 0.03, 0.15, M["int_metal"], "Interior")
    cyl("LampPole", lx, lz, FLOOR + 0.03, FLOOR + 1.45, 0.012, M["int_metal"], "Interior", verts=8)
    cyl("LampShade", lx, lz, FLOOR + 1.35, FLOOR + 1.6, 0.21, M["shade0"], "Interior", verts=20, r2=0.14)
    block(-0.18, 0.18, -0.18, 0.18, lx, lz)
    LAMPS.append((0, lx, lz, FLOOR + 1.47, 60, 0.08))
    plant(0.25, IZ - 0.35)
    shelf_x, shelf_z, shelf_y = -IX + 0.16, 3.35, FLOOR + 1.95
    alt = [box("AltarShelf", -0.45, 0.45, -0.16, 0.16, shelf_y - 0.04, shelf_y, M["red"], "Interior"),
           box("AltarBracket", -0.4, -0.36, -0.16, 0.0, shelf_y - 0.25, shelf_y - 0.04, M["red"], "Interior"),
           box("AltarBracket", 0.36, 0.4, -0.16, 0.0, shelf_y - 0.25, shelf_y - 0.04, M["red"], "Interior"),
           cyl("BuddhaBase", 0, 0.02, shelf_y, shelf_y + 0.05, 0.07, M["gold"], "Interior"),
           ball("BuddhaBody", 0, 0.02, shelf_y + 0.13, 0.07, M["gold"], "Interior", scale=(0.9, 0.7, 1.2)),
           ball("BuddhaHead", 0, 0.02, shelf_y + 0.25, 0.04, M["gold"], "Interior"),
           cyl("Vase", -0.25, 0.04, shelf_y, shelf_y + 0.12, 0.035, M["ceramic"], "Interior"),
           cyl("IncenseBowl", 0.24, 0.05, shelf_y, shelf_y + 0.05, 0.05, M["gold"], "Interior")]
    for k in range(5):
        alt.append(ball("Jasmine", -0.25 + random.uniform(-0.03, 0.03), 0.04 + random.uniform(-0.03, 0.03), shelf_y + 0.16 + random.uniform(0, 0.05), 0.022, M["white"], "Interior", sub=1))
    for k in range(3):
        alt.append(cyl("Incense", 0.22 + k * 0.02, 0.05, shelf_y + 0.05, shelf_y + 0.22, 0.003, M["red"], "Interior", verts=4))
    place(alt, shelf_x, shelf_z, math.pi / 2)
    item("altar", "Family Altar", "Family altar", "A small Buddha, fresh jasmine and incense. On holy days the family offers fruit and rice here.", shelf_x + 0.2, shelf_z, shelf_y + 0.1)
    # Painting above the sofa.
    box("PaintingFrame", sx - 0.62, sx + 0.62, 0.36, 0.39, FLOOR + 1.35, FLOOR + 2.15, M["wood_dark"], "Interior")
    pt = box("Painting", sx - 0.56, sx + 0.56, 0.39, 0.395, FLOOR + 1.41, FLOOR + 2.09, M["painting"], "Interior")
    planar_uv(pt, "x", sx - 0.56, sx + 0.56, FLOOR + 1.41, FLOOR + 2.09)
    item("painting", "Painting", "Sunset over the temples", "A painted print from a stall near the Russian Market: three towers against an evening sky.", sx, 0.42, FLOOR + 1.75)
    fan("living", -2.3, 2.2, 0)
    switch(0, "x", IZ, -1, FD_X - FD_W / 2 - 0.22)


def plant(x, z, scale=1.0):
    cyl("PlantPot", x, z, FLOOR, FLOOR + 0.42 * scale, 0.2 * scale, M["pot"], "Interior", r2=0.16 * scale)
    for k in range(10):
        a = k * 2.4
        rr = (0.1 + 0.03 * k) * scale
        ball("PlantLeaf", x + math.cos(a) * rr * 0.6, z + math.sin(a) * rr * 0.6, FLOOR + (0.55 + k * 0.08) * scale, 0.16 * scale, M["leaves"], "Interior", scale=(1.2, 0.5, 0.35), sub=1)
    SPEC["blockers"].append([[round(x - 0.24, 3), round(z - 0.24, 3)], [round(x + 0.24, 3), round(z - 0.24, 3)], [round(x + 0.24, 3), round(z + 0.24, 3)], [round(x - 0.24, 3), round(z + 0.24, 3)]])


def planar_uv(o, axis, a0, a1, y0, y1):
    """0-1 UVs across a flat picture (on a wall running along `axis`)."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    uvl = bm.loops.layers.uv.get("UVMap") or bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for loop in f.loops:
            p = loop.vert.co
            a = p.x if axis == "x" else -p.y
            loop[uvl].uv = ((a - a0) / (a1 - a0), (p.z - y0) / (y1 - y0))
    bm.to_mesh(o.data)
    bm.free()
    o["uv_done"] = True


def dining():
    tx, tz = 2.8, 2.35
    t = [box("DiningTop", -0.7, 0.7, -0.42, 0.42, FLOOR + 0.72, FLOOR + 0.76, M["wood"], "Interior", bevel=0.01)]
    for lx in (-0.63, 0.63):
        for lz in (-0.35, 0.35):
            t.append(box("DiningLeg", lx - 0.03, lx + 0.03, lz - 0.03, lz + 0.03, FLOOR, FLOOR + 0.72, M["wood"], "Interior"))
    t.append(cyl("FruitBowl", 0, 0, FLOOR + 0.76, FLOOR + 0.84, 0.13, M["ceramic"], "Interior", r2=0.16))
    for k in range(4):
        t.append(ball("Mango", random.uniform(-0.06, 0.06), random.uniform(-0.06, 0.06), FLOOR + 0.86, 0.045, mat("Int_Mango", "#e0a82e", 0.6), "Interior", scale=(1, 0.75, 0.75), sub=1))
    place(t, tx, tz, 0.0)
    seats = []
    for i, (cx_, side) in enumerate(((-0.35, -1), (0.35, -1), (-0.35, 1), (0.35, 1))):
        cz_ = side * 0.72
        yaw = 0.0 if side < 0 else math.pi  # face the table
        ch = [box("DChairSeat", -0.21, 0.21, -0.21, 0.21, FLOOR + 0.42, FLOOR + 0.46, M["wood_dark"], "Interior", bevel=0.01),
              box("DChairBack", -0.21, 0.21, -0.23, -0.19, FLOOR + 0.46, FLOOR + 0.95, M["wood_dark"], "Interior", bevel=0.01)]
        for lx in (-0.17, 0.17):
            for lz in (-0.19, 0.17):
                ch.append(box("DChairLeg", lx - 0.02, lx + 0.02, lz - 0.02, lz + 0.02, FLOOR, FLOOR + 0.42, M["wood_dark"], "Interior"))
        place(ch, tx + cx_, tz + cz_, yaw)
        # Slide in from the outer side (never through the chair back or the table).
        outer = -1 if cx_ < 0 else 1
        side_x = outer * (1 if side < 0 else -1)  # local +X points the other way on the far side
        sid = f"dining-{i + 1}"
        seat(sid, "chair", 0.0, 0.0, tx + cx_, tz + cz_, yaw, 0.46, stand=(side_x * 0.7, 0.0))
        seats.append(sid)
    block(-0.72, 0.72, -0.95, 0.95, tx, tz)
    SPEC["tables"].append({"id": "dining", "label": "Table", "rect": [round(tx - 0.7, 3), round(tx + 0.7, 3), round(tz - 0.42, 3), round(tz + 0.42, 3)], "seats": seats})
    bulb_pendant(tx, tz, 0)
    # Sideboard on the front wall with family photos, a radio and a vase.
    sbx, sbz = 4.25, IZ - 0.23
    sb = [box("Sideboard", -0.7, 0.7, -0.22, 0.22, FLOOR + 0.1, FLOOR + 0.82, M["wood"], "Interior", bevel=0.01)]
    for k in (-0.35, 0.35):
        sb.append(box("SideboardDoor", k - 0.33, k + 0.33, 0.22, 0.235, FLOOR + 0.16, FLOOR + 0.76, M["wood_dark"], "Interior"))
    for lx in (-0.62, 0.62):
        sb.append(box("SideboardLeg", lx - 0.03, lx + 0.03, -0.16, 0.16, FLOOR, FLOOR + 0.1, M["wood_dark"], "Interior"))
    sb.append(box("PhotoFrame", -0.38, -0.08, -0.04, -0.01, FLOOR + 0.82, FLOOR + 1.06, M["int_frame"], "Interior"))
    sb.append(box("Radio", 0.12, 0.44, -0.12, 0.08, FLOOR + 0.82, FLOOR + 1.0, M["wood_dark"], "Interior", bevel=0.01))
    sb.append(box("RadioGrille", 0.15, 0.3, 0.08, 0.085, FLOOR + 0.85, FLOOR + 0.97, M["fan_metal"], "Interior"))
    sb.append(cyl("Vase", 0.58, 0.0, FLOOR + 0.82, FLOOR + 1.02, 0.07, M["blue"], "Interior", r2=0.05))
    place(sb, sbx, sbz, math.pi)
    photo = place([box("Photo", -0.36, -0.1, -0.012, -0.009, FLOOR + 0.84, FLOOR + 1.04, M["photo"], "Interior")], sbx, sbz, math.pi)[0]
    pxa, pxb = sbx + 0.1, sbx + 0.36
    planar_uv(photo, "x", pxb, pxa, FLOOR + 0.84, FLOOR + 1.04)
    block(-0.72, 0.72, -0.24, 0.24, sbx, sbz, math.pi)
    item("photo", "Family Photo", "Family photo", "Three generations at Pchum Ben, lined up in front of the pagoda gate in their best clothes.", sbx + 0.22, sbz - 0.05, FLOOR + 0.95)
    item("radio", "Radio", "Old radio", "Still tuned to the morning news in Khmer, and to the Sunday music show.", sbx - 0.28, sbz - 0.05, FLOOR + 0.9)
    # Wall clock, a plant by the kitchen arch, a switch by the arch.
    box("ClockFace", IX - 0.04, IX, 1.0, 1.34, FLOOR + 1.85, FLOOR + 2.19, M["int_frame"], "Interior", bevel=0.02)
    box("ClockHand", IX - 0.05, IX - 0.04, 1.16, 1.18, FLOOR + 2.0, FLOOR + 2.13, M["int_metal"], "Interior")
    box("ClockHand", IX - 0.05, IX - 0.04, 1.16, 1.27, FLOOR + 2.01, FLOOR + 2.03, M["int_metal"], "Interior")
    plant(IX - 0.35, 0.75, 0.9)
    switch(0, "x", 0.36, 1, 2.45)


def bulb_pendant(x, z, group):
    cyl("Cord", x, z, CEIL - 0.7, CEIL, 0.006, M["black"], "Interior", verts=6)
    cyl("PendantShade", x, z, CEIL - 0.85, CEIL - 0.7, 0.26, M[f"shade{group}"], "Interior", verts=24, r2=0.05)
    ball("Bulb", x, z, CEIL - 0.82, 0.06, M[f"bulb{group}"], "Interior", sub=2)
    LAMPS.append((group, x, z, CEIL - 0.9, 120, 0.08))


def kitchen():
    # L-shaped counter: along the right wall (sink under the window) and the back wall (stove).
    c = []
    c.append(box("CounterR", IX - 0.6, IX, -IZ, -0.9, FLOOR, FLOOR + 0.86, M["white"], "Interior"))
    c.append(box("CounterRTop", IX - 0.62, IX, -IZ, -0.88, FLOOR + 0.86, FLOOR + 0.9, M["wood"], "Interior"))
    c.append(box("CounterB", 2.4, IX - 0.6, -IZ, -IZ + 0.6, FLOOR, FLOOR + 0.86, M["white"], "Interior"))
    c.append(box("CounterBTop", 2.4, IX - 0.6, -IZ, -IZ + 0.62, FLOOR + 0.86, FLOOR + 0.9, M["wood"], "Interior"))
    for z0 in (-3.0, -2.2, -1.4):
        c.append(box("CupboardDoor", IX - 0.61, IX - 0.6, z0 + 0.03, z0 + 0.77, FLOOR + 0.1, FLOOR + 0.8, M["wood_dark"], "Interior"))
    for x0 in (2.45, 3.2):
        c.append(box("CupboardDoor", x0, x0 + 0.7, -IZ + 0.6, -IZ + 0.61, FLOOR + 0.1, FLOOR + 0.8, M["wood_dark"], "Interior"))
    # Backsplash tiles above both counters.
    strip("Backsplash", "z", IX, -1, -IZ, -0.88, FLOOR + 0.9, FLOOR + 1.5, 0.012, M["tiles"], uv=1 / 0.6)
    strip("Backsplash", "x", -IZ, 1, 2.4, IX - 0.6, FLOOR + 0.9, FLOOR + 1.5, 0.012, M["tiles"], uv=1 / 0.6)
    # Sink with a tap, a dish rack.
    c.append(box("Sink", IX - 0.5, IX - 0.12, -2.45, -1.95, FLOOR + 0.8, FLOOR + 0.905, M["steel"], "Interior"))
    c.append(cyl("Tap", IX - 0.08, -2.2, FLOOR + 0.9, FLOOR + 1.12, 0.012, M["steel"], "Interior", verts=8))
    c.append(box("TapSpout", IX - 0.24, IX - 0.08, -2.21, -2.19, FLOOR + 1.1, FLOOR + 1.12, M["steel"], "Interior"))
    c.append(box("DishRack", IX - 0.45, IX - 0.15, -1.75, -1.35, FLOOR + 0.9, FLOOR + 1.02, M["steel"], "Interior"))
    # Two-burner gas stove with a pot; its flames are their own node (StoveFlame).
    sx, sz = 3.3, -IZ + 0.3
    c.append(box("Stove", sx - 0.36, sx + 0.36, sz - 0.22, sz + 0.2, FLOOR + 0.9, FLOOR + 0.98, M["black"], "Interior", bevel=0.01))
    for bx in (sx - 0.17, sx + 0.17):
        c.append(cyl("Burner", bx, sz, FLOOR + 0.98, FLOOR + 1.0, 0.07, M["int_metal"], "Interior", verts=16))
    c.append(cyl("Pot", sx - 0.17, sz, FLOOR + 1.0, FLOOR + 1.16, 0.12, M["steel"], "Interior", verts=20))
    c.append(cyl("Kettle", sx + 0.17, sz, FLOOR + 1.0, FLOOR + 1.12, 0.08, M["red"], "Interior", verts=16, r2=0.06))
    GROUPS["StoveFlame"] = []
    for bx in (sx - 0.17, sx + 0.17):
        cyl("Flame", bx, sz, FLOOR + 1.0, FLOOR + 1.03, 0.065, M["flame"], "StoveFlame", verts=16, r2=0.075)
    SPEC["toggles"].append({"id": "stove", "label": "Stove", "node": "StoveFlame", "kind": "flame", "x": sx, "z": round(sz + 0.25, 3), "y": FLOOR + 1.0})
    # Rice cooker, a wall shelf with jars and bowls, the fridge.
    c.append(cyl("RiceCooker", IX - 0.3, -1.15, FLOOR + 0.9, FLOOR + 1.12, 0.14, M["white"], "Interior", verts=20))
    c.append(cyl("RiceCookerLid", IX - 0.3, -1.15, FLOOR + 1.12, FLOOR + 1.15, 0.13, M["fan_metal"], "Interior", verts=20))
    item("ricecooker", "Rice Cooker", "Rice cooker", "Jasmine rice from Battambang, cooked and keeping warm for lunch.", IX - 0.3, -1.15, FLOOR + 1.05)
    c.append(box("WallShelf", 1.66, 1.92, -2.4, -1.2, FLOOR + 1.45, FLOOR + 1.48, M["wood"], "Interior"))
    for k in range(4):
        c.append(cyl("Jar", 1.79, -2.25 + k * 0.28, FLOOR + 1.48, FLOOR + 1.62, 0.055, M["ceramic"] if k % 2 else M["jar"], "Interior", verts=12))
    fx, fz = 2.0, -IZ + 0.33
    c.append(box("Fridge", fx - 0.32, fx + 0.32, fz - 0.32, fz + 0.32, FLOOR, FLOOR + 1.75, M["fridge"], "Interior", bevel=0.02))
    c.append(box("FridgeHandle", fx + 0.2, fx + 0.23, fz + 0.32, fz + 0.36, FLOOR + 0.9, FLOOR + 1.4, M["steel"], "Interior"))
    c.append(box("FridgeLine", fx - 0.32, fx + 0.32, fz + 0.32, fz + 0.325, FLOOR + 1.2, FLOOR + 1.21, M["int_metal"], "Interior"))
    SPEC["blockers"] += [
        [[IX - 0.62, -IZ], [IX, -IZ], [IX, -0.88], [IX - 0.62, -0.88]],
        [[2.4, -IZ], [IX - 0.6, -IZ], [IX - 0.6, -IZ + 0.62], [2.4, -IZ + 0.62]],
        [[fx - 0.33, fz - 0.33], [fx + 0.33, fz - 0.33], [fx + 0.33, fz + 0.36], [fx - 0.33, fz + 0.36]],
    ]
    bulb(3.3, -2.0, 1, drop=0.2)
    switch(1, "x", 0.24, -1, 4.25)


def bedroom():
    # Double bed against the back wall, krama blanket, pillows; bedside tables and a lamp.
    bx, bz = -3.0, -IZ + 1.0
    b = [box("BedFrame", -0.82, 0.82, -1.0, 1.0, FLOOR + 0.12, FLOOR + 0.35, M["wood_dark"], "Interior", bevel=0.01),
         box("Headboard", -0.85, 0.85, -1.0, -0.94, FLOOR + 0.12, FLOOR + 1.1, M["wood_dark"], "Interior", bevel=0.01),
         box("Mattress", -0.78, 0.78, -0.94, 0.96, FLOOR + 0.35, FLOOR + 0.52, M["linen"], "Interior", bevel=0.04),
         box("Blanket", -0.8, 0.8, -0.3, 0.98, FLOOR + 0.5, FLOOR + 0.545, M["krama"], "Interior", bevel=0.02),
         box("Pillow", -0.7, -0.08, -0.9, -0.55, FLOOR + 0.52, FLOOR + 0.64, M["white"], "Interior", bevel=0.05),
         box("Pillow", 0.08, 0.7, -0.9, -0.55, FLOOR + 0.52, FLOOR + 0.64, M["white"], "Interior", bevel=0.05)]
    for lx in (-0.78, 0.78):
        for lz in (-0.96, 0.96):
            b.append(box("BedLeg", lx - 0.04, lx + 0.04, lz - 0.04, lz + 0.04, FLOOR, FLOOR + 0.12, M["wood_dark"], "Interior"))
    place(b, bx, bz, 0.0)
    block(-0.86, 0.86, -1.0, 1.0, bx, bz)
    seat("bed-left", "bed", -0.4, 0.72, bx, bz, 0.0, 0.52, stand=(0.0, 0.62))
    seat("bed-right", "bed", 0.4, 0.72, bx, bz, 0.0, 0.52, stand=(0.0, 0.62))
    for nx in (bx - 1.12, bx + 1.12):
        place([box("Nightstand", -0.22, 0.22, -0.2, 0.2, FLOOR, FLOOR + 0.52, M["wood"], "Interior", bevel=0.01),
               box("NightstandDrawer", -0.18, 0.18, 0.2, 0.21, FLOOR + 0.3, FLOOR + 0.46, M["wood_dark"], "Interior")], nx, -IZ + 0.24, 0.0)
        block(-0.23, 0.23, -0.21, 0.21, nx, -IZ + 0.24)
    lx, lz = bx - 1.12, -IZ + 0.24
    cyl("BedLampBase", lx, lz, FLOOR + 0.52, FLOOR + 0.56, 0.07, M["ceramic"], "Interior")
    cyl("BedLampStem", lx, lz, FLOOR + 0.56, FLOOR + 0.78, 0.012, M["gold"], "Interior", verts=8)
    cyl("BedLampShade", lx, lz, FLOOR + 0.74, FLOOR + 0.92, 0.13, M["shade2"], "Interior", verts=16, r2=0.09)
    LAMPS.append((2, lx, lz, FLOOR + 0.83, 35, 0.05))
    # Wardrobe against the bathroom partition.
    wx, wz = -0.86 - 0.3, -1.5
    w = [box("Wardrobe", -0.6, 0.6, -0.29, 0.29, FLOOR, FLOOR + 2.0, M["wood"], "Interior", bevel=0.01)]
    for k in (-0.3, 0.3):
        w.append(box("WardrobeDoor", k - 0.28, k + 0.28, 0.29, 0.3, FLOOR + 0.06, FLOOR + 1.94, M["wood_dark"], "Interior"))
        w.append(box("WardrobeKnob", k - (0.22 if k > 0 else -0.22) - 0.012, k - (0.22 if k > 0 else -0.22) + 0.012, 0.3, 0.32, FLOOR + 1.0, FLOOR + 1.06, M["gold"], "Interior"))
    place(w, wx, wz, -math.pi / 2)
    block(-0.6, 0.6, -0.3, 0.32, wx, wz, -math.pi / 2)
    # Desk under the side window, a chair, books and a desk lamp.
    dx, dz = -IX + 0.28, -0.8
    d = [box("DeskTop", -0.55, 0.55, -0.28, 0.28, FLOOR + 0.72, FLOOR + 0.75, M["wood"], "Interior", bevel=0.01)]
    for lx_ in (-0.5, 0.5):
        for lz_ in (-0.23, 0.23):
            d.append(box("DeskLeg", lx_ - 0.025, lx_ + 0.025, lz_ - 0.025, lz_ + 0.025, FLOOR, FLOOR + 0.72, M["wood"], "Interior"))
    for k, colr in enumerate(("#8e2f2a", "#2f5f8a", "#c9953d", "#3d6b3a")):
        d.append(box("Book", -0.42 + k * 0.05, -0.38 + k * 0.05, -0.2, 0.0, FLOOR + 0.75, FLOOR + 0.98 - k * 0.02, mat(f"Int_Book{k}", colr, 0.8), "Interior"))
    d.append(box("Notebook", 0.0, 0.22, -0.05, 0.12, FLOOR + 0.75, FLOOR + 0.765, M["white"], "Interior"))
    place(d, dx, dz, math.pi / 2)
    block(-0.56, 0.56, -0.29, 0.29, dx, dz, math.pi / 2)
    item("books", "Books", "Books", "A Khmer–English dictionary, a novel by Soth Polin and well-thumbed exam notes.", dx + 0.05, dz + 0.3, FLOOR + 0.85)
    cx_, cz_ = dx + 0.62, dz
    ch = [box("DeskChairSeat", -0.21, 0.21, -0.21, 0.21, FLOOR + 0.43, FLOOR + 0.47, M["wood_dark"], "Interior", bevel=0.01),
          box("DeskChairBack", -0.21, 0.21, -0.23, -0.19, FLOOR + 0.47, FLOOR + 0.92, M["wood_dark"], "Interior", bevel=0.01)]
    for lx_ in (-0.17, 0.17):
        for lz_ in (-0.19, 0.17):
            ch.append(box("DeskChairLeg", lx_ - 0.02, lx_ + 0.02, lz_ - 0.02, lz_ + 0.02, FLOOR, FLOOR + 0.43, M["wood_dark"], "Interior"))
    place(ch, cx_, cz_, -math.pi / 2)
    seat("desk-chair", "desk chair", 0.0, 0.0, cx_, cz_, -math.pi / 2, 0.47, stand=(-0.55, 0.0))
    SPEC["tables"].append({"id": "desk", "label": "Desk", "rect": [round(-IX, 3), round(-IX + 0.56, 3), round(dz - 0.55, 3), round(dz + 0.55, 3)], "seats": ["desk-chair"]})
    fan("bedroom", -2.9, -1.6, 2)
    switch(2, "x", 0.24, -1, -2.7)


def bathroom():
    # Toilet in the back corner, a basin with a mirror, the water jar and a shower.
    tx, tz = -0.34, -IZ + 0.36
    t = [box("ToiletBase", -0.18, 0.18, -0.2, 0.25, FLOOR, FLOOR + 0.4, M["white"], "Interior", bevel=0.04),
         box("ToiletSeat", -0.19, 0.19, -0.18, 0.27, FLOOR + 0.4, FLOOR + 0.43, M["white"], "Interior", bevel=0.02),
         box("Cistern", -0.2, 0.2, -0.36, -0.18, FLOOR + 0.4, FLOOR + 0.82, M["white"], "Interior", bevel=0.02)]
    place(t, tx, tz, 0.0)
    block(-0.21, 0.21, -0.36, 0.28, tx, tz)
    sx, sz = 1.54 - 0.24, -1.75
    s = [box("Basin", -0.24, 0.24, -0.2, 0.2, FLOOR + 0.78, FLOOR + 0.86, M["white"], "Interior", bevel=0.03),
         box("BasinPedestal", -0.08, 0.08, -0.08, 0.08, FLOOR, FLOOR + 0.78, M["white"], "Interior"),
         box("Mirror", -0.25, 0.25, -0.22, -0.21, FLOOR + 1.15, FLOOR + 1.75, M["mirror"], "Interior")]
    place(s, sx, sz, -math.pi / 2)
    block(-0.25, 0.25, -0.22, 0.21, sx, sz, -math.pi / 2)
    jx, jz = 1.1, -IZ + 0.42
    cyl("WaterJar", jx, jz, FLOOR, FLOOR + 0.62, 0.3, M["jar"], "Interior", verts=24, r2=0.24)
    cyl("JarWater", jx, jz, FLOOR + 0.58, FLOOR + 0.6, 0.23, M["blue"], "Interior", verts=24)
    cyl("Dipper", jx + 0.12, jz + 0.05, FLOOR + 0.6, FLOOR + 0.68, 0.06, M["red"], "Interior", verts=12)
    block(-0.32, 0.32, -0.32, 0.32, jx, jz)
    item("waterjar", "Water Jar", "Water jar", "A big glazed jar and a plastic dipper: the classic Khmer shower, cool even in April.", jx, jz + 0.3, FLOOR + 0.5)
    cyl("ShowerPipe", 1.35, -IZ + 0.04, FLOOR + 1.0, FLOOR + 2.0, 0.012, M["steel"], "Interior", verts=8)
    cyl("ShowerHead", 1.35, -IZ + 0.1, FLOOR + 1.95, FLOOR + 2.0, 0.06, M["steel"], "Interior", verts=12)
    box("TowelRail", -0.74 + 0.0, -0.74 + 0.04, -2.9, -2.2, FLOOR + 1.3, FLOOR + 1.32, M["steel"], "Interior")
    box("Towel", -0.74 + 0.02, -0.74 + 0.06, -2.85, -2.25, FLOOR + 0.8, FLOOR + 1.33, M["blue"], "Interior")
    bulb(0.4, -2.7, 3, drop=0.15, watts=70)
    switch(3, "x", -1.14, 1, 1.0)


def hall():
    hx, hz = -0.74 + 0.2, -0.45
    place([box("ShoeRack", -0.35, 0.35, -0.15, 0.15, FLOOR, FLOOR + 0.42, M["wood"], "Interior", bevel=0.01)], hx, hz, math.pi / 2)
    for k in range(3):
        box("Sandal", hx - 0.08, hx + 0.08, hz - 0.28 + k * 0.2, hz - 0.18 + k * 0.2, FLOOR + 0.42, FLOOR + 0.45, M["red"] if k % 2 else M["blue"], "Interior")
    block(-0.36, 0.36, -0.16, 0.16, hx, hz, math.pi / 2)
    bulb(0.4, -0.35, 0, drop=0.15, watts=50)


def furniture():
    living()
    dining()
    kitchen()
    bedroom()
    bathroom()
    hall()


# ── Baking: daylight, then each room group's lamps on its own ────────────────────────────
def bake_setup():
    world = bpy.data.worlds.new("Sky")
    bpy.context.scene.world = world
    world.use_nodes = True
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 2.6
    sun.color = (1.0, 0.95, 0.86)
    sun.angle = math.radians(1.5)
    so = bpy.data.objects.new("Sun", sun)
    so.rotation_euler = Euler((math.radians(50), 0, math.radians(200)), "XYZ")
    bpy.context.collection.objects.link(so)
    lamps = []
    for group, x, z, y, watts, radius in LAMPS:
        lt = bpy.data.lights.new("Lamp", "POINT")
        lt.energy = watts
        lt.color = LAMP_COLOR
        lt.shadow_soft_size = radius
        lo = bpy.data.objects.new("Lamp", lt)
        lo.location = B(x, z, y)
        bpy.context.collection.objects.link(lo)
        lamps.append((group, lo))
    bpy.ops.mesh.primitive_plane_add(size=80, location=(0, 0, -0.001))
    g = bpy.context.object
    g.name = "BakeGround"
    g.data.materials.append(mat("BakeGround", "#9c9a7c", 0.95))
    return so, lamps


def set_lighting(sun, lamps, group):
    """group None: daylight only. group N: only that group's lamps and glowing bulbs."""
    bg = bpy.context.scene.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.55, 0.68, 0.9, 1)
    bg.inputs["Strength"].default_value = 0.9 if group is None else 0.0
    sun.hide_render = group is not None
    for g, lo in lamps:
        lo.hide_render = g != group
    for g in range(len(LIGHT_GROUPS)):
        on = g == group
        M[f"bulb{g}"].node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 6.0 if on else 0.0
        M[f"shade{g}"].node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 2.0 if on else 0.0


def bake_interior(interior, sun, lamps):
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
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, area_weight=0.0, scale_to_bounds=True)
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
    maps = {}
    for key in [None] + list(range(len(LIGHT_GROUPS))):
        set_lighting(sun, lamps, key)
        print(f"baking {'daylight' if key is None else LIGHT_GROUPS[key][0] + ' lamps'}: {LIGHTMAP_SIZE}² at {SAMPLES} samples (CPU)…", flush=True)
        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, uv_layer="Lightmap", margin=6)
        maps[key] = np.array(img.pixels[:], dtype=np.float32).reshape(LIGHTMAP_SIZE, LIGHTMAP_SIZE, 4)[::-1, :, :3]
    for m in me.materials:
        for n in list(m.node_tree.nodes):
            if n.name.startswith("bake_target") or n.type == "UVMAP":
                m.node_tree.nodes.remove(n)
    set_lighting(sun, lamps, None)
    for g in range(len(LIGHT_GROUPS)):  # glowing again for previews
        M[f"bulb{g}"].node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 6.0
        M[f"shade{g}"].node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 2.0
    return maps


def scale_of(values, pct=99.5):
    covered = values > 1e-5
    return float(np.percentile(values[covered], pct)) if covered.any() else 1.0


def smooth(channel_img):
    """Remove Monte Carlo speckle; the lightmap is smooth by nature."""
    return channel_img.filter(ImageFilter.MedianFilter(5)).filter(ImageFilter.GaussianBlur(1.8))


def save_maps(maps):
    """Day map: sRGB-encoded RGB / dayScale. Lamp map: one room group per channel (RGBA), each
    the luminance / lampScale, gamma-encoded (x^(1/2.2)); the client decodes and multiplies."""
    day = maps[None]
    day_scale = scale_of(day.mean(axis=2))
    img = Image.fromarray((np.clip(day / day_scale, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8))
    smooth(img).save(os.path.join(OUT, f"{NAME}-day.webp"), quality=90, method=6)
    lums = [maps[g].mean(axis=2) for g in range(len(LIGHT_GROUPS))]
    # The 98th percentile: the few pixels right next to a bulb clip, everything else keeps detail.
    lamp_scale = max(scale_of(l, 98) for l in lums)
    chans = [smooth(Image.fromarray((np.clip(l / lamp_scale, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8))) for l in lums]
    Image.merge("RGBA", chans).save(os.path.join(OUT, f"{NAME}-lamps.webp"), quality=90, method=6, exact=True)
    return day_scale, lamp_scale


def rect(x0, x1, z0, z1):
    return [[round(x0, 3), round(z0, 3)], [round(x1, 3), round(z0, 3)], [round(x1, 3), round(z1, 3)], [round(x0, 3), round(z1, 3)]]


def write_spec(path, day_scale, lamp_scale):
    walls = [rect(-W / 2, FD_X - FD_W / 2, D / 2 - T, D / 2), rect(FD_X + FD_W / 2, W / 2, D / 2 - T, D / 2),
             rect(-W / 2, W / 2, -D / 2, -D / 2 + T), rect(-W / 2, -W / 2 + T, -D / 2 + T, D / 2 - T), rect(W / 2 - T, W / 2, -D / 2 + T, D / 2 - T)]
    lintels = [{"ring": rect(FD_X - FD_W / 2, FD_X + FD_W / 2, D / 2 - T, D / 2), "base": FLOOR + DOOR_H}]
    for pid, axis, at, a0, a1 in PARTITIONS:
        gaps = [(c - w / 2, c + w / 2, h) for part, c, w, h, _ in OPENINGS if part == pid]
        for s0, s1 in segments(a0, a1, [(g0, g1) for g0, g1, _ in gaps]):
            walls.append(rect(s0, s1, at - P / 2, at + P / 2) if axis == "x" else rect(at - P / 2, at + P / 2, s0, s1))
        for g0, g1, h in gaps:
            lintels.append({"ring": rect(g0, g1, at - P / 2, at + P / 2), "base": round(FLOOR + h, 3)})
    mean = sum(LAMP_COLOR) / 3
    spec = {
        "version": 2,
        "name": NAME,
        "model": f"{NAME}.glb",
        "lightmaps": {"day": f"{NAME}-day.webp", "lamps": f"{NAME}-lamps.webp", "dayScale": round(day_scale, 4), "lampScale": round(lamp_scale, 4),
                      "lampColor": [round(c / mean, 4) for c in LAMP_COLOR]},
        "floor": FLOOR,
        "wallTop": WALL_TOP,
        # The ridge: walls block the camera up to here (it never ends up in the roof space).
        "roofTop": round(WALL_TOP - 0.02 + (D / 2 + ROOF_OVERHANG) * math.tan(ROOF_PITCH), 3),
        "footprint": rect(-W / 2, W / 2, -D / 2, D / 2),
        "interior": {"min": [-IX, -IZ], "max": [IX, IZ], "ceiling": CEIL},
        "rooms": [{"id": rid, "name": name, "rects": [[round(v, 3) for v in r] for r in rects], "light": g} for rid, name, rects, g in ROOMS],
        "lights": [{"id": lid, "label": label, "channel": g, "switches": SPEC["switches"][g], "materials": [f"Int_Bulb_{g}", f"Int_Shade_{g}"]}
                   for g, (lid, label) in enumerate(LIGHT_GROUPS)],
        "walls": walls,
        "lintels": lintels,
        "doors": SPEC["doors"],
        "steps": [{"ring": rect(*PORCH), "height": FLOOR}, {"ring": rect(*STEP), "height": FLOOR / 2}],
        "posts": [[round(x, 3), round(PORCH[3] - 0.12, 3), 0.12] for x in (PORCH[0] + 0.12, PORCH[1] - 0.12)]
                 + [[round(x, 3), round(D / 2 + 0.35, 3), 0.22] for x in (PORCH[0] + 0.35, PORCH[1] - 0.35)],
        "blockers": SPEC["blockers"],
        "seats": SPEC["seats"],
        "tables": SPEC["tables"],
        "items": SPEC["items"],
        "toggles": SPEC["toggles"],
        "fans": [{"node": f["node"], "rpm": f["rpm"]} for f in SPEC["fans"]],
    }
    with open(path, "w") as fh:
        json.dump(spec, fh, indent=1)


def preview(path_prefix):
    """Cycles stills from the street and inside (documentation and checks)."""
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = 960, 540
    scene.cycles.samples = 64
    scene.cycles.use_denoising = False  # this Blender build has no OpenImageDenoise
    scene.view_settings.view_transform = "AgX"
    shots = {"street": (B(9.0, 11.5, 2.4), B(-0.5, 0, 1.6), 40), "living": (B(-0.3, 3.9, 1.65), B(-4.2, 0.8, 0.9), 20),
             "dining": (B(-1.0, 3.9, 1.65), B(4.0, 0.6, 0.9), 20), "kitchen": (B(2.2, 0.0, 1.6), B(4.6, -3.8, 0.9), 18),
             "bedroom": (B(-1.3, -0.3, 1.65), B(-3.6, -3.6, 0.8), 18), "bathroom": (B(0.4, -1.4, 1.6), B(0.6, -4.0, 0.7), 14)}
    for name, (eye, at, lens) in shots.items():
        cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
        bpy.context.collection.objects.link(cam)
        cam.location = eye
        cam.rotation_euler = (at - eye).to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = lens
        scene.camera = cam
        scene.render.filepath = f"{path_prefix}-{name}.png"
        bpy.ops.render.render(write_still=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    tex = {k: os.path.join(TMP, f"{k}.png") for k in ("floor", "roof", "wood", "wood_dark", "door", "door_light", "rug", "painting", "terracotta", "planks", "mosaic", "tiles", "krama", "photo")}
    tex_floor(tex["floor"])
    tex_roof(tex["roof"])
    tex_wood(tex["wood"], "#9a6a3e", 1)
    tex_wood(tex["wood_dark"], "#5a3824", 2)
    tex_wood(tex["door"], "#6e3f22", 3)
    tex_wood(tex["door_light"], "#c49a6c", 4)
    tex_rug(tex["rug"])
    tex_painting(tex["painting"])
    tex_terracotta(tex["terracotta"])
    tex_planks(tex["planks"])
    tex_mosaic(tex["mosaic"])
    tex_wall_tiles(tex["tiles"])
    tex_krama(tex["krama"])
    tex_photo(tex["photo"])
    materials(tex)
    shell()
    furniture()
    # Real-world-size box UVs for every part that has no special mapping.
    for name, objs in GROUPS.items():
        if name == "Bake":
            continue
        for o in objs:
            if not o.get("uv_done"):
                box_uv(o, 1.0)
    nodes = {name: join(name, name) for name in list(GROUPS) if name != "Bake" and GROUPS[name]}
    paint_flat(nodes["Exterior"], "Ext_Painted", 0.88)
    paint_flat(nodes["Interior"], "Int_Painted", 0.9)
    for name in nodes:
        if name.startswith("Fan_"):
            paint_flat(nodes[name], f"{name}_Painted", 0.6)
    # Pivots: doors turn on their hinges, fans on their rods.
    pivots = {f"Door_{d['id']}": B(d["hinge"][0], d["hinge"][1], 0) for d in SPEC["doors"]}
    pivots.update({f["node"]: B(f["pivot"][0], f["pivot"][1], CEIL) for f in SPEC["fans"]})
    for name, pivot in pivots.items():
        o = nodes[name]
        bpy.context.scene.cursor.location = pivot
        for s in bpy.context.selected_objects:
            s.select_set(False)
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    sun, lamps = bake_setup()
    hidden = [o for n, o in nodes.items() if n in ("Glass", "TVScreen", "StoveFlame") or n.startswith("Fan_")]
    for o in hidden:
        o.hide_render = True  # daylight passes the windows; fans turn; TV and flames start off
    maps = bake_interior(nodes["Interior"], sun, lamps)
    day_scale, lamp_scale = save_maps(maps)
    for o in hidden:
        o.hide_render = False
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in nodes.values():
        o.select_set(True)
    target = os.path.join(OUT, f"{NAME}.glb")
    bpy.ops.export_scene.gltf(filepath=target + ".tmp.glb", export_format="GLB", export_yup=True, use_selection=True,
                              export_apply=True, export_texcoords=True, export_normals=True, export_lights=False,
                              export_vertex_color="ACTIVE", export_image_format="WEBP", export_image_quality=88)
    os.replace(target + ".tmp.glb", target)
    write_spec(os.path.join(OUT, f"{NAME}.json"), day_scale, lamp_scale)
    tris = 0
    for o in nodes.values():
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
    print("Wrote", target, "scales", round(day_scale, 3), round(lamp_scale, 3), "triangles", tris, "nodes", sorted(nodes))
    if os.environ.get("PPW_HOUSE_PREVIEW"):
        for _g, lo in lamps:
            lo.hide_render = False  # stills with the lights on
        preview(os.environ["PPW_HOUSE_PREVIEW"])


main()

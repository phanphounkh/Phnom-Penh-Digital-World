"""Street furniture and landmark models for Phnom Penh Digital World (original work, CC0).

Run:  blender --background --python-use-system-env --python tools/blender/generate_city_assets.py
Writes frontend/static/models/city/*.glb and frontend/static/models/landmarks/*.glb.
Then compress:  (cd frontend && npm run assets:compress)

Conventions relied on by the web client (frontend/src/lib/game/city/props.ts):
* Units are metres, Y up after export, origin at ground level in the centre of the footprint.
* Material names are semantic: Bark, Leaves, Metal, Lamp (glows at night), Signal, Stucco,
  Gold, Concrete, Louvre, Glass. The client may restyle them.
* Street furniture is instanced by the client: keep it low-poly (hundreds of copies).
"""

import math
import os
import random

import bpy

OUT = os.path.abspath(
    os.environ.get(
        "PPW_MODEL_OUTPUT", os.path.join(os.path.dirname(__file__), "../../frontend/static/models")
    )
)
ONLY = os.environ.get("PPW_ASSET_FILTER", "")
random.seed(855)

COLORS = {
    "Bark": ("#5a4636", 0.0, 0.95),
    "Leaves": ("#4c7a37", 0.0, 0.85),
    "LeavesLight": ("#6d9a45", 0.0, 0.85),
    "PalmLeaves": ("#5f8a3a", 0.0, 0.8),
    "Metal": ("#3d4448", 0.6, 0.45),
    "Lamp": ("#fff3d0", 0.0, 0.3),
    "Signal": ("#141618", 0.2, 0.5),
    "SignalRed": ("#d8352a", 0.0, 0.3),
    "SignalAmber": ("#e8a33d", 0.0, 0.3),
    "SignalGreen": ("#3fb36a", 0.0, 0.3),
    "Stucco": ("#ece6da", 0.0, 0.9),
    "Gold": ("#d9a441", 0.7, 0.35),
    "Concrete": ("#e6c97e", 0.0, 0.85),  # Phsar Thmei's ochre
    "ConcreteShade": ("#c9ab62", 0.0, 0.9),
    "Louvre": ("#5c5446", 0.0, 0.8),
    "Glass": ("#9fb7b5", 0.3, 0.2),
}
MATERIALS: dict[str, bpy.types.Material] = {}


def reset() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)


def mat(name: str) -> bpy.types.Material:
    if name in MATERIALS:
        return MATERIALS[name]
    color, metal, rough = COLORS[name]
    rgb = tuple((int(color[i : i + 2], 16) / 255) ** 2.2 for i in (1, 3, 5))
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*rgb, 1)
    p.inputs["Metallic"].default_value = metal
    p.inputs["Roughness"].default_value = rough
    m.diffuse_color = (*rgb, 1)
    MATERIALS[name] = m
    return m


def finish(o, material: str, smooth: bool = False):
    o.data.materials.clear()
    o.data.materials.append(mat(material))
    for poly in o.data.polygons:
        poly.use_smooth = smooth
    return o


def cylinder(name, r1, r2, depth, loc, material, verts=8, rot=(0, 0, 0), smooth=True):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=depth,
                                    location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    return finish(o, material, smooth)


def blob(name, radius, loc, scale, material, subdivisions=1, jitter=0.0):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=radius, location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    if jitter:
        for v in o.data.vertices:
            v.co.x += random.uniform(-jitter, jitter)
            v.co.y += random.uniform(-jitter, jitter)
            v.co.z += random.uniform(-jitter, jitter)
    return finish(o, material)


def box(name, size, loc, material, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = size
    return finish(o, material)


def export(path: str) -> None:
    if ONLY and not path.startswith(ONLY):
        reset()
        return
    bpy.ops.object.select_all(action="SELECT")
    target = os.path.join(OUT, path + ".glb")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=target + ".tmp.glb", export_format="GLB", export_yup=True,
                              export_apply=True)
    os.replace(target + ".tmp.glb", target)
    print("Wrote", target)
    reset()


# ── Trees ───────────────────────────────────────────────────────────────────────────────
def rain_tree() -> None:
    """Broad umbrella crown (rain tree / tamarind), the common shade tree of the riverside."""
    cylinder("Trunk", 0.32, 0.2, 3.6, (0, 0, 1.8), "Bark", verts=7)
    for i, (dx, dy) in enumerate(((1.0, 0.2), (-0.8, 0.6), (0.1, -1.0))):
        length = 2.2
        angle = math.atan2(dy, dx)
        cylinder(f"Branch{i}", 0.16, 0.08, length, (dx * 0.7, dy * 0.7, 4.0), "Bark", verts=6,
                 rot=(0, math.radians(55), angle))
    for i in range(7):
        a = i / 7 * math.tau
        r = 2.4 if i else 0
        blob(f"Crown{i}", 2.0, (math.cos(a) * r, math.sin(a) * r, 5.2 + random.uniform(-0.3, 0.5)),
             (1.25, 1.25, 0.7), "Leaves" if i % 3 else "LeavesLight", jitter=0.25)
    blob("CrownTop", 2.2, (0, 0, 6.1), (1.3, 1.3, 0.75), "LeavesLight", jitter=0.25)
    export("city/tree-rain")


def sugar_palm() -> None:
    """Sugar palm (Borassus flabellifer), Cambodia's national tree: tall trunk, round fan crown."""
    for k in range(6):
        cylinder(f"TrunkRing{k}", 0.27 - k * 0.012, 0.26 - k * 0.012, 1.9,
                 (0, 0, 0.95 + k * 1.9), "Bark", verts=8)
    blob("CrownCore", 0.7, (0, 0, 11.6), (1, 1, 1), "Bark")
    for i in range(14):
        a = i / 14 * math.tau
        tilt = math.radians(random.uniform(-20, 35))
        # A fan leaf: a thin, wide disc pushed out from the crown.
        bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=1.25, depth=0.06,
                                            location=(math.cos(a) * 1.5, math.sin(a) * 1.5,
                                                      11.6 + math.sin(tilt) * 1.2))
        leaf = bpy.context.object
        leaf.name = f"Fan{i}"
        leaf.rotation_euler = (math.pi / 2 - tilt, 0, a + math.pi / 2)
        finish(leaf, "PalmLeaves")
    export("city/tree-palm")


def slender_tree() -> None:
    """A smaller ornamental street tree with a two-tier crown."""
    cylinder("Trunk", 0.16, 0.1, 3.2, (0, 0, 1.6), "Bark", verts=6)
    blob("CrownLow", 1.4, (0, 0, 3.6), (1.1, 1.1, 0.75), "Leaves", jitter=0.18)
    blob("CrownHigh", 1.0, (0.2, 0.1, 4.6), (1, 1, 0.8), "LeavesLight", jitter=0.15)
    export("city/tree-slender")


# ── Street furniture ────────────────────────────────────────────────────────────────────
def lamp_post() -> None:
    """Double-arm boulevard lamp (8 m) like those along Phnom Penh's main avenues."""
    cylinder("Base", 0.22, 0.16, 1.0, (0, 0, 0.5), "Metal", verts=8)
    cylinder("Pole", 0.11, 0.07, 7.4, (0, 0, 4.7), "Metal", verts=8)
    for side in (-1, 1):
        cylinder(f"Arm{side}", 0.045, 0.04, 1.5, (side * 0.7, 0, 8.15), "Metal", verts=6,
                 rot=(0, side * math.radians(78), 0))
        box(f"Head{side}", (0.62, 0.3, 0.14), (side * 1.38, 0, 8.25), "Metal")
        box(f"Lamp{side}", (0.5, 0.22, 0.05), (side * 1.38, 0, 8.16), "Lamp")
    export("city/lamp")


def traffic_signal() -> None:
    cylinder("Pole", 0.09, 0.08, 4.2, (0, 0, 2.1), "Metal", verts=8)
    box("Housing", (0.34, 0.3, 1.0), (0, -0.2, 3.7), "Signal")
    for i, colour in enumerate(("SignalRed", "SignalAmber", "SignalGreen")):
        bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.1, depth=0.04,
                                            location=(0, -0.36, 4.02 - i * 0.31),
                                            rotation=(math.pi / 2, 0, 0))
        finish(bpy.context.object, colour)
        bpy.context.object.name = f"Light{i}"
    export("city/traffic-signal")


def sign_post() -> None:
    """Pole for street-name signs; the client adds the two blades with live text."""
    cylinder("Pole", 0.05, 0.05, 3.0, (0, 0, 1.5), "Metal", verts=8)
    cylinder("Cap", 0.07, 0.04, 0.08, (0, 0, 3.04), "Metal", verts=8)
    export("city/sign-post")


# ── Landmarks ───────────────────────────────────────────────────────────────────────────
def phsar_thmei_dome() -> None:
    """Central dome of Phsar Thmei (1937, Art Deco). Real scale: radius 23 m, 16 m tall; the
    client places it on top of the 10 m wings so the summit is at the published 26 m."""
    R = 23.0
    cylinder("Drum", R, R * 0.97, 3.2, (0, 0, 1.6), "Concrete", verts=48, smooth=False)
    # Art Deco louvre band around the drum.
    for i in range(32):
        a = i / 32 * math.tau
        box(f"Louvre{i}", (0.25, 2.2, 2.4),
            (math.cos(a) * (R * 0.985), math.sin(a) * (R * 0.985), 1.6), "Louvre",
            rot=(0, 0, a))
    # The low ribbed dome: stacked rings, then 16 ribs.
    rings = 9
    for k in range(rings):
        t0, t1 = k / rings, (k + 1) / rings
        r0 = R * 0.96 * math.cos(t0 * math.pi / 2)
        r1 = R * 0.96 * math.cos(t1 * math.pi / 2)
        z0 = 3.2 + 10.8 * math.sin(t0 * math.pi / 2)
        z1 = 3.2 + 10.8 * math.sin(t1 * math.pi / 2)
        cylinder(f"Shell{k}", r0, max(r1, 0.4), z1 - z0, (0, 0, (z0 + z1) / 2),
                 "Concrete" if k % 2 == 0 else "ConcreteShade", verts=48)
    for i in range(16):
        a = i / 16 * math.tau
        for k in range(rings - 1):
            t = (k + 0.5) / rings
            r = R * 0.965 * math.cos(t * math.pi / 2)
            z = 3.2 + 10.8 * math.sin(t * math.pi / 2)
            box(f"Rib{i}_{k}", (0.6, 0.5, 1.9), (math.cos(a) * r, math.sin(a) * r, z),
                "ConcreteShade", rot=(0, -math.radians(90 * t), a))  # follow the meridian
    cylinder("Lantern", 3.2, 2.8, 1.6, (0, 0, 14.6), "Glass", verts=16, smooth=False)
    cylinder("LanternRoof", 3.4, 0.4, 0.8, (0, 0, 15.8), "ConcreteShade", verts=16)
    export("landmarks/phsar-thmei-dome")


def stupa() -> None:
    """Khmer stupa (chedi) at real scale for Wat Phnom: base radius ~4.6 m, 18 m tall."""
    for k, (half, height) in enumerate(((5.2, 1.0), (4.4, 0.9), (3.7, 0.9))):
        z = sum(h for _, h in ((5.2, 1.0), (4.4, 0.9), (3.7, 0.9))[:k]) + height / 2
        box(f"Plinth{k}", (half * 2, half * 2, height), (0, 0, z), "Stucco")
    base = 2.8
    # Bell (anda): stacked rings bulging out then in.
    profile = [(2.7, 0.0), (3.1, 0.8), (3.2, 1.8), (2.9, 2.9), (2.2, 3.8), (1.2, 4.4)]
    for k in range(len(profile) - 1):
        (r0, z0), (r1, z1) = profile[k], profile[k + 1]
        cylinder(f"Bell{k}", r0, r1, z1 - z0, (0, 0, base + (z0 + z1) / 2), "Stucco", verts=24)
    box("Harmika", (2.0, 2.0, 1.0), (0, 0, base + 4.9), "Stucco")
    top = base + 5.4
    for k in range(7):
        r = 1.0 - k * 0.12
        cylinder(f"Spire{k}", r, r * 0.85, 0.9, (0, 0, top + 0.45 + k * 0.9), "Stucco", verts=16)
    cylinder("Finial", 0.25, 0.02, 2.4, (0, 0, top + 6.3 + 1.2), "Gold", verts=10)
    export("landmarks/stupa")


reset()
for build in (rain_tree, sugar_palm, slender_tree, lamp_post, traffic_signal, sign_post,
              phsar_thmei_dome, stupa):
    build()

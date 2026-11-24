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
    "Leaves": ("#5c8a3e", 0.0, 0.85),
    "LeavesLight": ("#6d9a45", 0.0, 0.85),
    "PalmLeaves": ("#5f8a3a", 0.0, 0.8),
    "PalmDead": ("#8b7650", 0.0, 0.9),
    "Shrub": ("#4f7d39", 0.0, 0.85),
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
    if ONLY and not any(path.startswith(prefix.strip()) for prefix in ONLY.split(",")):
        reset()
        return
    bpy.ops.object.select_all(action="SELECT")
    target = os.path.join(OUT, path + ".glb")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=target + ".tmp.glb", export_format="GLB", export_yup=True,
                              export_apply=True, export_vertex_color="ACTIVE")
    os.replace(target + ".tmp.glb", target)
    print("Wrote", target)
    reset()


# ── Trees ───────────────────────────────────────────────────────────────────────────────
# Crowns are built from many small leaf clumps (one mesh, one `Leaves` material per tree) with
#  * normals bent outward from the crown centre, so the canopy shades as one soft volume
#    instead of faceted balls (the usual trick for stylised-realistic foliage), and
#  * a vertex-colour ambient-occlusion term (darker underneath and inside, lighter on top)
#    plus a small per-clump tint, exported as COLOR_0 and multiplied by the material colour.


def _fib_dome(n, top_bias=0.65):
    """n unit directions spread over a sphere, denser toward the top (golden-angle spiral)."""
    out = []
    for i in range(n):
        y = 1 - (i + 0.5) / n * (1 + top_bias)  # 1 → -top_bias: skip most of the underside
        r = math.sqrt(max(0.0, 1 - y * y))
        a = i * 2.399963
        out.append((math.cos(a) * r, math.sin(a) * r, y))
    return out


def leaf_crown(name, clumps, center, radii, material="Leaves", seed=1, tint=0.08, flat=0.75):
    """Fixed leaf-spray cards with alpha-tested gaps; no solid crown cores.

    One merged mesh/material per crown, roughly 400 triangles for a rain tree,
    instead of thousands of folded polygon leaves. Not a surveyed species model.
    """
    from mathutils import Vector
    rng = random.Random(seed)
    vertices, faces, normals, colors = [], [], [], []
    c = Vector(center)
    for x, y, z, radius in clumps:
        for j in range(6):
            a = rng.uniform(0, math.tau)
            h = rng.uniform(-.85, .95)
            direction = Vector((math.cos(a)*math.sqrt(1-h*h), math.sin(a)*math.sqrt(1-h*h), h))
            p = Vector((x,y,z)) + Vector((direction.x,direction.y,direction.z*flat))*radius*.65
            normal = direction.normalized()
            axis = normal.cross(Vector((0,0,1))).normalized()
            up = normal.cross(axis).normalized()
            angle = rng.uniform(0, math.tau)
            right = axis*math.cos(angle)+up*math.sin(angle)
            vertical = -axis*math.sin(angle)+up*math.cos(angle)
            size = radius*rng.uniform(.7,1.05)
            first = len(vertices)
            for u,v in ((-1,-1),(1,-1),(1,1),(-1,1)):
                pos = p+right*(u*size)+vertical*(v*size)
                vertices.append(tuple(pos))
                outward = (pos-c).normalized()
                normals.append((normal*.25+outward*.75).normalized())
                height = max(0,min(1,(pos.z-c.z+radii[2])/(radii[2]*2)))
                shade = (.64+.34*height)*rng.uniform(1-tint,1+tint)
                colors.append((shade,shade,shade,1))
            faces.append(tuple(first+i for i in (0,1,2,3)))
    me = bpy.data.meshes.new(name)
    me.from_pydata(vertices, [], faces)
    me.update()
    uv = me.uv_layers.new(name="UVMap")
    coords = ((0,0),(1,0),(1,1),(0,1))
    for polygon in me.polygons:
        for k,loop in enumerate(polygon.loop_indices): uv.data[loop].uv = coords[k]
    me.normals_split_custom_set_from_vertices(normals)
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    for i,color in enumerate(colors): attr.data[i].color = color
    me.color_attributes.active_color = attr
    o = bpy.data.objects.new(name,me)
    bpy.context.collection.objects.link(o)
    finish(o,material,smooth=True)
    m = mat(material)
    if not m.node_tree.nodes.get("LeafSpray"):
        tex = m.node_tree.nodes.new("ShaderNodeTexImage")
        tex.name = "LeafSpray"
        tex.image = bpy.data.images.load(os.path.join(os.path.dirname(__file__),"../../frontend/static/textures/foliage-original.png"),check_existing=True)
        shader = m.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = (1,1,1,1)
        m.node_tree.links.new(tex.outputs["Color"],shader.inputs["Base Color"])
        cutoff = m.node_tree.nodes.new("ShaderNodeMath")
        cutoff.operation = 'GREATER_THAN'
        cutoff.inputs[1].default_value = .5
        m.node_tree.links.new(tex.outputs["Alpha"],cutoff.inputs[0])
        m.node_tree.links.new(cutoff.outputs[0],shader.inputs["Alpha"])
        m.use_backface_culling = False
    return o


def trunk(name, r_base, r_top, height, lean=(0.0, 0.0), verts=10, flare=1.6):
    """Tapered trunk with a root flare, leaning slightly."""
    cylinder(f"{name}Flare", r_base * flare, r_base, 0.55, (0, 0, 0.275), "Bark", verts=verts)
    o = cylinder(name, r_base, r_top, height, (lean[0] / 2, lean[1] / 2, height / 2 + 0.5), "Bark",
                 verts=verts, rot=(math.atan2(-lean[1], height), math.atan2(lean[0], height), 0))
    return o


def limb(name, start, end, r0, r1, verts=6):
    from mathutils import Vector

    a, b = Vector(start), Vector(end)
    d = b - a
    mid = (a + b) / 2
    rot = d.to_track_quat("Z", "Y").to_euler()
    return cylinder(name, r0, r1, d.length, tuple(mid), "Bark", verts=verts, rot=tuple(rot))


def rain_tree() -> None:
    """Rain tree / tamarind: the broad umbrella shade tree of Phnom Penh's boulevards."""
    trunk("Trunk", 0.34, 0.24, 3.0, lean=(0.25, 0.1))
    top = (0.25, 0.1, 3.45)
    ends = []
    for i in range(4):
        a = i / 4 * math.tau + 0.4
        end = (math.cos(a) * 2.3, math.sin(a) * 2.3, 5.3 + random.uniform(-0.3, 0.3))
        limb(f"Limb{i}", top, end, 0.17, 0.08)
        ends.append(end)
    center, radii = (0.2, 0.1, 6.0), (4.6, 4.6, 1.9)
    clumps = []
    for k, (x, y, z) in enumerate(_fib_dome(20)):
        r = random.uniform(1.15, 1.55)
        clumps.append((center[0] + x * (radii[0] - 1.0), center[1] + y * (radii[1] - 1.0), center[2] + z * (radii[2] - 0.4), r))
    for (x, y, z) in ends[:2]:  # fill the middle so the crown is not hollow from below
        clumps.append((x * 0.4, y * 0.4, 5.6, 1.7))
    leaf_crown("Crown", clumps, center, radii, seed=11)
    export("city/tree-rain")


def slender_tree() -> None:
    """A smaller ornamental street tree with an oval crown."""
    trunk("Trunk", 0.15, 0.1, 2.4, lean=(0.08, -0.05), verts=8, flare=1.4)
    for i in range(2):
        a = i * math.pi + 0.7
        limb(f"Limb{i}", (0.04, -0.02, 2.7), (math.cos(a) * 0.7, math.sin(a) * 0.7, 3.7), 0.08, 0.04)
    center, radii = (0.05, 0.0, 4.3), (1.8, 1.8, 1.7)
    clumps = [(center[0] + x * 1.1, center[1] + y * 1.1, center[2] + z * 1.15, random.uniform(0.75, 0.95))
              for (x, y, z) in _fib_dome(9, top_bias=0.9)]
    clumps.append((center[0], center[1], center[2], 1.15))
    leaf_crown("Crown", clumps, center, radii, seed=23, flat=0.85)
    export("city/tree-slender")


def fan_leaf(bm, base, direction, tilt, radius=1.25, ribs=9, rng=random):
    """A pleated palm fan: ribs alternating up and down, curving down at the tips."""
    from mathutils import Matrix, Vector

    rot = Matrix.Rotation(direction, 3, "Z") @ Matrix.Rotation(-tilt, 3, "Y")
    centre = bm.verts.new(base)
    rows = []
    for ring, rr in ((0, 0.55), (1, 1.0)):
        row = []
        for j in range(ribs):
            a = math.radians(-80 + 160 * j / (ribs - 1))
            pleat = 0.07 * (1 if j % 2 else -1) * rr
            droop = -0.25 * rr * rr
            p = Vector((math.cos(a) * radius * rr, math.sin(a) * radius * rr, pleat + droop))
            row.append(bm.verts.new(Vector(base) + rot @ p))
        rows.append(row)
    faces = []
    for j in range(ribs - 1):
        faces.append(bm.faces.new((centre, rows[0][j], rows[0][j + 1])))
        faces.append(bm.faces.new((rows[0][j], rows[1][j], rows[1][j + 1], rows[0][j + 1])))
    return faces


def sugar_palm() -> None:
    """Sugar palm (Borassus flabellifer), Cambodia's national tree: tall trunk, round fan crown."""
    import bmesh
    from mathutils import Vector

    for k in range(6):
        cylinder(f"TrunkRing{k}", 0.29 - k * 0.013, 0.27 - k * 0.013, 1.9, (0, 0, 0.95 + k * 1.9), "Bark", verts=9)
    cylinder("Flare", 0.42, 0.29, 0.5, (0, 0, 0.25), "Bark", verts=9)
    blob("CrownCore", 0.75, (0, 0, 11.6), (1, 1, 1.1), "Bark", jitter=0.08)
    rng = random.Random(41)
    for kind, count, tilt_range, material in (("live", 18, (-25, 40), "PalmLeaves"), ("dead", 6, (55, 80), "PalmDead")):
        bm = bmesh.new()
        for i in range(count):
            a = i / count * math.tau + rng.uniform(-0.15, 0.15)
            tilt = math.radians(rng.uniform(*tilt_range))
            stalk = 0.9 + rng.uniform(-0.1, 0.2)
            base = Vector((math.cos(a) * stalk * math.cos(tilt), math.sin(a) * stalk * math.cos(tilt),
                           11.6 + math.sin(tilt) * stalk * (1 if kind == "live" else -1)))
            fan_leaf(bm, base, a, tilt if kind == "live" else -tilt, radius=1.2 + rng.uniform(-0.1, 0.15), rng=rng)
        me = bpy.data.meshes.new(f"Fans_{kind}")
        bm.to_mesh(me)
        bm.free()
        o = bpy.data.objects.new(f"Fans_{kind}", me)
        bpy.context.collection.objects.link(o)
        finish(o, material, smooth=True)
        for i in range(count):  # leaf stalks
            a = i / count * math.tau
            limb(f"Stalk_{kind}{i}", (0, 0, 11.6), (math.cos(a) * 0.95, math.sin(a) * 0.95, 11.6 + (0.3 if kind == "live" else -0.5)), 0.035, 0.025, verts=4)
    export("city/tree-palm")


def bush() -> None:
    """A low shrub (parks, planters, temple grounds): a few leaf clumps, no trunk."""
    clumps = [(0, 0, 0.55, 0.62), (0.45, 0.1, 0.42, 0.45), (-0.4, 0.2, 0.4, 0.48), (0.05, -0.42, 0.4, 0.44), (0.1, 0.35, 0.7, 0.4)]
    leaf_crown("Shrub", clumps, (0, 0, 0.5), (0.9, 0.9, 0.55), material="Shrub", seed=5, flat=0.8)
    export("city/bush")


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
for build in (rain_tree, sugar_palm, slender_tree, bush, lamp_post, traffic_signal, sign_post,
              phsar_thmei_dome, stupa):
    build()

"""Vehicle models for Phnom Penh Digital World (original work, CC0): a city bicycle with a
front basket and a generic step-through motorbike (the everyday "moto" of Phnom Penh; no
real make or model is copied).

Run:  blender --background --python-use-system-env --python tools/blender/generate_vehicle_assets.py
Writes frontend/static/models/vehicles/{bicycle,motorbike}.glb.
Then compress:  (cd frontend && npm run assets:compress)

Conventions relied on by the web client (frontend/src/lib/game/vehicles/VehicleModels.ts):
* Metres, Y up after export, origin on the ground midway between the wheel contact points;
  the vehicle faces +Z after export (Blender -Y), like the avatar.
* Nodes: `Body` (static, one multi-material mesh), `Steer` (an empty at the steering head;
  rotating it about Y steers the fork, bars and front wheel), `WheelFront` (under Steer) and
  `WheelRear` (origins at the hubs; spin about X).
* Anchor empties for posing the rider: `Seat` (hips), `GripL`/`GripR` (hands), `PegL`/`PegR`
  (feet; on the bicycle `Crank` is the bottom bracket the pedals turn about). `L` is -X, the
  side of the avatar rig's LeftArm/LeftLeg.
* Materials: `Paint` takes the vehicle's colour and `PaintDark` a darker shade of it;
  `Light` glows at night; `TailLight`, `Rubber`, `Metal`, `Chrome`, `Seat`, `Plastic`,
  `Rattan`, and `Plate` (the client prints the virtual plate on it).
"""

import math
import os

import bpy
from mathutils import Vector

OUT = os.path.abspath(
    os.environ.get(
        "PPW_MODEL_OUTPUT", os.path.join(os.path.dirname(__file__), "../../frontend/static/models")
    )
)

COLORS = {
    "Paint": ("#c4552f", 0.25, 0.35),
    "PaintDark": ("#6b2a16", 0.2, 0.45),
    "Metal": ("#4a5055", 0.7, 0.4),
    "Chrome": ("#c9cfd3", 0.95, 0.18),
    "Rubber": ("#1b1d1f", 0.0, 0.85),
    "Seat": ("#24201d", 0.0, 0.6),
    "Plastic": ("#2c3034", 0.1, 0.55),
    "Light": ("#fff6dc", 0.0, 0.2),
    "TailLight": ("#c8261d", 0.1, 0.3),
    "Rattan": ("#b8874f", 0.0, 0.9),
    "Plate": ("#f2efe6", 0.0, 0.6),
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
    if name in ("Light", "TailLight"):
        p.inputs["Emission Color"].default_value = (*rgb, 1)
        p.inputs["Emission Strength"].default_value = 0.6
    m.diffuse_color = (*rgb, 1)
    MATERIALS[name] = m
    return m


def finish(o, material: str, smooth: bool = False):
    o.data.materials.clear()
    o.data.materials.append(mat(material))
    for poly in o.data.polygons:
        poly.use_smooth = smooth
    return o


def box(name, size, loc, material, rot=(0, 0, 0), bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = size
    if bevel:
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        mod = o.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 3
        bpy.ops.object.modifier_apply(modifier=mod.name)
        return finish(o, material, True)
    return finish(o, material)


def cylinder(name, r, depth, loc, material, axis="Z", verts=16, r2=None):
    rot = {"X": (0, math.radians(90), 0), "Y": (math.radians(90), 0, 0), "Z": (0, 0, 0)}[axis]
    bpy.ops.mesh.primitive_cone_add(
        vertices=verts, radius1=r, radius2=r if r2 is None else r2, depth=depth,
        location=loc, rotation=rot,
    )
    o = bpy.context.object
    o.name = name
    return finish(o, material, True)


def tube(name, a, b, r, material, verts=10):
    a, b = Vector(a), Vector(b)
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=d.length, location=(a + b) / 2)
    o = bpy.context.object
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = d.to_track_quat("Z", "Y")
    o.name = name
    return finish(o, material, True)


def torus_x(name, centre, major, minor, material, segments=32):
    """A ring in the YZ plane (axis X): tyres and rims."""
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major, minor_radius=minor, major_segments=segments, minor_segments=8,
        location=centre, rotation=(0, math.radians(90), 0),
    )
    o = bpy.context.object
    o.name = name
    return finish(o, material, True)


def empty(name, loc):
    bpy.ops.object.empty_add(type="PLAIN_AXES", radius=0.05, location=loc)
    o = bpy.context.object
    o.name = name
    return o


def join(objects, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = name
    return o


def parent(child, to):
    child.parent = to
    child.matrix_parent_inverse = to.matrix_world.inverted()


def wheel(name, hub, radius, tyre, spokes, cast=False):
    """Tyre, rim, hub and spokes, joined, origin at the hub (the hub cylinder comes first)."""
    hx, hy, hz = hub
    parts = [cylinder(name + "Hub", 0.04 if cast else 0.025, 0.11 if cast else 0.1, hub, "Metal", axis="X")]
    parts.append(torus_x(name + "Tyre", hub, radius - tyre, tyre, "Rubber"))
    rim_r = radius - tyre * 2
    parts.append(torus_x(name + "Rim", hub, rim_r, 0.012 if not cast else 0.02, "Chrome" if not cast else "Metal"))
    for k in range(spokes):
        a = k / spokes * math.tau
        end = (hx, hy + math.sin(a) * rim_r, hz + math.cos(a) * rim_r)
        if cast:
            parts.append(tube(name + f"Spoke{k}", hub, end, 0.018, "Metal", verts=6))
        else:
            side = 0.03 if k % 2 else -0.03
            parts.append(tube(name + f"Spoke{k}", (hx + side, hy, hz), end, 0.003, "Chrome", verts=4))
    return join(parts, name)


def export(path: str) -> None:
    bpy.ops.object.select_all(action="SELECT")
    target = os.path.join(OUT, path + ".glb")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=target + ".tmp.glb", export_format="GLB", export_yup=True, export_apply=True
    )
    os.replace(target + ".tmp.glb", target)
    print("Wrote", target)
    reset()


# ── bicycle ────────────────────────────────────────────────────────────────────────────


def bicycle() -> None:
    """A step-through city bicycle (26" wheels, 1.05 m wheelbase) with a front basket and a
    rear rack. Blender: front towards -Y."""
    r = 0.33
    front, rear = (0, -0.53, r), (0, 0.52, r)
    bb = (0, 0.06, 0.29)
    cluster = (0, 0.22, 0.72)
    head_top, head_low = (0, -0.43, 0.86), (0, -0.40, 0.70)
    body = []
    # Frame: curved step-through down tube, seat tube, stays.
    body.append(tube("HeadTube", head_low, head_top, 0.022, "Paint"))
    body.append(tube("Down1", (0, -0.41, 0.74), (0, -0.26, 0.42), 0.024, "Paint"))
    body.append(tube("Down2", (0, -0.26, 0.42), bb, 0.024, "Paint"))
    body.append(tube("SeatTube", bb, cluster, 0.02, "Paint"))
    for x in (-0.055, 0.055):
        body.append(tube("Chainstay", bb, (x, rear[1], rear[2]), 0.011, "Paint"))
        body.append(tube("Seatstay", (x * 0.4, cluster[1], cluster[2] - 0.02), (x, rear[1], rear[2]), 0.01, "Paint"))
    body.append(tube("SeatPost", cluster, (0, 0.25, 0.86), 0.013, "Chrome"))
    body.append(box("Saddle", (0.16, 0.26, 0.06), (0, 0.27, 0.89), "Seat", bevel=0.02))
    # Drivetrain.
    body.append(cylinder("Chainring", 0.095, 0.008, (0.07, bb[1], bb[2]), "Chrome", axis="X", verts=24))
    body.append(cylinder("Cog", 0.04, 0.008, (0.07, rear[1], rear[2]), "Chrome", axis="X"))
    for z in (0.095, -0.095):
        body.append(tube("Chain", (0.07, bb[1], bb[2] + z), (0.07, rear[1], rear[2] + z * 0.42), 0.005, "Metal", verts=4))
    body.append(box("ChainGuard", (0.012, 0.5, 0.08), (0.085, 0.3, 0.33), "PaintDark"))
    # Cranks and pedals: static (the client moves the rider's feet round the crank circle).
    for side, x in ((-1, -0.09), (1, 0.09)):
        tip = (x, bb[1] + 0.0 * side, bb[2] - 0.165 * side)
        body.append(tube("Crank", (x * 0.8, bb[1], bb[2]), tip, 0.009, "Metal", verts=6))
        body.append(box("Pedal", (0.09, 0.06, 0.02), (x * 1.5, tip[1], tip[2]), "Plastic"))
    # Rear rack and mudguards.
    body.append(box("Rack", (0.14, 0.34, 0.012), (0, 0.52, 0.71), "Metal"))
    for x in (-0.07, 0.07):
        body.append(tube("RackStay", (x, 0.66, 0.71), (x, rear[1] + 0.02, rear[2]), 0.006, "Metal", verts=6))
    body.append(box("Reflector", (0.06, 0.012, 0.03), (0, 0.70, 0.68), "TailLight"))
    body.append(box("Plate", (0.11, 0.004, 0.06), (0, 0.69, 0.62), "Plate"))
    body_obj = join(body, "Body")

    steer = empty("Steer", head_top)
    front_parts = []
    for x in (-0.05, 0.05):
        front_parts.append(tube("Fork", (x * 0.4, head_low[1], head_low[2]), (x, front[1], front[2]), 0.012, "Chrome"))
    front_parts.append(tube("Stem", head_top, (0, -0.42, 0.99), 0.014, "Chrome"))
    front_parts.append(tube("Bar", (-0.29, -0.33, 1.0), (0.29, -0.33, 1.0), 0.011, "Chrome"))
    for x in (-0.29, 0.29):
        front_parts.append(tube("BarSweep", (x * 0.5, -0.42, 0.99), (x, -0.33, 1.0), 0.011, "Chrome"))
        front_parts.append(cylinder("Grip", 0.017, 0.1, (x * 1.05, -0.33, 1.0), "Rubber", axis="X"))
    # The basket: rattan-coloured wire basket on the bars.
    front_parts.append(box("BasketBottom", (0.34, 0.26, 0.01), (0, -0.66, 0.78), "Rattan"))
    front_parts.append(box("BasketFront", (0.34, 0.01, 0.2), (0, -0.79, 0.88), "Rattan"))
    front_parts.append(box("BasketBack", (0.34, 0.01, 0.2), (0, -0.53, 0.88), "Rattan"))
    for x in (-0.17, 0.17):
        front_parts.append(box("BasketSide", (0.01, 0.26, 0.2), (x, -0.66, 0.88), "Rattan"))
    front_parts.append(cylinder("Lamp", 0.035, 0.05, (0, -0.81, 0.86), "Light", axis="Y"))
    steer_mesh = join(front_parts, "SteerParts")
    parent(steer_mesh, steer)
    wf = wheel("WheelFront", front, r, 0.022, 24)
    parent(wf, steer)
    wheel("WheelRear", rear, r, 0.022, 24)

    empty("Seat", (0, 0.24, 0.92))
    empty("GripL", (-0.27, -0.33, 1.0))
    empty("GripR", (0.27, -0.33, 1.0))
    empty("Crank", bb)
    empty("PegL", (-0.13, bb[1], bb[2]))
    empty("PegR", (0.13, bb[1], bb[2]))
    assert body_obj.name == "Body"
    export("vehicles/bicycle")


# ── motorbike ──────────────────────────────────────────────────────────────────────────


def motorbike() -> None:
    """A step-through underbone motorbike (17" wheels, 1.24 m wheelbase), the common
    city motorbike in Cambodia, drawn generically. Blender: front towards -Y."""
    r = 0.29
    front, rear = (0, -0.62, r), (0, 0.62, r)
    head = (0, -0.47, 0.82)
    body = []
    # Underbone frame and leg shield.
    body.append(tube("Spine1", head, (0, -0.24, 0.44), 0.035, "PaintDark"))
    body.append(tube("Spine2", (0, -0.24, 0.44), (0, 0.12, 0.46), 0.035, "PaintDark"))
    body.append(box("LegShield", (0.42, 0.06, 0.46), (0, -0.37, 0.62), "Paint", rot=(math.radians(-14), 0, 0), bevel=0.03))
    body.append(box("Tunnel", (0.16, 0.36, 0.1), (0, -0.12, 0.47), "Paint", bevel=0.03))
    # Engine, exhaust, swingarm, shocks.
    body.append(box("Engine", (0.22, 0.3, 0.24), (0, 0.06, 0.29), "Metal", bevel=0.03))
    body.append(cylinder("Cylinder", 0.07, 0.2, (0, -0.12, 0.3), "Metal", axis="Y", verts=12))
    body.append(tube("Header", (0.04, -0.2, 0.24), (0.16, 0.2, 0.22), 0.022, "Chrome"))
    body.append(cylinder("Muffler", 0.055, 0.42, (0.17, 0.48, 0.3), "Chrome", axis="Y", verts=14, r2=0.045))
    body.append(box("HeatShield", (0.02, 0.32, 0.08), (0.23, 0.46, 0.31), "Plastic"))
    for x in (-0.1, 0.1):
        body.append(tube("Swingarm", (x, 0.14, 0.3), (x, rear[1], rear[2]), 0.022, "Metal"))
        body.append(tube("Shock", (x * 1.2, 0.56, 0.34), (x * 1.2, 0.46, 0.66), 0.02, "Chrome"))
    # Seat, rear body, tail, plate.
    body.append(box("RearBody", (0.3, 0.62, 0.22), (0, 0.4, 0.62), "Paint", bevel=0.05))
    body.append(box("SeatPad", (0.27, 0.66, 0.09), (0, 0.33, 0.78), "Seat", bevel=0.035))
    body.append(box("Tail", (0.2, 0.08, 0.08), (0, 0.73, 0.68), "TailLight", bevel=0.02))
    body.append(tube("GrabRail", (-0.12, 0.6, 0.75), (0.12, 0.6, 0.75), 0.012, "Metal"))
    body.append(box("RearFender", (0.14, 0.34, 0.03), (0, 0.72, 0.56), "PaintDark", rot=(math.radians(-30), 0, 0)))
    body.append(box("Plate", (0.17, 0.006, 0.1), (0, 0.84, 0.5), "Plate"))
    for x in (-0.17, 0.17):  # rider foot pegs
        body.append(tube("Peg", (x * 0.5, 0.04, 0.3), (x, 0.04, 0.3), 0.012, "Rubber"))
    body_obj = join(body, "Body")

    steer = empty("Steer", head)
    parts = []
    for x in (-0.075, 0.075):
        parts.append(tube("ForkLeg", (x, head[1] - 0.02, head[2] - 0.05), (x, front[1], front[2]), 0.022, "Chrome"))
    parts.append(box("Fender", (0.13, 0.4, 0.03), (0, -0.62, 0.62), "Paint", bevel=0.01))
    parts.append(box("Cowl", (0.36, 0.2, 0.14), (0, -0.5, 1.0), "Paint", bevel=0.04))
    parts.append(cylinder("Headlight", 0.065, 0.04, (0, -0.61, 0.99), "Light", axis="Y", verts=20))
    parts.append(box("Indicator", (0.36, 0.03, 0.03), (0, -0.6, 0.93), "Plastic"))
    parts.append(tube("Bar", (-0.35, -0.44, 1.03), (0.35, -0.44, 1.03), 0.012, "Chrome"))
    for x in (-0.35, 0.35):
        parts.append(cylinder("Grip", 0.019, 0.12, (x * 0.98, -0.44, 1.03), "Rubber", axis="X"))
        parts.append(tube("MirrorStem", (x * 0.6, -0.47, 1.06), (x * 0.78, -0.45, 1.27), 0.007, "Chrome", verts=6))
        parts.append(cylinder("Mirror", 0.05, 0.015, (x * 0.8, -0.45, 1.3), "Chrome", axis="Y", verts=16))
    parts.append(box("Dash", (0.18, 0.08, 0.04), (0, -0.44, 1.08), "Plastic"))
    steer_mesh = join(parts, "SteerParts")
    parent(steer_mesh, steer)
    wf = wheel("WheelFront", front, r, 0.042, 5, cast=True)
    parent(wf, steer)
    wheel("WheelRear", rear, r, 0.045, 5, cast=True)

    empty("Seat", (0, 0.22, 0.86))
    empty("GripL", (-0.33, -0.44, 1.03))
    empty("GripR", (0.33, -0.44, 1.03))
    empty("PegL", (-0.17, 0.04, 0.32))
    empty("PegR", (0.17, 0.04, 0.32))
    assert body_obj.name == "Body"
    export("vehicles/motorbike")


if __name__ == "__main__":
    reset()
    for build in (bicycle, motorbike):
        build()

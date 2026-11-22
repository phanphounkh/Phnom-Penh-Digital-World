"""Render low-resolution turnaround previews of a character .blend (CPU or integrated GPU).

  blender --background output/male_avatar.blend --python scripts/render_previews.py -- \
      --out previews/male --size 360 [--engine EEVEE|CYCLES|WORKBENCH] [--views front,34,side,back,face]

The script tries Eevee first (works on Mesa/Intel integrated graphics) and falls back to
Cycles on the CPU with few samples if Eevee cannot start. Nothing here needs CUDA or OptiX.
"""

import argparse
import math
import os
import sys
import time

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True, help="output prefix, e.g. previews/male")
ap.add_argument("--size", type=int, default=360, help="image height in pixels")
ap.add_argument("--engine", default="EEVEE")
ap.add_argument("--views", default="front,34,side,back,face")
ap.add_argument("--samples", type=int, default=16)
args = ap.parse_args(argv)

scene = bpy.context.scene

# The character: every visible mesh; frame it from its bounding box.
meshes = [o for o in scene.objects if o.type == "MESH" and o.visible_get() and not o.name.startswith("_preview")]
lo = Vector((1e9, 1e9, 1e9))
hi = Vector((-1e9, -1e9, -1e9))
depsgraph = bpy.context.evaluated_depsgraph_get()
for o in meshes:
    for corner in o.bound_box:
        w = o.matrix_world @ Vector(corner)
        lo = Vector(map(min, lo, w))
        hi = Vector(map(max, hi, w))
height = hi.z - max(lo.z, 0.0)
center_x = (lo.x + hi.x) / 2


def ensure(name, factory):
    obj = bpy.data.objects.get(name)
    if obj is None:
        obj = factory()
        obj.name = name
    return obj


def add_light(name, kind, energy, loc, size=1.0, color=(1, 1, 1)):
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    data.color = color
    if kind == "AREA":
        data.size = size
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = loc
    direction = Vector((center_x, 0, height * 0.6)) - Vector(loc)
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj


# Studio: dark grey backdrop like the reference sheets, key/fill/rim area lights.
world = bpy.data.worlds.get("_preview_world") or bpy.data.worlds.new("_preview_world")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
bg.inputs["Color"].default_value = (0.045, 0.047, 0.055, 1)
bg.inputs["Strength"].default_value = 1.0
if not bpy.data.objects.get("_preview_floor"):
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
    floor = bpy.context.object
    floor.name = "_preview_floor"
    m = bpy.data.materials.new("_preview_floor")
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (0.035, 0.036, 0.042, 1)
    p.inputs["Roughness"].default_value = 0.6
    floor.data.materials.append(m)
    add_light("_preview_key", "AREA", 260, (2.2, -2.6, 2.8), size=2.0, color=(1.0, 0.96, 0.9))
    add_light("_preview_fill", "AREA", 90, (-2.8, -2.0, 1.6), size=3.0, color=(0.88, 0.92, 1.0))
    add_light("_preview_rim", "AREA", 220, (0.5, 3.0, 2.6), size=2.0)

cam_data = bpy.data.cameras.get("_preview_cam") or bpy.data.cameras.new("_preview_cam")
cam = ensure("_preview_cam", lambda: bpy.data.objects.new("_preview_cam", cam_data))
if cam.name not in scene.collection.objects:
    scene.collection.objects.link(cam)
scene.camera = cam

engines = [args.engine.upper()]
if engines[0] != "CYCLES":
    engines.append("CYCLES")


def set_engine(name):
    if name == "EEVEE":
        scene.render.engine = "BLENDER_EEVEE_NEXT"
        scene.eevee.taa_render_samples = args.samples
        scene.eevee.use_shadows = True
    elif name == "CYCLES":
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = max(8, args.samples)
        scene.cycles.use_denoising = True
    else:
        scene.render.engine = "BLENDER_WORKBENCH"


scene.render.resolution_y = args.size
scene.render.resolution_x = int(args.size * 2 / 3)
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.render.image_settings.file_format = "PNG"
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"

VIEWS = {
    # name: (azimuth degrees from front, framing)
    "front": (0, "body"),
    "34": (35, "body"),
    "side": (90, "body"),
    "back": (180, "body"),
    "face": (15, "face"),
    # Close-ups on bones (when the file has the Mixamo rig): (azimuth, framing, bone, distance)
    "lhand": (20, "bone", "mixamorig:LeftHand", 0.55),
    "neckback": (165, "bone", "mixamorig:Neck", 0.7),
    "chest": (0, "bone", "mixamorig:Spine2", 0.9),
    "feet": (25, "bone", "mixamorig:LeftFoot", 0.8),
    "headtop": (20, "bone", "mixamorig:Head", 0.9),
    "watch": (60, "bone", "mixamorig:LeftHand", 0.45),
}
rig = next((o for o in scene.objects if o.type == "ARMATURE"), None)

os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
for view in args.views.split(","):
    azimuth, framing, *extra = VIEWS[view]
    a = math.radians(azimuth)
    if framing == "bone":
        if rig is None or extra[0] not in rig.data.bones:
            continue
        cam_data.lens = 85
        target = rig.matrix_world @ rig.data.bones[extra[0]].head_local
        dist = extra[1]
        scene.render.resolution_x = args.size
    elif framing == "body":
        cam_data.lens = 70
        target = Vector((center_x, 0, height * 0.52))
        dist = height * 2.35
        scene.render.resolution_x = int(args.size * 2 / 3)
    else:
        cam_data.lens = 85
        target = Vector((center_x, 0, height * 0.925))
        dist = 0.95
        scene.render.resolution_x = args.size
    # Blender: the character faces -Y.
    cam.location = target + Vector((math.sin(a) * dist, -math.cos(a) * dist, 0.03 * dist))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    path = os.path.abspath(f"{args.out}_{view}.png")
    scene.render.filepath = path
    for engine in engines:
        try:
            set_engine(engine)
            t = time.time()
            bpy.ops.render.render(write_still=True)
            print(f"PREVIEW {path} engine={engine} {time.time() - t:.1f}s")
            engines = [engine]  # keep the engine that worked
            break
        except RuntimeError as e:
            print(f"PREVIEW engine {engine} failed: {e}")

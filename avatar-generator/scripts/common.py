"""Shared helpers for the avatar generator (run inside Blender 4.3+, `--python-use-system-env`).

Paths, MPFB bootstrap, fast NumPy access to mesh data, selection/deletion helpers and the
tiny geometry utilities the garment and accessory builders share.
"""

from __future__ import annotations

import importlib
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUTPUT = os.path.join(ROOT, "output")
PREVIEWS = os.path.join(ROOT, "previews")
TEXTURES = os.path.join(ROOT, "assets", "textures")  # generated textures (ours, CC0)
MPFB_MODULE = "bl_ext.user_default.mpfb"


# ── MPFB ─────────────────────────────────────────────────────────────────────────────────


def mpfb():
    """Enable MPFB (installed by scripts/fetch_assets.py) and return its services."""
    import addon_utils

    if MPFB_MODULE not in bpy.context.preferences.addons:
        # default_set: MPFB reads its own preferences while registering. The profile is the
        # project's private one (assets/blender-user), never the user's Blender settings.
        addon_utils.enable(MPFB_MODULE, default_set=True)
    if MPFB_MODULE not in bpy.context.preferences.addons:
        raise RuntimeError(
            "MPFB is not installed in this Blender profile. Run scripts/fetch_assets.py and "
            "start Blender with BLENDER_USER_RESOURCES=assets/blender-user (see README)."
        )
    services = importlib.import_module(MPFB_MODULE + ".services")
    from bl_ext.user_default.mpfb.services.humanservice import HumanService
    from bl_ext.user_default.mpfb.services.locationservice import LocationService
    from bl_ext.user_default.mpfb.services.targetservice import TargetService
    from bl_ext.user_default.mpfb.services.rigservice import RigService

    return {
        "HumanService": HumanService,
        "LocationService": LocationService,
        "TargetService": TargetService,
        "RigService": RigService,
        "services": services,
    }


def asset_path(*parts: str) -> str:
    """Absolute path inside the MakeHuman CC0 system-asset pack (MPFB user data)."""
    return os.path.join(mpfb()["LocationService"].get_user_data(), *parts)


def target_path(*parts: str) -> str:
    return os.path.join(mpfb()["LocationService"].get_mpfb_data("targets"), *parts)


# ── Scene ────────────────────────────────────────────────────────────────────────────────


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures, bpy.data.curves):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)


def link(obj, collection=None):
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def activate(obj):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)


def apply_modifier(obj, name):
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=name)


# ── Mesh data (NumPy) ───────────────────────────────────────────────────────────────────


def coords(obj) -> np.ndarray:
    me = obj.data
    a = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get("co", a)
    return a.reshape(-1, 3)


def set_coords(obj, co: np.ndarray):
    obj.data.vertices.foreach_set("co", np.ascontiguousarray(co, dtype=np.float64).ravel())
    if obj.data.shape_keys:
        obj.data.shape_keys.key_blocks[0].data.foreach_set("co", np.ascontiguousarray(co, dtype=np.float64).ravel())
    obj.data.update()


def normals(obj) -> np.ndarray:
    me = obj.data
    a = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get("normal", a)
    return a.reshape(-1, 3)


def group_weights(obj, name: str) -> np.ndarray:
    """Weight of every vertex in vertex group `name` (0 when absent)."""
    w = np.zeros(len(obj.data.vertices))
    vg = obj.vertex_groups.get(name)
    if vg is None:
        return w
    gi = vg.index
    for v in obj.data.vertices:
        for g in v.groups:
            if g.group == gi:
                w[v.index] = g.weight
                break
    return w


def bone_weights(obj, armature) -> dict[str, np.ndarray]:
    """Per-bone weight arrays for every deform bone that has a vertex group on `obj`."""
    names = {b.name for b in armature.data.bones if b.use_deform}
    index_to_name = {vg.index: vg.name for vg in obj.vertex_groups if vg.name in names}
    out = {n: np.zeros(len(obj.data.vertices)) for n in index_to_name.values()}
    for v in obj.data.vertices:
        for g in v.groups:
            n = index_to_name.get(g.group)
            if n:
                out[n][v.index] = g.weight
    return out


def keep_vertices(obj, keep: np.ndarray):
    """Delete every vertex where `keep` is False (shape keys and groups survive)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    doomed = [bm.verts[i] for i in np.nonzero(~keep)[0]]
    bmesh.ops.delete(bm, geom=doomed, context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def keep_faces(obj, keep_face: np.ndarray):
    """Delete faces where `keep_face` is False, then any vertex left without a face."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    doomed = [bm.faces[i] for i in np.nonzero(~keep_face)[0]]
    bmesh.ops.delete(bm, geom=doomed, context="FACES_ONLY")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def face_vertex_all(obj, mask: np.ndarray) -> np.ndarray:
    """Faces whose vertices are all in `mask`."""
    return np.array([all(mask[i] for i in p.vertices) for p in obj.data.polygons], dtype=bool)


def face_vertex_any(obj, mask: np.ndarray) -> np.ndarray:
    return np.array([any(mask[i] for i in p.vertices) for p in obj.data.polygons], dtype=bool)


def face_centers(obj) -> np.ndarray:
    a = np.empty(len(obj.data.polygons) * 3)
    obj.data.polygons.foreach_get("center", a)
    return a.reshape(-1, 3)


def duplicate(obj, name, *, keep_shape_keys=False, keep_modifiers=False):
    new = obj.copy()
    new.data = obj.data.copy()
    new.name = new.data.name = name
    link(new)
    if not keep_modifiers:
        new.modifiers.clear()
    if not keep_shape_keys and new.data.shape_keys:
        activate(new)
        bpy.ops.object.shape_key_remove(all=True, apply_mix=False)
    new.parent = None
    new.matrix_world = obj.matrix_world.copy()
    return new


def bvh(obj, depsgraph=None, evaluated=False) -> BVHTree:
    if evaluated:
        depsgraph = depsgraph or bpy.context.evaluated_depsgraph_get()
        return BVHTree.FromObject(obj, depsgraph)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.transform(obj.matrix_world)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    return tree


def smooth_laplacian(obj, iterations=10, factor=0.5, pin: np.ndarray | None = None):
    """Uniform Laplacian smoothing (keeps boundary vertices where pinned)."""
    me = obj.data
    n = len(me.vertices)
    edges = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", edges)
    edges = edges.reshape(-1, 2)
    deg = np.bincount(edges.ravel(), minlength=n).astype(np.float64)
    co = coords(obj)
    for _ in range(iterations):
        acc = np.zeros_like(co)
        np.add.at(acc, edges[:, 0], co[edges[:, 1]])
        np.add.at(acc, edges[:, 1], co[edges[:, 0]])
        avg = acc / np.maximum(deg, 1)[:, None]
        step = (avg - co) * factor
        if pin is not None:
            step[pin] = 0
        co = co + step
    set_coords(obj, co)


def smooth_taubin(obj, iterations=20, lam=0.5, mu=-0.53, pin: np.ndarray | None = None):
    """Taubin λ|μ smoothing: removes small bumps without shrinking thin parts (limbs)."""
    for _ in range(iterations):
        smooth_laplacian(obj, iterations=1, factor=lam, pin=pin)
        smooth_laplacian(obj, iterations=1, factor=mu, pin=pin)


def bisect(obj, planes):
    """Cut `obj` along infinite planes [(point, normal)], so colour regions get straight edges."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for co, no in planes:
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=Vector(co), plane_no=Vector(no).normalized())
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def boundary_vertices(obj) -> np.ndarray:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    mask = np.zeros(len(bm.verts), dtype=bool)
    for e in bm.edges:
        if e.is_boundary:
            for v in e.verts:
                mask[v.index] = True
    bm.free()
    return mask


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def hex_rgba(color: str, alpha=1.0):
    """sRGB hex → linear RGBA (Blender colour sockets are linear)."""
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return tuple(lin(int(color[i : i + 2], 16) / 255) for i in (1, 3, 5)) + (alpha,)


def curve_tube(name, points, radius, *, profile=None, resolution=4, bevel_resolution=3, closed=False, tilt=None):
    """A tube (or ribbon with `profile`) mesh along a poly-bezier through `points`."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.resolution_u = resolution
    spline = cu.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for i, p in enumerate(points):
        bp = spline.bezier_points[i]
        bp.co = p
        bp.handle_left_type = bp.handle_right_type = "AUTO"
        if tilt is not None:
            bp.tilt = tilt[i]
    spline.use_cyclic_u = closed
    if profile is not None:
        cu.bevel_mode = "OBJECT"
        cu.bevel_object = profile
    else:
        cu.bevel_depth = radius
        cu.bevel_resolution = bevel_resolution
    cu.use_fill_caps = not closed
    obj = link(bpy.data.objects.new(name, cu))
    activate(obj)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.object
    obj.name = obj.data.name = name
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def rect_profile(name, width, height, bevel=0.002):
    """A rounded-rectangle curve to use as a ribbon profile (straps, bands)."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "2D"
    spline = cu.splines.new("POLY")
    w, h = width / 2, height / 2
    pts = [(-w, -h), (w, -h), (w, h), (-w, h)]
    spline.points.add(len(pts) - 1)
    for i, (x, y) in enumerate(pts):
        spline.points[i].co = (x, y, 0, 1)
    spline.use_cyclic_u = True
    obj = link(bpy.data.objects.new(name, cu))
    obj.hide_render = True
    obj.hide_viewport = True
    return obj


def assign_material(obj, material):
    obj.data.materials.clear()
    obj.data.materials.append(material)


def set_smooth(obj, smooth=True):
    obj.data.polygons.foreach_set("use_smooth", [smooth] * len(obj.data.polygons))


def rigid_bind(obj, armature, bone_name):
    """Skin `obj` 100% to one bone (keeps it a skinned mesh, so LODs can merge it)."""
    obj.vertex_groups.clear()
    vg = obj.vertex_groups.new(name=bone_name)
    vg.add(range(len(obj.data.vertices)), 1.0, "REPLACE")
    bind_armature(obj, armature)


def bind_armature(obj, armature):
    obj.parent = armature
    obj.matrix_parent_inverse = armature.matrix_world.inverted()
    mod = next((m for m in obj.modifiers if m.type == "ARMATURE"), None) or obj.modifiers.new("Armature", "ARMATURE")
    mod.object = armature
    # Armature first, so later modifiers (none at export) act on the posed mesh.
    while obj.modifiers[0] != mod:
        activate(obj)
        bpy.ops.object.modifier_move_up(modifier=mod.name)


def bone_head(armature, name) -> Vector:
    return armature.matrix_world @ armature.data.bones[name].head_local


def bone_tail(armature, name) -> Vector:
    return armature.matrix_world @ armature.data.bones[name].tail_local


def log(*a):
    print("[avatar]", *a, flush=True)


def args_after_dashes() -> list[str]:
    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


__all__ = [n for n in dir() if not n.startswith("_")] + ["math", "np", "bpy", "bmesh", "Vector", "Matrix"]

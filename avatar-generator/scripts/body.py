"""Stage 1: the human — MakeHuman base mesh through MPFB, fitted Mixamo rig, face parts, expressions.

Everything here comes from the MakeHuman CC0 system assets: the base mesh (hm08), macro and
detail targets, the FACS-style Asian expression units, skins, eyes, brows, lashes, teeth, tongue.
"""

from common import *

FACE_PARTS = ("eyes", "eyebrows", "eyelashes", "teeth", "tongue")

# Expression shape keys exported as glTF morph targets. Each is a mix of MakeHuman expression
# units (targets/expression/units/asian). Values were tuned by eye on preview renders.
EXPRESSIONS = {
    "Smile": {"mouth-corner-puller": 0.75, "mouth-elevation": 0.15, "eye-left-slit": 0.25, "eye-right-slit": 0.25},
    "Excited": {"mouth-corner-puller": 0.7, "mouth-open": 0.55, "eyebrows-left-up": 0.35, "eyebrows-right-up": 0.35},
    "Surprised": {"mouth-open": 0.6, "mouth-pursing": 0.25, "eyebrows-left-up": 0.9, "eyebrows-right-up": 0.9,
                  "eye-left-opened-up": 0.6, "eye-right-opened-up": 0.6},
    "Thinking": {"mouth-compression": 0.45, "eyebrows-left-inner-up": 0.5, "eyebrows-right-down": 0.35,
                 "eye-right-slit": 0.2},
    "Wink": {"eye-left-closure": 1.0, "mouth-corner-puller": 0.45, "eyebrows-left-down": 0.25},
    "Blink": {"eye-left-closure": 1.0, "eye-right-closure": 1.0},
    "MouthOpen": {"mouth-open": 0.55},  # talking / lip-sync
}


def unit_path(name):
    return target_path("expression", "units", "asian", name + ".target.gz")


def _create(spec, scale):
    M = mpfb()
    HS, TS = M["HumanService"], M["TargetService"]
    clear_scene()
    macro = TS.get_default_macro_info_dict()
    for k, v in spec["phenotype"].items():
        macro[k] = dict(v) if isinstance(v, dict) else v
    body = HS.create_human(scale=scale, macro_detail_dict=macro)
    body.name = spec["name"] + ".body"
    for name, value in spec["targets"].items():
        path = TS.target_full_path(name)
        if not path:
            raise FileNotFoundError(name)
        TS.load_target(body, path, weight=value, name=name)
    for name, value in spec.get("rest_expression", {}).items():
        TS.load_target(body, unit_path(name), weight=value, name="rest-" + name)
    # Feet on the ground with the details applied (MPFB grounds before them).
    body.location.z -= _evaluated_z(body).min()
    activate(body)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    return body


def _body_mask(body):
    return group_weights(body, "body") > 0.5


def _evaluated_z(body):
    """Z of the 13,380 body vertices with every shape key applied (helpers come after them)."""
    body.data.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    depsgraph.update()
    ev = body.evaluated_get(depsgraph)
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    ev.to_mesh_clear()
    return co.reshape(-1, 3)[:13380, 2] + body.matrix_world.translation.z


def _evaluated_height(body):
    z = _evaluated_z(body)
    return z.max() - z.min()


def build_human(spec):
    """Create the body at the spec's height with rig, face parts and hair base fitted."""
    M = mpfb()
    HS, TS = M["HumanService"], M["TargetService"]
    probe = _create(spec, 0.1)
    scale = 0.1 * spec["height"] / _evaluated_height(probe)
    body = _create(spec, scale)
    log(spec["name"], "height", round(_evaluated_height(body), 3), "scale", round(scale, 5))

    rig = HS.add_builtin_rig(body, "mixamo", import_weights=True)
    rig.name = rig.data.name = spec["name"]

    parts = {}
    paths = {
        "eyes": asset_path("eyes", "high-poly", "high-poly.mhclo"),
        "eyebrows": asset_path("eyebrows", spec["eyebrows"], spec["eyebrows"] + ".mhclo"),
        "eyelashes": asset_path("eyelashes", spec["eyelashes"], spec["eyelashes"] + ".mhclo"),
        "teeth": asset_path("teeth", "teeth_base", "teeth_base.mhclo"),
        "tongue": asset_path("tongue", "tongue01", "tongue01.mhclo"),
        "hair": asset_path("hair", spec["hair"]["base"], spec["hair"]["base"] + ".mhclo"),
    }
    if spec.get("shoes"):
        # Clothes are fitted to helper vertices, so they must load before remove_helpers().
        paths["shoes"] = asset_path("clothes", spec["shoes"], spec["shoes"] + ".mhclo")
    for part, path in paths.items():
        obj = HS.add_mhclo_asset(path, body, asset_type=part, subdiv_levels=0, material_type="MAKESKIN")
        obj.name = obj.data.name = f"{spec['name']}.{part}"
        for m in obj.modifiers:
            if m.type == "SUBSURF":
                obj.modifiers.remove(m)
        parts[part] = obj

    TS.bake_targets(body)
    return body, rig, parts


def remove_helpers(body):
    """Delete the MakeHuman helper geometry (tights, skirt, joint cubes)."""
    keep = _body_mask(body)
    for m in list(body.modifiers):
        if m.type == "MASK":
            body.modifiers.remove(m)
    keep_vertices(body, keep)
    for vg in list(body.vertex_groups):
        if vg.name.startswith(("helper-", "joint-")) or vg.name in ("HelperGeometry", "JointCubes"):
            body.vertex_groups.remove(vg)


def add_expressions(body, parts, expressions=EXPRESSIONS):
    """Expression shape keys on the face, mirrored onto brows and lashes (surface deform)."""
    TS = mpfb()["TargetService"]
    units = sorted({u for mix in expressions.values() for u in mix})
    activate(body)
    if not body.data.shape_keys:
        body.shape_key_add(name="Basis", from_mix=False)
    for u in units:
        TS.load_target(body, unit_path(u), weight=0.0, name="unit-" + u)
    keys = body.data.shape_keys.key_blocks
    for name, mix in expressions.items():
        for k in keys:
            k.value = 0.0
        for u, w in mix.items():
            keys["unit-" + u].value = w
        body.shape_key_add(name=name, from_mix=True)
    for u in units:
        body.shape_key_remove(keys["unit-" + u])
    for k in body.data.shape_keys.key_blocks:
        k.value = 0.0
    names = list(expressions)
    for part in ("eyebrows", "eyelashes"):
        transfer_shape_keys(body, parts[part], names)
    return names


def transfer_shape_keys(source, target, names):
    """Give `target` the shape keys `names` of `source` by binding a Surface Deform to it."""
    activate(target)
    arm = [m for m in target.modifiers if m.type == "ARMATURE"]
    for m in arm:
        m.show_viewport = False
    sd = target.modifiers.new("ExprBind", "SURFACE_DEFORM")
    sd.target = source
    sd.falloff = 4.0
    while target.modifiers[0] != sd:
        bpy.ops.object.modifier_move_up(modifier=sd.name)
    keys = source.data.shape_keys.key_blocks
    for k in keys:
        k.value = 0.0
    bpy.ops.object.surfacedeform_bind(modifier=sd.name)
    if not sd.is_bound:
        raise RuntimeError(f"surface deform bind failed for {target.name}")
    if not target.data.shape_keys:
        target.shape_key_add(name="Basis", from_mix=False)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for name in names:
        for k in keys:
            k.value = 1.0 if k.name == name else 0.0
        depsgraph.update()
        ev = target.evaluated_get(depsgraph)
        me = ev.to_mesh()
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        ev.to_mesh_clear()
        sk = target.shape_key_add(name=name, from_mix=False)
        sk.data.foreach_set("co", co)
    for k in keys:
        k.value = 0.0
    target.modifiers.remove(sd)
    for m in arm:
        m.show_viewport = True


def transfer_shape_keys_nearest(source, target, names):
    """Shape keys for a simplified copy: each target vertex takes the offset of the nearest
    source triangle (barycentric blend). No binding step, so it cannot fail on odd topology."""
    from mathutils.bvhtree import BVHTree
    from mathutils.interpolate import poly_3d_calc

    me = source.data
    me.calc_loop_triangles()
    tris = [tuple(t.vertices) for t in me.loop_triangles]
    keys = me.shape_keys.key_blocks
    basis = np.empty(len(me.vertices) * 3)
    keys[0].data.foreach_get("co", basis)
    basis = basis.reshape(-1, 3)
    tree = BVHTree.FromPolygons([Vector(v) for v in basis], tris)
    tco = coords(target)
    idx = np.zeros((len(tco), 3), dtype=np.int64)
    w = np.zeros((len(tco), 3))
    for i, p in enumerate(tco):
        loc, _, ti, _ = tree.find_nearest(Vector(p))
        tri = tris[ti]
        idx[i] = tri
        w[i] = poly_3d_calc([Vector(basis[j]) for j in tri], loc)
    if not target.data.shape_keys:
        target.shape_key_add(name="Basis", from_mix=False)
    for name in names:
        kco = np.empty(len(me.vertices) * 3)
        keys[name].data.foreach_get("co", kco)
        delta = kco.reshape(-1, 3) - basis
        d = (delta[idx] * w[:, :, None]).sum(axis=1)
        sk = target.shape_key_add(name=name, from_mix=False)
        sk.data.foreach_set("co", (tco + d).ravel())

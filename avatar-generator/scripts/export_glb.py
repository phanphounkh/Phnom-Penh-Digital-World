"""Export a character .blend as two GLBs and write size/triangle statistics.

  blender --background output/male_avatar.blend --python-use-system-env --python scripts/export_glb.py

* output/<name>_avatar.glb       high quality (close-ups, avatar editor): full meshes, separate
                                  materials, textures up to 2048 px.
* output/<name>_avatar_game.glb  gameplay: decimated meshes, the flat-colour parts merged into one
                                  mesh per wardrobe choice (outfits.py) sharing one palette
                                  material, decals/brows+lashes/hair in small atlases, the skin
                                  some garments hide cut into region meshes; textures ≤ 1024 px.
                                  The manifest's "wardrobe" says which mesh is which, so the game
                                  shows one outfit at a time (about 12 draw calls).
The high-quality GLB (viewer, renders) carries the original outfit only.
Both keep the same 52-bone Mixamo skeleton, the 7 face morphs and the 8 animation clips.
Statistics go to output/<name>_stats.json.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import *  # noqa: E402
import body as body_stage  # noqa: E402
import outfits as O  # noqa: E402
import setup_materials as mats  # noqa: E402

PALETTE = {"size": 0, "cell": 0, "cells": {}}
MANIFEST = {}
SPEC = {}

HIGH_LIMITS = {"Skin": 2048, "Hair": 1024, "HairCards": 1024, "default": 1024, "Eyes": 512, "Teeth": 512}
GAME_DECIMATE = {"body": 0.33, "shell": 0.26, "band": 0.5, "shoes": 0.5, "solid": 0.4, "teeth": 0.12, "eyes": 0.5,
                 "hair": 0.6}


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def base_image(material):
    if not material or not material.node_tree:
        return None
    p = material.node_tree.nodes.get("Principled BSDF")
    if p and p.inputs["Base Color"].is_linked:
        node = p.inputs["Base Color"].links[0].from_node
        if node.type == "TEX_IMAGE":
            return node.image
    return None


def principled(material):
    return material.node_tree.nodes.get("Principled BSDF")


def character_objects(rig):
    return [o for o in bpy.data.objects if o.type == "MESH" and o.parent == rig]


def limit_images(objs, limits):
    seen = set()
    for o in objs:
        for m in o.data.materials:
            if not m or not m.node_tree:
                continue
            cap = limits.get(m.name, limits["default"])
            for n in m.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image and n.image.name not in seen:
                    img = n.image
                    seen.add(img.name)
                    w, h = img.size
                    if max(w, h) > cap:
                        k = cap / max(w, h)
                        img.scale(max(1, int(w * k)), max(1, int(h * k)))


def export(path, objects, rig):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objects + [rig]:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="JPEG",
        export_image_quality=88,
        export_skins=True,
        export_all_influences=False,
        export_morph=True,
        export_morph_normal=False,
        export_try_sparse_sk=True,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_def_bones=False,
        export_extras=False,
        export_cameras=False,
        export_lights=False,
    )
    return os.path.getsize(path)


def stats(objects, rig, path):
    mats_used, textures = {}, {}
    draw_calls = 0
    for o in objects:
        used = {p.material_index for p in o.data.polygons}
        draw_calls += len(used)
        for i in used:
            m = o.data.materials[i] if i < len(o.data.materials) else None
            if m:
                mats_used[m.name] = mats_used.get(m.name, 0) + 1
                if m.node_tree:
                    for n in m.node_tree.nodes:
                        if n.type == "TEX_IMAGE" and n.image:
                            textures[n.image.name] = list(n.image.size)
    morphs = sorted({k.name for o in objects if o.data.shape_keys for k in o.data.shape_keys.key_blocks[1:]})
    clips = sorted({t.name for t in (rig.animation_data.nla_tracks if rig.animation_data else [])})
    return {
        "file": os.path.basename(path),
        "bytes": os.path.getsize(path),
        "meshes": len(objects),
        "triangles": sum(tri_count(o) for o in objects),
        "vertices": sum(len(o.data.vertices) for o in objects),
        "materials": len(mats_used),
        "draw_calls_estimate": draw_calls,
        "textures": textures,
        "texture_pixels": sum(w * h for w, h in textures.values()),
        "bones": len(rig.data.bones),
        "morph_targets": morphs,
        "animations": clips,
        "per_mesh_triangles": {o.name: tri_count(o) for o in sorted(objects, key=lambda o: -tri_count(o))[:12]},
    }


# ── Game LOD ────────────────────────────────────────────────────────────────────────────


def kind_of(o, name):
    n = o.name[len(name) + 1 :]
    if n == "body":
        return "body"
    if n in ("eyes", "teeth", "tongue", "eyebrows", "eyelashes", "hair", "hair_cards"):
        return n
    images = [base_image(m) for m in o.data.materials if m]
    if any(images):
        return "decal"
    return "flat"


def decimate(o, ratio):
    if ratio >= 0.999 or len(o.data.polygons) < 60:
        return
    m = o.modifiers.new("Decimate", "DECIMATE")
    m.ratio = ratio
    m.use_collapse_triangulate = True
    activate(o)
    bpy.ops.object.modifier_move_to_index(modifier=m.name, index=0)
    bpy.ops.object.modifier_apply(modifier=m.name)


def flat_ratio(o):
    n = o.name
    shells = ("pants", "hoodie", "jacket", "pocket", "flap", "tee", "shirt", "jeans", "shorts")
    if any(k in n for k in shells) and len(o.data.polygons) > 400:
        return GAME_DECIMATE["shell"]
    if "sneakers" in n:
        return GAME_DECIMATE["shoes"]
    if len(o.data.polygons) > 300:
        return GAME_DECIMATE["band"]
    return GAME_DECIMATE["solid"]


def palette_material(name, flat_mats, cell=16):
    """One material for all flat colours: base colour, metal/roughness and emission palettes."""
    from PIL import Image

    n = len(flat_mats)
    # Power-of-two grid of 16 px cells: down to mip level 4 every texel is still one colour.
    cols = 1
    while cols * cols < n:
        cols *= 2
    size = cols * cell
    # RGBA, so the exporter keeps them lossless PNG (it writes 3-channel images as JPEG).
    base = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    mr = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    emit = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    uv = {}
    any_emission = False
    for i, m in enumerate(flat_mats):
        p = principled(m)
        c = p.inputs["Base Color"].default_value
        srgb = tuple(int(round(float(mats.linear_to_srgb(v)) * 255)) for v in c[:3])
        rough = int(round(p.inputs["Roughness"].default_value * 255))
        metal = int(round(p.inputs["Metallic"].default_value * 255))
        strength = p.inputs["Emission Strength"].default_value
        e = tuple(int(round(float(mats.linear_to_srgb(min(1.0, v * min(strength, 1.0)))) * 255)) for v in p.inputs["Emission Color"].default_value[:3]) if strength > 0 else (0, 0, 0)
        any_emission |= strength > 0
        x, y = (i % cols) * cell, (i // cols) * cell
        for img, val in ((base, srgb + (255,)), (mr, (255, rough, metal, 255)), (emit, e + (255,))):
            img.paste(val, (x, y, x + cell, y + cell))
        # UV of the cell centre (Blender UV origin is bottom-left; PIL rows go down).
        uv[m.name] = ((x + cell / 2) / size, 1 - (y + cell / 2) / size)
        PALETTE["cells"][m.name] = [x, y]  # top-left pixel, image rows downward
    PALETTE["size"], PALETTE["cell"] = size, cell
    paths = {}
    for key, img in (("base", base), ("mr", mr), ("emit", emit)):
        paths[key] = os.path.join(mats.GENERATED, f"{name}_palette_{key}.png")
        img.save(paths[key])
    m, nt, p = mats._principled(f"{name}.Outfit")
    tb = mats._image_node(nt, mats.load_image(paths["base"], alpha=False), (-600, 300))
    tb.interpolation = "Closest"
    nt.links.new(tb.outputs["Color"], p.inputs["Base Color"])
    tm = mats._image_node(nt, mats.load_image(paths["mr"], colorspace="Non-Color", alpha=False), (-600, 0))
    tm.interpolation = "Closest"
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(tm.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], p.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], p.inputs["Metallic"])
    if any_emission:
        te = mats._image_node(nt, mats.load_image(paths["emit"], alpha=False), (-600, -300))
        te.interpolation = "Closest"
        nt.links.new(te.outputs["Color"], p.inputs["Emission Color"])
        p.inputs["Emission Strength"].default_value = 1.0
    m.use_backface_culling = False
    return m, uv


def set_uv_to_cells(o, uv_by_material):
    me = o.data
    layer = me.uv_layers.active or me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        mat = me.materials[poly.material_index] if poly.material_index < len(me.materials) else None
        u, v = uv_by_material.get(mat.name if mat else "", (0.0, 0.0))
        for li in poly.loop_indices:
            layer.data[li].uv = (u, v)


def neutral(img, mean_linear=0.5):
    """Grey version of a tinted texture (alpha kept) whose average opaque value is `mean_linear`,
    so a colour factor (material.color in Three.js) gives it any hair colour."""
    from PIL import Image

    a = np.asarray(img.convert("RGBA"), dtype=np.float64) / 255
    lum = mats.srgb_to_linear(a[..., :3]) @ np.array([0.2126, 0.7152, 0.0722])
    opaque = a[..., 3] > 0.5
    scale = mean_linear / max(1e-6, lum[opaque].mean())
    g = mats.linear_to_srgb(np.clip(lum * scale, 0, 1))
    out = np.dstack([g, g, g, a[..., 3]])
    return Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA")


def atlas(name, items, cell, alpha, *, double_sided=True, roughness=0.6, factor=None):
    """Pack each object's base-colour image into one atlas row/grid and remap their UVs.
    `factor` (sRGB hex): store the images neutral grey and put this colour in the material."""
    from PIL import Image

    cols = int(math.ceil(math.sqrt(len(items))))
    rows = int(math.ceil(len(items) / cols))
    W, H = cols * cell[0], rows * cell[1]
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for i, (objs, img) in enumerate(items):
        src = Image.open(bpy.path.abspath(img.filepath)).convert("RGBA").resize(cell, Image.LANCZOS)
        if factor:
            src = neutral(src)
        cx, cy = (i % cols) * cell[0], (i // cols) * cell[1]
        out.paste(src, (cx, cy))
        u0, v0 = cx / W, 1 - (cy + cell[1]) / H
        su, sv = cell[0] / W, cell[1] / H
        for o in objs:
            layer = o.data.uv_layers.active
            for d in layer.data:
                u, v = d.uv
                # Keep inside the cell (clamp wrap-around UVs such as tiled fabric).
                d.uv = (u0 + min(max(u, 0.0), 1.0) * su, v0 + min(max(v, 0.0), 1.0) * sv)
    path = os.path.join(mats.GENERATED, f"{name}.png")
    out.save(path)
    m = mats.textured(name, path, roughness=roughness, alpha="CLIP" if alpha else None, double_sided=double_sided)
    if factor:
        # Texture × colour through a Multiply mix: exported as glTF baseColorFactor.
        nt = m.node_tree
        p = nt.nodes.get("Principled BSDF")
        tex = next(n for n in nt.nodes if n.type == "TEX_IMAGE")
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        nt.links.new(tex.outputs["Color"], mix.inputs[6])
        c = mats.srgb_to_linear(mats.hex_srgb(factor)) / 0.5
        mix.inputs[7].default_value = (*np.clip(c, 0, 1), 1.0)
        nt.links.new(mix.outputs[2], p.inputs["Base Color"])
    return m


def join(objs, name):
    objs = [o for o in objs if o]
    if len(objs) == 1:
        objs[0].name = objs[0].data.name = name
        return objs[0]
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    j = bpy.context.view_layer.objects.active
    j.name = j.data.name = name
    return j


def wear_key(o):
    """The wardrobe choice an object belongs to ("top.tee", "bag.backpack@top.tee"), or None."""
    if o.get("region"):
        return f"region.{o['region']}"
    slot = o.get("slot")
    if not slot:
        return None
    w = o.get("with")
    return f"{slot}.{o['variant']}" + (f"@{w}" if w else "")


def wear_info(key):
    if key.startswith("region."):
        return {"region": key[7:]}
    choice, _, w = key.partition("@")
    slot, variant = choice.split(".")
    return {"slot": slot, "variant": variant, "with": w or None}


def separate_faces(obj, mask, name):
    """Move the faces in `mask` into a new object (same modifiers, parent and materials)."""
    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    obj.data.polygons.foreach_set("select", np.asarray(mask, dtype=bool))
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    new = next(o for o in bpy.context.selected_objects if o is not obj)
    new.name = new.data.name = name
    return new


def split_skin_regions(gb, name):
    """Cut the region_* skin (outfits.REGIONS) off the game body into meshes of their own; a face
    belongs to a region when its vertices are mostly in it (the decimated weights blend)."""
    out = []
    for r in O.REGIONS:
        vg = gb.vertex_groups.get(f"region_{r}")
        if vg is None:
            continue
        w = np.zeros(len(gb.data.vertices))
        for v in gb.data.vertices:
            for g in v.groups:
                if g.group == vg.index:
                    w[v.index] = g.weight
        sel = np.array([w[list(p.vertices)].mean() > 0.5 for p in gb.data.polygons])
        if not sel.any():
            continue
        part = separate_faces(gb, sel, f"{name}.game.skin_{r}")
        if part.data.shape_keys:  # only the face morphs: not on arms, legs or feet
            activate(part)
            bpy.ops.object.shape_key_remove(all=True, apply_mix=False)
        out.append((part, r))
    for o in [gb] + [p for p, _ in out]:
        for vg in list(o.vertex_groups):
            if vg.name.startswith("region_"):
                o.vertex_groups.remove(vg)
    return out


def copy_morph_tracks(src, dst):
    sk, dk = src.data.shape_keys, dst.data.shape_keys
    if not (sk and dk and sk.animation_data):
        return
    dk.animation_data_create()
    for t in sk.animation_data.nla_tracks:
        nt = dk.animation_data.nla_tracks.new()
        nt.name = t.name
        for s in t.strips:
            nt.strips.new(s.name, int(s.frame_start), s.action)
        nt.mute = True


def build_game_lod(name, rig, high):
    by_kind = {}
    for o in high:
        by_kind.setdefault(kind_of(o, name), []).append(o)
    game = []

    # Body: decimate a copy, then re-create the face morphs on it.
    hb = by_kind["body"][0]
    gb = duplicate(hb, f"{name}.game.body")
    decimate(gb, GAME_DECIMATE["body"])
    keys = [k.name for k in hb.data.shape_keys.key_blocks[1:]]
    body_stage.transfer_shape_keys_nearest(hb, gb, keys)
    copy_morph_tracks(hb, gb)
    bind_armature(gb, rig)
    game.append(gb)
    wardrobe = {}
    for part, r in split_skin_regions(gb, name):
        game.append(part)
        wardrobe[part.name] = {"region": r}

    # Eyes, teeth (tongue dropped: hidden behind the teeth at gameplay distance).
    for kind in ("eyes", "teeth"):
        for o in by_kind.get(kind, []):
            g = duplicate(o, f"{name}.game.{kind}")
            decimate(g, GAME_DECIMATE[kind])
            bind_armature(g, rig)
            game.append(g)

    # Brows + lashes: one atlas, morphs kept (they blink and raise with the face).
    bl = []
    for kind in ("eyebrows", "eyelashes"):
        for o in by_kind.get(kind, []):
            g = duplicate(o, f"{name}.game.{kind}", keep_shape_keys=True)
            copy_morph_tracks(o, g)
            bind_armature(g, rig)
            bl.append((g, base_image(o.data.materials[0])))
    m = atlas(f"{name}_game_browslashes", [([g], img) for g, img in bl], (256, 256), True)
    for g, _ in bl:
        assign_material(g, m)
    game.append(join([g for g, _ in bl], f"{name}.game.browslashes"))

    # Hair: base hair + cards in one atlas; the cards on top of the head (hidden under a hat)
    # in a mesh of their own.
    hair, under_hat = [], []
    for kind in ("hair", "hair_cards"):
        for o in by_kind.get(kind, []):
            g = duplicate(o, f"{name}.game.{kind}")
            decimate(g, GAME_DECIMATE["hair"] if kind == "hair" else 1.0)
            bind_armature(g, rig)
            img = base_image(o.data.materials[0])
            if kind == "hair_cards":
                mask = O.under_hat_faces(g, rig)
                if mask.any():
                    under_hat.append((separate_faces(g, mask, f"{name}.game.hair_cards_hat"), img))
            hair.append((g, img))
    m = atlas(f"{name}_game_hair", [([g], img) for g, img in hair + under_hat], (512, 512), True, roughness=0.62,
              factor=SPEC["hair"]["color"])
    for g, _ in hair + under_hat:
        assign_material(g, m)
    game.append(join([g for g, _ in hair], f"{name}.game.hair"))
    if under_hat:
        h = join([g for g, _ in under_hat], f"{name}.game.hair_hat")
        game.append(h)
        wardrobe[h.name] = {"region": "hair_top"}

    # Decals (chest print, flag patch, backpack print, watch face): one atlas.
    dec = []
    for o in by_kind.get("decal", []):
        g = duplicate(o, f"{name}.game.{o.name[len(name) + 1:]}")
        bind_armature(g, rig)
        dec.append((g, base_image(o.data.materials[0])))
    if dec:
        m = atlas(f"{name}_game_decals", [([g], img) for g, img in dec], (256, 256), True, double_sided=False, roughness=0.75)
        for g, _ in dec:
            assign_material(g, m)
        groups = {}
        for g, _ in dec:
            groups.setdefault(wear_key(g), []).append(g)
        for key, objs in sorted(groups.items(), key=lambda kv: kv[0] or ""):
            j = join(objs, f"{name}.game.decals" + (f".{key}" if key else ""))
            game.append(j)
            if key:
                wardrobe[j.name] = wear_info(key)

    # Everything flat-coloured: decimate, point UVs at palette cells, one mesh, one material.
    flats = []
    for o in by_kind.get("flat", []):
        g = duplicate(o, f"{name}.game.{o.name[len(name) + 1:]}")
        decimate(g, flat_ratio(o))
        bind_armature(g, rig)
        flats.append(g)
    flat_mats = sorted({m for g in flats for m in g.data.materials if m}, key=lambda m: m.name)
    pal, uv = palette_material(name, flat_mats)
    MANIFEST["palette"] = {"size": PALETTE["size"], "cell": PALETTE["cell"], "cells": PALETTE["cells"]}
    for g in flats:
        set_uv_to_cells(g, uv)
        for uvl in list(g.data.uv_layers)[1:]:
            g.data.uv_layers.remove(uvl)
        g.data.materials.clear()
        g.data.materials.append(pal)
    groups = {}
    for g in flats:
        groups.setdefault(wear_key(g), []).append(g)
    for key, objs in sorted(groups.items(), key=lambda kv: kv[0] or ""):
        j = join(objs, f"{name}.game.outfit" + (f".{key}" if key else ""))
        game.append(j)
        if key:
            wardrobe[j.name] = wear_info(key)
    MANIFEST["wardrobe"] = {"slots": O.SLOTS, "default": O.DEFAULT, "hidden_when": O.HIDDEN_WHEN,
                            "meshes": wardrobe}

    for g in game:
        activate(g)
        if g.vertex_groups:
            bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
            bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
        # Single UV map per mesh (glTF TEXCOORD_0).
        for uvl in list(g.data.uv_layers)[1:]:
            g.data.uv_layers.remove(uvl)
    return game


def natural_speed(rig, clip, fps=30):
    """Ground speed (m/s) at which a looping gait clip shows no foot sliding: how fast a planted
    foot moves backward relative to the hips while it is on the ground (in-place clips)."""
    track = next((t for t in rig.animation_data.nla_tracks if t.name == clip), None)
    if track is None:
        return None
    action = track.strips[0].action
    rig.animation_data.action = action
    start, end = (int(round(v)) for v in action.frame_range)
    samples = {"Left": [], "Right": []}
    for f in range(start, end + 1):
        bpy.context.scene.frame_set(f)
        hips = rig.pose.bones["mixamorig:Hips"].head
        for side in samples:
            foot = rig.pose.bones[f"mixamorig:{side}Foot"].head
            samples[side].append((foot.z, foot.y - hips.y))  # forward is -Y
    rig.animation_data.action = None
    bpy.context.scene.frame_set(1)
    speeds = []
    for side, s in samples.items():
        low = min(z for z, _ in s)
        for i in range(len(s) - 1):
            if s[i][0] < low + 0.035 and s[i + 1][0] < low + 0.035:  # in contact with the ground
                speeds.append((s[i + 1][1] - s[i][1]) * fps)
    speeds = [v for v in speeds if v > 0]
    if not speeds:
        return None
    speeds.sort()
    return round(speeds[len(speeds) // 2], 3)


def main():
    rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    name = rig.name
    from characters import CHARACTERS

    SPEC.update(CHARACTERS[name])
    everything = character_objects(rig)
    os.makedirs(OUTPUT, exist_ok=True)
    game = build_game_lod(name, rig, everything)

    # High quality: the original outfit, its hidden skin removed (this session only, not saved).
    high = [o for o in everything if O.shown(o)]
    for o in high:
        groups = {vg.index: vg.name[7:] for vg in o.vertex_groups if vg.name.startswith("region_")}
        hidden = [i for i, r in groups.items() if O.region_hidden(r)]
        if hidden:
            gone = np.array([any(g.group in hidden and g.weight > 0.5 for g in v.groups) for v in o.data.vertices])
            keep_faces(o, ~face_vertex_all(o, gone))
    limit_images(high, HIGH_LIMITS)
    out_high = os.path.join(OUTPUT, f"{name}_avatar.glb")
    export(out_high, high, rig)
    s_high = stats(high, rig, out_high)
    log(name, "high", s_high["file"], f"{s_high['bytes'] / 1e6:.2f} MB", s_high["triangles"], "tris",
        s_high["draw_calls_estimate"], "draw calls")

    limit_images(game, {"default": 1024, f"{name}.game.Skin": 1024, "Skin": 1024, "Eyes": 256, "Teeth": 256})
    out_game = os.path.join(OUTPUT, f"{name}_avatar_game.glb")
    export(out_game, game, rig)
    s_game = stats(game, rig, out_game)
    log(name, "game", s_game["file"], f"{s_game['bytes'] / 1e6:.2f} MB", s_game["triangles"], "tris",
        s_game["draw_calls_estimate"], "draw calls")
    with open(os.path.join(OUTPUT, f"{name}_stats.json"), "w") as f:
        json.dump({"high": s_high, "game": s_game}, f, indent=2)
    # What the game needs to recolour and drive the game-quality model.
    MANIFEST.update({
        "kind": name,
        "file": os.path.basename(out_game),
        "height_m": SPEC["height"],
        "skin_tone": SPEC["skin"]["tone"],      # average colour of the baked skin texture
        "hair_color": SPEC["hair"]["color"],    # default hair colour (material factor × 0.5 grey)
        "hair_texture_mean": 0.5,
        "colors": SPEC["colors"],
        "clips": s_game["animations"],
        "morphs": s_game["morph_targets"],
        "triangles": s_game["triangles"],
        "walk_speed": natural_speed(rig, "Walk"),
        "run_speed": natural_speed(rig, "Run"),
        "sprint_speed": natural_speed(rig, "Sprint"),
    })
    with open(os.path.join(OUTPUT, f"{name}_avatar_game.json"), "w") as f:
        json.dump(MANIFEST, f, indent=2)


main()

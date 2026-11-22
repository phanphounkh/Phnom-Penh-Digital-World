"""Build one character end to end and save output/<name>_avatar.blend.

  blender --background --python-use-system-env --python scripts/build_character.py -- male [--stage body]

Called by generate_male.py / generate_female.py. Stages (each one builds on the previous):
  body     MakeHuman body, rig, face parts, expressions, skin/eye/brow/hair materials
  outfit   + garments (hoodie, jacket, cargo pants, sneakers)
  all      + accessories, weights, animation clips (default)
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import *  # noqa: E402
import body as body_stage  # noqa: E402
import setup_materials as mats  # noqa: E402
from characters import CHARACTERS  # noqa: E402


def face_materials(spec, body, parts):
    name = spec["name"]
    skin_src = mats.read_mhmat(asset_path(spec["skin"]["mhmat"]))["diffuseTexture"]
    skin = mats.textured(
        "Skin", mats.grade_skin(skin_src, spec["skin"]["tone"], f"{name}_skin.jpg"), roughness=0.52, specular=0.42
    )
    mats.replace_material(body, skin)

    eye_png = asset_path("eyes", "materials", spec["eyes"]["iris"] + "_eye.png")
    # The eye mesh has a cornea shell mapped to the texture's transparent corner.
    eye_png = mats.grade_iris(eye_png, spec["eyes"].get("iris_color", "#3a2417"), f"{name}_eyes.png")
    mats.replace_material(parts["eyes"], mats.textured("Eyes", eye_png, roughness=0.06, specular=0.7, alpha="CLIP"))

    hair_hex = spec["hair"]["color"]
    brow_png = asset_path("eyebrows", spec["eyebrows"], spec["eyebrows"] + ".png")
    mats.replace_material(
        parts["eyebrows"],
        mats.textured("Eyebrows", mats.tint_rgba(brow_png, hair_hex, f"{name}_brows.png"), roughness=0.7,
                      alpha="CLIP", double_sided=True),
    )
    lash_png = asset_path("eyelashes", spec["eyelashes"], spec["eyelashes"] + ".png")
    mats.replace_material(
        parts["eyelashes"],
        mats.textured("Eyelashes", mats.tint_rgba(lash_png, "#0b0909", f"{name}_lashes.png"), roughness=0.7,
                      alpha="CLIP", double_sided=True),
    )
    mats.replace_material(parts["teeth"], mats.textured("Teeth", asset_path("teeth", "teeth_base", "teeth.png"), roughness=0.25))
    mats.replace_material(
        parts["tongue"], mats.textured("Tongue", asset_path("tongue", "tongue01", "tongue01_diffuse.png"), roughness=0.35)
    )
    base = spec["hair"]["base"]
    hair_png = mats.read_mhmat(asset_path("hair", base, base + ".mhmat"))["diffuseTexture"]
    hair_mat = mats.textured(
        "Hair", mats.tint_rgba(hair_png, hair_hex, f"{name}_hair.png", keep_detail=0.55), roughness=0.6,
        alpha="CLIP", double_sided=True, specular=0.3,
    )
    mats.replace_material(parts["hair"], hair_mat)
    return {"Skin": skin, "Hair": hair_mat}


def build(spec, stage="all"):
    t0 = time.time()
    body, rig, parts = body_stage.build_human(spec)
    body_stage.remove_helpers(body)
    expressions = body_stage.add_expressions(body, parts)
    log(spec["name"], "expressions", expressions)
    face_materials(spec, body, parts)
    import hair

    parts["hair_cards"] = hair.build_hair(spec, body, rig, parts)
    if stage in ("outfit", "all"):
        import garments

        garments.build_outfit(spec, body, rig, parts)
    if stage == "all":
        import accessories
        import setup_rig

        accessories.build_accessories(spec, body, rig, parts)
        setup_rig.finish_rig(spec, body, rig)
    os.makedirs(OUTPUT, exist_ok=True)
    path = os.path.join(OUTPUT, f"{spec['name']}_avatar.blend")
    bpy.ops.wm.save_as_mainfile(filepath=path, compress=True)
    log(spec["name"], "saved", path, f"{time.time() - t0:.1f}s")
    return path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("character", choices=sorted(CHARACTERS))
    ap.add_argument("--stage", default="all", choices=["body", "outfit", "all"])
    a = ap.parse_args(args_after_dashes())
    build(CHARACTERS[a.character], a.stage)

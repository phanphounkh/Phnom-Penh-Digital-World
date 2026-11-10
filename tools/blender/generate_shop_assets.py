"""Shop interior fittings and generic product display models (original work, CC0).

Run:  blender --background --python-use-system-env --python tools/blender/generate_shop_assets.py
Writes frontend/static/models/shop/*.glb. Then compress:  (cd frontend && npm run assets:compress)

Conventions relied on by the web client (frontend/src/lib/game/shop/ShopAssets.ts):
* Metres, Y up after export, origin on the floor/shelf at the centre of the footprint.
* Fittings face +Z after export (Blender -Y): customers stand in front of them.
* Material names are semantic. `Tint` is recoloured with the shop's primary colour,
  `Accent` with its accent colour, and `Label` shows the product image when one exists.
* Products are small (10–30 cm) and low-poly: a shop shows a few dozen of them.

Food products reuse the CampusEats food models (models/food/*.glb).
"""

import math
import os

import bpy

OUT = os.path.abspath(
    os.environ.get(
        "PPW_MODEL_OUTPUT", os.path.join(os.path.dirname(__file__), "../../frontend/static/models")
    )
)

COLORS = {
    "Wood": ("#9a6b43", 0.0, 0.7),
    "WoodDark": ("#5e3f27", 0.0, 0.75),
    "Metal": ("#9aa2a6", 0.7, 0.35),
    "Tint": ("#c4552f", 0.0, 0.6),
    "Accent": ("#e8a33d", 0.0, 0.55),
    "Label": ("#f4efe4", 0.0, 0.8),
    "Cardboard": ("#c9a271", 0.0, 0.9),
    "Tape": ("#d8c39a", 0.0, 0.5),
    "Paper": ("#e9dcc3", 0.0, 0.9),
    "Glass": ("#7fa89a", 0.2, 0.15),
    "Cap": ("#2c2f33", 0.3, 0.5),
    "Cloth": ("#3d6fb6", 0.0, 0.95),
    "Screen": ("#15191d", 0.4, 0.2),
    "Rattan": ("#b8874f", 0.0, 0.9),
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
    if name == "Glass":
        p.inputs["Alpha"].default_value = 0.55
        m.blend_method = "BLEND"
    m.diffuse_color = (*rgb, 1)
    MATERIALS[name] = m
    return m


def finish(o, material: str, smooth: bool = False):
    o.data.materials.clear()
    o.data.materials.append(mat(material))
    for poly in o.data.polygons:
        poly.use_smooth = smooth
    return o


def box(name, size, loc, material, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = size
    return finish(o, material)


def cylinder(name, r1, r2, depth, loc, material, verts=12, rot=(0, 0, 0), smooth=True):
    bpy.ops.mesh.primitive_cone_add(
        vertices=verts, radius1=r1, radius2=r2, depth=depth, location=loc, rotation=rot
    )
    o = bpy.context.object
    o.name = name
    return finish(o, material, smooth)


def torus(name, major, minor, loc, material, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major, minor_radius=minor, major_segments=16, minor_segments=6,
        location=loc, rotation=rot,
    )
    o = bpy.context.object
    o.name = name
    return finish(o, material, True)


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


# ── fittings ────────────────────────────────────────────────────────────────────────


def shelf() -> None:
    """A 2 m wall shelving unit with four display levels and a tinted header board.
    Shelf top surfaces (metres above the floor): 0.12, 0.55, 0.98, 1.41."""
    w, d, h = 2.0, 0.42, 1.9
    for x in (-w / 2 + 0.03, w / 2 - 0.03):
        box("Upright", (0.06, d, h), (x, 0, h / 2), "WoodDark")
    box("Back", (w, 0.02, h - 0.1), (0, d / 2 - 0.01, h / 2 + 0.05), "Wood")
    for i, z in enumerate((0.1, 0.53, 0.96, 1.39)):
        box(f"Shelf{i}", (w - 0.06, d, 0.04), (0, 0, z), "Wood")
        box(f"Lip{i}", (w - 0.06, 0.015, 0.05), (0, -d / 2 + 0.008, z + 0.035), "Accent")
    box("Header", (w, 0.05, 0.22), (0, -0.0, h + 0.11), "Tint")
    export("shop/shelf")


def display_table() -> None:
    """A low island table for the middle of the shop (top at 0.8 m)."""
    box("Top", (1.4, 0.8, 0.06), (0, 0, 0.8), "Wood")
    box("Skirt", (1.3, 0.7, 0.18), (0, 0, 0.68), "Tint")
    for x in (-0.6, 0.6):
        for y in (-0.32, 0.32):
            box("Leg", (0.06, 0.06, 0.6), (x, y, 0.3), "WoodDark")
    export("shop/table")


def awning() -> None:
    """Striped fabric awning, 1 m wide module (the client repeats it across the frontage).
    Origin at the wall, top edge; it slopes out towards -Y (the street)."""
    for i in range(4):
        x = -0.375 + i * 0.25
        box(f"Stripe{i}", (0.25, 1.1, 0.02), (x, -0.5, -0.18), "Tint" if i % 2 else "Accent",
            rot=(math.radians(-18), 0, 0))
    box("Valance", (1.0, 0.02, 0.16), (0, -1.03, -0.42), "Tint")
    export("shop/awning")


# ── generic products ───────────────────────────────────────────────────────────────


def product_box() -> None:
    box("Body", (0.24, 0.18, 0.2), (0, 0, 0.1), "Cardboard")
    box("Tape", (0.245, 0.04, 0.005), (0, 0, 0.2), "Tape")
    box("Label", (0.16, 0.002, 0.12), (0, -0.091, 0.1), "Label")  # faces the customer
    export("shop/product-box")


def product_bag() -> None:
    box("Bag", (0.22, 0.1, 0.26), (0, 0, 0.13), "Paper")
    box("Label", (0.16, 0.002, 0.14), (0, -0.051, 0.12), "Label")
    torus("Handle", 0.05, 0.006, (0, 0, 0.27), "Tint", rot=(math.radians(90), 0, 0))
    export("shop/product-bag")


def product_bottle() -> None:
    cylinder("Body", 0.04, 0.04, 0.2, (0, 0, 0.1), "Glass")
    cylinder("Shoulder", 0.04, 0.016, 0.05, (0, 0, 0.225), "Glass")
    cylinder("Cap", 0.017, 0.017, 0.025, (0, 0, 0.262), "Cap")
    cylinder("Label", 0.0405, 0.0405, 0.08, (0, 0, 0.1), "Label")
    export("shop/product-bottle")


def product_book() -> None:
    box("Cover", (0.16, 0.035, 0.23), (0, 0, 0.115), "Tint")
    box("Pages", (0.15, 0.03, 0.22), (0.006, 0, 0.115), "Paper")
    box("Label", (0.12, 0.002, 0.15), (0, -0.0185, 0.13), "Label")
    export("shop/product-book")


def product_jar() -> None:
    cylinder("Body", 0.055, 0.055, 0.12, (0, 0, 0.06), "Glass", verts=14)
    cylinder("Lid", 0.058, 0.058, 0.03, (0, 0, 0.135), "Accent", verts=14)
    cylinder("Label", 0.0555, 0.0555, 0.06, (0, 0, 0.06), "Label", verts=14)
    export("shop/product-jar")


def product_shirt() -> None:
    """A folded shirt, as stacked on a shelf."""
    box("Fold", (0.26, 0.2, 0.05), (0, 0, 0.025), "Cloth")
    box("Collar", (0.09, 0.03, 0.012), (0, -0.07, 0.055), "Cloth")
    box("Label", (0.06, 0.002, 0.03), (0, -0.101, 0.025), "Label")
    export("shop/product-shirt")


def product_phone() -> None:
    """A phone standing in its retail box."""
    box("Box", (0.1, 0.03, 0.17), (0, 0.01, 0.085), "Label")
    box("Phone", (0.075, 0.012, 0.15), (0, -0.012, 0.085), "Cap")
    box("Screen", (0.066, 0.002, 0.13), (0, -0.019, 0.087), "Screen")
    export("shop/product-phone")


def product_basket() -> None:
    """A woven rattan basket (crafts)."""
    cylinder("Basket", 0.11, 0.14, 0.12, (0, 0, 0.06), "Rattan", verts=16)
    torus("Rim", 0.14, 0.01, (0, 0, 0.12), "WoodDark")
    torus("Handle", 0.1, 0.008, (0, 0, 0.12), "WoodDark", rot=(math.radians(90), 0, 0))
    box("Label", (0.06, 0.002, 0.04), (0, -0.131, 0.06), "Label")
    export("shop/product-basket")


if __name__ == "__main__":
    reset()
    for build in (
        shelf, display_table, awning, product_box, product_bag, product_bottle, product_book,
        product_jar, product_shirt, product_phone, product_basket,
    ):
        build()

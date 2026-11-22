"""Materials and generated textures, kept to what glTF 2.0 / Three.js can express.

Every material is a single Principled BSDF fed by at most an image (base colour, optionally with
alpha), a normal map and constant factors, so the Blender glTF exporter maps it 1:1 onto
MeshStandardMaterial. Skin and hair colours are graded into new textures here instead of using
shader math the exporter would drop.

Generated textures (assets/generated/, rebuilt on every run, CC0):
* <name>_skin.jpg       MakeHuman young-asian skin graded to the character's tone
* <name>_hair.png       hair strand texture (also used by the procedural bun and fringe cards)
* print_angkor_*.png    Angkor-style temple print for the hoodies (original drawing)
* flag_patch.png        Cambodian flag patch (the national flag is public domain)
* watch_*.png           smartwatch faces
* fabric_normal.png     tileable knit/twill normal map
"""

import os

from common import *

GENERATED = os.path.join(ROOT, "assets", "generated")
os.makedirs(GENERATED, exist_ok=True)


def _pil():
    from PIL import Image, ImageDraw, ImageFilter  # system Python (python3-pil)

    return Image, ImageDraw, ImageFilter


# ── Images ───────────────────────────────────────────────────────────────────────────────


def load_image(path, *, colorspace="sRGB", alpha=True):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = colorspace
    img.alpha_mode = "STRAIGHT" if alpha else "NONE"
    return img


def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(np.asarray(c, dtype=np.float64), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def hex_srgb(color):
    return np.array([int(color[i : i + 2], 16) / 255 for i in (1, 3, 5)])


def grade_skin(source_png, tone_hex, out_name, size=2048):
    """Re-tone a MakeHuman skin texture so its average skin colour becomes `tone_hex`."""
    Image, _, _ = _pil()
    im = Image.open(source_png).convert("RGB")
    a = np.asarray(im, dtype=np.float64) / 255
    lin = srgb_to_linear(a)
    lum = lin @ np.array([0.2126, 0.7152, 0.0722])
    skin = lum > 0.05  # skip the black padding around UV islands
    mean = lin[skin].mean(axis=0)
    target = srgb_to_linear(hex_srgb(tone_hex))
    gain = target / mean
    out = linear_to_srgb(lin * gain)
    img = Image.fromarray((out * 255 + 0.5).astype(np.uint8))
    if img.width != size:
        img = img.resize((size, size), Image.LANCZOS)
    path = os.path.join(GENERATED, out_name)
    img.save(path, quality=92)
    return path


def grade_iris(source_png, iris_hex, out_name):
    """Recolour the iris (the saturated pixels) to `iris_hex`, keeping sclera, pupil and detail."""
    Image, _, _ = _pil()
    im = Image.open(source_png).convert("RGBA")
    a = np.asarray(im, dtype=np.float64) / 255
    rgb = a[..., :3]
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-6)
    iris = np.clip((sat - 0.18) / 0.2, 0, 1)[..., None]
    lin = srgb_to_linear(rgb)
    lum = (lin @ np.array([0.2126, 0.7152, 0.0722]))[..., None]
    ref = np.percentile(lum[iris[..., 0] > 0.5], 70) if (iris > 0.5).any() else 1.0
    target = srgb_to_linear(hex_srgb(iris_hex)) * np.clip(lum / ref, 0, 2.2)
    out = linear_to_srgb(lin * (1 - iris) + target * iris)
    path = os.path.join(GENERATED, out_name)
    Image.fromarray((np.concatenate([out, a[..., 3:]], -1) * 255 + 0.5).astype(np.uint8), "RGBA").save(path)
    return path


def tint_rgba(source_png, color_hex, out_name, *, keep_detail=0.35, size=None):
    """Recolour a greyscale-ish RGBA texture (hair, brows) to `color_hex`, keeping its shading."""
    Image, _, _ = _pil()
    im = Image.open(source_png).convert("RGBA")
    if size and im.width != size:
        im = im.resize((size, size), Image.LANCZOS)
    a = np.asarray(im, dtype=np.float64) / 255
    rgb, alpha = a[..., :3], a[..., 3:]
    lum = (srgb_to_linear(rgb) @ np.array([0.2126, 0.7152, 0.0722]))[..., None]
    shade = lum / max(1e-6, np.percentile(lum[alpha[..., 0] > 0.5], 75))
    target = srgb_to_linear(hex_srgb(color_hex))
    lin = target * (1 - keep_detail + keep_detail * np.clip(shade, 0, 2.5))
    out = np.concatenate([linear_to_srgb(lin), alpha], axis=-1)
    path = os.path.join(GENERATED, out_name)
    Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA").save(path)
    return path


def hair_strand_texture(color_hex, out_name, size=1024, seed=3):
    """Vertical hair strands with alpha, for procedural hair cards (bun, wisps, fringe).

    The texture is split in 4 columns of different density so cards can pick a style:
    U 0–0.25 dense, 0.25–0.5 medium, 0.5–0.75 sparse wisps, 0.75–1 single strands.
    """
    Image, ImageDraw, ImageFilter = _pil()
    rng = np.random.default_rng(seed)
    base = srgb_to_linear(hex_srgb(color_hex))
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    col_w = size // 4
    for col, (count, alpha_range) in enumerate([(900, (150, 255)), (450, (120, 240)), (140, (90, 220)), (40, (120, 230))]):
        for _ in range(count):
            x0 = col * col_w + rng.uniform(2, col_w - 2)
            sway = rng.uniform(-6, 6)
            top = rng.uniform(0, 0.1) * size
            bottom = size - rng.uniform(0, 0.25 if col >= 2 else 0.05) * size
            shade = rng.uniform(0.55, 1.6)
            c = linear_to_srgb(np.clip(base * shade + rng.uniform(0, 0.012), 0, 1))
            alpha = int(rng.uniform(*alpha_range))
            pts = []
            for t in np.linspace(0, 1, 12):
                y = top + (bottom - top) * t
                x = x0 + sway * np.sin(t * np.pi * rng.uniform(0.5, 1.5))
                pts.append((x, y))
            width = 1 if col < 3 else 2
            d.line(pts, fill=tuple(int(v * 255) for v in c) + (alpha,), width=width)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    # Taper the alpha at the card tips.
    a = np.asarray(img, dtype=np.float64)
    ys = np.linspace(0, 1, size)[:, None]
    a[..., 3] *= np.clip((1 - ys) / 0.18, 0, 1) * np.clip(ys / 0.03, 0, 1)
    path = os.path.join(GENERATED, out_name)
    Image.fromarray(a.astype(np.uint8), "RGBA").save(path)
    return path


def _temple(d, cx, base_y, scale, fill, outline=None):
    """Draw an Angkor-style temple silhouette: five lotus-bud towers on stepped galleries."""
    s = scale

    def tower(x, height, width):
        # Stacked tiers narrowing to a lotus bud.
        tiers = 7
        y = base_y - 0.30 * s
        for i in range(tiers):
            w = width * (1 - i / (tiers + 1.5))
            h = height / tiers
            d.polygon([(x - w, y), (x + w, y), (x + w * 0.86, y - h), (x - w * 0.86, y - h)], fill=fill)
            y -= h * 0.92
        d.polygon([(x - width * 0.18, y), (x + width * 0.18, y), (x, y - height * 0.22)], fill=fill)

    # Galleries and steps.
    for i, (w, h) in enumerate([(1.0, 0.1), (0.86, 0.09), (0.7, 0.08), (0.5, 0.06)]):
        y0 = base_y - sum(hh for _, hh in [(1.0, 0.1), (0.86, 0.09), (0.7, 0.08), (0.5, 0.06)][:i]) * s
        d.rectangle([cx - w * s, y0 - h * s, cx + w * s, y0], fill=fill)
    # Gallery colonnade gaps.
    if outline:
        for k in range(-8, 9):
            x = cx + k * 0.1 * s
            d.rectangle([x - 0.018 * s, base_y - 0.085 * s, x + 0.018 * s, base_y - 0.02 * s], fill=outline)
    tower(cx, 0.62 * s, 0.17 * s)
    for dx, hh, ww in ((0.3, 0.42, 0.12), (0.58, 0.34, 0.1)):
        tower(cx - dx * s, hh * s, ww * s)
        tower(cx + dx * s, hh * s, ww * s)


def angkor_print(color_hex, out_name, size=512, outline_hex=None):
    """An original Angkor-style line print with transparent background (chest graphic)."""
    Image, ImageDraw, ImageFilter = _pil()
    big = size * 2
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rgb = tuple(int(v * 255) for v in hex_srgb(color_hex))
    _temple(d, big / 2, big * 0.86, big * 0.44, rgb + (255,), (0, 0, 0, 0))
    # Ground line.
    d.rectangle([big * 0.1, big * 0.875, big * 0.9, big * 0.885], fill=rgb + (255,))
    # Fabric print look: slightly worn.
    a = np.asarray(img, dtype=np.float64)
    rng = np.random.default_rng(7)
    a[..., 3] *= 0.82 + 0.18 * rng.random(a.shape[:2])
    img = Image.fromarray(a.astype(np.uint8), "RGBA").resize((size, size), Image.LANCZOS)
    path = os.path.join(GENERATED, out_name)
    img.save(path)
    return path


def flag_patch(out_name, w=512, h=336):
    """Cambodian flag as an embroidered patch (blue-red-blue, white Angkor Wat, stitched edge)."""
    Image, ImageDraw, ImageFilter = _pil()
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    blue, red, white = (3, 46, 161, 255), (224, 0, 37, 255), (250, 250, 250, 255)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=18, fill=(245, 245, 245, 255))
    m = 12
    d.rounded_rectangle([m, m, w - 1 - m, h - 1 - m], radius=10, fill=blue)
    band = (h - 2 * m) / 4
    d.rectangle([m, m + band, w - 1 - m, h - 1 - m - band], fill=red)
    _temple(d, w / 2, m + band * 3 - band * 0.12, band * 1.15, white, red)
    # Stitched border.
    for x in range(m, w - m, 14):
        d.line([(x, m // 2 + 1), (x + 7, m // 2 + 1)], fill=(200, 200, 205, 255), width=3)
        d.line([(x, h - m // 2 - 2), (x + 7, h - m // 2 - 2)], fill=(200, 200, 205, 255), width=3)
    path = os.path.join(GENERATED, out_name)
    img.filter(ImageFilter.SMOOTH).save(path)
    return path


def watch_face(color_hex, out_name, size=256):
    Image, ImageDraw, ImageFilter = _pil()
    img = Image.new("RGB", (size, size), (6, 6, 10))
    d = ImageDraw.Draw(img)
    c = tuple(int(v * 255) for v in hex_srgb(color_hex))
    for r in range(int(size * 0.42), int(size * 0.2), -6):
        k = r / (size * 0.42)
        d.ellipse([size / 2 - r, size / 2 - r * 1.2, size / 2 + r, size / 2 + r * 1.2],
                  outline=tuple(int(v * (1.1 - k)) for v in c), width=3)
    _temple(d, size / 2, size * 0.66, size * 0.22, c + (255,) if False else c)
    path = os.path.join(GENERATED, out_name)
    img.filter(ImageFilter.SMOOTH).save(path)
    return path


def fabric_normal(out_name, size=512, scale=48, strength=0.35, seed=5):
    """Tileable fine knit normal map (subtle) so flat-colour fabric does not look like plastic."""
    Image, _, ImageFilter = _pil()
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size] / size
    h = 0.5 * np.sin(2 * np.pi * scale * x) * np.sin(2 * np.pi * scale * 2 * y)
    noise = rng.random((size // 8, size // 8))
    noise = np.asarray(Image.fromarray((noise * 255).astype(np.uint8)).resize((size, size), Image.BICUBIC)) / 255
    h = h * 0.35 + noise * 0.65
    gy, gx = np.gradient(h)
    n = np.dstack([-gx * strength * size / 8, -gy * strength * size / 8, np.ones_like(h)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    img = Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8), "RGB")
    path = os.path.join(GENERATED, out_name)
    img.save(path)
    return path


# ── Materials ────────────────────────────────────────────────────────────────────────────


def _principled(name):
    m = bpy.data.materials.get(name)
    if m:
        bpy.data.materials.remove(m)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes.get("Principled BSDF")
    return m, nt, p


def _image_node(nt, image, location=(-500, 300)):
    node = nt.nodes.new("ShaderNodeTexImage")
    node.image = image
    node.location = location
    return node


def _normal_map(nt, p, image, strength=1.0, uv_scale=None):
    tex = _image_node(nt, image, (-700, -300))
    tex.image.colorspace_settings.name = "Non-Color"
    if uv_scale:
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Scale"].default_value = (uv_scale, uv_scale, 1)
        uv = nt.nodes.new("ShaderNodeTexCoord")
        nt.links.new(uv.outputs["UV"], mapping.inputs["Vector"])
        nt.links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.inputs["Strength"].default_value = strength
    nt.links.new(tex.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])


def textured(name, image_path, *, roughness=0.5, metallic=0.0, alpha=None, normal=None,
             normal_strength=1.0, specular=0.5, double_sided=False, emission=None):
    """Base-colour texture material. `alpha` = 'CLIP' or 'BLEND' uses the texture's alpha."""
    m, nt, p = _principled(name)
    img = load_image(image_path, alpha=bool(alpha))
    tex = _image_node(nt, img)
    nt.links.new(tex.outputs["Color"], p.inputs["Base Color"])
    if alpha == "CLIP":
        # Blender 4.2+ glTF export: Alpha through Math(Round) = alphaMode MASK, cutoff 0.5.
        rnd = nt.nodes.new("ShaderNodeMath")
        rnd.operation = "ROUND"
        nt.links.new(tex.outputs["Alpha"], rnd.inputs[0])
        nt.links.new(rnd.outputs["Value"], p.inputs["Alpha"])
    elif alpha:
        nt.links.new(tex.outputs["Alpha"], p.inputs["Alpha"])
    if alpha:
        m.blend_method = "HASHED" if alpha == "CLIP" else "BLEND"
        m.surface_render_method = "DITHERED" if alpha == "CLIP" else "BLENDED"
        m["gltf_alpha"] = alpha
    p.inputs["Roughness"].default_value = roughness
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Specular IOR Level"].default_value = specular
    if emission:
        nt.links.new(tex.outputs["Color"], p.inputs["Emission Color"])
        p.inputs["Emission Strength"].default_value = emission
    if normal:
        _normal_map(nt, p, load_image(normal, colorspace="Non-Color", alpha=False), normal_strength)
    m.use_backface_culling = not double_sided
    return m


def flat(name, color_hex, *, roughness=0.6, metallic=0.0, specular=0.5, emission=0.0,
         normal=None, normal_strength=0.6, normal_scale=1.0, sheen=0.0, coat=0.0, double_sided=False):
    """Plain colour material (fabric, plastic, metal), optional tiled fabric normal map."""
    m, nt, p = _principled(name)
    c = hex_rgba(color_hex)
    p.inputs["Base Color"].default_value = c
    p.inputs["Roughness"].default_value = roughness
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Specular IOR Level"].default_value = specular
    if sheen:
        p.inputs["Sheen Weight"].default_value = sheen
    if coat:
        p.inputs["Coat Weight"].default_value = coat
    if emission:
        p.inputs["Emission Color"].default_value = c
        p.inputs["Emission Strength"].default_value = emission
    if normal:
        _normal_map(nt, p, load_image(normal, colorspace="Non-Color", alpha=False), normal_strength, normal_scale)
    m.diffuse_color = c
    m.use_backface_culling = not double_sided
    return m


def read_mhmat(path):
    """Texture entries of a MakeHuman .mhmat, as absolute paths."""
    out = {}
    base = os.path.dirname(path)
    with open(path) as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 2 and parts[0].endswith("Texture"):
                out[parts[0]] = os.path.join(base, os.path.basename(parts[1]))
    return out


def mhmat_texture(obj, key="diffuseTexture"):
    """Texture used by an MPFB-imported MakeHuman asset (from its material's image nodes)."""
    for slot in obj.material_slots:
        if slot.material and slot.material.node_tree:
            for n in slot.material.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image:
                    label = (n.label + n.name).lower()
                    want = {"diffuseTexture": "diffuse", "normalmapTexture": "normal"}[key]
                    if want in label or (want == "diffuse" and "color" in label):
                        return bpy.path.abspath(n.image.filepath)
    return None


def asset_textures(obj):
    """Every image file an MPFB asset material references (diffuse first)."""
    paths = []
    for slot in obj.material_slots:
        if slot.material and slot.material.node_tree:
            for n in slot.material.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image:
                    paths.append((n.name, n.label, bpy.path.abspath(n.image.filepath)))
    return paths


def replace_material(obj, material):
    obj.data.materials.clear()
    obj.data.materials.append(material)

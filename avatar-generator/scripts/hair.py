"""Procedural hair cards on top of a MakeHuman base hair (which covers the scalp).

* `short_messy` (male): ~380 tousled cards, long on top, a fringe falling over the forehead and
  stopping above the brows, short sides and back.
* `messy_bun` (female): the ponytail01 base without its tail, strands pulled up to a high
  loose bun built from wrapped cards, see-through bangs and face-framing wisps.

Cards are ribbons that lie tangent to the head, textured with the generated strand texture
(4 density columns, see setup_materials.hair_strand_texture) and alpha-clipped. They are skinned
100 % to the Head bone. Everything is seeded, so builds are repeatable.
"""

from common import *
import setup_materials as mats

COLUMNS = {"dense": (0.0, 0.25), "medium": (0.25, 0.5), "wisp": (0.5, 0.75), "single": (0.75, 1.0)}


class Head:
    """Sphere fit of the scalp plus a BVH of the body for strand collision."""

    def __init__(self, body):
        scalp = group_weights(body, "scalp") > 0.5
        co = coords(body)
        pts = co[scalp]
        # Algebraic sphere fit: |p|^2 = 2 c·p + (r^2 - |c|^2)
        A = np.hstack([2 * pts, np.ones((len(pts), 1))])
        b = (pts ** 2).sum(1)
        sol, *_ = np.linalg.lstsq(A, b, rcond=None)
        self.center = Vector(sol[:3])
        self.radius = math.sqrt(sol[3] + self.center.length_squared)
        self.top = pts[:, 2].max()
        self.scalp_mask = scalp
        self.body = body
        self.tree = bvh(body)
        faces = [p for p in body.data.polygons if all(scalp[i] for i in p.vertices)]
        self.tris = []
        for p in faces:
            vs = [co[i] for i in p.vertices]
            for k in range(1, len(vs) - 1):
                self.tris.append((vs[0], vs[k], vs[k + 1]))
        self.tris = np.array(self.tris)
        e1 = self.tris[:, 1] - self.tris[:, 0]
        e2 = self.tris[:, 2] - self.tris[:, 0]
        cr = np.cross(e1, e2)
        self.area = np.linalg.norm(cr, axis=1) / 2
        self.tri_n = cr / np.maximum(np.linalg.norm(cr, axis=1, keepdims=True), 1e-12)

    def sample(self, n, rng, where=None):
        """Area-weighted random scalp points (and normals), optionally filtered by `where(p, u)`."""
        out = []
        prob = self.area / self.area.sum()
        while len(out) < n:
            idx = rng.choice(len(self.tris), size=n * 2, p=prob)
            r1, r2 = rng.random(n * 2), rng.random(n * 2)
            s = np.sqrt(r1)
            for k, i in enumerate(idx):
                a, b, c = self.tris[i]
                p = Vector((1 - s[k]) * a + s[k] * (1 - r2[k]) * b + s[k] * r2[k] * c)
                nrm = Vector(self.tri_n[i])
                if nrm.dot(p - self.center) < 0:
                    nrm = -nrm
                u = (p - self.center).normalized()
                if where is None or where(p, u):
                    out.append((p, nrm))
                    if len(out) >= n:
                        break
        return out

    def push_out(self, p, min_offset, max_offset=None):
        """Keep `p` in the shell `min_offset`..`max_offset` above the skin."""
        hit, nrm, _, dist = self.tree.find_nearest(p)
        if hit is None:
            return p
        outward = (p - hit)
        if outward.dot(nrm) < 0 or dist < min_offset:
            return hit + nrm * min_offset
        if max_offset is not None and dist > max_offset:
            return hit + outward.normalized() * max_offset
        return p


def ribbon(points, widths, normals, column, rng, twist=0.0):
    """Vertices, faces and UVs of one card along `points` (root first)."""
    u0, u1 = COLUMNS[column]
    span = (u1 - u0) * rng.uniform(0.35, 0.6)
    ua = rng.uniform(u0, u1 - span)
    verts, uvs = [], []
    n = len(points)
    for i, p in enumerate(points):
        if i < n - 1:
            t = (points[i + 1] - p).normalized()
        else:
            t = (p - points[i - 1]).normalized()
        side = t.cross(normals[i]).normalized()
        if twist:
            side = (side * math.cos(twist * i / n) + normals[i] * math.sin(twist * i / n)).normalized()
        w = widths[i] / 2
        verts += [p - side * w, p + side * w]
        v = 0.97 - 0.96 * i / (n - 1)
        uvs += [(ua, v), (ua + span, v)]
    faces = [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(n - 1)]
    return verts, faces, uvs


def build_cards(name, cards, material):
    verts, faces, uvs = [], [], []
    for v, f, uv in cards:
        base = len(verts)
        verts += v
        uvs += uv
        faces += [tuple(base + i for i in face) for face in f]
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    uv_layer = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li in poly.loop_indices:
            uv_layer.data[li].uv = uvs[me.loops[li].vertex_index]
    me.materials.append(material)
    obj = link(bpy.data.objects.new(name, me))
    set_smooth(obj)
    return obj


def grow(head, root, normal, flow, length, rng, *, segments=7, lift=0.6, gravity=0.15, curl=0.25,
         min_offset=0.016, max_offset=None, floor_z=None):
    """Integrate one strand from `root`; returns its points (root first)."""
    seg = length / segments
    tangent = (flow - normal * flow.dot(normal)).normalized()
    d = (normal * lift + tangent).normalized()
    pts = [head.push_out(root + normal * min_offset * 0.6, min_offset * 0.6)]
    phase = rng.uniform(0, math.tau)
    for i in range(segments):
        wobble = Vector((math.sin(phase + i * 1.3), math.cos(phase * 1.7 + i), math.sin(phase * 0.6 - i * 0.8)))
        d = (d * 0.62 + tangent * 0.38 + Vector((0, 0, -gravity)) + wobble * curl * 0.3).normalized()
        nxt = head.push_out(pts[-1] + d * seg, min_offset, max_offset)
        d = (nxt - pts[-1]).normalized() if (nxt - pts[-1]).length > 1e-6 else d
        if floor_z is not None and nxt.z < floor_z:
            break
        # Re-aim the tangent along the head so long strands keep hugging it.
        radial = (nxt - head.center).normalized()
        tangent = (tangent - radial * tangent.dot(radial)).normalized() if tangent.length > 1e-6 else tangent
        pts.append(nxt)
    return pts


def card_normals(head, pts):
    return [(p - head.center).normalized() for p in pts]


# ── Styles ───────────────────────────────────────────────────────────────────────────────


def short_messy(spec, body, head, material, brow_z, rng):
    cards = []
    down, fwd = Vector((0, 0, -1)), Vector((0, -1, 0))
    for root, nrm in head.sample(720, rng):
        u = (root - head.center).normalized()
        top = float(smoothstep(0.45, 0.9, u.z))
        front = float(smoothstep(-0.15, -0.65, u.y))
        back = float(smoothstep(0.1, 0.6, u.y))
        side = Vector((math.copysign(1, u.x), 0, 0))
        flow = fwd * (1.0 * front + 0.55 * top) + down * (1.0 - 0.75 * top) + side * 0.25 * (1 - top) + Vector((0, 0.3 * back, 0))
        # A loose side sweep of the fringe toward the character's right.
        flow += Vector((-0.35 * front, 0, 0))
        flow = flow.normalized()
        ang = rng.normal(0, 0.45)
        flow = (flow * math.cos(ang) + nrm.cross(flow) * math.sin(ang)).normalized()
        length = (0.04 + 0.07 * max(top, 0.95 * front)) * rng.uniform(0.8, 1.2)
        lift = 0.25 + 0.75 * top
        inner = 0.013 + 0.006 * top
        pts = grow(head, root, nrm, flow, length, rng, lift=lift, gravity=0.12 + 0.2 * front, curl=0.45,
                   min_offset=inner, max_offset=inner + rng.uniform(0.004, 0.014) + 0.012 * top,
                   floor_z=brow_z + 0.012)
        if len(pts) < 3:
            continue
        w = rng.uniform(0.008, 0.015) * (1 + 0.3 * top)
        widths = [w * (1 - 0.7 * i / (len(pts) - 1)) for i in range(len(pts))]
        column = "dense" if rng.random() < 0.4 else ("medium" if rng.random() < 0.65 else "wisp")
        cards.append(ribbon(pts, widths, card_normals(head, pts), column, rng, twist=rng.normal(0, 0.5)))
    return [build_cards(f"{spec['name']}.hair_cards", cards, material)]


def remove_tail(hair, head, keep_within=0.03):
    """Drop the ponytail and anything below the natural hairline: keep base-hair vertices that
    lie within `keep_within` of the skin over the scalp (MakeHuman's `scalp` group)."""
    from mathutils.kdtree import KDTree

    body_co = coords(head.body)
    kd = KDTree(len(body_co))
    for i, p in enumerate(body_co):
        kd.insert(Vector(p), i)
    kd.balance()
    co = coords(hair)
    keep = np.zeros(len(co), dtype=bool)
    for i, p in enumerate(co):
        _, idx, dist = kd.find(Vector(p))
        keep[i] = dist < keep_within and head.scalp_mask[idx]
    keep_faces(hair, face_vertex_all(hair, keep))


def messy_bun(spec, body, head, material, brow_z, rng):
    cards = []
    up = Vector((0, 0, 1))
    # Bun on the crown, slightly back: the scalp point in that direction plus its radius.
    direction = Vector((0, 0.55, 1)).normalized()
    hit, nrm, _, _ = head.tree.ray_cast(head.center + direction * 0.5, -direction)
    bun_r = 0.05
    bun_c = hit + nrm * (bun_r * 0.85)
    axis = (nrm + Vector((0, -0.25, 0))).normalized()

    # 1) Wrapped loops: partial circles around the bun axis at several radii and tilts.
    a1 = axis.orthogonal().normalized()
    a2 = axis.cross(a1).normalized()
    for k in range(70):
        r = bun_r * rng.uniform(0.45, 1.05)
        h = rng.uniform(-0.55, 0.55) * bun_r
        tilt = rng.normal(0, 0.35)
        start = rng.uniform(0, math.tau)
        sweep = rng.uniform(0.7, 1.0) * math.tau
        n_pts = 9
        pts, nrms = [], []
        for i in range(n_pts):
            t = start + sweep * i / (n_pts - 1)
            radial = a1 * math.cos(t) + a2 * math.sin(t)
            radial = (radial * math.cos(tilt) + axis * math.sin(tilt)).normalized()
            shrink = math.sqrt(max(0.05, 1 - (h / (bun_r * 1.1)) ** 2))
            p = bun_c + axis * h + radial * r * shrink
            pts.append(p)
            nrms.append((p - bun_c).normalized())
        w = rng.uniform(0.02, 0.034)
        cards.append(ribbon(pts, [w] * n_pts, nrms, "dense" if k % 3 else "medium", rng))
    # 2) Loose ends poking out of the bun.
    for k in range(16):
        d = Vector(rng.normal(0, 1, 3)).normalized()
        if d.dot(axis) < -0.2:
            d = -d
        p0 = bun_c + d * bun_r * 0.8
        pts = [p0]
        dd = d
        for i in range(5):
            dd = (dd + Vector(rng.normal(0, 0.8, 3)) + Vector((0, 0, -0.35))).normalized()
            pts.append(pts[-1] + dd * rng.uniform(0.007, 0.012))
        nrms = [(p - bun_c).normalized() for p in pts]
        cards.append(ribbon(pts, [0.006 * (1 - 0.6 * i / 5) for i in range(6)], nrms, "single", rng))
    # 3) Strands pulled up from the hairline to the bun, hugging the head.
    for root, nrm in head.sample(170, rng, where=lambda p, u: u.z < 0.75):
        pts = [head.push_out(root + nrm * 0.008, 0.009)]
        for i in range(14):
            to_bun = bun_c - pts[-1]
            if to_bun.length < bun_r * 0.9:
                break
            step = to_bun.normalized() * min(0.022, to_bun.length)
            pts.append(head.push_out(pts[-1] + step, 0.011 + 0.002 * rng.random()))
        if len(pts) < 3:
            continue
        w = rng.uniform(0.02, 0.03)
        widths = [w * (1 - 0.3 * i / (len(pts) - 1)) for i in range(len(pts))]
        cards.append(ribbon(pts, widths, card_normals(head, pts), "dense" if rng.random() < 0.6 else "medium", rng))
    # 4) See-through bangs, parted near the middle, falling to the brows.
    for k in range(22):
        x = rng.uniform(-0.055, 0.055)
        root_dir = Vector((x * 6, -1.0, 0.95)).normalized()
        hit, nrm, _, _ = head.tree.ray_cast(head.center + root_dir * 0.4, -root_dir)
        if hit is None:
            continue
        flow = Vector((math.copysign(0.45, x) + rng.normal(0, 0.15), -0.35, -1)).normalized()
        pts = grow(head, hit, nrm, flow, rng.uniform(0.075, 0.1), rng, segments=7, lift=0.35, gravity=0.3,
                   curl=0.35, min_offset=0.012, floor_z=brow_z + 0.002)
        if len(pts) < 3:
            continue
        widths = [0.011 * (1 - 0.6 * i / (len(pts) - 1)) for i in range(len(pts))]
        cards.append(ribbon(pts, widths, card_normals(head, pts), "wisp", rng))
    # 5) Face-framing wisps from the temples down past the cheeks, softly waved.
    for sx in (-1, 1):
        for k in range(4):
            root_dir = Vector((sx * 0.85, -0.55 - 0.1 * k, 0.25 + 0.06 * k)).normalized()
            hit, nrm, _, _ = head.tree.ray_cast(head.center + root_dir * 0.4, -root_dir)
            if hit is None:
                continue
            pts = [hit + nrm * 0.012]
            length = rng.uniform(0.11, 0.15)
            for i in range(10):
                wave = math.sin(i * 0.9 + k) * 0.35
                d = Vector((sx * (0.12 + wave * 0.25), -0.18, -1)).normalized()
                pts.append(head.push_out(pts[-1] + d * length / 10, 0.012))
            widths = [0.008 * (1 - 0.55 * i / 10) for i in range(11)]
            nrms = [Vector((sx, -0.6, 0)).normalized()] * len(pts)
            cards.append(ribbon(pts, widths, nrms, "wisp" if k else "medium", rng))
    return [build_cards(f"{spec['name']}.hair_cards", cards, material)]


STYLES = {"short_messy": short_messy, "messy_bun": messy_bun}


def build_hair(spec, body, rig, parts):
    """Add the style's cards; returns the new hair objects (skinned to the Head bone)."""
    rng = np.random.default_rng(11 if spec["name"] == "male" else 23)
    head = Head(body)
    brow_z = float(coords(parts["eyebrows"])[:, 2].mean())
    style = spec["hair"]["style"]
    if style == "messy_bun":
        remove_tail(parts["hair"], head)
    color = spec["hair"]["color"]
    tex = mats.hair_strand_texture(color, f"{spec['name']}_strands.png")
    material = mats.textured("HairCards", tex, roughness=0.62, alpha="CLIP", double_sided=True, specular=0.28)
    objs = STYLES[style](spec, body, head, material, brow_z, rng)
    for o in objs:
        rigid_bind(o, rig, "mixamorig:Head")
        log(spec["name"], o.name, "cards tris", sum(len(p.vertices) - 2 for p in o.data.polygons))
    return objs

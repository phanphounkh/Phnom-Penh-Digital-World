"""More garments for the in-game wardrobe, tailored from the body like the original outfit.

* `tee`     crew-neck t-shirt: short sleeves to mid upper arm, untucked straight hem.
* `shirt`   short-sleeved button shirt: boxy, fold-down collar, front placket with buttons.
* `jeans`   slim straight jeans: waistband, belt loops, back pockets, a copper button, hems.
* `shorts`  knee-length chino shorts.
* `sandals` flip-flops: a sole under each foot and a Y strap from between the toes.
* `cap`, `bucket`  hats over the hair, rigid on the head (the hair on top hides under them).

Each returns (parts, covered) like the originals: the objects, and the body vertices the garment
covers (used to keep only skin some choice can show; see outfits.py).
"""

from common import *
import garments as G
from garments import B, arm_param, band, noise3, shell, trim_edges, patch


# ── Tops ────────────────────────────────────────────────────────────────────────────────


def _top_keep(L, Wt, co, *, hem_z, neckline, sleeve_end):
    t_arm, d_arm = arm_param(L, co)
    keep = (co[:, 2] > hem_z) & (co[:, 2] < neckline) & (Wt.head + Wt.hands < 0.3)
    keep &= ~((d_arm < 0.13) & (t_arm > sleeve_end))
    keep &= ~((Wt.legs > 0.5) & (co[:, 2] < hem_z + 0.02))
    return keep


def _crew_neckline(L, co, depth):
    """A neckline round the neck that dips `depth` at the front centre."""
    front = smoothstep(0.0, -0.09, co[:, 1] - L.neck.y)
    return L.neck.z - 0.012 - depth * front * smoothstep(0.08, 0.0, np.abs(co[:, 0]))


def _hem_bands(name, g, L, M_hem, M_cuff, M_neck, hem_z, radii=(0.006, 0.005, 0.007)):
    parts = []
    gco = coords(g)
    shoulder_z = L.shoulder["Left"].z
    for i, (loop, closed) in enumerate(G.boundary_loops(g, with_closed=True)):
        pts = gco[loop]
        z = pts[:, 2].mean()
        if z < hem_z + 0.06:
            parts.append(band(f"{name}_hem", pts, radii[0], M_hem, closed=closed))
        elif z > shoulder_z:
            if M_neck is not None:
                parts.append(band(f"{name}_neck", pts, radii[2], M_neck, closed=closed))
        else:
            parts.append(band(f"{name}_sleeve{i}", pts, radii[1], M_cuff, closed=closed))
    return parts


def even_neckline(g, L, depth, out_of=None):
    """A clean neckline: cut the top along a plane tilted from just under the back of the neck to
    `depth` below it at the front (a crew neck is close to planar), only round the neck, so the
    edge no longer follows the body's face rows."""
    import bmesh

    n = L.neck
    back = Vector((0, n.y + 0.07, n.z - 0.004))
    front = Vector((0, n.y - 0.09, n.z - 0.006 - depth))
    normal = (front - back).cross(Vector((1, 0, 0))).normalized()
    if normal.z < 0:
        normal = -normal
    bm = bmesh.new()
    bm.from_mesh(g.data)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=back, plane_no=normal)
    gone = [f for f in bm.faces if (f.calc_center_median() - back).dot(normal) > 1e-5
            and abs(f.calc_center_median().x) < 0.14 and f.calc_center_median().z > L.spine2.z]
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bm.to_mesh(g.data)
    bm.free()
    g.data.update()


def tee(spec, body, L, Wt, M, co, below, *, tree=None):
    name = spec["name"]
    female = name == "female"
    hem_z = L.hips.z - (0.06 if female else 0.09)
    sleeve_end = 0.36 if female else 0.4
    # Up the neck at first: the neckline is then cut cleanly along a plane (even_neckline).
    keep = _top_keep(L, Wt, co, hem_z=hem_z, neckline=np.full(len(co), L.neck.z + 0.015), sleeve_end=sleeve_end)

    def offset(p):
        t, d = arm_param(L, p)
        arm = (d < 0.09) & (t > 0.08)
        torso = 0.008 + 0.012 * smoothstep(L.spine2.z, hem_z + 0.05, p[:, 2])
        sleeve = 0.012 + 0.012 * smoothstep(0.1, sleeve_end, t)
        return np.where(arm, sleeve, torso)

    def folds(p):
        t, d = arm_param(L, p)
        arm = (d < 0.09) & (t > 0.08)
        drape = noise3(p, 3.5, 21) * 0.0035
        sleeve = np.sin(t * math.tau / 0.06 + noise3(p, 7, 22) * 2) * 0.002
        return np.where(arm, sleeve, drape)

    g = shell(body, f"{name}.tee", keep, offset, folds=folds, material=M["tee"], below=below, smooth=40, tree=tree)
    even_neckline(g, L, 0.045, tree or bvh(body))
    parts = [g] + _hem_bands(f"{name}.tee", g, L, M["tee"], M["tee"], M["tee_rib"], hem_z)
    return parts, keep, hem_z


def shirt(spec, body, L, Wt, M, co, below, *, tree=None):
    """Short-sleeved button shirt, worn untucked, buttoned to the top."""
    name = spec["name"]
    female = name == "female"
    hem_z = L.hips.z - (0.07 if female else 0.1)
    sleeve_end = 0.4 if female else 0.44
    keep = _top_keep(L, Wt, co, hem_z=hem_z, neckline=np.full(len(co), L.neck.z + 0.015), sleeve_end=sleeve_end)

    def offset(p):
        t, d = arm_param(L, p)
        arm = (d < 0.09) & (t > 0.08)
        torso = 0.014 + 0.014 * smoothstep(L.spine2.z + 0.05, hem_z + 0.08, p[:, 2])
        sleeve = 0.02 + 0.006 * smoothstep(0.1, sleeve_end, t)
        return np.where(arm, sleeve, torso)

    def folds(p):
        t, d = arm_param(L, p)
        arm = (d < 0.09) & (t > 0.08)
        drape = noise3(p, 3.0, 31) * 0.004 + noise3(p, 7, 32) * 0.0012
        return np.where(arm, noise3(p, 6, 33) * 0.002, drape)

    g = shell(body, f"{name}.shirt", keep, offset, folds=folds, material=M["shirt"], below=below, smooth=40,
              clearance=0.008, tree=tree)
    even_neckline(g, L, 0.03, tree or bvh(body))
    parts = [g] + _hem_bands(f"{name}.shirt", g, L, M["shirt"], M["shirt"], None, hem_z, radii=(0.005, 0.006, 0))
    gtree = bvh(g)

    def on_shirt(x, z, out=0.002):
        hit, nrm, _, _ = gtree.ray_cast(Vector((x, -1.0, z)), Vector((0, 1, 0)))
        return (hit + nrm * out, nrm) if hit is not None else (None, None)

    # Placket down the front centre, with buttons.
    top_z = L.neck.z - 0.03
    pts, nrms = [], []
    for z in np.linspace(hem_z + 0.012, top_z, 14):
        p, n = on_shirt(0.0, float(z))
        if p is not None:
            pts.append(p)
            nrms.append(n)
    if len(pts) > 3:
        import accessories as A

        parts.append(A.strip(f"{name}.shirt_placket", pts, nrms, 0.026, 0.003, M["shirt"]))
        for k, z in enumerate(np.linspace(hem_z + 0.06, top_z - 0.01, 6)):
            p, n = on_shirt(0.0, float(z), out=0.0045)
            if p is None:
                continue
            bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.0055, depth=0.0025, location=p)
            btn = bpy.context.object
            btn.name = btn.data.name = f"{name}.shirt_button{k}"
            btn.rotation_euler = Vector((0, 0, 1)).rotation_difference(n).to_euler()
            assign_material(btn, M["button"])
            parts.append(btn)
    parts += shirt_collar(spec, g, L, M)
    return parts, keep, hem_z


def shirt_collar(spec, g, L, M):
    """A fold-down collar: a band lying round the neckline, its two points falling at the front."""
    import accessories as A

    name = spec["name"]
    gco = coords(g)
    loops = [loop for loop in G.boundary_loops(g) if gco[loop][:, 2].mean() > L.shoulder["Left"].z]
    if not loops:
        return []
    neck = gco[max(loops, key=lambda lp: gco[lp][:, 2].mean())]
    c = neck.mean(axis=0)
    # Order round the neck starting at the front centre, so the collar opens there.
    ang = np.arctan2(neck[:, 0] - c[0], -(neck[:, 1] - c[1]))
    order = np.argsort(np.where(ang < 0, ang + math.tau, ang))
    ring = neck[order]
    tree = bvh(g)
    pts, nrms = [], []
    n = len(ring)
    for i in range(n + 1):
        p = Vector(ring[i % n])
        out = (p - Vector(c)).normalized()
        out.z = 0.0
        out.normalize()
        # Lie on the shoulders: a little below and outside the neckline.
        q = p + out * 0.016 + Vector((0, 0, -0.012))
        hit, nrm, _, _ = tree.ray_cast(q + out * 0.08 + Vector((0, 0, 0.03)), (-(out * 0.08 + Vector((0, 0, 0.03)))).normalized())
        if hit is not None:
            q, nn = hit + nrm * 0.004, nrm
        else:
            nn = (out + Vector((0, 0, 0.6))).normalized()
        pts.append(q)
        nrms.append(nn)
    # Collar points: extend both front ends down and out.
    for end, sx in ((0, 1), (-1, -1)):
        p, nn = pts[end], nrms[end]
        tip = p + Vector((sx * 0.012, -0.006, -0.04))
        if end == 0:
            pts.insert(0, tip)
            nrms.insert(0, nn)
        else:
            pts.append(tip)
            nrms.append(nn)
    return [A.strip(f"{name}.shirt_collar", pts, nrms, 0.04, 0.004, M["shirt"])]


# ── Bottoms ─────────────────────────────────────────────────────────────────────────────


def _pants_keep(L, Wt, co, waist_z, hem_z):
    t_arm, d_arm = arm_param(L, co)
    keep = (co[:, 2] < waist_z) & (co[:, 2] > hem_z) & (Wt.arms + Wt.hands < 0.3) & (Wt.feet < 0.5)
    keep &= ~((d_arm < 0.1) & (t_arm > 0.3))
    return keep


def jeans(spec, body, L, Wt, M, co, *, tree=None):
    name = spec["name"]
    waist_z = (L.hips.z + L.spine.z) / 2 + 0.005
    ankle_z = min(L.ankle["Left"].z, L.ankle["Right"].z)
    hem_z = ankle_z + 0.03
    knee_z = L.knee["Left"].z
    keep = _pants_keep(L, Wt, co, waist_z, hem_z)

    def offset(p):
        z = p[:, 2]
        ease = 0.007 + 0.012 * smoothstep(knee_z + 0.12, hem_z + 0.05, z)  # straight leg: room below the knee
        seat = 0.004 * np.exp(-((z - (L.hips.z - 0.06)) / 0.08) ** 2)
        waist = smoothstep(waist_z - 0.005, waist_z - 0.05, z)
        return (ease + seat) * (0.5 + 0.5 * waist)

    def folds(p):
        z = p[:, 2]
        knee = np.sin((z - knee_z) * math.tau / 0.045 + noise3(p, 5, 41)) * 0.0018 * np.exp(-((z - knee_z) / 0.08) ** 2)
        stack = np.sin((z - hem_z) * math.tau / 0.04 + noise3(p, 6, 42) * 1.5) * 0.0025 * np.exp(-((z - hem_z) / 0.09) ** 2)
        return knee + stack + noise3(p, 4, 43) * 0.0015

    g = shell(body, f"{name}.jeans", keep, offset, folds=folds, material=M["jeans"], smooth=24, tree=tree)
    parts = [g]
    gco = coords(g)
    for i, (loop, closed) in enumerate(G.boundary_loops(g, with_closed=True)):
        pts = gco[loop]
        top = pts[:, 2].mean() > (waist_z + hem_z) / 2
        parts.append(band(f"{name}.jeans_{'waistband' if top else 'hem'}{i}", pts, 0.011 if top else 0.0055,
                          M["jeans"], closed=closed))
    gtree = bvh(g)
    # Belt loops, the button, and two back pockets with orange stitching.
    band_z = waist_z - 0.012
    for k, a in enumerate(np.radians([-150, -100, -40, 40, 100, 150, 180])):
        d = Vector((math.sin(a), math.cos(a), 0))  # a = 0 at the back (+Y), the front is ±180
        hit, nrm, _, _ = gtree.ray_cast(Vector((0, L.hips.y, band_z)) + d * 0.5, -d)
        if hit is None:
            continue
        pts = [hit + nrm * 0.011 + Vector((0, 0, dz)) for dz in (-0.018, 0.0, 0.016)]
        loop = curve_tube(f"{name}.jeans_loop{k}", pts, 0.0028, resolution=1, bevel_resolution=0)
        assign_material(loop, M["jeans"])
        parts.append(loop)
    hit, nrm, _, _ = gtree.ray_cast(Vector((0, -1.0, band_z)), Vector((0, 1, 0)))
    if hit is not None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.007, depth=0.004, location=hit + nrm * 0.013)
        btn = bpy.context.object
        btn.name = btn.data.name = f"{name}.jeans_button"
        btn.rotation_euler = Vector((0, 0, 1)).rotation_difference(nrm).to_euler()
        assign_material(btn, M["rivet"])
        parts.append(btn)
    fc = face_centers(g)
    fn = np.array([p.normal[:] for p in g.data.polygons])
    for side in ("Left", "Right"):
        sx = 1 if side == "Left" else -1
        zc = L.hips.z - 0.06
        sel = (np.abs(fc[:, 2] - zc) < 0.06) & (fn[:, 1] > 0.6) & (fc[:, 0] * sx > 0.03) & (fc[:, 0] * sx < 0.15)
        if sel.sum() < 4:
            continue
        pocket = patch(g, f"{name}.jeans_pocket_{side}", sel, 0.004, M["jeans"])
        parts.append(pocket)
        parts += trim_edges(pocket, f"{name}.jeans_stitch_{side}", 0.0016, M["stitch"])
    return parts, keep, hem_z


def shorts(spec, body, L, Wt, M, co, *, tree=None):
    name = spec["name"]
    female = name == "female"
    waist_z = (L.hips.z + L.spine.z) / 2 + 0.005
    knee_z = L.knee["Left"].z
    hem_z = knee_z + (0.08 if female else 0.1)
    keep = _pants_keep(L, Wt, co, waist_z, hem_z)

    def offset(p):
        z = p[:, 2]
        ease = 0.012 + 0.014 * smoothstep(waist_z - 0.15, hem_z, z)  # chinos widen to the hem
        waist = smoothstep(waist_z - 0.005, waist_z - 0.05, z)
        return ease * (0.5 + 0.5 * waist)

    def folds(p):
        return noise3(p, 4, 51) * 0.003 + noise3(p, 9, 52) * 0.001

    g = shell(body, f"{name}.shorts", keep, offset, folds=folds, material=M["shorts"], smooth=24, tree=tree)
    parts = [g]
    gco = coords(g)
    for i, (loop, closed) in enumerate(G.boundary_loops(g, with_closed=True)):
        pts = gco[loop]
        top = pts[:, 2].mean() > (waist_z + hem_z) / 2
        parts.append(band(f"{name}.shorts_{'waistband' if top else 'hem'}{i}", pts, 0.011 if top else 0.006,
                          M["shorts_rib"] if top else M["shorts"], closed=closed))
    return parts, keep, hem_z


# ── Shoes ───────────────────────────────────────────────────────────────────────────────


def _hull(pts):
    """2D convex hull (Andrew's monotone chain), counter-clockwise."""
    pts = sorted(map(tuple, pts))
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return np.array(lower[:-1] + upper[:-1])


def _resample_closed(poly, n):
    seq = np.vstack([poly, poly[:1]])
    seg = np.linalg.norm(np.diff(seq, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    t = np.linspace(0, s[-1], n, endpoint=False)
    return np.stack([np.interp(t, s, seq[:, k]) for k in range(2)], axis=1)


def sandals(spec, body, rig, L, Wt, M, co):
    """Flip-flops: a sole under each foot (the foot rests a few mm into it) and a Y strap."""
    name = spec["name"]
    ankle_z = G.L_ankle_z(rig)
    tree = bvh(body)
    parts = []
    covered = np.zeros(len(co), dtype=bool)
    for side in ("Left", "Right"):
        sx = 1 if side == "Left" else -1
        foot = (Wt.feet > 0.3) & (co[:, 0] * sx > 0) & (co[:, 2] < ankle_z)
        bottom = co[foot & (co[:, 2] < 0.03)]
        if len(bottom) < 10:
            continue
        hull = _hull(bottom[:, :2])
        cxy = hull.mean(axis=0)
        r = np.linalg.norm(hull - cxy, axis=1, keepdims=True)
        outline = _resample_closed(cxy + (hull - cxy) * (1 + 0.01 / np.maximum(r, 1e-3)), 36)
        z0, z1 = -0.002, 0.014
        verts = [(x, y, z1) for x, y in outline] + [(x, y, z0) for x, y in outline]
        n = len(outline)
        faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
        faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
        me = bpy.data.meshes.new(f"{name}.sandal_sole_{side}")
        me.from_pydata(verts, [], faces)
        me.validate()
        sole = link(bpy.data.objects.new(me.name, me))
        assign_material(sole, M["sandal_sole"])
        recompute_normals_outward(sole)
        parts.append(sole)
        covered |= foot & (co[:, 2] < 0.012)
        # The Y strap: from between the big toe and the next one, over the instep to both sides.
        y_toe, y_heel = outline[:, 1].min(), outline[:, 1].max()
        length = y_heel - y_toe
        fx = bottom[:, 0]
        inner_x = fx.min() if sx > 0 else fx.max()  # big-toe side (towards the body's middle)
        outer_x = fx.max() if sx > 0 else fx.min()
        post = Vector((inner_x + (outer_x - inner_x) * 0.3, y_toe + 0.035, 0.0))
        for end_x in (inner_x - sx * 0.002, outer_x + sx * 0.002):
            end = Vector((end_x, y_toe + 0.42 * length, 0.0))
            pts, nrms = [], []
            for t in np.linspace(0, 1, 9):
                q = post.lerp(end, t)
                hit, nrm, _, _ = tree.ray_cast(Vector((q.x, q.y, 0.25)), Vector((0, 0, -1)))
                if hit is None:
                    continue
                lift = 0.004 if 0.05 < t < 0.95 else 0.0
                p = hit + nrm * (0.002 + lift)
                if t > 0.9:  # down to the sole's edge
                    p.z = min(p.z, z1 + 0.002)
                pts.append(p)
                nrms.append(nrm)
            if len(pts) > 3:
                import accessories as A

                parts.append(A.strip(f"{name}.sandal_strap_{side}{'i' if end_x == inner_x - sx * 0.002 else 'o'}",
                                     pts, nrms, 0.013, 0.003, M["sandal_strap"]))
        hit, nrm, _, _ = tree.ray_cast(Vector((post.x, post.y, 0.25)), Vector((0, 0, -1)))
        if hit is not None:
            peg = curve_tube(f"{name}.sandal_post_{side}", [Vector((post.x, post.y, z1)), hit + nrm * 0.003], 0.0028,
                             resolution=1, bevel_resolution=1)
            assign_material(peg, M["sandal_strap"])
            parts.append(peg)
    return parts, covered


def recompute_normals_outward(obj):
    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")


# ── Hats ────────────────────────────────────────────────────────────────────────────────


class HatFrame:
    """Where a hat sits: a dome over the head and hair, cut by a plane that runs above the ears,
    a little above the brows at the front and lower at the back."""

    def __init__(self, body, parts):
        import hair as H

        head = H.Head(body)
        self.c = c = head.center
        brow_z = float(coords(parts["eyebrows"])[:, 2].mean())
        R = head.radius
        front = Vector((0, c.y - R, brow_z + 0.035))
        back = Vector((0, c.y + R, c.z - 0.035))
        n = (back - front).cross(Vector((1, 0, 0))).normalized()
        if n.z < 0:
            n = -n
        self.n, self.p0 = n, front
        # The dome encloses the scalp and the base hair (not the cards: those hide under the hat).
        pts = [coords(parts["hair"])] + [coords(body)[head.scalp_mask]]
        allp = np.vstack(pts)
        above = allp[(allp - np.array(front)) @ np.array(n) > -0.01]
        rel = above - np.array(c)
        self.rx = float(np.abs(rel[:, 0]).max()) + 0.012
        self.ry = float(np.abs(rel[:, 1]).max()) + 0.012
        self.rz = float(rel[:, 2].max()) + 0.012

    def above(self, p):
        return (np.asarray(p) - np.array(self.p0)) @ np.array(self.n)


def _dome(name, f, material, *, lift=0.0, seg=40, rings=20):
    """The crown: an ellipsoid round the head, cut along the hat plane (open at the bottom)."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, radius=1.0, location=(0, 0, 0))
    o = bpy.context.object
    o.name = o.data.name = name
    co = coords(o)
    co = co * np.array([f.rx, f.ry, f.rz + lift]) + np.array(f.c)
    set_coords(o, co)
    keep = f.above(co) > -0.004
    keep_faces(o, face_vertex_all(o, keep))
    # Snap the rim onto the plane so it ends cleanly.
    co = coords(o)
    rim = boundary_vertices(o)
    d = f.above(co)
    co[rim] -= np.outer(d[rim], np.array(f.n))
    set_coords(o, co)
    f.rim = co[rim]  # where a brim starts
    sol = o.modifiers.new("Thickness", "SOLIDIFY")
    sol.thickness = 0.004
    sol.offset = -1
    apply_modifier(o, sol.name)
    assign_material(o, material)
    set_smooth(o)
    return o


def _brim(name, f, material, *, around, width, droop, seg=48):
    """A brim along the dome's rim: `around(angle)` says where it is (0..1 of `width`), angle 0 at
    the front; it slopes down by `droop` at its outer edge."""
    # The dome's own rim, by angle round the head (0 at the front, -Y), interpolated.
    rim = np.asarray(f.rim)
    rel = rim - np.array(f.c)
    ang = np.arctan2(rel[:, 0], -rel[:, 1])
    order = np.argsort(ang)
    ang, rim = ang[order], rim[order]
    ang = np.concatenate([ang - math.tau, ang, ang + math.tau])
    rim = np.vstack([rim, rim, rim])
    rim_pts = []
    for k in range(seg + 1):
        a = -math.pi + math.tau * k / seg
        p = Vector([float(np.interp(a, ang, rim[:, j])) for j in range(3)])
        rim_pts.append((a, p, Vector((math.sin(a), -math.cos(a), 0))))
    verts, faces = [], []
    for a, p, out in rim_pts:
        w = width * around(a)
        verts += [tuple(p), tuple(p + out * w + Vector((0, 0, -droop * around(a))))]
    for k in range(seg):
        i = 2 * k
        if around(rim_pts[k][0]) > 0 or around(rim_pts[k + 1][0]) > 0:
            faces.append((i, i + 2, i + 3, i + 1))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    o = link(bpy.data.objects.new(name, me))
    sol = o.modifiers.new("Thickness", "SOLIDIFY")
    sol.thickness = 0.004
    apply_modifier(o, sol.name)
    assign_material(o, material)
    set_smooth(o)
    return o


def cap(spec, f, M):
    name = spec["name"]
    crown = _dome(f"{name}.cap", f, M["cap"])
    front = lambda a: max(0.0, math.cos(a)) ** 0.6 if abs(a) < 1.35 else 0.0
    brim = _brim(f"{name}.cap_brim", f, M["cap"], around=front, width=0.068, droop=0.012)
    top = Vector(f.c) + Vector((0, 0, f.rz + 0.002))
    bpy.ops.mesh.primitive_uv_sphere_add(segments=10, ring_count=5, radius=0.009, location=top)
    btn = bpy.context.object
    btn.name = btn.data.name = f"{name}.cap_button"
    btn.scale.z = 0.45
    bpy.ops.object.transform_apply(scale=True)
    assign_material(btn, M["cap"])
    return [crown, brim, btn]


def bucket(spec, f, M):
    name = spec["name"]
    crown = _dome(f"{name}.bucket", f, M["bucket"], lift=0.015)
    brim = _brim(f"{name}.bucket_brim", f, M["bucket"], around=lambda a: 1.0, width=0.055, droop=0.03)
    return [crown, brim]

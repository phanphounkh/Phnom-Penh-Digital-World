"""Stage 2: garments tailored from the body surface (no MakeHuman clothes fit the references).

Every garment starts as a copy of the body faces it covers, so it inherits the body's UVs and
bone weights. It is then:
  1. smoothed (Laplacian, boundary pinned) so muscles, navel and ribs disappear under fabric,
  2. offset outward by a per-region ease (loose hoodie body, bloused jogger legs, tight cuffs),
  3. given folds (cuff bunching, elbow and knee rings, low-frequency drape noise),
  4. pushed out of the body and of the layer below it (pants < hoodie < jacket),
  5. trimmed with ribbed bands along its open edges (hems, cuffs, waistband, collar).
Body faces that end up fully under fabric are deleted, so nothing pokes through when posed.
Shoes are the MakeHuman CC0 sneakers (shoes05/06) recoloured by region.
"""

from common import *
import setup_materials as mats

B = "mixamorig:"


class Landmarks:
    def __init__(self, rig):
        h = lambda n: bone_head(rig, B + n)
        self.hips, self.spine, self.spine1, self.spine2 = h("Hips"), h("Spine"), h("Spine1"), h("Spine2")
        self.neck, self.head = h("Neck"), h("Head")
        self.shoulder = {s: h(s + "Arm") for s in ("Left", "Right")}
        self.elbow = {s: h(s + "ForeArm") for s in ("Left", "Right")}
        self.wrist = {s: h(s + "Hand") for s in ("Left", "Right")}
        self.hip = {s: h(s + "UpLeg") for s in ("Left", "Right")}
        self.knee = {s: h(s + "Leg") for s in ("Left", "Right")}
        self.ankle = {s: h(s + "Foot") for s in ("Left", "Right")}
        self.toe = {s: h(s + "ToeBase") for s in ("Left", "Right")}

    def side_of(self, x):
        # MakeHuman/Mixamo: the character's left is +X in Blender.
        return "Left" if x > 0 else "Right"


def arm_param(L, co):
    """Per vertex: position along shoulder→wrist (0..1, >1 on the hand) and distance to that axis."""
    t = np.zeros(len(co))
    d = np.full(len(co), 9.0)
    for side in ("Left", "Right"):
        s = np.array(L.shoulder[side])
        w = np.array(L.wrist[side])
        axis = w - s
        ln = np.linalg.norm(axis)
        tt = ((co - s) @ axis) / (ln * ln)
        foot = s + np.outer(np.clip(tt, 0, 1.2), axis)
        dd = np.linalg.norm(co - foot, axis=1)
        mine = (np.sign(co[:, 0]) == (1 if side == "Left" else -1))
        t = np.where(mine, tt, t)
        d = np.where(mine, dd, d)
    return t, d


class Weights:
    def __init__(self, body, rig):
        W = bone_weights(body, rig)
        z = np.zeros(len(body.data.vertices))
        g = lambda *names: sum((W.get(B + n, z) for n in names), z.copy())
        fingers = [f"{s}Hand{f}{i}" for s in ("Left", "Right") for f in ("Thumb", "Index", "Middle", "Ring", "Pinky") for i in (1, 2, 3)]
        self.head = g("Head")
        self.neck = g("Neck")
        self.hands = g("LeftHand", "RightHand", *fingers)
        self.arms = g("LeftArm", "LeftForeArm", "RightArm", "RightForeArm")
        self.legs = g("LeftUpLeg", "LeftLeg", "RightUpLeg", "RightLeg")
        self.feet = g("LeftFoot", "LeftToeBase", "RightFoot", "RightToeBase")


def noise3(co, scale, seed):
    """Cheap smooth 3D noise (sum of random sines), roughly in [-1, 1]."""
    rng = np.random.default_rng(seed)
    out = np.zeros(len(co))
    for k in range(6):
        d = rng.normal(size=3)
        d /= np.linalg.norm(d)
        f = scale * rng.uniform(0.7, 1.6)
        out += np.sin(co @ d * f * math.tau + rng.uniform(0, math.tau)) / 6 * 1.6
    return out


def recompute_normals(obj):
    obj.data.update()
    return normals(obj)


def shell(body, name, keep_vertex, offset, *, smooth=14, clearance=0.006, below=(), folds=None, material=None,
          tree=None):
    """Garment surface from the body faces whose vertices all satisfy `keep_vertex`.

    smooth (hem lines too) → wrap tightly over the body (push out to `clearance`) → add the
    region's ease and folds along the wrapped normals → push out of the layers below.
    """
    g = duplicate(body, name)
    keep_faces(g, face_vertex_all(g, keep_vertex[: len(g.data.vertices)]))
    drop_islands(g)
    smooth_hems(g)
    pin = boundary_vertices(g)
    smooth_laplacian(g, iterations=smooth, factor=0.5, pin=pin)
    tree = tree or bvh(body)
    push_outside(g, [(tree, clearance)])
    smooth_laplacian(g, iterations=3, factor=0.4, pin=pin)
    push_outside(g, [(tree, clearance)])
    co = coords(g)
    n = recompute_normals(g)
    off = offset(co)
    if folds is not None:
        off = off + folds(co)
    set_coords(g, co + n * off[:, None])
    smooth_laplacian(g, iterations=2, factor=0.3, pin=pin)
    push_outside(g, [(tree, clearance)] + [(bvh(b), *rest) for b, *rest in below])
    if material:
        assign_material(g, material)
    set_smooth(g)
    return g


def drop_islands(g, min_share=0.1):
    """Delete small disconnected bits (a stray patch on a hand or the neck)."""
    bm = bmesh.new()
    bm.from_mesh(g.data)
    bm.faces.ensure_lookup_table()
    seen, islands = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, island = [f], []
        seen.add(f.index)
        while stack:
            cur = stack.pop()
            island.append(cur.index)
            for e in cur.edges:
                for nb in e.link_faces:
                    if nb.index not in seen:
                        seen.add(nb.index)
                        stack.append(nb)
        islands.append(island)
    bm.free()
    total = sum(len(i) for i in islands)
    keep = np.ones(total, dtype=bool)
    for island in islands:
        if len(island) < min_share * total:
            keep[island] = False
    if not keep.all():
        keep_faces(g, keep)


def smooth_hems(g, iterations=12):
    """Straighten the zig-zag edge loops left by cutting along body faces (1D Laplacian)."""
    co = coords(g)
    for loop, closed in boundary_loops(g, with_closed=True):
        pts = co[loop]
        for _ in range(iterations):
            if closed:
                avg = (np.roll(pts, 1, axis=0) + np.roll(pts, -1, axis=0)) / 2
                pts = pts + (avg - pts) * 0.5
            else:
                avg = (pts[:-2] + pts[2:]) / 2
                pts[1:-1] = pts[1:-1] + (avg - pts[1:-1]) * 0.5
        co[loop] = pts
    set_coords(g, co)


def push_outside(obj, layers):
    """Move vertices that are inside (or too close to) any layer out along its normal.

    A layer is (tree, clearance) or (tree, clearance, reach): with a reach, only vertices within
    `reach` of the layer are considered (an open garment's edge must not pull far fabric to it)."""
    co = coords(obj)
    changed = False
    for layer in layers:
        tree, clearance = layer[0], layer[1]
        reach = layer[2] if len(layer) > 2 else None
        for i, p in enumerate(co):
            hit, nrm, _, dist = tree.find_nearest(Vector(p)) if reach is None else tree.find_nearest(Vector(p), reach)
            if hit is None:
                continue
            outward = Vector(p) - hit
            if outward.dot(nrm) < 0 or dist < clearance:
                co[i] = np.array(hit + nrm * clearance)
                changed = True
    if changed:
        set_coords(obj, co)


def boundary_loops(obj, with_closed=False):
    """Ordered vertex-index chains along the mesh's open edges (closed loops flagged)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    adj = {}
    for e in bm.edges:
        if e.is_boundary:
            a, b = e.verts[0].index, e.verts[1].index
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
    bm.free()

    def walk(start, first):
        chain, prev, cur = [start], start, first
        while cur is not None and cur != start:
            chain.append(cur)
            seen.add(cur)
            nxt = [v for v in adj[cur] if v != prev and v not in seen]
            prev, cur = cur, (nxt[0] if nxt else (start if start in adj[cur] and len(chain) > 2 else None))
        return chain, cur == start

    loops, seen = [], set()
    for start in adj:
        if start in seen:
            continue
        seen.add(start)
        chain, closed = walk(start, adj[start][0])
        if not closed and len(adj[start]) > 1:
            back, _ = walk(start, adj[start][1]) if adj[start][1] not in seen else ([start], False)
            chain = list(reversed(back[1:])) + chain
        if len(chain) > 4:
            loops.append((chain, closed))
    return loops if with_closed else [c for c, _ in loops]


def band(name, points, radius, material, closed=True):
    """A ribbed band (tube) along `points`, resampled to an even, modest point count."""
    pts = [Vector(p) for p in points]
    if closed and (pts[0] - pts[-1]).length < 1e-6:
        pts = pts[:-1]
    seq = pts + ([pts[0]] if closed else [])
    seglen = [(b - a).length for a, b in zip(seq, seq[1:])]
    total = sum(seglen)
    count = int(min(56, max(10, total / (radius * 5))))
    step = total / count
    out, acc, i, pos = [seq[0]], 0.0, 0, 0.0
    target = step
    for a, b, L_ in zip(seq, seq[1:], seglen):
        while L_ > 0 and acc + L_ >= target - 1e-9 and len(out) < count + (0 if closed else 1):
            t = (target - acc) / L_
            out.append(a.lerp(b, t))
            target += step
        acc += L_
    if closed and len(out) > 3 and (out[-1] - out[0]).length < step * 0.5:
        out = out[:-1]
    tube = curve_tube(name, out, radius, closed=closed, resolution=2,
                      bevel_resolution=0 if radius < 0.004 else 1)
    assign_material(tube, material)
    return tube


def trim_edges(g, name, radius, material, pick=None):
    """Bands along every open edge loop of `g` (or the loops `pick(points)` accepts)."""
    co = coords(g)
    tubes = []
    for i, (loop, closed) in enumerate(boundary_loops(g, with_closed=True)):
        pts = co[loop]
        if pick and not pick(pts):
            continue
        tubes.append(band(f"{name}.{i}", pts, radius, material, closed=closed))
    return tubes


def patch(source, name, face_mask, offset, material, uv_from=None):
    """Copy faces of `source` (a garment) as a separate layer `offset` above it (pockets, decals)."""
    p = duplicate(source, name)
    keep_faces(p, face_mask)
    co = coords(p)
    n = recompute_normals(p)
    set_coords(p, co + n * offset)
    if uv_from:
        uv_from(p)
    assign_material(p, material)
    return p


def planar_uv(obj, origin, u_axis, v_axis, size_u, size_v):
    """Project UVs onto a plane: (origin, axes in metres) → 0..1."""
    me = obj.data
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    uv = me.uv_layers.active
    co = coords(obj)
    o, ua, va = np.array(origin), np.array(u_axis), np.array(v_axis)
    for poly in me.polygons:
        for li in poly.loop_indices:
            p = co[me.loops[li].vertex_index] - o
            uv.data[li].uv = (0.5 + (p @ ua) / size_u, 0.5 + (p @ va) / size_v)


def tag_source_index(body):
    """Remember each body vertex index; copies made from the body (garments) keep it."""
    attr = body.data.attributes.get("src_index") or body.data.attributes.new("src_index", "INT", "POINT")
    attr.data.foreach_set("value", np.arange(len(body.data.vertices), dtype=np.int32))


def source_index(obj):
    attr = obj.data.attributes["src_index"]
    a = np.empty(len(obj.data.vertices), dtype=np.int32)
    attr.data.foreach_get("value", a)
    return a


def covered_by(co, nrm, shells, margin, reach=0.07):
    """Body points really under these garments: straight out from the skin (along its normal) the
    fabric is within `reach` (or the skin pokes just through it), and the point is further than
    `margin` from every open edge (hem, cuff, neckline) of the garments. Skin merely near a hem
    (below the shorts) does not count."""
    from mathutils.kdtree import KDTree

    trees = [bvh(g) for g in shells]
    under = np.zeros(len(co), dtype=bool)
    for i in range(len(co)):
        o = Vector(co[i])
        d = Vector(nrm[i])
        for t in trees:
            hit = t.ray_cast(o + d * 0.001, d, reach)
            if hit[0] is not None:
                under[i] = True
                break
            # Skin poking through the fabric (the body sticks out past the softened shape the
            # fabric drapes over): just outside it, so the ray above never meets it.
            near = t.find_nearest(o, 0.02)
            if near[0] is not None and (o - near[0]).dot(near[1]) > 0:
                under[i] = True
                break
    edge = [coords(g)[loop] for g in shells for loop in boundary_loops(g)]
    if not edge:
        return under
    edge = np.vstack(edge)
    kd = KDTree(len(edge))
    for i, p in enumerate(edge):
        kd.insert(Vector(p), i)
    kd.balance()
    far = np.array([kd.find(Vector(p))[2] > margin for p in co])
    return under & far


def delete_covered(target, covered_mask, garments, margin):
    """Remove faces of `target` (body or an inner garment) fully covered by `garments`.

    `covered_mask` is over original body vertices; a vertex counts as covered when its source body
    vertex is, and it is further than `margin` from every open edge of the covering garments.
    """
    co = coords(target)
    edge_pts = []
    for g in garments:
        gco = coords(g)
        for loop in boundary_loops(g):
            edge_pts.append(gco[loop])
    if edge_pts:
        edge = np.vstack(edge_pts)
        from mathutils.kdtree import KDTree

        kd = KDTree(len(edge))
        for i, p in enumerate(edge):
            kd.insert(Vector(p), i)
        kd.balance()
        far = np.array([kd.find(Vector(p))[2] > margin for p in co])
    else:
        far = np.ones(len(co), dtype=bool)
    covered = covered_mask[source_index(target)]
    gone = face_vertex_all(target, covered & far)
    keep_faces(target, ~gone)
    return int(gone.sum())


# ── Garments ─────────────────────────────────────────────────────────────────────────────


def cargo_pants(spec, body, L, Wt, M, co, tree=None):
    waist_z = (L.hips.z + L.spine.z) / 2 + 0.015
    ankle_z = min(L.ankle["Left"].z, L.ankle["Right"].z)
    cuff_z = ankle_z + 0.055
    t_arm, d_arm = arm_param(L, co)
    keep = (co[:, 2] < waist_z) & (co[:, 2] > cuff_z) & (Wt.arms + Wt.hands < 0.3) & (Wt.feet < 0.5)
    keep &= ~((d_arm < 0.1) & (t_arm > 0.3))
    knee_z = L.knee["Left"].z

    def offset(p):
        z = p[:, 2]
        # Relaxed joggers: ease grows down the leg, tight elastic cuff, a little seat room.
        ease = 0.014 + 0.014 * (1 - smoothstep(knee_z - 0.25, waist_z - 0.12, z))
        cuff = smoothstep(cuff_z + 0.01, cuff_z + 0.08, z)  # 0 at the cuff
        blouse = np.exp(-((z - (cuff_z + 0.085)) / 0.04) ** 2) * 0.016
        waist = smoothstep(waist_z - 0.005, waist_z - 0.06, z)  # 1 below the band
        return (ease * cuff + 0.004 * (1 - cuff) + blouse) * (0.45 + 0.55 * waist)

    def folds(p):
        z = p[:, 2]
        stack = np.sin((z - cuff_z) * math.tau / 0.035 + noise3(p, 6, 2) * 1.5) * 0.004 * np.exp(-((z - cuff_z) / 0.14) ** 2)
        knee = np.sin((z - knee_z) * math.tau / 0.05 + noise3(p, 5, 3)) * 0.0025 * np.exp(-((z - knee_z) / 0.09) ** 2)
        drape = noise3(p, 3.5, 4) * 0.004
        return stack + knee + drape

    pants = shell(body, f"{spec['name']}.pants", keep, offset, folds=folds, material=M["pants"], smooth=24, tree=tree)
    parts = [pants]
    # Waistband and cuffs.
    pco = coords(pants)
    for i, (loop, closed) in enumerate(boundary_loops(pants, with_closed=True)):
        pts = pco[loop]
        top = pts[:, 2].mean() > (waist_z + cuff_z) / 2
        parts.append(band(f"{spec['name']}.pants_{'waistband' if top else 'cuff'}{i}", pts,
                          0.011 if top else 0.012, M["pants_rib"], closed=closed))
    # Cargo pockets with flaps on the outer thighs.
    centers = coords(pants)
    fc = face_centers(pants)
    fn = np.array([p.normal[:] for p in pants.data.polygons])
    for side in ("Left", "Right"):
        sx = 1 if side == "Left" else -1
        hip, knee = L.hip[side], L.knee[side]
        zc = knee.z + 0.2
        outward = fn[:, 0] * sx
        leg_c = np.array(hip.lerp(knee, 0.55))
        sel = (np.abs(fc[:, 2] - zc) < 0.085) & (outward > 0.55) & (np.abs(fc[:, 1] - leg_c[1] + 0.005) < 0.075) & (fc[:, 0] * sx > 0)
        if sel.sum() < 4:
            continue
        pocket = patch(pants, f"{spec['name']}.pocket_{side}", sel, 0.008, M["pants"])
        parts.append(pocket)
        parts += trim_edges(pocket, f"{spec['name']}.pocket_seam_{side}", 0.0028, M["pants_rib"])
        flap_sel = sel & (fc[:, 2] > zc + 0.045)
        if flap_sel.sum() >= 2:
            flap = patch(pants, f"{spec['name']}.flap_{side}", flap_sel, 0.014, M["pants"])
            parts.append(flap)
            parts += trim_edges(flap, f"{spec['name']}.flap_seam_{side}", 0.003, M["pants_rib"])
    covered = keep
    return parts, covered, cuff_z


def hoodie(spec, body, L, Wt, M, co, below, *, hem_drop, front_only=None, tree=None, under_jacket=False):
    """Hoodie body+sleeves (+hood roll, drawstrings, pocket). `front_only` keeps a front strip
    only (under an open jacket) — the rest would be invisible."""
    hem_z = L.hips.z - hem_drop
    t_arm, d_arm = arm_param(L, co)
    neck_z = L.neck.z - 0.005
    front = smoothstep(0.0, -0.09, co[:, 1] - L.neck.y)  # 1 on the chest side
    neckline = neck_z - 0.018 * front * smoothstep(0.07, 0.0, np.abs(co[:, 0]))
    on_arm = Wt.arms > 0.35
    sleeve_end = 1.0 - 0.018 / np.linalg.norm(np.array(L.wrist["Left"] - L.shoulder["Left"]))
    keep = (co[:, 2] > hem_z) & (co[:, 2] < neckline) & (Wt.head + Wt.hands < 0.3) & ~((d_arm < 0.13) & (t_arm > sleeve_end))
    keep &= ~((Wt.legs > 0.5) & (co[:, 2] < hem_z + 0.02))
    if front_only is not None:
        keep &= front_only(co)
    shoulder_z = L.shoulder["Left"].z

    def offset(p):
        z = p[:, 2]
        t, d = arm_param(L, p)
        arm = (Wt_arm_at(p) > 0.3)
        torso = 0.02 + 0.012 * smoothstep(L.spine2.z, hem_z + 0.08, z)
        hem = smoothstep(hem_z + 0.005, hem_z + 0.055, z)
        torso = torso * hem + 0.009 * (1 - hem)
        sleeve = 0.014 + 0.008 * smoothstep(0.2, 0.75, t)
        cuff = smoothstep(sleeve_end - 0.005, sleeve_end - 0.09, t)
        sleeve = sleeve * cuff + 0.005 * (1 - cuff) + np.exp(-((t - (sleeve_end - 0.13)) / 0.06) ** 2) * 0.01
        return np.where(arm, sleeve, torso)

    def Wt_arm_at(p):
        # Arm membership by nearest original vertex (the shell keeps vertex order per face set).
        t, d = arm_param(L, p)
        return ((d < 0.09) & (t > 0.08)).astype(float)

    def folds(p):
        t, d = arm_param(L, p)
        elbow_t = 0.52
        elbow = np.sin(t * math.tau / 0.07 + noise3(p, 7, 5) * 2) * 0.003 * np.exp(-((t - elbow_t) / 0.08) ** 2)
        cuff = np.sin(t * math.tau / 0.045 + noise3(p, 8, 6) * 2) * 0.003 * np.exp(-((t - (sleeve_end - 0.1)) / 0.07) ** 2)
        armpit = noise3(p, 4, 7) * 0.003
        return np.where((d < 0.09) & (t > 0.08), elbow + cuff, 0) + armpit

    name = spec["name"]
    h = shell(body, f"{name}.hoodie", keep, offset, folds=folds, material=M["hoodie"], below=below, smooth=40, tree=tree)
    parts = [h]
    hco = coords(h)
    for i, (loop, closed) in enumerate(boundary_loops(h, with_closed=True)):
        pts = hco[loop]
        z = pts[:, 2].mean()
        if z < hem_z + 0.06:
            parts.append(band(f"{name}.hoodie_hem", pts, 0.012, M["hoodie_rib"], closed=closed))
        elif z > shoulder_z:
            parts.append(band(f"{name}.hoodie_neck", pts, 0.009, M["hoodie_rib"], closed=closed))
        elif not under_jacket:
            parts.append(band(f"{name}.hoodie_cuff{i}", pts, 0.0075, M["hoodie_rib"], closed=closed))
    parts.append(hood(spec, L, M, lift=0.03 if under_jacket else 0.0))
    parts += drawstrings(spec, L, M)
    return parts, keep, hem_z


def hood(spec, L, M, lift=0.0):
    """The hood lying folded around the back of the neck: a fat roll, thin at the front.
    `lift` moves it out and up so it lies over a jacket collar."""
    n = L.neck + Vector((0, lift, lift * 0.7))
    sw = abs(L.shoulder["Left"].x) * 0.6 + lift * 0.8
    pts, radii = [], []
    for i in range(15):
        a = math.pi * (-0.6 + 1.2 * i / 14)  # -108°..108° around the neck, 0 = back
        x = math.sin(a) * sw
        y = n.y + 0.03 + math.cos(a) * 0.075
        z = n.z + 0.005 + 0.012 * math.cos(a)
        pts.append(Vector((x, y, z)))
        radii.append((0.014 + 0.024 * math.cos(a) ** 2) * (1 + lift * 6))
    # A bevelled curve whose per-point radius gives the profile (fat at the back, thin in front).
    cu = bpy.data.curves.new(f"{spec['name']}.hood", "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = 1.0
    cu.bevel_resolution = 4
    cu.resolution_u = 3
    cu.use_fill_caps = True
    sp = cu.splines.new("BEZIER")
    sp.bezier_points.add(len(pts) - 1)
    for bp, p, r in zip(sp.bezier_points, pts, radii):
        bp.co = p
        bp.radius = r
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    o = link(bpy.data.objects.new(f"{spec['name']}.hood", cu))
    activate(o)
    bpy.ops.object.convert(target="MESH")
    o = bpy.context.object
    # Flatten the roll against the back (folded fabric, not a tube).
    co = coords(o)
    c = np.array(n) + np.array([0, 0.03, 0.005])
    rel = co - c
    radial = rel.copy()
    radial[:, 2] = 0
    rn = radial / np.maximum(np.linalg.norm(radial, axis=1, keepdims=True), 1e-6)
    co = c + rel - rn * (rel * rn).sum(1, keepdims=True) * 0.45
    co[:, 2] = c[2] + rel[:, 2] * 0.6
    set_coords(o, co)
    assign_material(o, M["hoodie"])
    set_smooth(o)
    return o


def drawstrings(spec, L, M):
    out = []
    n = L.neck
    for sx in (-1, 1):
        top = Vector((sx * 0.035, n.y - 0.085, n.z - 0.045))
        pts = [top + Vector((sx * 0.004 * math.sin(i), -0.012 * math.sin(i * 0.4), -0.03 * i)) for i in range(7)]
        s = curve_tube(f"{spec['name']}.drawstring{sx}", pts, 0.0032, resolution=3, bevel_resolution=2)
        assign_material(s, M["string"])
        out.append(s)
        tip = pts[-1]
        a = curve_tube(f"{spec['name']}.aglet{sx}", [tip, tip + Vector((0, 0, -0.022))], 0.0042, resolution=1, bevel_resolution=2)
        assign_material(a, M["aglet"])
        out.append(a)
    return out


def kangaroo_pocket(spec, h, L, M, hem_z):
    fc = face_centers(h)
    fn = np.array([p.normal[:] for p in h.data.polygons])
    sel = (fc[:, 2] > hem_z + 0.05) & (fc[:, 2] < hem_z + 0.2) & (np.abs(fc[:, 0]) < 0.13 - 0.25 * np.maximum(0, fc[:, 2] - hem_z - 0.12)) & (fn[:, 1] < -0.5)
    if sel.sum() < 4:
        return []
    p = patch(h, f"{spec['name']}.hoodie_pocket", sel, 0.006, M["hoodie"])
    return [p] + trim_edges(p, f"{spec['name']}.hoodie_pocket_seam", 0.0028, M["hoodie_rib"])


def jacket(spec, body, L, Wt, M, co, below, hem_z, tree=None):
    """Open zip jacket: hoodie cut with a front opening, more ease, blue panels, collar."""
    t_arm, d_arm = arm_param(L, co)
    neck_z = L.neck.z + 0.005
    on_arm = Wt.arms > 0.35
    sleeve_end = 1.0 - 0.012 / np.linalg.norm(np.array(L.wrist["Left"] - L.shoulder["Left"]))
    front = co[:, 1] < L.spine2.y - 0.02
    # The opening widens toward the hem (the jacket hangs open).
    half_open = 0.05 + 0.05 * smoothstep(L.spine2.z + 0.05, hem_z, co[:, 2])
    opening = front & (np.abs(co[:, 0]) < half_open)
    keep = (co[:, 2] > hem_z + 0.01) & (co[:, 2] < neck_z) & (Wt.head + Wt.hands < 0.3) & ~((d_arm < 0.13) & (t_arm > sleeve_end)) & ~opening
    keep &= ~((Wt.legs > 0.5) & (co[:, 2] < hem_z + 0.03))

    def offset(p):
        t, d = arm_param(L, p)
        arm = (d < 0.095) & (t > 0.08)
        torso = 0.032 + 0.01 * smoothstep(L.spine2.z, hem_z, p[:, 2])
        sleeve = 0.024 + 0.006 * smoothstep(0.3, 0.8, t)
        cuff = smoothstep(sleeve_end - 0.005, sleeve_end - 0.08, t)
        sleeve = sleeve * cuff + 0.014 * (1 - cuff)
        return np.where(arm, sleeve, torso)

    def folds(p):
        t, d = arm_param(L, p)
        arm = (d < 0.095) & (t > 0.08)
        elbow = np.sin(t * math.tau / 0.08 + noise3(p, 6, 9) * 2) * 0.004 * np.exp(-((t - 0.52) / 0.09) ** 2)
        return np.where(arm, elbow, 0) + noise3(p, 3, 10) * 0.005

    name = spec["name"]
    j = shell(body, f"{name}.jacket", keep, offset, folds=folds, material=M["jacket"], below=below, smooth=40,
              clearance=0.012, tree=tree)
    # Blue panels with straight edges: cut the shell along the panel borders, then colour.
    x0, x1, z_top = 0.072, 0.128, L.spine2.z + 0.05
    planes = [((sx * x, 0, 0), (1, 0, 0)) for sx in (-1, 1) for x in (x0, x1)] + [((0, 0, z_top), (0, 0, 1))]
    stripe = {}
    for side in ("Left", "Right"):
        s0 = L.shoulder[side]
        a = (L.wrist[side] - s0)
        ln = a.length
        a = a.normalized()
        o = (Vector((0, 0, 1)) - a * a.z).normalized()
        stripe[side] = (s0, a, ln, o)
        for ang in (-0.42, 0.42):
            r = Matrix.Rotation(ang, 3, a) @ o
            planes.append((s0, a.cross(r)))
        for t in (0.1, 0.48):
            planes.append((s0 + a * ln * t, a))
    bisect(j, planes)
    fc = face_centers(j)
    t, d = arm_param(L, fc)
    arm = (d < 0.11) & (t > 0.06)
    j.data.materials.append(M["jacket_panel"])
    panel = (~arm & (fc[:, 1] < L.spine2.y - 0.03) & (np.abs(fc[:, 0]) > x0) & (np.abs(fc[:, 0]) < x1) & (fc[:, 2] < z_top))
    on_stripe = np.zeros(len(fc), dtype=bool)
    for side, (s0, a, ln, o) in stripe.items():
        rel = fc - np.array(s0)
        tt = rel @ np.array(a) / ln
        radial = rel - np.outer(rel @ np.array(a), np.array(a))
        radial /= np.maximum(np.linalg.norm(radial, axis=1, keepdims=True), 1e-9)
        mine = np.sign(fc[:, 0]) == (1 if side == "Left" else -1)
        on_stripe |= mine & arm & (tt > 0.1) & (tt < 0.48) & (radial @ np.array(o) > math.cos(0.42))
    idx = np.nonzero(panel | on_stripe)[0]
    mi = np.zeros(len(fc), dtype=np.int32)
    mi[idx] = 1
    j.data.polygons.foreach_set("material_index", mi)
    parts = [j]
    jco = coords(j)
    for i, (loop, closed) in enumerate(boundary_loops(j, with_closed=True)):
        pts = jco[loop]
        if pts[:, 2].max() - pts[:, 2].min() > 0.2:  # the big loop: hem + opening + neckline
            parts.append(band(f"{name}.jacket_edge", pts, 0.008, M["jacket_trim"], closed=closed))
        else:
            parts.append(band(f"{name}.jacket_cuff{i}", pts, 0.0075, M["jacket_trim"], closed=closed))
    parts.append(collar(spec, L, M))
    parts += zipper(spec, j, L, M, hem_z)
    return parts, keep


def half_open_at(z, L, hem_z):
    return 0.05 + 0.05 * smoothstep(L.spine2.z + 0.05, hem_z, z)


def collar(spec, L, M):
    """Stand-up jacket collar, open at the front."""
    n = L.neck
    pts = []
    for i in range(13):
        a = math.pi * (-0.78 + 1.56 * i / 12)
        pts.append(Vector((math.sin(a) * 0.082, n.y + 0.012 + math.cos(a) * 0.07, n.z + 0.01 + 0.012 * math.cos(a))))
    prof = rect_profile(f"{spec['name']}.collar_prof", 0.012, 0.055)
    o = curve_tube(f"{spec['name']}.collar", pts, 0.0, profile=prof)
    bpy.data.objects.remove(prof)
    assign_material(o, M["jacket"])
    return o


def zipper(spec, j, L, M, hem_z):
    out = []
    for sx in (-1, 1):
        pts = []
        for z in np.linspace(hem_z + 0.03, L.neck.z - 0.03, 12):
            x = sx * (half_open_at(np.array([z]), L, hem_z)[0] + 0.004)
            hit = _surface_hit(j, Vector((x, -1.0, z)), Vector((0, 1, 0)))
            if hit is not None:
                pts.append(hit + Vector((0, -0.004, 0)))
        if len(pts) > 3:
            z_ = curve_tube(f"{spec['name']}.zip{sx}", pts, 0.0035, resolution=2, bevel_resolution=1)
            assign_material(z_, M["zip"])
            out.append(z_)
    return out


def _surface_hit(obj, origin, direction):
    hit, nrm, _, _ = bvh(obj).ray_cast(origin, direction)
    return hit


# ── Shoes ───────────────────────────────────────────────────────────────────────────────


def sneakers(spec, body, rig, M, shoes):
    """Restyle the fitted MakeHuman sneakers (loaded in body.build_human) by region."""
    shoes.name = shoes.data.name = f"{spec['name']}.sneakers"
    for m in list(shoes.modifiers):
        if m.type not in ("ARMATURE",):
            shoes.modifiers.remove(m)
    # Chunky sole: widen and thicken the bottom.
    co = coords(shoes)
    z = co[:, 2]
    sole_top = 0.032
    for side in (1, -1):
        mine = co[:, 0] * side > 0
        cx, cy = co[mine, 0].mean(), co[mine, 1].mean()
        k = smoothstep(sole_top + 0.01, 0.0, z) * mine
        co[:, 0] += (co[:, 0] - cx) * 0.07 * k
        co[:, 1] += (co[:, 1] - cy) * 0.04 * k
    co[:, 2] = np.where(z < 0.012, z - 0.006 * (1 - z / 0.012), z)
    co[:, 2] -= co[:, 2].min()
    set_coords(shoes, co)
    # Regions: sole (+ midsole stripe), diagonal side stripe, heel counter, upper, sock.
    shoes.data.materials.clear()
    for m in (M["shoe_upper"], M["shoe_sole"], M["shoe_accent"], M["sock"]):
        shoes.data.materials.append(m)
    ankle = max(L_ankle_z(rig), 0.07)
    co = coords(shoes)
    y_toe, y_heel = co[:, 1].min(), co[:, 1].max()
    ly = y_heel - y_toe
    slope = Vector((0, -0.09 / ly, 1))
    planes = [((0, 0, sole_top - 0.004), (0, 0, 1)), ((0, 0, sole_top + 0.004), (0, 0, 1)),
              ((0, 0, ankle + 0.035), (0, 0, 1)),
              ((0, y_toe + 0.25 * ly, 0), (0, 1, 0)), ((0, y_toe + 0.85 * ly, 0), (0, 1, 0)),
              ((0, y_toe, sole_top - 0.0225 - 0.011), slope), ((0, y_toe, sole_top - 0.0225 + 0.011), slope)]
    bisect(shoes, planes)
    fc = face_centers(shoes)
    nrm = np.array([p.normal[:] for p in shoes.data.polygons])
    f = (fc[:, 1] - y_toe) / ly
    z = fc[:, 2]
    side = np.abs(nrm[:, 0]) > 0.35
    back = nrm[:, 1] > 0.45
    mi = np.zeros(len(fc), dtype=np.int32)
    mi[(side) & (f > 0.25) & (f < 0.85) & (np.abs((z - sole_top) - 0.09 * (f - 0.25)) < 0.011)] = 2
    mi[(back | (f > 0.85)) & (z < ankle + 0.02)] = 2
    mi[z < sole_top + 0.004] = 2
    mi[z < sole_top - 0.004] = 1
    mi[z > ankle + 0.035] = 3
    shoes.data.polygons.foreach_set("material_index", mi)
    set_smooth(shoes)
    return shoes


def laces(spec, shoes, M):
    """Five lace crossings over each instep, sitting on the shoe surface."""
    co = coords(shoes)
    tree = bvh(shoes)
    out = []
    for sx in (1, -1):
        foot = co[(co[:, 0] * sx) > 0]
        cx = foot[:, 0].mean()
        y_toe, y_heel = foot[:, 1].min(), foot[:, 1].max()
        for k in range(5):
            y = y_toe + (y_heel - y_toe) * (0.28 + 0.07 * k)
            pts = []
            for dx in np.linspace(-0.022, 0.022, 5):
                hit, nrm, _, _ = tree.ray_cast(Vector((cx + dx, y, 0.3)), Vector((0, 0, -1)))
                if hit is not None:
                    pts.append(hit + nrm * 0.003)
            if len(pts) >= 3:
                t = curve_tube(f"{spec['name']}.lace{sx}_{k}", pts, 0.0024, resolution=2, bevel_resolution=1)
                assign_material(t, M["lace"])
                out.append(t)
    return out


def L_ankle_z(rig):
    return bone_head(rig, B + "LeftFoot").z


# ── Outfit ──────────────────────────────────────────────────────────────────────────────


def outfit_materials(spec):
    c = spec["colors"]
    knit = mats.fabric_normal("fabric_knit.png", scale=64, strength=0.4)
    twill = mats.fabric_normal("fabric_twill.png", scale=40, strength=0.5, seed=9)
    rib = mats.fabric_normal("fabric_rib.png", scale=20, strength=0.9, seed=13)
    M = {
        "hoodie": mats.flat("Hoodie", c["hoodie"], roughness=0.85, double_sided=True),
        "hoodie_rib": mats.flat("HoodieRib", c["hoodie"], roughness=0.9, normal=rib, normal_scale=10),
        "pants": mats.flat("Pants", c["pants"], roughness=0.8, normal=twill, normal_scale=8, normal_strength=0.15,
                           double_sided=True),
        "pants_rib": mats.flat("PantsRib", c["pants"], roughness=0.85, normal=rib, normal_scale=10),
        "string": mats.flat("Drawstring", "#f1efe9" if spec["name"] == "female" else "#2a2a2e", roughness=0.7),
        "aglet": mats.flat("Aglet", "#b9bcc2", roughness=0.35, metallic=0.6),
        "shoe_upper": mats.flat("ShoeUpper", c["shoe_upper"], roughness=0.55),
        "shoe_sole": mats.flat("ShoeSole", c["shoe_sole"], roughness=0.7),
        "shoe_accent": mats.flat("ShoeAccent", c["shoe_accent"], roughness=0.5),
        "sock": mats.flat("Sock", "#f2f1ee", roughness=0.9),
        "lace": mats.flat("Lace", "#f4f3f0", roughness=0.8),
    }
    # The wardrobe's other garments (wardrobe_garments.py); the game recolours most of them.
    M.update({
        "tee": mats.flat("Tee", c.get("tee", "#e9e6df"), roughness=0.88, normal=knit, normal_scale=12,
                         normal_strength=0.2, double_sided=True),
        "tee_rib": mats.flat("TeeRib", c.get("tee", "#e9e6df"), roughness=0.9, normal=rib, normal_scale=10),
        "shirt": mats.flat("Shirt", c.get("shirt", "#7d9bb8"), roughness=0.75, double_sided=True),
        "button": mats.flat("Button", "#f1eee6", roughness=0.4),
        "jeans": mats.flat("Jeans", c.get("jeans", "#2f4a6d"), roughness=0.85, normal=twill, normal_scale=10,
                           normal_strength=0.25, double_sided=True),
        "stitch": mats.flat("JeansStitch", "#c98a3c", roughness=0.8),
        "rivet": mats.flat("Rivet", "#b87333", roughness=0.35, metallic=0.8),
        "shorts": mats.flat("Shorts", c.get("shorts", "#b8a27c"), roughness=0.82, normal=twill, normal_scale=8,
                            normal_strength=0.15, double_sided=True),
        "shorts_rib": mats.flat("ShortsRib", c.get("shorts", "#b8a27c"), roughness=0.85, normal=rib, normal_scale=10),
        "sandal_sole": mats.flat("SandalSole", "#2a2420", roughness=0.8),
        "sandal_strap": mats.flat("SandalStrap", c["shoe_upper"], roughness=0.6),
        "cap": mats.flat("Cap", c.get("cap", "#1f3b5a"), roughness=0.75, double_sided=True),
        "bucket": mats.flat("Bucket", c.get("cap", "#1f3b5a"), roughness=0.85, double_sided=True),
    })
    if "jacket" in spec["outfit"]:
        M.update({
            "jacket": mats.flat("Jacket", c["jacket"], roughness=0.5, double_sided=True),
            "jacket_panel": mats.flat("JacketPanel", c["jacket_panel"], roughness=0.48, double_sided=True),
            "jacket_trim": mats.flat("JacketTrim", c["jacket_trim"], roughness=0.8, normal=rib, normal_scale=10),
            "zip": mats.flat("Zip", "#2b2d33", roughness=0.35, metallic=0.4),
        })
    return M


def build_outfit(spec, body, rig, parts):
    """Every garment the wardrobe offers (outfits.SLOTS), tagged with its slot and variant.

    The original outfit (hoodie or jacket+hoodie, cargo joggers, sneakers) is built exactly as
    before; the other choices are built over the same body. Body skin is deleted only where every
    choice of a slot covers it; skin some choices show (forearms, lower legs, ankles, feet) is kept
    and marked with region_* vertex groups, which the export cuts into separate meshes.
    """
    import outfits as O
    import wardrobe_garments as W

    L = Landmarks(rig)
    Wt = Weights(body, rig)
    co = coords(body)
    M = outfit_materials(spec)
    name = spec["name"]
    tag_source_index(body)
    # Fabric drapes over a softened body: nipples, navel and ribs must not print through.
    collider = duplicate(body, "_collider")
    smooth_taubin(collider, iterations=30)
    tree = bvh(collider)
    bpy.data.objects.remove(collider)
    garments = {}
    covers = {slot: {} for slot in O.SLOTS}

    # ── The original outfit (unchanged) ──
    pants_parts, pants_cover, cuff_z = cargo_pants(spec, body, L, Wt, M, co, tree=tree)
    garments["pants"] = pants_parts
    pants = pants_parts[0]

    jacketed = "jacket" in spec["outfit"]
    hoodie_parts, hoodie_cover, hem_z = hoodie(spec, body, L, Wt, M, co, [(pants, 0.008)],
                                               hem_drop=0.05 if name == "female" else 0.1,
                                               tree=tree, under_jacket=jacketed)
    garments["hoodie"] = hoodie_parts
    if name == "female":
        garments["hoodie"] += kangaroo_pocket(spec, hoodie_parts[0], L, M, hem_z)
    top_cover = hoodie_cover.copy()
    if jacketed:
        jacket_parts, jacket_cover = jacket(spec, body, L, Wt, M, co, [(pants, 0.01), (hoodie_parts[0], 0.012)], hem_z,
                                            tree=tree)
        garments["jacket"] = jacket_parts
        top_cover |= jacket_cover
        # Most of the hoodie is hidden by the jacket: keep the opening, hem and neck.
        hidden = delete_covered(hoodie_parts[0], jacket_cover, [jacket_parts[0]], margin=0.045)
        log(name, "hoodie faces hidden under the jacket", hidden)
    shoes = sneakers(spec, body, rig, M, parts["shoes"])
    garments["shoes"] = [shoes] + laces(spec, shoes, M)
    legacy_top = [hoodie_parts[0]] + ([jacket_parts[0]] if jacketed else [])

    # ── The other choices ──
    jeans_parts, _, _ = W.jeans(spec, body, L, Wt, M, co, tree=tree)
    shorts_parts, _, shorts_hem = W.shorts(spec, body, L, Wt, M, co, tree=tree)
    garments["jeans"], garments["shorts"] = jeans_parts, shorts_parts
    # Over the trousers, jeans and shorts (each pushes only fabric near it: see push_outside).
    below = [(pants, 0.008, 0.05), (jeans_parts[0], 0.008, 0.05), (shorts_parts[0], 0.008, 0.05)]
    tee_parts, _, _ = W.tee(spec, body, L, Wt, M, co, below, tree=tree)
    shirt_parts, _, _ = W.shirt(spec, body, L, Wt, M, co, below, tree=tree)
    garments["tee"], garments["shirt"] = tee_parts, shirt_parts
    sandal_parts, _ = W.sandals(spec, body, rig, L, Wt, M, co)
    garments["sandals"] = sandal_parts
    frame = W.HatFrame(body, parts)
    garments["cap"] = W.cap(spec, frame, M)
    garments["bucket"] = W.bucket(spec, frame, M)
    # Where hats sit, for the export and previews (hair above this plane hides under a hat).
    rig["hat_point"], rig["hat_normal"] = list(frame.p0), list(frame.n)

    wardrobe = {
        "pants": ("bottom", "trousers"), "jeans": ("bottom", "jeans"), "shorts": ("bottom", "shorts"),
        "hoodie": ("top", "hoodie"), "jacket": ("top", "hoodie"), "tee": ("top", "tee"), "shirt": ("top", "shirt"),
        "shoes": ("shoes", "sneakers"), "sandals": ("shoes", "sandals"),
        "cap": ("hat", "cap"), "bucket": ("hat", "bucket"),
    }
    for key, group in garments.items():
        for g in group:
            O.tag(g, *wardrobe[key])

    # Skin the new meshes like the body (hats ride the head).
    for key, group in garments.items():
        for g in group:
            if g.name.endswith("sneakers"):
                continue
            if key in ("cap", "bucket"):
                rigid_bind(g, rig, B + "Head")
            else:
                transfer_weights(g, body, rig)

    # Delete only the skin every choice of a slot really covers (measured on the garments).
    margin = 0.035
    nrm = normals(body)
    covers["top"] = {"hoodie": covered_by(co, nrm, legacy_top, margin), "tee": covered_by(co, nrm, [tee_parts[0]], margin),
                     "shirt": covered_by(co, nrm, [shirt_parts[0]], margin)}
    covers["bottom"] = {v: covered_by(co, nrm, [g[0]], margin) for v, g in
                        (("trousers", pants_parts), ("jeans", jeans_parts), ("shorts", shorts_parts))}
    always = np.zeros(len(co), dtype=bool)
    for slot in ("top", "bottom"):
        always |= np.logical_and.reduce(list(covers[slot].values()))
    removed = int(face_vertex_all(body, always[source_index(body)]).sum())
    keep_faces(body, ~face_vertex_all(body, always[source_index(body)]))

    # Regions of the skin that stays, for the game to hide under the garments that cover them.
    ankle_z = L_ankle_z(rig)
    t_arm, d_arm = arm_param(L, co)
    z = co[:, 2]
    # A region holds only skin that every garment hiding it really covers (outfits.HIDDEN_WHEN):
    # skin near a cuff or hem stays visible under every choice, as it did before regions.
    shoes_cover = covered_by(co, nrm, [garments["shoes"][0]], margin)
    trousers, jeans_c = covers["bottom"]["trousers"], covers["bottom"]["jeans"]
    # Skin the original top only just covers (or pokes through): hidden with it, like the arms.
    hoodie_trees = [bvh(g) for g in legacy_top]
    grazing = np.zeros(len(co), dtype=bool)
    for i in range(len(co)):
        if Wt.hands[i] > 0.4 or Wt.head[i] > 0.3:
            continue
        for t in hoodie_trees:
            if t.find_nearest(Vector(co[i]), 0.004)[0] is not None:
                grazing[i] = True
                break
    region = {
        "arms": (((Wt.arms > 0.4) | ((d_arm < 0.13) & (t_arm > 0.15))) & (Wt.hands < 0.4) & (Wt.head < 0.3)
                 & covers["top"]["hoodie"]) | grazing,
        # Below the ankle everything goes under sneakers (toes too, whatever bones they follow).
        "feet": z < ankle_z + 0.025,
        "ankles": (z >= ankle_z + 0.025) & (z < cuff_z + 0.02) & (Wt.legs + Wt.feet > 0.3)
        & jeans_c & (trousers | shoes_cover),
        "legs": (z >= cuff_z + 0.02) & (Wt.legs > 0.3) & (Wt.arms + Wt.hands < 0.3) & trousers & jeans_c,
    }
    src = source_index(body)
    for r, mask in region.items():
        vg = body.vertex_groups.new(name=f"region_{r}")
        idx = np.nonzero(mask[src])[0].tolist()
        if idx:
            vg.add(idx, 1.0, "REPLACE")

    all_objs = [g for group in garments.values() for g in group]
    for o in [body] + all_objs:
        if "src_index" in o.data.attributes:
            o.data.attributes.remove(o.data.attributes["src_index"])
    log(name, "garments", {k: sum(len(o.data.polygons) for o in v) for k, v in garments.items()},
        "body faces hidden", removed, "regions", {r: int(m[src].sum()) for r, m in region.items()})
    parts["garments"] = garments
    return garments


def transfer_weights(obj, body, rig):
    """Copy the body's bone weights onto `obj` (nearest face, interpolated), max 4 per vertex."""
    activate(obj)
    obj.vertex_groups.clear()
    for vg in body.vertex_groups:
        if vg.name.startswith(B):
            obj.vertex_groups.new(name=vg.name)
    dt = obj.modifiers.new("Weights", "DATA_TRANSFER")
    dt.object = body
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "POLYINTERP_NEAREST"
    dt.layers_vgroup_select_src = "ALL"
    dt.layers_vgroup_select_dst = "NAME"
    bpy.ops.object.modifier_apply(modifier=dt.name)
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    for vg in list(obj.vertex_groups):
        if not any(vg.index == g.group for v in obj.data.vertices for g in v.groups):
            obj.vertex_groups.remove(vg)
    bind_armature(obj, rig)

"""Stage 3: accessories and graphics, placed on the dressed body by ray casts.

Backpack with straps, headphones, smartwatch, sunglasses, hoop earrings, necklace, the Cambodian
flag patch and the Angkor-style chest print. Rigid parts are skinned 100 % to one bone; parts
that wrap the body (straps, necklace, patches) copy the body's weights.
"""

from common import *
import garments as G
import setup_materials as mats

B = "mixamorig:"


def outer_tree(objs):
    """BVH over several meshes (the outermost layers), in world space."""
    bm = bmesh.new()
    for o in objs:
        tmp = bmesh.new()
        tmp.from_mesh(o.data)
        tmp.transform(o.matrix_world)
        me = bpy.data.meshes.new("_tmp")
        tmp.to_mesh(me)
        tmp.free()
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    from mathutils.bvhtree import BVHTree

    tree = BVHTree.FromBMesh(bm)
    bm.free()
    return tree


def onto(tree, point, direction, offset):
    """Ray from outside along `direction` onto the surface; returns hit + normal*offset."""
    origin = point - direction.normalized() * 0.5
    hit, nrm, _, _ = tree.ray_cast(origin, direction.normalized(), 1.0)
    if hit is None:
        return None, None
    return hit + nrm * offset, nrm


def strip(name, pts, normals, width, thickness, material):
    """A flat strap: ribbon along `pts` lying on the surface, with thickness."""
    verts, faces = [], []
    n = len(pts)
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
        side = t.cross(normals[i]).normalized()
        for k, off in enumerate((0, thickness)):
            base = p + normals[i] * off
            verts += [base - side * width / 2, base + side * width / 2]
    for i in range(n - 1):
        a, b = 4 * i, 4 * (i + 1)
        faces += [(a + 0, a + 1, b + 1, b + 0), (a + 3, a + 2, b + 2, b + 3), (a + 1, a + 3, b + 3, b + 1), (a + 2, a + 0, b + 0, b + 2)]
    faces += [(0, 2, 3, 1), (4 * (n - 1) + 1, 4 * (n - 1) + 3, 4 * (n - 1) + 2, 4 * (n - 1) + 0)]
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.materials.append(material)
    o = link(bpy.data.objects.new(name, me))
    return o


def rounded_box(name, size, bevel, material, segments=4, subdiv=1):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.object
    o.name = o.data.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    m = o.modifiers.new("Bevel", "BEVEL")
    m.width = bevel
    m.segments = segments
    m.limit_method = "NONE"
    apply_modifier(o, m.name)
    if subdiv:
        s = o.modifiers.new("Sub", "SUBSURF")
        s.levels = subdiv
        apply_modifier(o, s.name)
    assign_material(o, material)
    set_smooth(o)
    return o


def place(o, matrix):
    o.matrix_world = matrix
    activate(o)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def frame(origin, x, y, z):
    m = Matrix.Identity(4)
    for i, axis in enumerate((x, y, z)):
        m.col[i][:3] = axis.normalized()
    m.col[3][:3] = origin
    return m


def decal(name, tree, center, u_axis, v_axis, size_u, size_v, material, offset=0.0022, res=(10, 8), direction=None):
    """A grid conformed to the surface under it, UV 0..1 across (patches, prints)."""
    nrm_dir = direction or v_axis.cross(u_axis).normalized()
    verts, uvs, faces = [], [], []
    nu, nv = res
    for j in range(nv + 1):
        for i in range(nu + 1):
            u, v = i / nu, j / nv
            p = center + u_axis * (u - 0.5) * size_u + v_axis * (v - 0.5) * size_v
            hit, n = onto(tree, p, -nrm_dir, offset)
            verts.append(hit if hit is not None else p)
            uvs.append((u, v))
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            faces.append((a, a + 1, a + nu + 2, a + nu + 1))
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    uv = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[me.loops[li].vertex_index]
    me.materials.append(material)
    o = link(bpy.data.objects.new(name, me))
    set_smooth(o)
    return o


# ── Pieces ──────────────────────────────────────────────────────────────────────────────


def chest_print(spec, hoodie, L, M):
    tree = outer_tree([hoodie])
    female = spec["name"] == "female"
    w = 0.15 if female else 0.13
    zc = L.spine2.z + (0.035 if female else -0.01)
    c = Vector((0, -0.5, zc))
    hit, _ = onto(tree, c, Vector((0, 1, 0)), 0.0)
    center = Vector((0, hit.y if hit else -0.12, zc))
    return decal(f"{spec['name']}.chest_print", tree, center, Vector((1, 0, 0)), Vector((0, 0, 1)), w, w,
                 M["print"], direction=Vector((0, -1, 0)), res=(12, 12))


def flag_patch(spec, outer, L, M):
    """On the character's right upper arm, outer side (as in the references)."""
    tree = outer_tree([outer])
    s0, w0 = L.shoulder["Right"], L.wrist["Right"]
    a = (w0 - s0).normalized()
    out = Vector((-1, -0.45, 0.25))
    out = (out - a * out.dot(a)).normalized()
    p = s0 + (w0 - s0) * 0.24 + out * 0.2
    hit, n = onto(tree, p, -out, 0.0)
    if hit is None:
        return None
    u = a.cross(n).normalized()  # around the arm
    v = -a                       # up the arm, toward the shoulder
    if u.dot(Vector((0, -1, 0))) < 0:
        u = -u  # read left-to-right from the front
    return decal(f"{spec['name']}.flag_patch", tree, hit, u, v, 0.085, 0.056, M["flag"], direction=n, res=(10, 7))


def drawstrings_on(spec, hoodie, L, M):
    """Hoodie drawstrings lying on the fabric (replaces the free-hanging ones)."""
    tree = outer_tree([hoodie])
    out = []
    for sx in (-1, 1):
        pts = []
        for k in range(8):
            z = L.neck.z - 0.03 - 0.026 * k
            x = sx * (0.032 + 0.003 * math.sin(k * 1.3))
            hit, n = onto(tree, Vector((x, -0.4, z)), Vector((0, 1, 0)), 0.0042)
            if hit is not None:
                pts.append(hit)
        if len(pts) > 3:
            t = curve_tube(f"{spec['name']}.drawstring{sx}", pts, 0.0032, resolution=3, bevel_resolution=2)
            assign_material(t, M["string"])
            tip = pts[-1]
            ag = curve_tube(f"{spec['name']}.aglet{sx}", [tip, tip + Vector((0, -0.001, -0.022))], 0.0042, resolution=1)
            assign_material(ag, M["aglet"])
            out += [t, ag]
    return out


def backpack(spec, outer_objs, L, M):
    name = spec["name"]
    female = name == "female"
    tree = outer_tree(outer_objs)
    W, H, D = (0.28, 0.4, 0.13) if female else (0.31, 0.43, 0.15)
    zc = L.spine2.z - 0.05
    hit, n = onto(tree, Vector((0, 0.5, zc)), Vector((0, -1, 0)), 0.0)
    back_y = hit.y if hit else L.spine2.y + 0.12
    tilt = Matrix.Rotation(math.radians(-7), 4, "X")
    center = Vector((0, back_y + D / 2 + 0.008, zc))
    parts = []
    bag = rounded_box(f"{name}.backpack", (W, D, H), 0.04, M["bag"], segments=4, subdiv=1)
    # Soften the back panel against the body: pull its rear vertices slightly in.
    place(bag, Matrix.Translation(center) @ tilt)
    parts.append(bag)
    pocket = rounded_box(f"{name}.backpack_pocket", (W * 0.72, 0.045, H * 0.42), 0.018, M["bag"], segments=3, subdiv=1)
    place(pocket, Matrix.Translation(center + Vector((0, D / 2 + 0.012, -H * 0.2))) @ tilt)
    parts.append(pocket)
    # Accent side panels and piping.
    for sx in (-1, 1):
        panel = rounded_box(f"{name}.backpack_side{sx}", (0.012, D * 0.8, H * 0.82), 0.005, M["bag_accent"], segments=2, subdiv=0)
        place(panel, Matrix.Translation(center + Vector((sx * (W / 2 + 0.002), 0.004, -0.01))) @ tilt)
        parts.append(panel)
    pipe = []
    for k in range(17):
        a = math.pi * k / 16
        pipe.append(center + (tilt.to_3x3() @ Vector((-math.cos(a) * (W / 2 - 0.02), D / 2 + 0.003, H / 2 - 0.06 + math.sin(a) * 0.05))))
    p = curve_tube(f"{name}.backpack_zip", pipe, 0.004, resolution=2, bevel_resolution=1)
    assign_material(p, M["bag_accent"])
    parts.append(p)
    handle = curve_tube(f"{name}.backpack_handle", [center + tilt.to_3x3() @ Vector((x, 0.0, H / 2 + h)) for x, h in
                                                     ((-0.035, 0.0), (-0.02, 0.025), (0.02, 0.025), (0.035, 0.0))], 0.006)
    assign_material(handle, M["bag"])
    parts.append(handle)
    # Print on the pocket.
    print_tree = outer_tree([pocket])
    pc = center + Vector((0, D / 2 + 0.04, -H * 0.2))
    parts.append(decal(f"{name}.backpack_print", print_tree, pc, Vector((-1, 0, 0)), Vector((0, 0, 1)), 0.1, 0.1,
                       M["bag_print"], direction=Vector((0, 1, 0)), res=(6, 6), offset=0.0015))
    # Shoulder straps: bag top → over the shoulder → down the chest → under the arm → bag bottom.
    straps = []
    strap_tree = outer_tree(outer_objs)
    for sx in (-1, 1):
        sx_shoulder = abs(L.shoulder["Left"].x) * 0.62
        guide = []
        top = center + tilt.to_3x3() @ Vector((sx * 0.075, -D / 2, H / 2 - 0.03))
        guide.append((top + Vector((0, 0.05, 0.02)), Vector((0, -1, -0.3))))
        for k in range(5):  # over the shoulder (back → front)
            a = math.pi * (0.15 + 0.7 * k / 4)
            p = Vector((sx * sx_shoulder, L.neck.y + math.cos(a) * 0.12, L.shoulder["Left"].z + 0.03 + math.sin(a) * 0.12))
            guide.append((p, -Vector((0, math.cos(a), math.sin(a)))))
        for k in range(5):  # down the chest
            z = L.shoulder["Left"].z - 0.04 - 0.055 * k
            guide.append((Vector((sx * (sx_shoulder + 0.006 * k), -0.5, z)), Vector((0, 1, 0))))
        pts, nrms = [], []
        for p, d in guide:
            hit, nrm = onto(strap_tree, p, d, 0.006)
            if hit is not None:
                pts.append(hit)
                nrms.append(nrm)
        if len(pts) > 4:
            straps.append(strip(f"{name}.strap{sx}", pts, nrms, 0.045, 0.008, M["strap"]))
    # Sternum strap with a buckle.
    sz = L.spine2.z + 0.02
    sp = []
    for x in np.linspace(-abs(L.shoulder["Left"].x) * 0.66, abs(L.shoulder["Left"].x) * 0.66, 7):
        hit, nrm = onto(strap_tree, Vector((x, -0.5, sz)), Vector((0, 1, 0)), 0.016)
        if hit is not None:
            sp.append((hit, nrm))
    if len(sp) > 3:
        straps.append(strip(f"{name}.sternum", [p for p, _ in sp], [n for _, n in sp], 0.018, 0.004, M["strap"]))
        mid = sp[len(sp) // 2][0]
        buckle = rounded_box(f"{name}.buckle", (0.035, 0.01, 0.022), 0.004, M["bag_accent"], segments=2, subdiv=0)
        place(buckle, Matrix.Translation(mid + Vector((0, -0.006, 0))))
        straps.append(buckle)
    return parts, straps


def headphones(spec, L, M, tree, hooded=False):
    """Worn around the neck: cups resting on the collar at the front sides, band behind."""
    name = spec["name"]
    out = []
    n = L.neck
    cups = {}
    for sx in (-1, 1):
        d = Vector((sx * 0.55, -0.6, 0.55)).normalized()
        aim = Vector((sx * 0.105, n.y - 0.09, n.z - 0.05))
        # Approach the chest horizontally. A downward diagonal can pass through
        # an open neckline and hit the back, putting both cups behind the wearer.
        hit, nrm = onto(tree, aim, Vector((0, 1, 0)), 0.021)
        if hit is not None and (hit.y > n.y or sx * hit.x < 0.06):
            hit, nrm = None, None
        c = hit if hit is not None else aim
        axis = ((nrm if nrm is not None else d) + d).normalized()  # the cup faces out, forward and up
        cups[sx] = (c, axis)
        x = axis.cross(Vector((0, 0, 1))).normalized()
        y = axis.cross(x).normalized()
        m = frame(c, x, y, axis)
        bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.043, depth=0.032)
        cup = bpy.context.object
        cup.name = cup.data.name = f"{name}.headphone_cup{sx}"
        b = cup.modifiers.new("Bevel", "BEVEL")
        b.width = 0.008
        b.segments = 3
        apply_modifier(cup, b.name)
        place(cup, m)
        assign_material(cup, M["phones"])
        set_smooth(cup)
        bpy.ops.mesh.primitive_torus_add(major_segments=40, minor_segments=8, major_radius=0.034, minor_radius=0.0032)
        ring = bpy.context.object
        ring.name = ring.data.name = f"{name}.headphone_glow{sx}"
        place(ring, m @ Matrix.Translation((0, 0, 0.0165)))
        assign_material(ring, M["glow"])
        bpy.ops.mesh.primitive_torus_add(major_segments=32, minor_segments=10, major_radius=0.036, minor_radius=0.012)
        pad = bpy.context.object
        pad.name = pad.data.name = f"{name}.headphone_pad{sx}"
        place(pad, m @ Matrix.Translation((0, 0, -0.02)))
        assign_material(pad, M["phones_pad"])
        set_smooth(pad)
        out += [cup, ring, pad]
    # Only the hoodie needs the extra height and depth to clear its hood.
    band_pts = []
    for k in range(11):
        a = math.pi * (-0.5 + k / 10)
        depth = 0.1 if hooded else 0.065
        base_z = 0.02 if hooded else -0.035
        arch = 0.035 if hooded else 0.015
        p = Vector((math.sin(a) * 0.115, n.y + 0.03 + math.cos(a) * depth, n.z + base_z + arch * math.cos(a)))
        band_pts.append(p)
    for k, sx in ((0, -1), (-1, 1)):
        c, axis = cups[sx]
        band_pts[k] = c - axis * 0.012 + Vector((0, 0.025, 0.02))
    for i in range(1, len(band_pts) - 1):  # keep the band outside the hood and collar
        p = band_pts[i]
        d = (p - Vector((0, n.y, p.z))).normalized()
        hit, _ = onto(tree, p + d * 0.2, -d, 0.012)
        if hit is not None and (hit - Vector((0, n.y, p.z))).length > (p - Vector((0, n.y, p.z))).length:
            band_pts[i] = hit
    prof = rect_profile(f"{name}.hp_prof", 0.024, 0.009)
    bnd = curve_tube(f"{name}.headphone_band", band_pts, 0.0, profile=prof)
    bpy.data.objects.remove(prof)
    assign_material(bnd, M["phones"])
    out.append(bnd)
    return out


def watch(spec, body, L, M, side="Left"):
    """Smartwatch on the wrist: band around the wrist, case on the back of the wrist."""
    name = spec["name"]
    tree = outer_tree([body])
    s0, w0 = L.shoulder[side], L.wrist[side]
    a = (w0 - s0).normalized()
    sx = 1 if side == "Left" else -1
    c = w0 - a * 0.035
    dorsal = Vector((sx, 0.05, 0.25))
    dorsal = (dorsal - a * dorsal.dot(a)).normalized()
    side_v = a.cross(dorsal).normalized()
    ring, nrms = [], []
    for k in range(24):
        t = math.tau * k / 24
        d = dorsal * math.cos(t) + side_v * math.sin(t)
        hit, nrm = onto(tree, c + d * 0.12, -d, 0.002)
        if hit is not None:
            ring.append(hit)
            nrms.append(nrm)
    out = []
    if len(ring) > 12:
        ring.append(ring[0])
        nrms.append(nrms[0])
        out.append(strip(f"{name}.watch_band", ring, nrms, 0.02, 0.003, M["watch"]))
    top, n = onto(tree, c + dorsal * 0.12, -dorsal, 0.006)
    if top is not None:
        m = frame(top, a.cross(n), a, n)
        case = rounded_box(f"{name}.watch_case", (0.034, 0.04, 0.011), 0.005, M["watch"], segments=3, subdiv=0)
        place(case, m)
        screen = decal_plane(f"{name}.watch_screen", 0.028, 0.034, M["watch_screen"])
        place(screen, m @ Matrix.Translation((0, 0, 0.0057)))
        out += [case, screen]
    return out


def decal_plane(name, w, h, material):
    bpy.ops.mesh.primitive_plane_add(size=1)
    o = bpy.context.object
    o.name = o.data.name = name
    o.scale = (w, h, 1)
    bpy.ops.object.transform_apply(scale=True)
    assign_material(o, material)
    return o


def sunglasses(spec, head_tree, head_c, M):
    """Pushed up on top of the head, lenses tilted back."""
    name = spec["name"]
    d = Vector((0, -0.55, 1)).normalized()
    hit, nrm = onto(head_tree, head_c + d * 0.4, -d, 0.008)
    if hit is None:
        return []
    fwd = Vector((0, -1, 0))
    up = nrm
    right = fwd.cross(up).normalized() * -1
    out = []
    lens_w, lens_h = 0.056, 0.046
    for sx in (-1, 1):
        cen = hit + right * sx * 0.036 + (up.cross(right).normalized()) * 0.0
        m = frame(cen, right, up.cross(right).normalized() * -1, up)
        bpy.ops.mesh.primitive_cylinder_add(vertices=28, radius=0.5, depth=0.004)
        lens = bpy.context.object
        lens.name = lens.data.name = f"{name}.sunglass_lens{sx}"
        lens.scale = (lens_w, lens_h, 1)
        bpy.ops.object.transform_apply(scale=True)
        place(lens, m)
        assign_material(lens, M["lens"])
        bpy.ops.mesh.primitive_torus_add(major_segments=32, minor_segments=6, major_radius=0.5, minor_radius=0.05)
        rim = bpy.context.object
        rim.name = rim.data.name = f"{name}.sunglass_rim{sx}"
        rim.scale = (lens_w, lens_h, lens_w * 1.2)
        bpy.ops.object.transform_apply(scale=True)
        place(rim, m)
        assign_material(rim, M["frame"])
        out += [lens, rim]
        # Temple arm back over the head.
        outer = cen + right * sx * lens_w / 2
        pts = [outer]
        for k in range(1, 5):
            guess = outer + Vector((sx * 0.01 * k, 0.03 * k, -0.006 * k))
            radial = (guess - head_c).normalized()
            q, _ = onto(head_tree, guess, -radial, 0.004)
            pts.append(q if q is not None else guess)
        arm = curve_tube(f"{name}.sunglass_arm{sx}", pts, 0.0022, resolution=3)
        assign_material(arm, M["frame"])
        out.append(arm)
    bridge = curve_tube(f"{name}.sunglass_bridge", [hit - right * 0.009 + up * 0.003, hit + up * 0.006, hit + right * 0.009 + up * 0.003], 0.002)
    assign_material(bridge, M["frame"])
    out.append(bridge)
    return out


def earrings(spec, body, M):
    name = spec["name"]
    ears = group_weights(body, "ears") > 0.5
    co = coords(body)
    out = []
    for sx in (-1, 1):
        mine = ears & (np.sign(co[:, 0]) == sx)
        if not mine.any():
            continue
        pts = co[mine]
        lobe = Vector(pts[pts[:, 2].argmin()])
        bpy.ops.mesh.primitive_torus_add(major_segments=36, minor_segments=8, major_radius=0.013, minor_radius=0.0014)
        hoop = bpy.context.object
        hoop.name = hoop.data.name = f"{name}.earring{sx}"
        m = frame(lobe + Vector((sx * 0.003, 0.002, -0.012)), Vector((0, 1, 0)), Vector((0, 0, 1)), Vector((1, 0, 0)))
        place(hoop, m)
        assign_material(hoop, M["gold"])
        set_smooth(hoop)
        out.append(hoop)
    return out


def necklace(spec, body, outer, L, M):
    name = spec["name"]
    tree = outer_tree([body, outer])
    pts = []
    for k in range(25):
        a = math.tau * k / 24
        z = L.neck.z - 0.004 - 0.03 * (0.5 - 0.5 * math.cos(a))  # lowest at the front (a=π)
        d = Vector((math.sin(a), math.cos(a), 0))
        hit, nrm = onto(tree, Vector((0, L.neck.y, z)) + d * 0.3, -d, 0.0025)
        if hit is not None:
            pts.append(hit)
    out = []
    if len(pts) > 12:
        chain = curve_tube(f"{name}.necklace", pts[:-1], 0.0011, closed=True, resolution=2, bevel_resolution=1)
        assign_material(chain, M["silver"])
        out.append(chain)
        front = min(pts, key=lambda p: p.y)
        bpy.ops.mesh.primitive_uv_sphere_add(segments=14, ring_count=8, radius=0.008)
        pend = bpy.context.object
        pend.name = pend.data.name = f"{name}.pendant"
        pend.scale = (0.9, 0.45, 1.25)
        bpy.ops.object.transform_apply(scale=True)
        place(pend, Matrix.Translation(front + Vector((0, -0.004, -0.012))))
        assign_material(pend, M["silver"])
        set_smooth(pend)
        out.append(pend)
    return out


# ── Stage ───────────────────────────────────────────────────────────────────────────────


def accessory_materials(spec):
    c = spec["colors"]
    female = spec["name"] == "female"
    print_png = mats.angkor_print(c["hoodie_print"], f"{spec['name']}_print.png")
    bag_print = mats.angkor_print("#e9e9ee", "bag_print.png")
    M = {
        "print": mats.textured("ChestPrint", print_png, roughness=0.85, alpha="CLIP"),
        "flag": mats.textured("FlagPatch", mats.flag_patch("flag_patch.png"), roughness=0.75, alpha="CLIP"),
        "bag": mats.flat("Backpack", c["backpack"], roughness=0.6),
        "bag_accent": mats.flat("BackpackAccent", c["backpack_accent"], roughness=0.5),
        "bag_print": mats.textured("BackpackPrint", bag_print, roughness=0.7, alpha="CLIP"),
        "strap": mats.flat("Strap", "#121215", roughness=0.75),
        "watch": mats.flat("Watch", c["watch"], roughness=0.35, metallic=0.3),
        "watch_screen": mats.textured("WatchScreen", mats.watch_face(c["watch_screen"], f"{spec['name']}_watch.png"),
                                      roughness=0.1, emission=1.5),
        "string": mats.flat("Drawstring", "#f1efe9" if female else "#26262a", roughness=0.7),
        "aglet": mats.flat("Aglet", "#b9bcc2", roughness=0.35, metallic=0.6),
    }
    if not female:
        M.update({
            "phones": mats.flat("Headphones", c["headphones"], roughness=0.35),
            "phones_pad": mats.flat("HeadphonePad", "#0d0d0f", roughness=0.7),
            "glow": mats.flat("HeadphoneGlow", c["headphones_glow"], roughness=0.3, emission=3.0),
        })
    else:
        M.update({
            "frame": mats.flat("SunglassFrame", c["sunglasses"], roughness=0.3),
            "lens": mats.flat("SunglassLens", c["lens"], roughness=0.05, metallic=0.2, specular=0.8),
            "gold": mats.flat("Gold", c["gold"], roughness=0.25, metallic=1.0),
            "silver": mats.flat("Silver", c["silver"], roughness=0.2, metallic=1.0),
        })
    return M


def build_accessories(spec, body, rig, parts):
    """Accessories. Those that sit on the top (prints, flag patch, drawstrings, backpack straps,
    headphones, necklace) are fitted to each top the wardrobe offers and tagged with it; the
    original top's are made exactly as before. The watch, sunglasses and earrings are always worn."""
    import outfits as O

    name = spec["name"]
    L = G.Landmarks(rig)
    M = accessory_materials(spec)
    gar = parts["garments"]
    rigid, wrapped = [], []

    def fitted(top, objs):
        for o in objs:
            if o is not None:
                O.tag(o, "top", top)
        return objs

    def bag_for(top, objs):
        for o in objs:
            O.tag(o, "bag", "backpack", with_=f"top.{top}")
        return objs

    # ── The original top: hoodie (under the jacket on the male) ──
    hoodie = gar["hoodie"][0]
    outer = gar["jacket"][0] if "jacket" in gar else hoodie
    outer_objs = [o for o in (outer, hoodie) if o]
    # Replace the free-hanging drawstrings with ones lying on the fabric.
    for o in list(gar["hoodie"]):
        if ".drawstring" in o.name or ".aglet" in o.name:
            gar["hoodie"].remove(o)
            bpy.data.objects.remove(o)
    wrapped += fitted("hoodie", drawstrings_on(spec, hoodie, L, M))
    wrapped += fitted("hoodie", [chest_print(spec, hoodie, L, M)])
    wrapped += fitted("hoodie", [flag_patch(spec, outer, L, M)])
    bag, straps = backpack(spec, outer_objs, L, M)
    rigid += [(o, "Spine2") for o in bag_for("hoodie", bag)]
    wrapped += bag_for("hoodie", straps)
    if "headphones" in spec["outfit"]:
        neckwear = [o for o in gar.get("jacket", []) + gar["hoodie"] if o.name.endswith((".hood", ".collar", ".jacket"))]
        rigid += [(o, "Spine2") for o in fitted("hoodie", headphones(spec, L, M, outer_tree(neckwear), hooded=True))]
    if "necklace" in spec["outfit"]:
        wrapped += fitted("hoodie", necklace(spec, body, hoodie, L, M))

    # ── The other tops ──
    for top in ("tee", "shirt"):
        shell = gar[top][0]
        if top == "tee":
            wrapped += fitted(top, [chest_print(spec, shell, L, M)])
        wrapped += fitted(top, [flag_patch(spec, shell, L, M)])
        bag, straps = backpack(spec, [shell], L, M)
        rigid += [(o, "Spine2") for o in bag_for(top, bag)]
        wrapped += bag_for(top, straps)
        if "headphones" in spec["outfit"]:
            neckwear = [o for o in gar[top] if o.name.split(".")[-1].startswith(("tee_neck", "shirt_collar", "tee", "shirt"))]
            rigid += [(o, "Spine2") for o in fitted(top, headphones(spec, L, M, outer_tree(neckwear)))]
        if "necklace" in spec["outfit"]:
            wrapped += fitted(top, necklace(spec, body, shell, L, M))

    # ── Always worn ──
    for o in watch(spec, body, L, M, "Left"):
        rigid.append((o, "LeftForeArm"))
    if "sunglasses" in spec["outfit"]:
        hair_objs = [parts["hair"]] + list(parts.get("hair_cards", []))
        import hair as H

        head = H.Head(body)
        shades = sunglasses(spec, outer_tree(hair_objs + [body]), head.center, M)
        for o in shades:
            o["region"] = "hair_top"  # pushed up on the head: they go under a hat with the hair
        rigid += [(o, "Head") for o in shades]
    if "earrings" in spec["outfit"]:
        rigid += [(o, "Head") for o in earrings(spec, body, M)]

    for o, bone in rigid:
        rigid_bind(o, rig, B + bone)
    for o in wrapped:
        if o is not None:
            G.transfer_weights(o, body, rig)
    acc = [o for o, _ in rigid] + [o for o in wrapped if o is not None]
    parts["accessories"] = acc
    log(name, "accessories", len(acc), "objects,", sum(len(o.data.polygons) for o in acc), "faces")
    return acc

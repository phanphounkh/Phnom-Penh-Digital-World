"""Vehicle models for Phnom Penh Digital World (original work, CC0): a city bicycle with a
front basket and a reference-inspired Dream-style step-through motorbike.
An original visual approximation, not a manufacturer-provided or dimensionally exact asset.

Run:  blender --background --python-use-system-env --python tools/blender/generate_vehicle_assets.py
Writes frontend/static/models/vehicles/{bicycle,motorbike}.glb.
Then compress:  (cd frontend && npm run assets:compress)

Conventions relied on by the web client (frontend/src/lib/game/vehicles/VehicleModels.ts):
* Metres, Y up after export, origin on the ground midway between the wheel contact points;
  the vehicle faces +Z after export (Blender -Y), like the avatar.
* Nodes: `Body` (static, one multi-material mesh), `Steer` (an empty at the steering head;
  rotating it about Y steers the fork, bars and front wheel), `WheelFront` (under Steer) and
  `WheelRear` (origins at the hubs; spin about X).
* Anchor empties for posing the rider: `Seat` (hips), `GripL`/`GripR` (hands), `PegL`/`PegR`
  (feet; on the bicycle `Crank` is the bottom bracket the pedals turn about). `L` is -X, the
  side of the avatar rig's LeftArm/LeftLeg.
* Materials: `Paint` takes the vehicle's colour and `PaintDark` a darker shade of it;
  `Light` glows at night; `TailLight`, `Rubber`, `Metal`, `Chrome`, `Seat`, `Plastic`,
  `Rattan`, and `Plate` (a fictional decorative plate).
"""

import math
import os

import bpy
from mathutils import Vector

OUT = os.path.abspath(
    os.environ.get(
        "PPW_MODEL_OUTPUT", os.path.join(os.path.dirname(__file__), "../../frontend/static/models")
    )
)

COLORS = {
    "Paint": ("#c4552f", 0.25, 0.35),
    "PaintDark": ("#6b2a16", 0.2, 0.45),
    "Metal": ("#4a5055", 0.7, 0.4),
    "Chrome": ("#c9cfd3", 0.95, 0.18),
    "Rubber": ("#1b1d1f", 0.0, 0.85),
    "Seat": ("#24201d", 0.0, 0.6),
    "Plastic": ("#2c3034", 0.1, 0.55),
    "Light": ("#fff6dc", 0.0, 0.2),
    "TailLight": ("#c8261d", 0.1, 0.3),
    "Rattan": ("#b8874f", 0.0, 0.9),
    "Plate": ("#f2efe6", 0.0, 0.6),
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
    if name in ("Light", "TailLight"):
        p.inputs["Emission Color"].default_value = (*rgb, 1)
        p.inputs["Emission Strength"].default_value = 0.6
    m.diffuse_color = (*rgb, 1)
    MATERIALS[name] = m
    return m


def finish(o, material: str, smooth: bool = False):
    o.data.materials.clear()
    o.data.materials.append(mat(material))
    for poly in o.data.polygons:
        poly.use_smooth = smooth
    return o


def box(name, size, loc, material, rot=(0, 0, 0), bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = size
    if bevel:
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        mod = o.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 3
        bpy.ops.object.modifier_apply(modifier=mod.name)
        return finish(o, material, True)
    return finish(o, material)


def cylinder(name, r, depth, loc, material, axis="Z", verts=16, r2=None):
    rot = {"X": (0, math.radians(90), 0), "Y": (math.radians(90), 0, 0), "Z": (0, 0, 0)}[axis]
    bpy.ops.mesh.primitive_cone_add(
        vertices=verts, radius1=r, radius2=r if r2 is None else r2, depth=depth,
        location=loc, rotation=rot,
    )
    o = bpy.context.object
    o.name = name
    return finish(o, material, True)


def tube(name, a, b, r, material, verts=10):
    a, b = Vector(a), Vector(b)
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=d.length, location=(a + b) / 2)
    o = bpy.context.object
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = d.to_track_quat("Z", "Y")
    o.name = name
    return finish(o, material, True)


def torus_x(name, centre, major, minor, material, segments=32):
    """A ring in the YZ plane (axis X): tyres and rims."""
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major, minor_radius=minor, major_segments=segments, minor_segments=8,
        location=centre, rotation=(0, math.radians(90), 0),
    )
    o = bpy.context.object
    o.name = name
    return finish(o, material, True)


def empty(name, loc):
    bpy.ops.object.empty_add(type="PLAIN_AXES", radius=0.05, location=loc)
    o = bpy.context.object
    o.name = name
    return o


def join(objects, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = name
    return o


def parent(child, to):
    child.parent = to
    child.matrix_parent_inverse = to.matrix_world.inverted()


def wheel(name, hub, radius, tyre, spokes, cast=False):
    """Tyre, rim, hub and spokes, joined, origin at the hub (the hub cylinder comes first)."""
    hx, hy, hz = hub
    parts = [cylinder(name + "Hub", 0.04 if cast else 0.025, 0.11 if cast else 0.1, hub, "Metal", axis="X")]
    parts.append(torus_x(name + "Tyre", hub, radius - tyre, tyre, "Rubber"))
    rim_r = radius - tyre * 2
    parts.append(torus_x(name + "Rim", hub, rim_r, 0.012 if not cast else 0.02, "Chrome" if not cast else "Metal"))
    for k in range(spokes):
        a = k / spokes * math.tau
        end = (hx, hy + math.sin(a) * rim_r, hz + math.cos(a) * rim_r)
        if cast:
            parts.append(tube(name + f"Spoke{k}", hub, end, 0.018, "Metal", verts=6))
        else:
            side = 0.03 if k % 2 else -0.03
            parts.append(tube(name + f"Spoke{k}", (hx + side, hy, hz), end, 0.003, "Chrome", verts=4))
    return join(parts, name)


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


# ── bicycle ────────────────────────────────────────────────────────────────────────────


def bicycle() -> None:
    """A step-through city bicycle (26" wheels, 1.05 m wheelbase) with a front basket and a
    rear rack. Blender: front towards -Y."""
    r = 0.33
    front, rear = (0, -0.53, r), (0, 0.52, r)
    bb = (0, 0.06, 0.29)
    cluster = (0, 0.22, 0.72)
    head_top, head_low = (0, -0.43, 0.86), (0, -0.40, 0.70)
    body = []
    # Frame: curved step-through down tube, seat tube, stays.
    body.append(tube("HeadTube", head_low, head_top, 0.022, "Paint"))
    body.append(tube("Down1", (0, -0.41, 0.74), (0, -0.26, 0.42), 0.024, "Paint"))
    body.append(tube("Down2", (0, -0.26, 0.42), bb, 0.024, "Paint"))
    body.append(tube("SeatTube", bb, cluster, 0.02, "Paint"))
    for x in (-0.055, 0.055):
        body.append(tube("Chainstay", bb, (x, rear[1], rear[2]), 0.011, "Paint"))
        body.append(tube("Seatstay", (x * 0.4, cluster[1], cluster[2] - 0.02), (x, rear[1], rear[2]), 0.01, "Paint"))
    body.append(tube("SeatPost", cluster, (0, 0.25, 0.86), 0.013, "Chrome"))
    body.append(box("Saddle", (0.16, 0.26, 0.06), (0, 0.27, 0.89), "Seat", bevel=0.02))
    # Drivetrain.
    body.append(cylinder("Chainring", 0.095, 0.008, (0.07, bb[1], bb[2]), "Chrome", axis="X", verts=24))
    body.append(cylinder("Cog", 0.04, 0.008, (0.07, rear[1], rear[2]), "Chrome", axis="X"))
    for z in (0.095, -0.095):
        body.append(tube("Chain", (0.07, bb[1], bb[2] + z), (0.07, rear[1], rear[2] + z * 0.42), 0.005, "Metal", verts=4))
    body.append(box("ChainGuard", (0.012, 0.5, 0.08), (0.085, 0.3, 0.33), "PaintDark"))
    # Cranks and pedals: static (the client moves the rider's feet round the crank circle).
    for side, x in ((-1, -0.09), (1, 0.09)):
        tip = (x, bb[1] + 0.0 * side, bb[2] - 0.165 * side)
        body.append(tube("Crank", (x * 0.8, bb[1], bb[2]), tip, 0.009, "Metal", verts=6))
        body.append(box("Pedal", (0.09, 0.06, 0.02), (x * 1.5, tip[1], tip[2]), "Plastic"))
    # Rear rack and mudguards.
    body.append(box("Rack", (0.14, 0.34, 0.012), (0, 0.52, 0.71), "Metal"))
    for x in (-0.07, 0.07):
        body.append(tube("RackStay", (x, 0.66, 0.71), (x, rear[1] + 0.02, rear[2]), 0.006, "Metal", verts=6))
    body.append(box("Reflector", (0.06, 0.012, 0.03), (0, 0.70, 0.68), "TailLight"))
    body.append(box("Plate", (0.11, 0.004, 0.06), (0, 0.69, 0.62), "Plate"))
    body_obj = join(body, "Body")

    steer = empty("Steer", head_top)
    front_parts = []
    for x in (-0.05, 0.05):
        front_parts.append(tube("Fork", (x * 0.4, head_low[1], head_low[2]), (x, front[1], front[2]), 0.012, "Chrome"))
    front_parts.append(tube("Stem", head_top, (0, -0.42, 0.99), 0.014, "Chrome"))
    front_parts.append(tube("Bar", (-0.29, -0.33, 1.0), (0.29, -0.33, 1.0), 0.011, "Chrome"))
    for x in (-0.29, 0.29):
        front_parts.append(tube("BarSweep", (x * 0.5, -0.42, 0.99), (x, -0.33, 1.0), 0.011, "Chrome"))
        front_parts.append(cylinder("Grip", 0.017, 0.1, (x * 1.05, -0.33, 1.0), "Rubber", axis="X"))
    # The basket: rattan-coloured wire basket on the bars.
    front_parts.append(box("BasketBottom", (0.34, 0.26, 0.01), (0, -0.66, 0.78), "Rattan"))
    front_parts.append(box("BasketFront", (0.34, 0.01, 0.2), (0, -0.79, 0.88), "Rattan"))
    front_parts.append(box("BasketBack", (0.34, 0.01, 0.2), (0, -0.53, 0.88), "Rattan"))
    for x in (-0.17, 0.17):
        front_parts.append(box("BasketSide", (0.01, 0.26, 0.2), (x, -0.66, 0.88), "Rattan"))
    front_parts.append(cylinder("Lamp", 0.035, 0.05, (0, -0.81, 0.86), "Light", axis="Y"))
    steer_mesh = join(front_parts, "SteerParts")
    parent(steer_mesh, steer)
    wf = wheel("WheelFront", front, r, 0.022, 24)
    parent(wf, steer)
    wheel("WheelRear", rear, r, 0.022, 24)

    empty("Seat", (0, 0.24, 0.92))
    empty("GripL", (-0.27, -0.33, 1.0))
    empty("GripR", (0.27, -0.33, 1.0))
    empty("Crank", bb)
    empty("PegL", (-0.13, bb[1], bb[2]))
    empty("PegR", (0.13, bb[1], bb[2]))
    assert body_obj.name == "Body"
    export("vehicles/bicycle")


# ── motorbike ──────────────────────────────────────────────────────────────────────────


def mesh_surface(name, vertices, faces, material, smooth=True):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return finish(obj, material, smooth)


def loft(name, sections, material, sides=16):
    """Rounded cross sections along Y: (y, z centre, width, height)."""
    vertices = []
    for y, z, width, height in sections:
        for k in range(sides):
            angle = math.tau * k / sides
            # Superellipse gives a softly rounded rectangular panel, without subdivision.
            c, sn = math.cos(angle), math.sin(angle)
            vertices.append((width / 2 * math.copysign(abs(c)**0.55, c), y,
                             z + height / 2 * math.copysign(abs(sn)**0.55, sn)))
    faces = [tuple(range(sides))]
    for j in range(len(sections)-1):
        for k in range(sides):
            a, b = j*sides+k, j*sides+(k+1)%sides
            faces.append((a, a+sides, b+sides, b))
    faces.append(tuple(reversed(range((len(sections)-1)*sides, len(sections)*sides))))
    return mesh_surface(name, vertices, faces, material)


def path_tube(name, points, radius, material):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.resolution_u = 1
    curve.bevel_depth = radius
    curve.bevel_resolution = 0
    spline = curve.splines.new('POLY')
    spline.points.add(len(points)-1)
    for pt, co in zip(spline.points, points):
        pt.co = (*co, 1)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target='MESH')
    return finish(bpy.context.object, material, True)


def mudguard(name, hub, radius, material, start=-1.4, end=1.4):
    vertices, faces = [], []
    for j in range(25):
        angle = start+(end-start)*j/24
        for k in range(7):
            x = (k/6-.5)*.14
            rr = radius-.018*(x/.07)**2
            vertices.append((x, hub[1]+math.sin(angle)*rr, hub[2]+math.cos(angle)*rr))
    for j in range(24):
        for k in range(6):
            a=j*7+k
            faces.append((a,a+1,a+8,a+7))
    obj=mesh_surface(name,vertices,faces,material)
    mod=obj.modifiers.new('Shell thickness','SOLIDIFY'); mod.thickness=.004
    bpy.context.view_layer.objects.active=obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def dream_wheel(name, hub):
    parts=[cylinder(name+'Drum',.072,.105,hub,'Alloy',axis='X',verts=24)]
    parts.append(torus_x(name+'Tyre',hub,.255,.035,'Rubber',48))
    for x in (-.021,.021):
        parts.append(torus_x(name+'Rim',(x,hub[1],hub[2]),.222,.008,'Chrome',48))
    # Alternating left/right crossed spokes, rather than cast alloy spokes.
    for k in range(36):
        a=k*math.tau/36
        b=a+(.38 if k%2 else -.38)
        x=.043 if k%2 else -.043
        parts.append(tube('Spoke',(x,hub[1]+.057*math.sin(b),hub[2]+.057*math.cos(b)),
                          (x*.35,hub[1]+.222*math.sin(a),hub[2]+.222*math.cos(a)),
                          .0018,'Chrome',verts=4))
    return join(parts,name)


def label(name, text, loc, size, material, rotation, align='CENTER'):
    curve=bpy.data.curves.new(name,'FONT');curve.body=text;curve.size=size
    curve.align_x=align;curve.align_y='CENTER';curve.resolution_u=2
    obj=bpy.data.objects.new(name,curve);bpy.context.collection.objects.link(obj)
    obj.location=loc;obj.rotation_euler=rotation
    bpy.ops.object.select_all(action='DESELECT');obj.select_set(True)
    bpy.context.view_layer.objects.active=obj;bpy.ops.object.convert(target='MESH')
    return finish(bpy.context.object,material)


def motorbike() -> None:
    """Reference-inspired Dream 125 exterior, original procedural mesh, not OEM CAD.
    Existing wheelbase and rider anchors are retained for gameplay compatibility.
    """
    COLORS.update({
        'DreamBlack': ('#161d22',.42,.24), 'Alloy': ('#9da3a7',.72,.34),
        'Gold': ('#d7a640',.55,.32), 'Ivory': ('#ebe7dc',.15,.4),
        'Amber': ('#ef900e',.1,.27), 'Dial': ('#141a1d',.15,.5),
        'PlateInk': ('#20427d',.05,.5), 'Needle': ('#ec4d28',.1,.4),
    })
    front,rear=(0,-.62,.29),(0,.62,.29)
    head=(0,-.47,.82)
    body=[tube('Underbone',head,(0,-.23,.4),.034,'DreamBlack'),
          tube('LowerFrame',(0,-.23,.4),(0,.45,.54),.028,'Metal')]
    # Curved, narrow step-through shield: wide at shoulders, tucked around the engine.
    verts=[]
    stations=[(.39,-.18,.12),(.46,-.25,.22),(.6,-.36,.30),(.78,-.45,.33),(.91,-.48,.26),(.94,-.48,.18)]
    for z,y,w in stations:
        for k in range(13):
            t=k/12*2-1
            verts.append((t*w/2,y+.068*t*t,z-.016*t*t))
    faces=[]
    for j in range(len(stations)-1):
        for k in range(12):
            a=j*13+k;faces.append((a,a+1,a+14,a+13))
    shield=mesh_surface('CurvedLegShield',verts,faces,'DreamBlack')
    mod=shield.modifiers.new('Panel thickness','SOLIDIFY');mod.thickness=.008
    bpy.context.view_layer.objects.active=shield;bpy.ops.object.modifier_apply(modifier=mod.name)
    body.append(shield)
    body.append(loft('StepThroughTunnel',[(-.28,.41,.13,.09),(-.1,.44,.13,.1),(.08,.55,.18,.19),(.18,.64,.24,.18)],'DreamBlack'))
    body.append(loft('RearFairing',[(.04,.66,.17,.16),(.17,.66,.27,.24),(.39,.66,.29,.23),(.65,.69,.25,.17),(.79,.72,.17,.08)],'DreamBlack'))
    body.append(loft('LongSaddle',[(-.035,.8,.16,.06),(.015,.812,.25,.09),(.22,.815,.29,.095),(.5,.82,.29,.10),(.72,.818,.265,.09),(.78,.81,.18,.06)],'Seat',24))
    for side in (-1,1):
        # Body stripes follow the real panel rather than changing the footprint.
        x=side*.148
        order = (0,1,2,3,4) if side > 0 else (4,3,2,1,0)
        body.append(mesh_surface('GoldSweep',[(x,.12,.715),(x,.59,.715),(side*.13,.72,.74),(x,.53,.684),(x,.28,.65)],[order],'Gold',False))
        order = (0,1,2,3) if side > 0 else (3,2,1,0)
        body.append(mesh_surface('IvorySweep',[(x*1.008,.12,.726),(x*1.008,.60,.727),(side*.135,.71,.745),(x*1.008,.55,.714)],[order],'Ivory',False))
        # Text lies in YZ; its normal points outwards on each side.
        body.append(label('DreamBadge','Dream 125',(side*.15,.38,.701),.037,'Ivory',
                          (math.pi/2,0,side*math.pi/2)))
        body.append(path_tube('SaddlePiping',[(side*.11,.0,.8),(side*.143,.22,.8),(side*.143,.5,.803),(side*.13,.72,.8)],.002,'Plastic'))
    # Horizontal four-stroke engine and detailed crankcase covers.
    body.append(box('EngineBlock',(.19,.22,.14),(0,.04,.3),'Alloy',bevel=.025))
    for side in (-1,1):
        body.append(cylinder('Crankcase',.09,.035,(side*.112,.06,.31),'Alloy',axis='X',verts=24))
        body.append(cylinder('CaseInset',.06,.004,(side*.132,.06,.31),'Alloy',axis='X',verts=24))
        for k in range(5):
            a=k*math.tau/5
            body.append(cylinder('CaseBolt',.006,.008,(side*.135,.06+.074*math.sin(a),.31+.074*math.cos(a)),'Chrome',axis='X',verts=6))
        body.append(tube('Swingarm',(side*.085,.12,.29),(side*.085,.62,.29),.018,'Alloy'))
        body.append(tube('RearShock',(side*.12,.6,.3),(side*.12,.48,.67),.012,'Chrome'))
        points=[]
        for k in range(65):
            t=k/64;a=t*math.tau*8
            points.append((side*.12+.023*math.cos(a),.58-.08*t+.022*math.sin(a),.36+.24*t))
        body.append(path_tube('SuspensionSpring',points,.004,'Chrome'))
        body.append(tube('RiderFootpeg',(side*.10,.04,.31),(side*.20,.04,.31),.018,'Rubber'))
        body.append(tube('PassengerFootpeg',(side*.12,.42,.4),(side*.20,.42,.4),.013,'Rubber'))
    for k in range(7):
        body.append(box('CylinderFin',(.16,.012,.115),(0,-.11-k*.017,.31),'Alloy',bevel=.003))
    body.append(cylinder('CylinderHead',.059,.045,(0,-.245,.31),'Alloy',axis='Y'))
    body.append(path_tube('ExhaustHeader',[(.045,-.22,.25),(.08,-.25,.20),(.17,-.12,.19),(.19,.14,.22)],.018,'Chrome'))
    body.append(cylinder('ChromeSilencer',.042,.64,(.19,.44,.235),'Chrome',axis='Y',verts=24,r2=.048))
    body.append(cylinder('ExhaustOutlet',.025,.004,(.19,.765,.235),'Rubber',axis='Y'))
    body.append(box('ChromeHeatShield',(.016,.45,.047),(.233,.38,.26),'Chrome',bevel=.012))
    body.append(box('ChainEnclosure',(.035,.49,.10),(-.105,.37,.31),'Alloy',bevel=.027))
    body.append(path_tube('KickStarter',[(.145,.1,.31),(.17,.16,.45),(.22,.16,.45)],.009,'Chrome'))
    body.append(tube('GearLever',(-.15,.07,.29),(-.15,-.08,.29),.008,'Chrome'))
    body.append(mudguard('RearMudguard',rear,.322,'DreamBlack',-.8,2.1))
    body.append(box('RearMudflap',(.14,.018,.23),(0,.87,.35),'Rubber',rot=(-.18,0,0),bevel=.008))
    body.append(path_tube('PassengerGrabRail',[(-.14,.51,.80),(-.155,.73,.82),(-.12,.83,.82),(.12,.83,.82),(.155,.73,.82),(.14,.51,.80)],.012,'Chrome'))
    body.append(box('TailHousing',(.23,.08,.11),(0,.81,.705),'Plastic',bevel=.025))
    body.append(box('TailLens',(.19,.025,.073),(0,.856,.714),'TailLight',bevel=.015))
    for side in (-1,1):
        body.append(tube('RearIndicatorStem',(side*.09,.8,.65),(side*.16,.8,.65),.009,'Plastic'))
        body.append(box('RearAmberLens',(.065,.048,.041),(side*.17,.81,.65),'Amber',bevel=.012))
    body.append(box('PlateFrame',(.187,.015,.13),(0,.887,.535),'Chrome',bevel=.008))
    body.append(box('VirtualPlate',(.175,.004,.118),(0,.897,.535),'Plate',bevel=.004))
    body.append(label('PlateNumber','PPW 125',(0,.900,.543),.034,'PlateInk',(math.pi/2,0,math.pi)))
    body.append(label('PlateCity','PHNOM PENH',(0,.900,.503),.015,'PlateInk',(math.pi/2,0,math.pi)))
    join(body,'Body')

    steer=empty('Steer',head);parts=[]
    for side in (-1,1):
        x=side*.066
        parts.append(tube('ForkUpper',(x,-.49,.84),(x,-.57,.48),.022,'DreamBlack'))
        parts.append(tube('ForkSlider',(x,-.57,.49),(x,-.62,.29),.017,'Alloy'))
    parts.append(mudguard('FrontMudguard',front,.335,'DreamBlack'))
    parts.append(loft('HandlebarCowl',[(-.65,1.005,.31,.12),(-.61,1.015,.39,.15),(-.48,1.03,.35,.14),(-.40,1.025,.23,.09)],'DreamBlack'))
    parts.append(box('HeadlampChrome',(.213,.024,.125),(0,-.661,1.01),'Chrome',bevel=.028))
    parts.append(box('RectangularHeadlamp',(.188,.015,.101),(0,-.678,1.011),'Light',bevel=.021))
    for k in range(9):
        x=(k-4)*.018
        parts.append(tube('LensFluting',(x,-.687,.98),(x,-.687,1.045),.001,'Ivory',verts=4))
    for side in (-1,1):
        parts.append(box('FrontAmberIndicator',(.075,.025,.072),(side*.147,-.651,1.008),'Amber',bevel=.014))
        parts.append(tube('Handlebar',(side*.14,-.46,1.03),(side*.385,-.44,1.03),.012,'Chrome'))
        parts.append(cylinder('Grip',.018,.105,(side*.333,-.44,1.03),'Rubber',axis='X'))
        parts.append(box('SwitchHousing',(.04,.055,.045),(side*.265,-.44,1.03),'Plastic',bevel=.009))
        parts.append(path_tube('BrakeLever',[(side*.26,-.47,1.02),(side*.31,-.50,1.02),(side*.38,-.485,1.02)],.005,'Chrome'))
        parts.append(path_tube('MirrorStem',[(side*.23,-.48,1.065),(side*.25,-.48,1.14),(side*.34,-.46,1.27)],.006,'Chrome'))
        parts.append(box('MirrorBack',(.123,.035,.074),(side*.35,-.46,1.29),'Plastic',rot=(0,side*.13,side*.12),bevel=.029))
        parts.append(box('MirrorGlass',(.108,.005,.060),(side*.35,-.439,1.29),'Chrome',rot=(0,side*.13,side*.12),bevel=.024))
    # Chrome front carrier and crossbars, above the fender with clearance for steering.
    for x in (-.13,.13):
        parts.append(path_tube('RackRail',[(x,-.51,.84),(x,-.6,.73),(x,-.86,.73)],.006,'Chrome'))
    for y in (-.60,-.68,-.76,-.84):
        parts.append(tube('RackCrossbar',(-.13,y,.73),(.13,y,.73),.004,'Chrome'))
    for x in (-.065,0,.065):
        parts.append(tube('RackLongitudinal',(x,-.60,.73),(x,-.84,.73),.003,'Chrome'))
    for z in (.83,.85,.87):
        parts.append(box('ShieldVent',(.085,.008,.006),(0,-.489,z),'Plastic',bevel=.002))
    # Visible low-cost analogue gauge. Decorative dial, not a live telemetry display.
    parts.append(box('InstrumentBezel',(.16,.1,.018),(0,-.455,1.106),'Plastic',bevel=.027))
    parts.append(cylinder('Speedometer',.044,.005,(0,-.455,1.117),'Dial',verts=32))
    for k in range(13):
        a=(-.75+k/12*1.5)*math.pi
        x,y=math.sin(a),math.cos(a)
        parts.append(tube('DialTick',(x*.033,-.455+y*.033,1.12),(x*.04,-.455+y*.04,1.12),.001,'Ivory',verts=4))
    parts.append(tube('GaugeNeedle',(0,-.455,1.122),(-.025,-.477,1.122),.0015,'Needle',verts=4))
    parts.append(label('NeutralIndicator','N',(-.058,-.45,1.12),.012,'Ivory',(0,0,0)))
    parent(join(parts,'SteerParts'),steer)
    parent(dream_wheel('WheelFront',front),steer)
    dream_wheel('WheelRear',rear)
    empty('Seat',(0,.22,.86))
    parent(empty('GripL',(-.33,-.44,1.03)),steer)
    parent(empty('GripR',(.33,-.44,1.03)),steer)
    empty('PegL',(-.17,.04,.32));empty('PegR',(.17,.04,.32))
    # Save an optional review scene before export resets the scene.
    if os.environ.get('PPW_VEHICLE_BLEND'):
        bpy.ops.wm.save_as_mainfile(filepath=os.environ['PPW_VEHICLE_BLEND'])
    export('vehicles/motorbike')


if __name__ == '__main__':
    reset()
    for build in (bicycle,motorbike):
        if os.environ.get('PPW_VEHICLE_FILTER', build.__name__) == build.__name__:
            build()

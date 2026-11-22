"""Retarget CMU motion capture (BVH, cgspeed conversion) onto the avatar's Mixamo rig.

The CMU Graphics Lab Motion Capture Database is free for any use (the BVH conversion by Bruce
Hahne adds no restrictions). Every cgspeed BVH starts with a T-pose frame facing -Y after import,
with the subject's left at +X — the same convention as our MakeHuman rig — so retargeting is:

  for each mapped bone b and frame t:
    D(t)  = Q_src(t) · Q_src(T)⁻¹          world rotation of the source bone since its T-pose
    W(t)  = D(t) · A2T_b · R_rest_b        the target bone, from its own "T-pose"
  where A2T_b turns the target's rest (A-pose) bone direction onto the source T-pose direction.

One loopable cycle is cut from heel strike to heel strike (the left foot most forward relative to
the hips), resampled to the clip frame rate, and its seam drift is distributed over the cycle.
Hips translation keeps the bounce and sway (scaled by leg-length ratio) and drops forward travel,
so clips play in place. `warp` lengthens strides (amplifies leg/arm swing around the cycle mean)
to make a sprint from a run without just speeding the legs up.
"""

from __future__ import annotations

import math

import bpy
from mathutils import Matrix, Quaternion, Vector

B = "mixamorig:"
# source (cgspeed CMU) → target (Mixamo rig) bone names
MAP = {
    "Hips": "Hips", "LowerBack": "Spine", "Spine": "Spine1", "Spine1": "Spine2", "Neck": "Neck", "Head": "Head",
}
for side in ("Left", "Right"):
    for name in ("UpLeg", "Leg", "Foot", "ToeBase", "Shoulder", "Arm", "ForeArm", "Hand"):
        MAP[side + name] = side + name
SWING = {f"{s}{n}" for s in ("Left", "Right") for n in ("UpLeg", "Leg", "Foot", "Arm", "ForeArm")}


def _world_quats(arm, names):
    m = arm.matrix_world.to_quaternion()
    return {n: m @ arm.pose.bones[n].matrix.to_quaternion() for n in names}


def _leg_length(arm, side="Left", prefix=""):
    b = arm.data.bones
    up, knee, foot = (b[prefix + side + n].head_local for n in ("UpLeg", "Leg", "Foot"))
    return (knee - up).length + (foot - knee).length


def import_bvh(path):
    for o in [o for o in bpy.data.objects if o.get("ppw_mocap")]:
        bpy.data.objects.remove(o, do_unlink=True)
    before = set(bpy.data.objects)
    bpy.ops.import_anim.bvh(filepath=path, global_scale=1.0, frame_start=1, use_fps_scale=False, rotate_mode="NATIVE")
    src = next(o for o in bpy.data.objects if o not in before)
    src["ppw_mocap"] = True
    return src


def heel_strikes(src, fps):
    """Frames where the left foot is furthest ahead of the hips (forward = -Y)."""
    act = src.animation_data.action
    f0, f1 = (int(v) for v in act.frame_range)
    r = []
    for f in range(f0 + 1, f1 + 1):
        bpy.context.scene.frame_set(f)
        hips = src.matrix_world @ src.pose.bones["Hips"].head
        foot = src.matrix_world @ src.pose.bones["LeftFoot"].head
        r.append((f, hips.y - foot.y))
    gap = int(0.2 * fps)
    out = []
    for i in range(2, len(r) - 2):  # windows shrink at the clip ends (short takes)
        window = [v for _, v in r[max(0, i - gap):i + gap + 1]]
        if r[i][1] == max(window) and r[i][1] > 0 and (not out or r[i][0] - out[-1] > gap):
            out.append(r[i][0])
    return out


def retarget_cycle(R, src, *, fps_src=120.0, fps_out=30, cycle=None, warp=1.0, lean=0.0, curl=0.55):
    """Return (frames, specs, hips_offsets) for one loopable cycle, in R's (setup_rig.Rig) terms."""
    strikes = heel_strikes(src, fps_src)
    if len(strikes) < 2:
        raise ValueError("no full gait cycle found")
    k = cycle if cycle is not None else max(0, len(strikes) // 2 - 1)
    a, b = strikes[k], strikes[k + 1]
    n_out = max(8, round((b - a) / fps_src * fps_out))
    names = list(MAP)

    # Reference T-pose (frame 1) of the source.
    bpy.context.scene.frame_set(1)
    q_t = _world_quats(src, names)
    dir_t = {}
    for n in names:
        pb = src.pose.bones[n]
        dir_t[n] = (src.matrix_world.to_3x3() @ (pb.tail - pb.head)).normalized()
    hips_t = src.matrix_world @ src.pose.bones["Hips"].head
    scale = _leg_length_rig(R) / _leg_length(src)

    # Target: rest → source-T-pose bone directions.
    a2t = {}
    for s, t in MAP.items():
        a2t[t] = R.dir[B + t].rotation_difference(dir_t[s])

    samples = []
    for i in range(n_out + 1):
        f = a + (b - a) * i / n_out
        bpy.context.scene.frame_set(int(f), subframe=f - int(f))
        q = _world_quats(src, names)
        hips = src.matrix_world @ src.pose.bones["Hips"].head
        deltas = {MAP[n]: q[n] @ q_t[n].inverted() for n in names}
        samples.append((deltas, hips))

    # Seam: distribute the end-vs-start difference over the cycle; remove forward travel.
    start, end = samples[0], samples[-1]
    travel = end[1] - start[1]
    frames = []
    for i, (deltas, hips) in enumerate(samples[:-1]):
        u = i / n_out
        fixed = {}
        for t, d in deltas.items():
            err = end[0][t] @ start[0][t].inverted()  # end = err · start
            fixed[t] = Quaternion().slerp(err.inverted(), u) @ d
        off = (hips - start[1]) - travel * u
        off = Vector((off.x, off.y, hips.z - hips_t.z)) * scale
        frames.append((fixed, off))

    if warp != 1.0:  # stride warping around the cycle-mean rotation of swinging limbs
        for t in SWING:
            mean = _mean_quat([fr[0][t] for fr in frames])
            for fr in frames:
                d = fr[0][t] @ mean.inverted()
                if d.w < 0:  # shortest arc: angle ≤ π, or the amplified rotation flips
                    d = Quaternion((-d.w, -d.x, -d.y, -d.z))
                axis, angle = d.to_axis_angle()
                fr[0][t] = Quaternion(axis, angle * warp) @ mean

    specs = []
    for deltas, off in frames:
        spec = {B + t: ("world", deltas[t] @ a2t[t]) for t in deltas}
        if lean:
            for t in ("Spine", "Spine1", "Spine2"):
                spec[B + t] = ("world", Quaternion((1, 0, 0), lean / 3) @ spec[B + t][1])
        # Relaxed, slightly curled fingers (the BVH has no finger motion).
        for side in ("Left", "Right"):
            for fname in ("Index", "Middle", "Ring", "Pinky"):
                for j in (1, 2, 3):
                    spec[B + f"{side}Hand{fname}{j}"] = ("rel", Quaternion(_curl_axis(R, side, fname, j), curl * (0.6 if j == 1 else 1.0)))
        specs.append(spec)
    return specs, [off for _, off in frames], n_out


def _curl_axis(R, side, fname, j):
    """Finger flexion axis (armature space): rotating about d × n turns the finger toward the palm."""
    d = R.dir[B + f"{side}Hand{fname}{j}"]
    palm = Vector((-1 if side == "Left" else 1, 0, 0))  # A-pose palms face the thighs
    axis = d.cross(palm)
    return axis.normalized() if axis.length > 1e-6 else Vector((0, 1, 0))


def _mean_quat(qs):
    acc = Vector((0, 0, 0, 0))
    ref = qs[0]
    for q in qs:
        v = Vector(q[:])
        if v.dot(Vector(ref[:])) < 0:
            v = -v
        acc += v
    return Quaternion(acc.normalized())


def _leg_length_rig(R):
    up, knee, foot = (R.head[B + "Left" + n] for n in ("UpLeg", "Leg", "Foot"))
    return (knee - up).length + (foot - knee).length


def jump_phases(src, fps=120.0):
    """(takeoff, apex, landing) frames of the first jump: both feet off the ground → back."""
    act = src.animation_data.action
    f0, f1 = (int(v) for v in act.frame_range)
    feet, hips = [], []
    for f in range(f0 + 1, f1 + 1):
        bpy.context.scene.frame_set(f)
        m = src.matrix_world
        feet.append(min((m @ src.pose.bones["LeftFoot"].head).z, (m @ src.pose.bones["RightFoot"].head).z))
        hips.append((m @ src.pose.bones["Hips"].head).z)
    ground = sorted(feet[: int(0.4 * fps)])[len(feet[: int(0.4 * fps)]) // 2]
    clear = 0.08 * _leg_length(src)
    air = [i for i, z in enumerate(feet) if z > ground + clear]
    if not air:
        raise ValueError("no jump found")
    take = air[0]
    land = next((i for i in range(take, len(feet)) if feet[i] <= ground + clear), len(feet) - 1)
    apex = max(range(take, land + 1), key=lambda i: hips[i])
    return f0 + 1 + take, f0 + 1 + apex, f0 + 1 + land


def retarget_range(R, src, start, end, *, fps_src=120.0, fps_out=30, curl=0.4):
    """One-shot clip between two source frames; hips height measured from the lowest foot, so
    the game's jump physics adds the real height."""
    names = list(MAP)
    bpy.context.scene.frame_set(1)
    q_t = _world_quats(src, names)
    dir_t = {n: (src.matrix_world.to_3x3() @ (src.pose.bones[n].tail - src.pose.bones[n].head)).normalized() for n in names}
    m = src.matrix_world
    feet_t = min((m @ src.pose.bones["LeftFoot"].head).z, (m @ src.pose.bones["RightFoot"].head).z)
    rel_t = (m @ src.pose.bones["Hips"].head).z - feet_t
    scale = _leg_length_rig(R) / _leg_length(src)
    a2t = {t: R.dir[B + t].rotation_difference(dir_t[s]) for s, t in MAP.items()}
    n_out = max(2, round((end - start) / fps_src * fps_out))
    bpy.context.scene.frame_set(start)
    h0 = m @ src.pose.bones["Hips"].head
    specs, offs = [], []
    for i in range(n_out + 1):
        f = start + (end - start) * i / n_out
        bpy.context.scene.frame_set(int(f), subframe=f - int(f))
        q = _world_quats(src, names)
        hips = m @ src.pose.bones["Hips"].head
        feet = min((m @ src.pose.bones["LeftFoot"].head).z, (m @ src.pose.bones["RightFoot"].head).z)
        spec = {B + MAP[n]: ("world", q[n] @ q_t[n].inverted() @ a2t[MAP[n]]) for n in names}
        for side in ("Left", "Right"):
            for fname in ("Index", "Middle", "Ring", "Pinky"):
                for j in (1, 2, 3):
                    spec[B + f"{side}Hand{fname}{j}"] = ("rel", Quaternion(_curl_axis(R, side, fname, j), curl))
        specs.append(spec)
        offs.append(Vector((hips.x - h0.x, hips.y - h0.y, (hips.z - feet) - rel_t)) * scale)
    # In place: no horizontal travel (the game moves the player).
    for o in offs:
        o.x = o.y = 0.0
    return specs, offs, n_out


def ground(R, rig, specs, offs, ankle=None):
    """Shift hips so the lowest ankle over the clip sits at the rest ankle height (no floating
    or sinking feet)."""
    lows = []
    for spec, off in zip(specs, offs):
        local = R.solve(spec)
        for pb in rig.pose.bones:
            pb.rotation_quaternion = local[pb.name]
        rig.pose.bones[B + "Hips"].location = R.world_to_local_offset(B + "Hips", off)
        bpy.context.view_layer.update()
        lf = rig.matrix_world @ rig.pose.bones[B + "LeftFoot"].head
        rf = rig.matrix_world @ rig.pose.bones[B + "RightFoot"].head
        lows.append(min(lf.z, rf.z))
    rest = ankle if ankle is not None else R.head[B + "LeftFoot"].z
    shift = min(lows) - rest
    for off in offs:
        off.z -= shift
    return shift

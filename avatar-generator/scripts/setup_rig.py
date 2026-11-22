"""Stage 4: rig clean-up and starter animation clips on the Mixamo-compatible skeleton.

* Every mesh is skinned to the 52-bone MPFB "mixamo" rig (bone names `mixamorig:*`, so Mixamo
  and other Mixamo-retargeted clips play on it unchanged), max 4 weights per vertex, normalised.
* Clips are keyframed procedurally (30 fps) and stored as NLA tracks, one glTF animation each:
  Idle, Walk, Run, Wave, Sit, Talk, Dance, Greet (the Cambodian sampeah: palms together, slight
  bow). Talk, Wave, Greet, Dance and Idle also drive the face morphs (MouthOpen, Smile, Blink).
  They are starter clips for testing the rig, not motion capture.

Poses are written as rotations about armature axes (X = character's left, -Y = forward, Z = up)
or as aim directions, and converted to each bone's local frame here.
"""

from common import *
from mathutils import Quaternion

B = "mixamorig:"
FPS = 30


# ── Pose evaluation ─────────────────────────────────────────────────────────────────────


class Rig:
    def __init__(self, rig):
        self.obj = rig
        self.rest = {b.name: b.matrix_local.to_3x3().to_quaternion() for b in rig.data.bones}
        self.dir = {b.name: (b.tail_local - b.head_local).normalized() for b in rig.data.bones}
        self.head = {b.name: b.head_local.copy() for b in rig.data.bones}
        self.length = {b.name: b.length for b in rig.data.bones}
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in rig.data.bones}
        self.order = [b.name for b in rig.data.bones]  # parents before children
        for pb in rig.pose.bones:
            pb.rotation_mode = "QUATERNION"

    def solve(self, spec):
        """spec: bone → ("rel", Quaternion) | ("aim", Vector) | ("world", Quaternion).
        Returns local pose quaternions for every bone."""
        delta, local = {}, {}
        for name in self.order:
            parent = self.parent[name]
            dp = delta[parent] if parent else Quaternion()
            kind = spec.get(name)
            if kind is None:
                d = dp
            elif kind[0] == "rel":
                d = dp @ kind[1]
            elif kind[0] == "aim":
                carried = dp @ self.dir[name]
                d = carried.rotation_difference(kind[1].normalized()) @ dp
            else:
                d = kind[1]
            delta[name] = d
            r = self.rest[name]
            local[name] = r.inverted() @ dp.inverted() @ d @ r
        return local

    def world_to_local_offset(self, name, offset):
        return self.rest[name].inverted() @ offset


def q(axis, angle):
    return Quaternion(Vector(axis).normalized(), angle)


def two_bone(S, T, l1, l2, pole):
    """Elbow/knee position for a 2-bone chain from S reaching T, bending toward `pole`."""
    d = max(1e-4, min((T - S).length, l1 + l2 - 1e-4))
    u = (T - S).normalized()
    a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    h = math.sqrt(max(0.0, l1 * l1 - a * a))
    p = (pole - u * pole.dot(u)).normalized()
    return S + u * a + p * h


# ── Clips ───────────────────────────────────────────────────────────────────────────────


def arms_down(R, spec, sx_list=("Left", "Right"), spread=0.17, fwd=0.03, elbow=0.18):
    """From the A-pose to arms relaxed along the body, elbows slightly bent."""
    for side in sx_list:
        sx = 1 if side == "Left" else -1
        spec[B + side + "Arm"] = ("aim", Vector((sx * spread, -fwd, -1)))
        spec[B + side + "ForeArm"] = ("aim", Vector((sx * spread * 0.6, -fwd - elbow, -1)))


def clip_idle(R, t, dur):
    w = math.tau * t / dur
    spec = {}
    arms_down(R, spec)
    spec[B + "Spine1"] = ("rel", q((1, 0, 0), -0.015 * math.sin(w * 2)))
    spec[B + "Spine2"] = ("rel", q((1, 0, 0), -0.02 * math.sin(w * 2)))
    spec[B + "Hips"] = ("rel", q((0, 1, 0), 0.025 * math.sin(w)))
    spec[B + "Head"] = ("rel", q((0, 0, 1), 0.12 * math.sin(w + 1.0)) @ q((1, 0, 0), 0.03 * math.sin(w * 2)))
    hips = Vector((0.012 * math.sin(w), 0, -0.004 * (1 - math.cos(w * 2)) / 2))
    morphs = {"Blink": 1.0 if abs(t - dur * 0.55) < 0.07 else 0.0, "Smile": 0.25}
    return spec, hips, morphs


def leg_cycle(spec, phase, thigh, knee_amp, knee_base, foot_gain, side):
    s = math.sin(phase)
    c = math.cos(phase)
    flex = -thigh * s  # negative = forward
    knee = knee_base + knee_amp * max(0.0, c) ** 1.4
    spec[B + side + "UpLeg"] = ("rel", q((1, 0, 0), flex))
    spec[B + side + "Leg"] = ("rel", q((1, 0, 0), knee))
    spec[B + side + "Foot"] = ("rel", q((1, 0, 0), -(flex + knee) * foot_gain + 0.12 * max(0.0, -c) * (s < 0)))


def clip_walk(R, t, dur):
    w = math.tau * t / dur
    spec = {}
    leg_cycle(spec, w, 0.55, 0.7, 0.06, 0.55, "Left")
    leg_cycle(spec, w + math.pi, 0.55, 0.7, 0.06, 0.55, "Right")
    for side, ph in (("Left", w), ("Right", w + math.pi)):
        sx = 1 if side == "Left" else -1
        swing = 0.32 * math.sin(ph)  # opposite to the same-side leg
        spec[B + side + "Arm"] = ("aim", q((1, 0, 0), swing) @ Vector((sx * 0.16, -0.03, -1)))
        spec[B + side + "ForeArm"] = ("aim", q((1, 0, 0), swing - 0.25 - 0.12 * max(0, -math.sin(ph))) @ Vector((sx * 0.1, -0.03, -1)))
    spec[B + "Hips"] = ("rel", q((0, 0, 1), 0.09 * math.sin(w)) @ q((0, 1, 0), 0.035 * math.cos(w)))
    spec[B + "Spine2"] = ("rel", q((0, 0, 1), -0.12 * math.sin(w)) @ q((1, 0, 0), 0.03))
    spec[B + "Head"] = ("rel", q((0, 0, 1), 0.03 * math.sin(w)))
    hips = Vector((0, 0, 0.008 * math.cos(2 * w) - 0.012))
    return spec, hips, {"Smile": 0.15}


def clip_run(R, t, dur):
    w = math.tau * t / dur
    spec = {}
    leg_cycle(spec, w, 0.85, 1.45, 0.25, 0.45, "Left")
    leg_cycle(spec, w + math.pi, 0.85, 1.45, 0.25, 0.45, "Right")
    for side, ph in (("Left", w), ("Right", w + math.pi)):
        sx = 1 if side == "Left" else -1
        swing = 0.62 * math.sin(ph)
        spec[B + side + "Arm"] = ("aim", q((1, 0, 0), swing) @ Vector((sx * 0.22, 0.05, -1)))
        spec[B + side + "ForeArm"] = ("aim", q((1, 0, 0), swing - 1.45) @ Vector((sx * 0.12, 0.0, -1)))
    spec[B + "Hips"] = ("rel", q((1, 0, 0), 0.12) @ q((0, 0, 1), 0.14 * math.sin(w)))
    spec[B + "Spine2"] = ("rel", q((0, 0, 1), -0.22 * math.sin(w)) @ q((1, 0, 0), 0.06))
    spec[B + "Head"] = ("rel", q((1, 0, 0), -0.12))
    hips = Vector((0, 0, 0.03 * abs(math.cos(w)) - 0.05))
    return spec, hips, {"Excited": 0.0}


def ease(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def blend(spec_a, spec_b, k, R):
    """Blend two pose specs by converting both to local quaternions (slerp)."""
    la, lb = R.solve(spec_a), R.solve(spec_b)
    return {n: la[n].slerp(lb[n], k) for n in la}


def clip_wave(R, t, dur):
    idle_spec, hips, _ = clip_idle(R, t, dur)
    up = dict(idle_spec)
    up[B + "RightArm"] = ("aim", Vector((-0.75, -0.2, 0.55)))
    wave = 0.38 * math.sin(math.tau * 2.2 * t)
    up[B + "RightForeArm"] = ("aim", q((0, 1, 0), wave) @ Vector((-0.12, -0.25, 1)))
    up[B + "RightHand"] = ("rel", q((0, 1, 0), wave * 0.4))
    up[B + "Head"] = ("rel", q((0, 0, 1), -0.12) @ q((0, 1, 0), 0.06))
    k = ease(t / 0.5) * ease((dur - t) / 0.5)
    return ("blend", idle_spec, up, k), hips, {"Smile": 0.85 * k, "Blink": 1.0 if abs(t - 1.6) < 0.07 else 0.0}


def clip_sit(R, t, dur):
    w = math.tau * t / dur
    spec = {}
    for side in ("Left", "Right"):
        sx = 1 if side == "Left" else -1
        spec[B + side + "UpLeg"] = ("rel", q((1, 0, 0), -1.5) @ q((0, 1, 0), -sx * 0.05))
        spec[B + side + "Leg"] = ("rel", q((1, 0, 0), 1.5))
        spec[B + side + "Foot"] = ("rel", q((1, 0, 0), 0.0))
        spec[B + side + "Arm"] = ("aim", Vector((sx * 0.12, -0.45, -1)))
        spec[B + side + "ForeArm"] = ("aim", Vector((sx * 0.02, -1, -0.22)))
    spec[B + "Spine1"] = ("rel", q((1, 0, 0), 0.04 - 0.015 * math.sin(w)))
    spec[B + "Spine2"] = ("rel", q((1, 0, 0), 0.03 - 0.015 * math.sin(w)))
    spec[B + "Head"] = ("rel", q((0, 0, 1), 0.1 * math.sin(w * 0.5)))
    thigh_z = R.head[B + "LeftUpLeg"].z
    shin = R.length[B + "LeftLeg"]
    ankle = R.head[B + "LeftFoot"].z
    hips = Vector((0, 0.0, (shin + ankle) - thigh_z + 0.02))
    return spec, hips, {"Smile": 0.3, "Blink": 1.0 if abs(t - 1.2) < 0.07 else 0.0}


def clip_talk(R, t, dur):
    spec, hips, _ = clip_idle(R, t, dur)
    g1 = ease(math.sin(math.pi * min(1, max(0, (t - 0.2) / 1.4))) ** 2)
    g2 = ease(math.sin(math.pi * min(1, max(0, (t - 1.3) / 1.4))) ** 2)
    spec[B + "RightArm"] = ("aim", Vector((-0.2, -0.25 * g1, -1)))
    spec[B + "RightForeArm"] = ("aim", Vector((-0.3 * g1 - 0.1, -1.0 * g1 - 0.2, -1 + 0.9 * g1)))
    spec[B + "RightHand"] = ("rel", q((0, 1, 0), 0.4 * g1 * math.sin(t * 7)))
    spec[B + "LeftArm"] = ("aim", Vector((0.2, -0.25 * g2, -1)))
    spec[B + "LeftForeArm"] = ("aim", Vector((0.3 * g2 + 0.1, -1.0 * g2 - 0.2, -1 + 0.9 * g2)))
    spec[B + "Head"] = ("rel", q((1, 0, 0), 0.05 * math.sin(t * 5.3)) @ q((0, 0, 1), 0.08 * math.sin(t * 1.7)))
    syll = max(0.0, math.sin(t * math.tau * 4.1)) * (0.55 + 0.25 * math.sin(t * 2.3))
    pause = 0.0 if 1.15 < t < 1.45 or t > dur - 0.2 else 1.0
    return spec, hips, {"MouthOpen": syll * pause, "Smile": 0.3}


def clip_dance(R, t, dur):
    beat = math.tau * 2 * t / dur * 2  # 4 beats per loop
    bar = math.tau * t / dur
    spec = {}
    bounce = 0.5 - 0.5 * math.cos(beat)
    for side in ("Left", "Right"):
        sx = 1 if side == "Left" else -1
        spec[B + side + "UpLeg"] = ("rel", q((1, 0, 0), -0.25 * bounce) @ q((0, 1, 0), -sx * 0.08))
        spec[B + side + "Leg"] = ("rel", q((1, 0, 0), 0.5 * bounce))
        spec[B + side + "Foot"] = ("rel", q((1, 0, 0), -0.25 * bounce))
        ph = bar + (0 if sx > 0 else math.pi)
        spec[B + side + "Arm"] = ("aim", Vector((sx * 0.45, -0.5 * math.sin(ph), -0.6 + 0.4 * math.cos(ph))))
        spec[B + side + "ForeArm"] = ("aim", Vector((sx * 0.1, -0.9, 0.35 + 0.3 * math.sin(ph))))
    spec[B + "Hips"] = ("rel", q((0, 1, 0), 0.08 * math.sin(bar)) @ q((0, 0, 1), 0.15 * math.sin(bar)))
    spec[B + "Spine2"] = ("rel", q((0, 0, 1), -0.25 * math.sin(bar)) @ q((0, 1, 0), -0.08 * math.sin(bar)))
    spec[B + "Head"] = ("rel", q((1, 0, 0), 0.1 * bounce - 0.05) @ q((0, 1, 0), 0.08 * math.sin(bar)))
    hips = Vector((0.04 * math.sin(bar), 0, -0.05 * bounce))
    return spec, hips, {"Smile": 0.6, "Excited": 0.25 * bounce}


def clip_greet(R, t, dur):
    """Sampeah: palms pressed together in front of the chest, fingers up, a slight bow."""
    idle_spec, hips, _ = clip_idle(R, 0.0, dur)
    k = ease(t / 0.6) * ease((dur - t) / 0.6)
    bow = 0.22 * ease((t - 0.5) / 0.5) * ease((dur - 0.5 - t) / 0.5)
    pose = dict(idle_spec)
    pose[B + "Spine2"] = ("rel", q((1, 0, 0), bow))
    pose[B + "Head"] = ("rel", q((1, 0, 0), bow * 0.8))
    # Hands meet at the sternum, ~16 cm in front of it (before the bow).
    chest = R.head[B + "Spine2"]
    target = Vector((0, chest.y - 0.26, chest.z + 0.04))
    for side in ("Left", "Right"):
        sx = 1 if side == "Left" else -1
        S = R.head[B + side + "Arm"]
        l1, l2 = R.length[B + side + "Arm"], R.length[B + side + "ForeArm"]
        T = target + Vector((sx * 0.012, 0, -0.03))
        E = two_bone(S, T, l1, l2, Vector((sx * 0.6, 0.3, -1)))
        pose[B + side + "Arm"] = ("aim", E - S)
        pose[B + side + "ForeArm"] = ("aim", T - E)
        # Fingers up, palm toward the other hand.
        pose[B + side + "Hand"] = ("aim", Vector((-sx * 0.15, -0.25, 1)))
    return ("blend", idle_spec, pose, k), hips, {"Smile": 0.7 * k}


def clip_cheer(R, t, dur):
    """Both arms thrown up in a V, a little bounce, big smile (the game's "cheer" emote)."""
    idle_spec, hips, _ = clip_idle(R, t, dur)
    up = dict(idle_spec)
    bounce = 0.5 - 0.5 * math.cos(math.tau * 2.5 * t)
    for side in ("Left", "Right"):
        sx = 1 if side == "Left" else -1
        up[B + side + "Arm"] = ("aim", Vector((sx * 0.55, -0.1, 1)))
        up[B + side + "ForeArm"] = ("aim", Vector((sx * 0.3, -0.15, 1)))
        up[B + side + "UpLeg"] = ("rel", q((1, 0, 0), -0.12 * bounce))
        up[B + side + "Leg"] = ("rel", q((1, 0, 0), 0.24 * bounce))
        up[B + side + "Foot"] = ("rel", q((1, 0, 0), -0.12 * bounce))
    up[B + "Head"] = ("rel", q((1, 0, 0), -0.12))
    k = ease(t / 0.35) * ease((dur - t) / 0.35)
    return ("blend", idle_spec, up, k), hips + Vector((0, 0, -0.03 * bounce * k)), {"Smile": 0.6 * k, "Excited": 0.5 * k}


CLIPS = {
    "Idle": (clip_idle, 4.0),
    "Walk": (clip_walk, 0.95),
    "Run": (clip_run, 0.7),
    "Wave": (clip_wave, 3.0),
    "Sit": (clip_sit, 4.0),
    "Talk": (clip_talk, 3.0),
    "Dance": (clip_dance, 2.0),
    "Greet": (clip_greet, 3.0),
    "Cheer": (clip_cheer, 2.2),
}


def bake_clip(R, name, fn, dur, morph_meshes):
    rig = R.obj
    rig.animation_data_create()
    action = bpy.data.actions.new(name)
    rig.animation_data.action = action
    frames = max(2, int(round(dur * FPS)))
    morph_actions = {}
    for me_obj in morph_meshes:
        key = me_obj.data.shape_keys
        key.animation_data_create()
        a = bpy.data.actions.new(f"{name}.{me_obj.name}")
        key.animation_data.action = a
        morph_actions[me_obj] = a
    for f in range(frames + 1):
        t = f / FPS
        spec, hips, morphs = fn(R, t, dur)
        if spec[0] == "blend" if isinstance(spec, tuple) else False:
            _, a_spec, b_spec, k = spec
            local = blend(a_spec, b_spec, k, R)
        else:
            local = R.solve(spec)
        for pb in rig.pose.bones:
            pb.rotation_quaternion = local[pb.name]
            pb.keyframe_insert("rotation_quaternion", frame=f + 1, group=pb.name)
        hp = rig.pose.bones[B + "Hips"]
        hp.location = R.world_to_local_offset(B + "Hips", hips)
        hp.keyframe_insert("location", frame=f + 1, group=hp.name)
        for me_obj in morph_meshes:
            kb = me_obj.data.shape_keys.key_blocks
            for k in kb[1:]:
                k.value = morphs.get(k.name, 0.0)
                k.keyframe_insert("value", frame=f + 1)
    # Loop cleanly; store as NLA tracks named after the clip (merged into one glTF animation).
    for owner, act in [(rig, action)] + [(m.data.shape_keys, a) for m, a in morph_actions.items()]:
        for fc in act.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"
        track = owner.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 1, act)
        strip.name = name
        track.mute = True
        owner.animation_data.action = None
    return frames


def finish_rig(spec, body, rig):
    name = spec["name"]
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and not o.name.startswith("_")]
    for o in meshes:
        if o.parent != rig:
            bind_armature(o, rig)
        activate(o)
        deform = {b.name for b in rig.data.bones}
        for vg in list(o.vertex_groups):
            if vg.name not in deform:
                o.vertex_groups.remove(vg)
        if o.vertex_groups:
            bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
            bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
        for m in list(o.modifiers):
            if m.type != "ARMATURE":
                o.modifiers.remove(m)
    R = Rig(rig)
    morph_meshes = [o for o in meshes if o.data.shape_keys and len(o.data.shape_keys.key_blocks) > 1]
    for clip, (fn, dur) in CLIPS.items():
        frames = bake_clip(R, clip, fn, dur, morph_meshes)
        log(name, "clip", clip, frames, "frames")
    # Back to the rest (A) pose.
    for pb in rig.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()
    for o in morph_meshes:
        for k in o.data.shape_keys.key_blocks:
            k.value = 0.0
    bpy.context.scene.render.fps = FPS
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = int(4 * FPS) + 1

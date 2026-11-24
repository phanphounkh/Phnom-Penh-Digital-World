"""Check fitted headphones in a generated male blend (Blender --python)."""
import bpy
from mathutils import Vector

rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
neck = rig.matrix_world @ rig.data.bones["mixamorig:Neck"].head_local
cups = [o for o in bpy.data.objects if ".headphone_cup" in o.name]
assert len(cups) == 6, f"Expected two cups for each of three tops, got {len(cups)}"
for cup in cups:
    center = sum((cup.matrix_world @ Vector(c) for c in cup.bound_box), Vector()) / 8
    assert center.y < neck.y, f"{cup.name} is behind the neck: {tuple(center)}"
    assert 0.06 < abs(center.x) < 0.2, f"{cup.name} is not beside the collar"
    assert abs(center.z - neck.z) < 0.1, f"{cup.name} is below the collar"
for band in (o for o in bpy.data.objects if ".headphone_band" in o.name):
    if band.get("variant") in ("tee", "shirt"):
        highest = max((band.matrix_world @ Vector(c)).z for c in band.bound_box)
        assert highest < neck.z + 0.04, f"{band.name} sticks up behind the neck"
print("[avatar] All six headphone cups sit at the front sides of the collar.")

"""What a character can wear, slot by slot, and which skin each choice hides.

Every garment object carries its place in the wardrobe as custom properties:
  o["slot"] = "top" | "bottom" | "shoes" | "hat" | "bag"
  o["variant"] = one of SLOTS[slot]
  o["with"] = "top.tee"   (optional: shown only together with that choice, e.g. backpack
                           straps fitted over the t-shirt)
Skin that only some choices cover (forearms, lower legs, ankles, feet) stays on the body and is
cut into regions at export; a region is hidden when any of its HIDDEN_WHEN clauses holds (every
"slot.variant" of the clause is worn). The hair on top of the head hides under a hat the same way.

The default outfit is the characters' original look (and what avatars saved before garments
existed keep wearing): the hoodie (with the jacket on the male), cargo joggers, sneakers, no hat
and the backpack.
"""

SLOTS = {
    "top": ["hoodie", "tee", "shirt"],
    "bottom": ["trousers", "jeans", "shorts"],
    "shoes": ["sneakers", "sandals"],
    "hat": ["none", "cap", "bucket"],
    "bag": ["backpack", "none"],
}

DEFAULT = {"top": "hoodie", "bottom": "trousers", "shoes": "sneakers", "hat": "none", "bag": "backpack"}

# Region → clauses (all of a clause's choices worn → the region is hidden).
HIDDEN_WHEN = {
    # Forearms, and any skin the hoodie only just covers.
    "arms": [["top.hoodie"]],
    "legs": [["bottom.trousers"], ["bottom.jeans"]],
    # Between the sneakers' socks and the joggers' cuffs: covered by jeans, or by joggers over sneakers.
    "ankles": [["bottom.jeans"], ["bottom.trousers", "shoes.sneakers"]],
    "feet": [["shoes.sneakers"]],
    "hair_top": [["hat.cap"], ["hat.bucket"]],
}

REGIONS = ["arms", "legs", "ankles", "feet"]


def tag(obj, slot, variant, with_=None):
    assert variant in SLOTS[slot], (slot, variant)
    obj["slot"] = slot
    obj["variant"] = variant
    if with_:
        s, v = with_.split(".")
        assert v in SLOTS[s], with_
        obj["with"] = with_
    return obj


def worn(outfit, choice):
    slot, variant = choice.split(".")
    return outfit.get(slot, DEFAULT[slot]) == variant


def shown(obj, outfit=DEFAULT):
    """Is this object visible in `outfit`? Untagged objects (body, face, hair, watch…) always are;
    objects with a region (sunglasses up on the head: "hair_top") hide with it."""
    if obj.get("region") and region_hidden(obj["region"], outfit):
        return False
    slot = obj.get("slot")
    if slot is None:
        return True
    if outfit.get(slot, DEFAULT[slot]) != obj.get("variant"):
        return False
    w = obj.get("with")
    return w is None or worn(outfit, w)


def region_hidden(region, outfit=DEFAULT):
    return any(all(worn(outfit, c) for c in clause) for clause in HIDDEN_WHEN.get(region, []))


def parse(text):
    """'top=tee,bottom=jeans' → an outfit (unnamed slots keep the default)."""
    outfit = dict(DEFAULT)
    for part in filter(None, (text or "").split(",")):
        slot, variant = part.split("=")
        assert variant in SLOTS[slot], part
        outfit[slot] = variant
    return outfit


def under_hat_faces(obj, rig, margin=0.01):
    """Faces of a hair mesh that hide under a hat: every card (connected piece) reaching more than
    `margin` above the hat plane stored on the rig (rig["hat_point"], rig["hat_normal"])."""
    import bmesh
    import numpy as np

    if "hat_point" not in rig.keys():
        return np.zeros(len(obj.data.polygons), dtype=bool)
    p0 = np.array(rig["hat_point"])
    n = np.array(rig["hat_normal"])
    mw = np.array(obj.matrix_world)
    co = np.array([v.co[:] for v in obj.data.vertices])
    co = co @ mw[:3, :3].T + mw[:3, 3]
    height = (co - p0) @ n
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    island = np.full(len(bm.faces), -1)
    hidden = np.zeros(len(bm.faces), dtype=bool)
    k = 0
    for f in bm.faces:
        if island[f.index] >= 0:
            continue
        stack, members = [f], []
        island[f.index] = k
        while stack:
            g = stack.pop()
            members.append(g.index)
            for e in g.edges:
                for h in e.link_faces:
                    if island[h.index] < 0:
                        island[h.index] = k
                        stack.append(h)
        verts = {v.index for i in members for v in bm.faces[i].verts}
        if max(height[list(verts)]) > margin:
            hidden[members] = True
        k += 1
    bm.free()
    return hidden

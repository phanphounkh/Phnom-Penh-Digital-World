"""Build an NPC-only face with existing MakeHuman CC0 targets and the player-compatible rig.
Run in the project's private Blender profile; writes intermediates only under /tmp.
Never overwrites the player model, manifest or output directory.
"""
import copy
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
from characters import CHARACTERS

kind, face = common.args_after_dashes()[:2]
if kind not in ("male", "female") or face not in ("broad", "slender"):
    raise ValueError("Expected male|female broad|slender")
common.OUTPUT = str(Path('/tmp/ppg-npc-faces') / f'{kind}-{face}')
os.makedirs(common.OUTPUT, exist_ok=True)
spec = copy.deepcopy(CHARACTERS[kind])
# Semantic MakeHuman facial targets fit the eyes, brows, lashes and teeth to the new head.
for key in list(spec['targets']):
    if key.startswith(('head-', 'chin-', 'nose-', 'mouth-', 'l-cheek', 'r-cheek', 'l-eye', 'r-eye')):
        del spec['targets'][key]
if face == 'broad':
    spec['targets'].update({'head-round': .65, 'head-square': .2, 'chin-width-incr': .45,
        'chin-prominent-incr': .2, 'nose-scale-horiz-incr': .25,
        'nose-point-width-decr': .05, 'l-cheek-volume-incr': .25, 'r-cheek-volume-incr': .25,
        'mouth-lowerlip-volume-incr': .12, 'mouth-upperlip-volume-incr': .1})
else:
    spec['targets'].update({'head-oval': .8, 'chin-width-decr': .35,
        'chin-prominent-incr': .15, 'nose-scale-vert-incr': .25,
        'nose-point-width-decr': .3, 'l-cheek-bones-incr': .4, 'r-cheek-bones-incr': .4,
        'mouth-lowerlip-volume-incr': .05, 'mouth-upperlip-volume-incr': .05})
spec['rest_expression'] = {'mouth-corner-puller': .10 if face == 'broad' else .18, 'mouth-elevation': .02}
CHARACTERS[kind] = spec
from build_character import build
build(spec)
# export_glb reads the in-memory spec and uses the redirected output directory.
import export_glb  # executes its normal exporter
print(f'[npc] FINISHED {kind}-{face}', flush=True)

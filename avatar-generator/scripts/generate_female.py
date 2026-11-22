"""Build the female avatar → output/female_avatar.blend.

  BLENDER_USER_RESOURCES=assets/blender-user \
  blender --background --python-use-system-env --python scripts/generate_female.py [-- --stage body|outfit|all]
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from build_character import build  # noqa: E402
from characters import FEMALE  # noqa: E402
from common import args_after_dashes  # noqa: E402

args = args_after_dashes()
build(FEMALE, args[args.index("--stage") + 1] if "--stage" in args else "all")

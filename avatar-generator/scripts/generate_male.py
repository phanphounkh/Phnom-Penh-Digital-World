"""Build the male avatar → output/male_avatar.blend.

  BLENDER_USER_RESOURCES=assets/blender-user \
  blender --background --python-use-system-env --python scripts/generate_male.py [-- --stage body|outfit|all]
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from build_character import build  # noqa: E402
from characters import MALE  # noqa: E402
from common import args_after_dashes  # noqa: E402

args = args_after_dashes()
build(MALE, args[args.index("--stage") + 1] if "--stage" in args else "all")

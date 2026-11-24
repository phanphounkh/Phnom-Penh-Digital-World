"""Asset budgets and alpha-cutout contract; no Blender, GPU or downloads required."""
import json
import struct
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]


class FoliageAssets(unittest.TestCase):
    def test_crowns_are_masked_and_within_triangle_budgets(self):
        for name, budget in (("tree-rain", 1200), ("tree-slender", 650), ("bush", 250)):
            with self.subTest(name=name):
                data = (ROOT / f"frontend/static/models/city/{name}.glb").read_bytes()
                length = struct.unpack_from("<I", data, 12)[0]
                gltf = json.loads(data[20:20+length])
                triangles = sum(gltf["accessors"][p["indices"]]["count"]//3
                                for m in gltf["meshes"] for p in m["primitives"])
                self.assertLessEqual(triangles, budget)
                foliage = [m for m in gltf["materials"] if m["name"] in ("Leaves", "Shrub")]
                self.assertTrue(foliage)
                for material in foliage:
                    self.assertEqual(material["alphaMode"], "MASK")
                    self.assertIn("baseColorTexture", material["pbrMetallicRoughness"])

    def test_original_atlas_has_gaps_and_bounded_resolution(self):
        with Image.open(ROOT / "frontend/static/textures/foliage-original.png") as image:
            self.assertEqual(image.size, (512, 512))
            alpha = image.getchannel("A")
            self.assertEqual(alpha.getextrema(), (0, 255))
            self.assertLess(alpha.histogram()[255], 512*512*.65)


if __name__ == "__main__":
    unittest.main()

"""Original procedural leaf spray, CC0. No downloaded imagery or generated AI image.

Run with Python/Pillow before generate_city_assets.py. Leaf colours are decorative;
transparent gaps create a canopy silhouette without solid blobs.
"""
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw


def build(path: Path):
    scale = 2
    image = Image.new("RGBA", (512 * scale, 512 * scale))
    draw = ImageDraw.Draw(image)
    rng = random.Random(855)

    def line(points, fill, width):
        draw.line([(int(x * scale), int(y * scale)) for x, y in points], fill=fill,
                  width=max(1, int(width * scale)))

    def leaf(x, y, angle, length):
        width = length * .33
        ca, sa = math.cos(angle), math.sin(angle)
        points = []
        for i in range(20):
            a = i * math.tau / 20
            u, v = math.cos(a) * length, math.sin(a) * width
            points.append(((x + ca * u - sa * v) * scale, (y + sa * u + ca * v) * scale))
        shade = rng.randint(175, 245)
        draw.polygon(points, fill=(int(shade*.55), int(shade*.8), int(shade*.37), 255))
        line([(x-ca*length*.8, y-sa*length*.8), (x+ca*length*.8, y+sa*length*.8)],
             (int(shade*.64), min(255,int(shade*.88)), int(shade*.4), 255), .9)

    line([(245, 475), (256, 280), (276, 45)], (124, 124, 124, 255), 5)
    for k in range(9):
        y = 400 - k * 39
        for side in (-1, 1):
            x = 255 + (400-y)*.05
            reach = 165 * math.sin((k+1)/11*math.pi) + 20
            end = (x+side*reach, y-65)
            line([(x, y), end], (145, 145, 145, 255), 2)
            for j in range(5):
                t = .22+j*.17
                px, py = x+(end[0]-x)*t, y-65*t
                for s in (-1, 1):
                    angle = (-.55 if side == 1 else math.pi+.55) + s*.65
                    length = rng.uniform(17, 27)
                    leaf(px+math.cos(angle)*length*.6, py+math.sin(angle)*length*.6,
                         angle, length)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.resize((512, 512), Image.Resampling.LANCZOS).save(path)


if __name__ == "__main__":
    build(Path(__file__).resolve().parents[2] / "frontend/static/textures/foliage-original.png")

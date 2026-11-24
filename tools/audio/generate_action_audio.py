"""Original CC0 procedural PCM sound effects. Python standard library only."""
import math
import random
import struct
import wave
from pathlib import Path

RATE = 24000
OUT = Path(__file__).resolve().parents[2] / "frontend/static/audio"


def save(name, duration, sample):
    rng = random.Random(855)
    values = [sample(i / RATE, rng) for i in range(int(duration * RATE))]
    peak = max(abs(v) for v in values) or 1
    with wave.open(str(OUT / (name + ".wav")), "wb") as f:
        f.setparams((1, 2, RATE, len(values), "NONE", "not compressed"))
        f.writeframes(b"".join(struct.pack("<h", round(v / peak * 27000)) for v in values))


def foot(t, rng, heavy=False):
    env = math.exp(-t * (20 if heavy else 28)) * min(1, t * 600)
    thud = math.sin(math.tau * (180 * t - 130 * t * t))
    scrape = rng.uniform(-1, 1) * (.6 if t < .045 else .2)
    return (thud * .7 + scrape) * env


def motor(t, rng):
    pulse = sum(a * math.sin(math.tau * 80 * k * t) for k, a in enumerate([0, 1, .65, .45, .25, .12]))
    return (pulse * (.8 + .15 * math.sin(math.tau * 40 * t)) + rng.uniform(-.06, .06)) * min(1, t*100, (2-t)*100)


def bike(t, rng, coast=False):
    period = 1 / (9 if coast else 4)
    click = math.exp(-(t % period) * 650) * math.sin(math.tau * 2400 * t)
    rolling = rng.uniform(-1, 1) * .035
    return (click * (.65 if coast else .25) + rolling) * min(1, t*100, (2-t)*100)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    save("walk", .24, lambda t, r: foot(t, r))
    save("run", .28, lambda t, r: foot(t, r, True))
    save("landing", .35, lambda t, r: foot(t, r, True) + .3*math.sin(math.tau*110*t)*math.exp(-t*18))
    save("motorbike", 2, motor)
    save("bicycle-pedal", 2, lambda t, r: bike(t, r))
    save("bicycle-coast", 2, lambda t, r: bike(t, r, True))
    save("test-tone", .95, lambda t, r: (math.sin(math.tau*(660 if t>.48 else 440)*t) * min(1,(t % .48)*80) * max(0,min(1,(.35-t % .48)*40))) if t % .48 < .35 else 0)

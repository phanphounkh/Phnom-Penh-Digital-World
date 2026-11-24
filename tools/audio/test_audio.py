"""Verify generated browser-playable PCM files contain sound and stay bounded."""
import array
import unittest
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "frontend/static/audio"


class AudioAssets(unittest.TestCase):
    def test_pcm_assets_are_non_silent_and_decode(self):
        for name in ("walk", "run", "landing", "motorbike", "bicycle-pedal", "bicycle-coast", "test-tone"):
            with self.subTest(name=name), wave.open(str(ROOT / (name+".wav")), "rb") as audio:
                self.assertEqual(audio.getsampwidth(), 2)
                self.assertEqual(audio.getnchannels(), 1)
                self.assertEqual(audio.getframerate(), 24000)
                self.assertGreater(audio.getnframes(), 4000)
                samples = array.array("h", audio.readframes(audio.getnframes()))
                self.assertGreater(max(abs(v) for v in samples), 10000)
                self.assertLessEqual(max(abs(v) for v in samples), 30000)


if __name__ == "__main__":
    unittest.main()

"""Riverside Breeze: original CC0-1.0 instrumental, 75 BPM, 16-bar seamless loop.
No third-party samples, melody, model, recording or paid service. Requires NumPy + ffmpeg.
"""
import math
import subprocess
import tempfile
import wave
from pathlib import Path
import numpy as np

RATE = 32000
BEAT = .8
DURATION = 16 * 4 * BEAT
ROOT = Path(__file__).resolve().parents[2]

def compose():
    count = round(RATE * DURATION)
    mix = np.zeros((count, 2), dtype=np.float64)
    def note(midi, start, duration, gain, pan=0., pad=False):
        t = np.arange(round((duration + 2.4) * RATE)) / RATE
        hz = 440 * 2 ** ((midi - 69) / 12)
        if pad:
            env = np.minimum(1., t / .7) * np.exp(-np.maximum(0, t-duration) / .75)
            tone = (np.sin(math.tau*hz*t) + .24*np.sin(math.tau*hz*2*t)) * env
        else:
            env = (1-np.exp(-t*150)) * np.exp(-t/(1.0 if midi>65 else 1.5))
            tone = (np.sin(math.tau*hz*t) + .32*np.sin(math.tau*hz*2*t)*np.exp(-t*2)
                    + .12*np.sin(math.tau*hz*3*t)*np.exp(-t*4)) * env
        # Finite, quiet tails; circular accumulation also wraps the reverb across the loop.
        tone *= np.minimum(1., (t[-1]-t)/.15)
        for delay, amount, side in [(0,1,pan),(.23,.16,-pan),(.41,.09,pan*.5)]:
            at = (round((start+delay)*RATE)+np.arange(len(t))) % count
            np.add.at(mix[:,0],at,tone*gain*amount*math.sqrt((1-side)/2))
            np.add.at(mix[:,1],at,tone*gain*amount*math.sqrt((1+side)/2))
    chords = [(50,57,62,66,69),(47,54,59,62,66),(43,55,59,62,66),(45,57,59,64,69)]
    phrases = [
        [(0,74),(.75,78),(1.5,81),(2.75,78)],
        [(.25,76),(1,74),(2,71),(3,74)],
        [(0,78),(1.25,81),(2,83),(3.25,81)],
        [(.5,78),(1.5,76),(2.75,74)],
    ]
    for bar in range(16):
        root,*chord = chords[bar%4]
        at = bar * BEAT * 4
        note(root,at,2.8,.19,0)
        for k,midi in enumerate(chord):
            note(midi,at,BEAT*3.5,.035,(k-1.5)*.12,True)
            note(midi+12,at+(k*.5+.25)*BEAT,1.6,.075,(-1 if k%2 else 1)*.3)
        for k,(beat,midi) in enumerate(phrases[bar%4]):
            # Original responding phrase every second four-bar section.
            if bar//4%2 and k==1: midi -= 2 if midi in (76,83) else 0
            note(midi,at+beat*BEAT,1.7,.14,math.sin(bar*.8)*.2)
    peak = np.max(np.abs(mix))
    mix *= .78 / max(peak, 1e-6)
    return np.round(mix * 32767).astype('<i2')

if __name__ == '__main__':
    samples = compose()
    target = ROOT/'frontend/static/audio/riverside-breeze.mp3'
    with tempfile.TemporaryDirectory(prefix='ppw-music-') as temporary:
        wav = Path(temporary)/'riverside-breeze.wav'
        with wave.open(str(wav),'wb') as f:
            f.setparams((2,2,RATE,len(samples),'NONE','not compressed'));f.writeframes(samples.tobytes())
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(wav),'-codec:a','libmp3lame','-b:a','96k',
                        '-metadata','title=Riverside Breeze','-metadata','artist=Phnom Penh Digital World',
                        '-metadata','copyright=CC0-1.0',str(target)],check=True)
    print(f'{target.name}: {DURATION:.1f}s, {target.stat().st_size} bytes, peak {np.max(np.abs(samples.astype(float)))/32767:.3f}')

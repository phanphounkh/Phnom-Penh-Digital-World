#!/usr/bin/env python3
"""Download, verify and install the free third-party inputs (run once, plain Python 3).

  python3 scripts/fetch_assets.py

* MPFB 2.0.18 (MakeHuman Plugin For Blender, GPL-3.0) from extensions.blender.org — a build
  tool only; nothing of its code ends up in the GLBs.
* MakeHuman system assets, CC0 pack (base mesh, targets, skins, eyes, brows, lashes, teeth,
  tongue, hair, shoes): explicitly released as CC0 1.0 in 2020.

Both are pinned by SHA-256. They are installed into a private Blender profile
(assets/blender-user, used through BLENDER_USER_RESOURCES), so your own Blender settings and
add-ons are never touched. Everything lands in git-ignored folders (~330 MB on disk).
"""

import hashlib
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
VENDOR = os.path.join(ROOT, "assets", "vendor")
PROFILE = os.path.join(ROOT, "assets", "blender-user")
MPFB_DATA = os.path.join(PROFILE, "extensions", ".user", "user_default", "mpfb", "data")

DOWNLOADS = {
    "mpfb.zip": (
        "https://extensions.blender.org/download/sha256:c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad/add-on-mpfb-v2.0.18.zip",
        "c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad",
    ),
    # CMU Graphics Lab Motion Capture Database (free for any use), BVH conversion by B. Hahne
    # (no added restrictions): walk, jog, run and standing-jump takes for the clips.
    "mocap/16_21.bvh": ("https://raw.githubusercontent.com/sfd158/cmu-mocap/master/data/016/16_21.bvh",
                        "fa1ac84e2efca453c4cd002b0d908f1e6c1fab4aa237898ac3ee5c80efdddd0e"),
    "mocap/35_17.bvh": ("https://raw.githubusercontent.com/sfd158/cmu-mocap/master/data/035/35_17.bvh",
                        "50c6469efea1edbba0f7acd46b1fa72e0b74b78e1698aa1b441990bd2a78d730"),
    "mocap/16_45.bvh": ("https://raw.githubusercontent.com/sfd158/cmu-mocap/master/data/016/16_45.bvh",
                        "6c179f799f3b2f766ce41cf962caaae08d9342ce73fc32fbc15648bf6589e872"),
    "mocap/16_01.bvh": ("https://raw.githubusercontent.com/sfd158/cmu-mocap/master/data/016/16_01.bvh",
                        "f989be024ec2b26099300707e182c0b96c22fdf7843757f0ba36e75a475c309c"),
    "mh_cc0.zip": (
        # The asset server only answers on plain HTTP; the SHA-256 pin protects the content.
        "http://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip",
        "b542127a8e25547c7c29c19f2d1d2adb9a664c80396ecd694095dbc8028a0107",
    ),
}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(name, url, digest):
    path = os.path.join(VENDOR, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path) and sha256(path) == digest:
        print(f"ok      {name} (cached)")
        return path
    print(f"get     {name} ← {url}")
    tmp = path + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "avatar-generator/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    got = sha256(tmp)
    if got != digest:
        os.remove(tmp)
        sys.exit(f"checksum mismatch for {name}: {got} != {digest}")
    os.replace(tmp, path)
    print(f"ok      {name} (sha256 verified)")
    return path


def main():
    os.makedirs(VENDOR, exist_ok=True)
    os.makedirs(PROFILE, exist_ok=True)
    blender = shutil.which("blender") or sys.exit("Blender 4.2+ not found on PATH")
    paths = {n: fetch(n, *v) for n, v in DOWNLOADS.items()}

    env = dict(os.environ, BLENDER_USER_RESOURCES=PROFILE)
    installed = os.path.join(PROFILE, "extensions", "user_default", "mpfb", "__init__.py")
    if not os.path.exists(installed):
        print("install MPFB into the private Blender profile")
        subprocess.run([blender, "--python-use-system-env", "--command", "extension", "install-file", "-r",
                        "user_default", "-e", paths["mpfb.zip"]], env=env, check=True)
    else:
        print("ok      MPFB already installed")

    marker = os.path.join(MPFB_DATA, "packs", "makehuman_system_assets.json")
    if not os.path.exists(marker):
        print("unpack  MakeHuman CC0 assets")
        os.makedirs(MPFB_DATA, exist_ok=True)
        with zipfile.ZipFile(paths["mh_cc0.zip"]) as z:
            z.extractall(MPFB_DATA)
    else:
        print("ok      MakeHuman CC0 assets already unpacked")
    print("ready   (start Blender with BLENDER_USER_RESOURCES=assets/blender-user --python-use-system-env)")


if __name__ == "__main__":
    main()

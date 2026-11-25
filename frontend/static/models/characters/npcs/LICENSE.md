# NPC character assets

Files: `male-broad.glb`, `male-slender.glb`, `female-broad.glb`, `female-slender.glb`.

Generated locally in Blender with `avatar-generator/scripts/generate_npc.py`.
These fictional faces are geometric MakeHuman target variations, not scans or portraits.
No photographic pixels, external character downloads, or AI-generated textures were added.

- MakeHuman system meshes, fitted eyes/brows/lashes/teeth, and shape targets: **CC0 1.0**.
  Source: the existing MPFB/MakeHuman build resources described in
  `avatar-generator/README.md`; upstream https://static.makehumancommunity.org/
- Project procedural clothing, textures and facial configuration: **CC0 1.0**,
  matching the existing realistic character asset pipeline.
- Retargeted locomotion clips: existing CMU Graphics Lab Motion Capture Database
  recordings, free to use for any purpose including commercial products.
  Source and terms: http://mocap.cs.cmu.edu/ ; BVH conversion by Bruce Hahne.
  Raw recordings are not included. Other clips use the existing procedural animation generator.
- Blender and MPFB are build tools, not shipped runtime code. MPFB is GPL-3.0;
  its system asset license is separate from its software license.

No real individual is depicted. NPC appearance, names and shopping activity are
fictional game content and provide no evidence about people in Phnom Penh.

Reproduction and runtime limits: `docs/npc-life.md` in the repository.

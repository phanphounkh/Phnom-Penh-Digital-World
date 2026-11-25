# Street life and postcard pass

This pass addresses the empty Street 144 screenshot with a bounded street population,
less repetitive decorative shop finishes and a way to capture moments in the world.
It extends the existing playable city, avatar and in-world delivery milestone.

## Player-facing changes

- Neighbours walk short routes on existing rendered sidewalk offsets or mapped paths,
  pause at their ends and turn toward a nearby player. Press **G** within 3 m to greet
  one; they answer with a Khmer/English bubble and the existing sampeah animation.
  A wall blocks greeting. Nearby NPCs are fictional game characters, not real residents.
- Population caps are **1 Low / 2 Medium / 3 High**; fewer appear when safe routes are
  unavailable. Routes are selected within 45 m and actors unload beyond 65 m. They
  update at reduced frequency with distance, have small walking colliders, and share
  one lightweight contact-shadow geometry/material. No extra dynamic lights.
- Decorative shop awnings use muted fabric finishes and small paint variations rather
  than one repeated red-and-white treatment. Eligible street-facing shophouse walls
  receive a small number of overhead projecting canopies inside the existing chunk
  relief budget, at most two per building. The building footprints, heights, doors,
  interiors and landmark classifications are preserved. These are procedural visual
  approximations, not verified replicas of actual businesses or façade colours.
- Press **K**, or **More → Take a postcard**, to preview and save the current actual
  3D view as a PNG. HUD and route ribbons are omitted from the image. Orbit the camera
  and use existing emotes to choose a composition. No AI image generation, camera
  permission, upload, paid service or new asset download is involved. Export width is
  capped at 1600 pixels and temporary object URLs are released on replacement/teardown.

## Geographic and performance constraints

Pedestrians use `ChunkRoad` source geometry and the same sidewalk offsets as existing
road rendering. Candidate paths reject bridges, raised roads, foot-forbidden routes,
carriageway crossings, building/water footprints, close wall contacts and steep slopes.
The planner keeps safe subsegments rather than requiring an entire 26 m stretch to
be clear. The real Street 144 fixture retains a roughly 13 m unobstructed section;
unsafe or missing pavements are not silently replaced with invented routes.

The regression fixture is a small excerpt of the existing imported OpenStreetMap
roads and game collision geometry, with attribution in its JSON. Original OSM data
remains © OpenStreetMap contributors, ODbL 1.0. Source snapshot attribution remains
in docs/DATA.md and tools/gis/data/osm. Character assets retain their existing licenses;
all added geometry and shader/canvas artwork are authored in code. No new dependency.

## Verification and limits

- Unit tests exercise path safety, crossings, obstacles, slope rejection, the real
  Street 144 excerpt, population caps, movement/greetings, collider cleanup and late
  model loads. Existing delivery/passport tests remain part of the frontend suite.
- Postcard tests cover image-size limits and restoring route visibility after both
  success and failure. Actual Chrome checks validate a decoded, non-empty PNG download.
- `tests/perf/street-life.mjs` captures an actual app camera at world x=763, z=-60,
  Medium, noon and 1280×720, for before/after comparison. Its QA multiplayer connection
  is explicitly stopped before camera positioning; this is a visual comparison, not
  a claim that the setup teleport passed multiplayer validation.
- `tests/perf/street-life-play.mjs` separately walks online from Riverside toward
  Street 144 using the existing street graph, approaches and greets a pedestrian,
  previews/downloads a postcard, returns to play, and checks the Low population cap.
  Its connection remains open; no fake player replaces the current user avatar.
- Measurements: docs/perf/street-life-before.json, street-life-after.json and
  street-life-play.json. Screenshots and the actual exported postcard are under
  /tmp/ppg-street-life-before.png, /tmp/ppg-street-life-after.png,
  /tmp/ppg-street-neighbour.png, /tmp/ppg-street-postcard.png and
  /tmp/ppg-street-postcard-preview.png.

This does not complete a photorealistic city. Large empty areas, estimated buildings,
landmark detail and repeated architecture still need source-backed work. Pedestrians
are local presentation, not synchronized multiplayer entities or city-wide schedules;
there is no new ambient vehicle traffic. Postcards download locally, without an online
album. Existing in-world delivery and multiplayer systems are preserved. No new
city-wide FPS target or physical second-device test is claimed.

Final validation: 269 frontend unit tests and three Node asset tests passed; frontend
check reported zero errors/warnings, the local Docker production build succeeded,
and both final Chrome scripts passed with no page errors. The online run verified
that navigation visibility is restored after postcard capture. The downloaded PNG
is a non-empty 1280×720 actual game image. Stationary matched Street 144 samples
were approximately 60 FPS before and after; draw calls changed from 123 to 138,
triangles from 65,176 to 87,286, and reported JS heap from 40.7 to 45.0 MiB. These
are short measurements on this machine, not GPU-memory or whole-city benchmarks.
No backend changes or new database migrations were made in this pass.

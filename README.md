# Phnom Penh Digital World · ពិភពឌីជីថលភ្នំពេញ

A multiplayer 3D city, marketplace, transport and delivery platform built on **real Phnom Penh
map data**. This repository grew out of two existing projects, which are left untouched:

* **CampusEats World** (`~/Downloads/campuseats-world`): the SvelteKit + Three.js 3D
  shopping game with 29 Blender GLBs. Its engine pieces (asset loading, articulated character
  animation) are reused, and the food court still runs at **`/mall`**.
* **CampusEats** (`~/Desktop/campusEats`): the FastAPI + PostgreSQL ordering backend. Its
  core (config, Argon2 auth, CSRF, error envelope, rate limiting, Alembic, real-DB tests) is
  reused. Its canteen ordering and demo-payment code are the reference for Phases 4 and 7.

**Status: Phases 1 (Foundation), 2 (3D city) and 3 (Multiplayer) are complete.** A new user can
register, verify, build an avatar, choose roles, pick a private delivery address and a public
spawn area on a real map, then walk the real streets of Daun Penh in 3D **with other real
players**: they see each other move, chat nearby or room-wide, send direct messages, wave or
sampeah, add friends, invite a friend and join them, and mute, block or report. Admins
moderate reports live. The city has Phsar Thmei's dome, Wat Phnom on its hill, Blender street
trees and lamps, bilingual street signs at real intersections, shophouse facades and a
day/night cycle on real Phnom Penh time, at 60 fps on an integrated Intel GPU. Shops,
vehicles, delivery and the wallet come in later phases (`docs/ROADMAP.md`).

| | |
|---|---|
| ![Central Market at midday](frontend/artifacts/phase2-central-market-noon.png) | ![Street 136 at night](frontend/artifacts/phase2-central-market-night.png) |
| ![Wat Phnom hill in the morning](frontend/artifacts/phase2-wat-phnom-morning.png) | ![Street 136 at sunset](frontend/artifacts/phase2-central-market-sunset.png) |
| ![Avatar](frontend/artifacts/phase1-avatar.png) | ![Location](frontend/artifacts/phase1-location.png) |
| ![Two players, chat and friends](frontend/artifacts/phase3-two-players.png) | |

*Phase 2 screenshots: headless Chrome on the machine's Intel GPU (`tests/perf/tour.mjs`).
Phase 1 and 3 screenshots: software WebGL, as used by the automated tests (the Phase 3 image is
player A's view during the two-browser test: player B nearby, the chat line, the People panel
showing B as an online friend).*

---

## Stack

| Layer | Technology |
|---|---|
| Web | SvelteKit 2 · Svelte 5 · TypeScript · Tailwind CSS 4 · Three.js 0.180 · MapLibre GL 5 · proj4 |
| API | Python 3.13 · FastAPI · Pydantic 2 · SQLAlchemy 2 (async) · Alembic · GeoAlchemy2 · Shapely · pyproj · uv |
| Data | PostgreSQL 17 + PostGIS 3.5 + pg_trgm (Docker) · OpenStreetMap snapshots |
| 3D assets | Blender 4.3 (`bpy` scripts) → GLB |
| Tests | pytest + HTTPX (real PostGIS) · Vitest · node:test · Playwright (real Chrome) |

## Quick start (development)

Requirements: Docker, [uv](https://docs.astral.sh/uv/), Node 22+, Chrome or Chromium (for E2E).

```bash
cp .env.example .env        # then set POSTGRES_PASSWORD (also inside both URLs) and JWT_SECRET
                            #   openssl rand -hex 24 ; openssl rand -hex 32
docker compose up -d db     # PostGIS on 127.0.0.1:5440, also creates ppw_test

cd backend
uv sync
uv run alembic upgrade head
uv run python scripts/import_osm.py      # ~3 s: real Daun Penh → PostGIS + 90 world chunks
uv run python scripts/seed.py            # bootstrap admin (prints a password once)
uv run uvicorn app.main:app --port 8000  # API docs: http://127.0.0.1:8000/api/docs

cd ../frontend                            # new terminal
npm install
npm run dev                               # http://localhost:5173
```

> If your Docker CLI points at Docker Desktop but the system daemon is the one running, prefix
> commands with `DOCKER_HOST=unix:///var/run/docker.sock`.

**Verification codes:** no SMS or e-mail provider is connected yet. In development, the code is
shown in a dashed "Developer mode" box on the Verify screen and logged by the API. The API
refuses to start with this enabled when `APP_ENV=production`.

**Admin:** sign in as the seeded admin and open `/admin` to approve seller and driver applications.

### Full stack in Docker

```bash
docker compose --profile full up -d --build   # http://localhost:3000
```

The API container migrates, imports the OSM snapshot if the database has none, then serves.
`infrastructure/nginx/ppw.conf` is an example TLS front proxy.

## Using it

1. **Welcome**: Enter / Sign in / Create account / Learn about the platform.
2. **Create account**: username, email or phone (Cambodian `0…` numbers become `+855…`),
   password, display name, language, terms and privacy.
3. **Verify** the 6-digit code.
4. **Avatar**: build, skin tone, hairstyle, tee or hoodie, trousers or shorts, colours, up to
   3 accessories (cap, glasses, backpack, krama). Drag to rotate the 3D preview.
5. **Role**: visitor always; buyer immediate; seller and driver await approval.
6. **Location**: search the city, tap the map to pin a **private** delivery address (buyers
   only; must be inside Phnom Penh), pick a **public** spawn area, and choose visible or hidden.
7. **World**: WASD or arrow keys, Shift to run, drag to orbit, wheel to zoom, **M** for places
   (fast travel), **Esc** for help. The HUD shows the street (English and Khmer), nearby
   landmark, lat/lon and world x/z; the minimap is drawn from the same data.
8. **Multiplayer**: other visible players appear with their own avatars and name tags. **Enter**
   opens chat (Nearby ≈ 40 m or World), **1–4** play emotes (wave, sampeah, cheer, dance),
   **P** opens People: nearby players, friends with online status, requests, direct messages,
   and per-player actions (add friend, invite, message, mute, block, report). An invite shows a
   "Join" toast to your friend. The chip at the top shows the connection state and players online.
9. **Admin** (`/admin`): seller and driver approvals, and the player report queue with the
   reported player's recent chat; dismiss, warn, mute chat for N hours or suspend.

## Tests and results (Phase 3, run on 2026-11-08)

```bash
cd backend  && uv run pytest && uv run ruff check . && uv run ruff format --check .
cd frontend && npm run check && npm test
cd frontend && npx playwright test tests/phase1.spec.ts tests/phase2.spec.ts tests/phase3.spec.ts  # needs API + dev server
cd frontend && npm run build && CAMPUS_PRODUCTION_TEST=1 npx playwright test tests/phase1.spec.ts tests/phase2.spec.ts tests/phase3.spec.ts
cd frontend && node tests/perf/measure.mjs                                     # real-GPU frame rates
cd frontend && BASE=http://127.0.0.1:3000 node tests/perf/two-players.mjs      # two GPU browsers against Docker
```

| Suite | Result |
|---|---|
| Backend pytest (real PostGIS, real Alembic migrations, real OSM import, real WebSockets) | **89 passed** (23 new: 15 multiplayer, 8 social/moderation) |
| Ruff lint + format | clean |
| `svelte-check` (TypeScript strict for new code) | 0 errors, 0 warnings |
| Vitest (projection vs pyproj, terrain vs Python, sun, chunk geometry, collision, avatar ↔ GLB contract, API client, **snapshot interpolation, socket reconnect/backoff**) | **52 passed** |
| Legacy CampusEats node tests (integrity of all 38 GLBs, cart/camera/crowd logic) | **10 passed** |
| Playwright E2E, dev server: Phase 1 onboarding → walk → resume, guards; Phase 2 hill, workers, props, night/day; **Phase 3 two browsers: see, follow, chat, emote, befriend, disconnect** | **4 passed** |
| Same E2E against the **production build** (`vite build`, adapter-node, worker bundle, WebSocket proxy) | **4 passed** |
| `docker compose --profile full build` + boot, two **GPU** browsers through `server.js` | both images build; the bots see each other (1.4 m apart), movement syncs (3.9 m walk), chat delivered, no page errors |
| GPU frame rate (Intel ADL-N iGPU, 1280×720, vsync) | **60 fps** in every scene at high quality (Phase 2 measurement, `docs/perf/`) |
| Legacy mall E2E (`tests/shopping.spec.js`, at `/mall`) | not re-run in Phase 3 (last: 2 passed in Phase 2; `/mall` code is unchanged) |

What the backend tests cover: registration and validation, Argon2 hashing, login by username,
email or phone, per-account rate limiting, session revocation (replayed cookies rejected),
CSRF and Origin checks, tampered tokens, verification (expiry, reuse, attempt limits, resend
cooldown), role permissions and admin approval (403 for non-admins), onboarding order, the
address service area and the single default address, the explicit visibility opt-in, privacy
(addresses owner-only, absent from public cards and audit logs, hidden players undiscoverable),
projection accuracy (<0.1 % against geodesic distance), OSM parsing (width and height sources,
multipolygon courtyards, partial-geometry regression, stupas mapped as towers), stable ids
across re-import, spawn points on open ground, chunk ETags, search in English and Khmer, the
terrain profile and Python/TypeScript fixture, landmark overrides in the chunks, sign
placement at real intersections and clear of carriageways and buildings, and lamp spacing
along whole streets. **Phase 3:** WebSocket admission (Origin, login, onboarding), two players
seeing each other and movement sync, despawn on leave, hidden players never broadcast, a second
tab replacing the first, server rejection of teleports, walls, water and out-of-region moves,
interest areas across fast travel, protocol errors, the chat filter, nearby range vs world chat
and persistence, chat and travel rate limits, emotes, sign-out and suspension kicking a live
socket, resume within 15 minutes, spawn spreading under concurrent joins, the friend flow with
live notifications, invites and joining, mute vs block semantics, direct messages, and reports
with chat evidence through to admin chat-mute and suspension.

## Project layout

```text
backend/            FastAPI app
  app/core          config, security, database, errors, rate limit
  app/api/v1        auth, me, geo, world, players, admin, realtime (WebSocket), social
  app/services      accounts, onboarding, geo, world, audit, notifier, social
  app/multiplayer   world hub (rooms, interest grid, tick), protocol, movement validation, chat filter
  app/geography     regions + landmark overrides + terrain (single source of truth), projection,
                    OSM parser, streetscape (signs, lamps), importer
  app/models        identity, geo, admin, social (rooms, player sessions, friends, blocks, mutes, chat, reports)
  migrations/       Alembic (0001: Phase 1 schema, PostGIS + pg_trgm; 0002: multiplayer and social)
  scripts/          import_osm.py, seed.py
  tests/            89 tests against PostGIS (HTTP and WebSocket)
frontend/           SvelteKit app; server.js = production server with the WebSocket upgrade proxy
  src/routes        / · about · login · register · onboarding/{verify,avatar,role,location} · world · admin · legal · mall (legacy) · dev/assets (dev only)
  src/lib/api       typed client + endpoints
  src/lib/game/city engine, chunk worker + geometry, assembly, materials (facade shader), props,
                    lighting + sun, terrain, collision, chunk streaming
  src/lib/game/net  WorldSocket (reconnect), WorldSession (reactive state), Interpolator, RemotePlayers
  src/lib/game      avatar/ (+ emotes), legacy player/camera/cart/npc
  src/lib/components/world  ChatBox, PeoplePanel
  src/lib/geo       projection (proj4, mirrors the backend)
  static/models     38 Blender GLBs (29 CampusEats + avatar + 6 street props + 2 landmarks)
  tests             Playwright (phase1/2/3.spec.ts, shopping.spec.js), legacy node tests, perf/ tools
tools/gis           fetch_osm.py + committed OSM snapshots (data/osm)
tools/blender       generate_avatars.py, generate_city_assets.py, compress_glb.mjs, generate_assets.py (CampusEats)
infrastructure/     Dockerfiles, Postgres init, nginx example
docs/               PRD, SRS, HLD, LLD, ERD, API, DATA, ROADMAP, perf/, legacy/
```

## Phase 3 report: multiplayer

**Features implemented**

* **World server.** An authoritative hub inside the API process at `WS /api/v1/world/ws`
  (same origin, proxied by Vite in dev/preview, by `frontend/server.js` in Docker, nginx example
  included). Admission requires an allowed `Origin`, the revocable login session and completed
  onboarding. Logins are re-checked every 30 s, so signing out or a suspension disconnects
  the socket.
* **Rooms and interest management.** A room per playable region (capacity 150; a new shard
  opens when full). The room is a grid of 200 m cells; each player receives only the 3×3 cells
  around them. A 10 Hz tick sends spawn, despawn and changed positions only, through a bounded
  per-connection queue.
* **Server-side movement.** Every position is checked for reachable speed, region bounds,
  building footprints and water using the same OSM data as the client. Invalid moves get a
  `correct` back. Fast travel and joining a friend are server teleports. Arrivals are spread
  out, including under concurrent joins.
* **Remote players.** Real avatars from each player's customisation, snapshot interpolation
  (100 ms behind), walking gait, name tags, speech bubbles, emotes (wave, sampeah, cheer, dance).
  Only registered, online and visible players appear. Nothing is simulated.
* **Chat.** Nearby (40 m) and world channels, direct messages (REST plus live delivery), text
  normalisation, a length cap, profanity masking with flagging, rate limits and chat-mutes.
* **Social.** Friends (requests, accept or decline, unfriend, mutual auto-accept) with
  online presence, invites with a one-click join, mute (chat only) and block (both players
  disappear for each other immediately and the friendship ends).
* **Safety and moderation.** Reports carry the reported player's last 24 h of public chat and
  the DMs they sent the reporter. The admin queue offers dismiss, warn, chat-mute (1 h to 7 days)
  and suspend, which apply to the live session immediately and are audited.
* **Persistence.** `player_sessions` keeps each connection and its last *virtual* position;
  reconnecting within 15 minutes resumes there.
* **Client UI.** Connection chip, online count, chat box, People panel (Nearby, Friends,
  Messages), emote bar, toasts, keyboard shortcuts. The legacy "Solo preview" label is gone.

**Files.** Backend: `app/multiplayer/` (hub, protocol, validation, chatfilter),
`app/models/social.py`, `app/services/social.py`, `app/api/v1/realtime.py`,
`app/api/v1/social.py`, the admin report endpoints, migration `0002`, `tests/test_multiplayer.py`
and `tests/test_social.py`. Frontend: `src/lib/game/net/` (protocol, WorldSocket, Interpolator,
RemotePlayers, WorldSession), `src/lib/game/avatar/emotes.ts`, `ChatBox.svelte`,
`PeoplePanel.svelte`, the world and admin pages, `server.js`, `tests/phase3.spec.ts` and
`tests/perf/two-players.mjs`. Infrastructure: the frontend Dockerfile runs `server.js`, and nginx
has a WebSocket location. Docs: HLD, LLD (protocol, close codes), ERD, API, SRS, ROADMAP, and
the privacy draft.

**Bugs found and fixed during Phase 3**

* The friendship pair index was built on string constants and would have allowed only one
  friendship in the whole table. It now indexes `least/greatest` of the real columns.
* Two players joining at the same moment were placed on the same spot. Registration in the room
  now happens before the first database await, and arrivals are spread out.
* A Phase 1 E2E regression came from walking speed scaling with frame rate on software-rendered
  browsers (around 2 fps): a 0.1 s step clamp caused slow motion. The engine now uses real
  elapsed time with a 0.25 s clamp.

**Known limitations (honest list)**

* **One API process.** The hub is in memory, so a deployment runs a single API worker (about
  150 players per room; total capacity has not been load-tested). Redis pub/sub and room
  pinning for scale-out are planned for Phase 8, and the rate limiter is still in-process.
* **The chat filter is basic and English-only.** Khmer terms need native-speaker input.
  Moderators cannot yet hide individual messages.
* **No chat retention job yet.** Messages are kept indefinitely in development; a retention
  period must be set before launch (the privacy draft says so).
* **The server does not collide with trees and poles** (the client does), so a modified client
  could walk through a lamp post, but never through a building or into the river.
* **Remote avatars are cosmetic**: no vehicles (Phase 5), and no player-to-player collision.
* Software-rendered E2E browsers run at about 1–3 fps, so those tests check movement by
  distance rather than timing. Real-GPU sync was verified separately with `two-players.mjs`.
* **E2E tests share the dev API and world hub.** While they run, the test bots are real
  players in that world and anyone online there can see them (this happened during
  development: two bot chat lines, "Sous-dey! Meet me at the dome 🙂" and "(test bot) sync
  check", and the E2E line "(e2e) hello from B"). A dedicated test API instance on the
  `ppw_test` database is the fix (next task). The 14 transient E2E accounts have been deleted
  from the dev database; `perfbot` and `perfbot2` remain for the perf scripts.
* Earlier limitations still apply: no SMS or e-mail provider, a stylised city with mostly
  estimated heights, an English-only UI, and draft legal pages.

**Next development tasks: Phase 4, marketplace.** Virtual shop units with transactional,
database-unique claims, merchant verification, a seller dashboard and product catalogue, 3D
storefronts (the `/mall` food court as the interior template), and a server-priced
multi-merchant cart with demo checkout. The design is in `docs/ROADMAP.md`.

## Phase 2 report: 3D city

**Features implemented**

* **Landmarks.** Phsar Thmei: the real X-plan wings plus a Blender Art Deco dome (louvred drum,
  16 ribs, lantern) reaching the published 26 m. Wat Phnom: a Blender stupa on the OSM stupa
  footprint (newly parsed: OSM maps it as `man_made=tower`) and a tiered Khmer roof with chofa
  finials on the vihara. Temples and pagodas get Khmer roofs automatically. Two duplicate OSM
  footprints are hidden. Every override records its height source (`reference` or `estimated`).
* **Terrain.** Wat Phnom's 27 m hill, a single function shared by Python and TypeScript (test
  fixtures keep them identical). Roads, buildings, props, labels, signs, the avatar and the
  camera all follow it.
* **Street furniture.** New Blender GLBs: rain tree, ornamental tree, sugar palm, double-arm
  boulevard lamp, traffic signal, sign post. They are Meshopt-compressed, instanced per chunk,
  and given colliders.
* **Street signs.** 181 blue bilingual signs (Khmer above English) at real named
  intersections, one blade per street, readable from both sides.
* **Lamps.** 748 generated along whole streets (OSM maps none here). At night they light warm
  pools on the ground.
* **Facades.** A shader tiles 4 m × 3.3 m bays: shophouse ground floors with rolled shutters
  and goods, windows above, and about 42 % of windows plus every shop lit at night.
* **Day/night.** The real sun over Phnom Penh (UTC+7) or Morning, Midday, Sunset and Night
  presets: sun and moon, sky, fog and exposure. The HUD shows the clock.
* **Performance.** Chunk fetching and triangulation moved to two Web Workers with zero-copy
  transfer; at most one chunk is assembled per frame; shadows are cached on a 12 m grid; distant
  detail is hidden. Result: a locked 60 fps on an Intel Alder Lake-N iGPU (render ≈ 4 ms/frame).
  The first Phase 2 build had dropped to 43 fps; the measurement-driven fixes are in
  `docs/perf/README.md`.
* **Tooling.** A dev-only `/dev/assets` gallery, an asset compression script, and GPU
  benchmark, probe, ablation and screenshot-tour scripts.

**Bugs found and fixed during Phase 2:** lamps were missing on short OSM street fragments
(streets are now merged before spacing); street-sign posts stood at the carriageway edge
(the bisector offset ignored the corner angle, which a test caught); a temple got shopfronts;
night lighting was too dark to play.

**Known limitations (honest list)**

* **Verification delivery** is not connected to an SMS or e-mail provider (dev code on screen;
  production refuses).
* **Stylised, not photorealistic.** 97.8 % of building heights are estimated. Facade colours,
  window lighting, tree species, park trees and all street lamps are generated. The hill shape
  and the landmark proportions are approximations (`docs/DATA.md` lists every source).
* **Performance is measured on one machine** (Intel ADL-N iGPU). Other GPUs, phones and
  high-DPI screens are not yet profiled.
* The camera can end up under tree canopies (crowns are not occluders). There is no entering
  buildings, jumping or physics.
* **The UI is English only.** Khmer is used for place names and street signs; UI translation
  needs native review.
* The rate limiter is in-process (one API worker). (Phase 3 moved Redis to Phase 8.)
* The terms and privacy pages are drafts, not legal documents.

## Data and licences

* Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL 1.0.
  Snapshot dates, coverage and accuracy: `docs/DATA.md`.
* Location-picker base map: OpenFreeMap / OpenMapTiles (configurable: `PUBLIC_MAP_STYLE_URL`).
* 3D models: original Blender work, CC0 (`frontend/static/models/LICENSE.txt`).
* **Virtual property is not real property, and demo credits have no monetary value.** Real
  payments will be added only through a licensed provider, after Cambodian legal and
  regulatory advice.

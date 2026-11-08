# High-level design

## Shape: a modular monolith

```text
 Browser ──HTTPS──▶ SvelteKit server (adapter-node)
   │                 ├─ pages: welcome, auth, onboarding, world, admin, /mall (legacy)
   │                 ├─ /api/* ──proxy (same-origin cookies)──▶ FastAPI (uvicorn)
   │                 └─ /api/v1/world/ws ──WebSocket pass-through (Vite proxy / server.js)──▶
   │                                                              ├─ core: config, security, errors, rate limit
   │  WebGL: Three.js city, Blender GLBs                           ├─ api/v1: auth, me, geo, world, players, admin
   │  MapLibre: location picker                                    ├─ services: accounts, onboarding, geo, world, audit
   │                                                               ├─ geography: projection, OSM parser, importer
   └─ static: /models/*.glb                                       ├─ multiplayer: world hub (rooms, presence, chat), social
                                                                    └─ (marketplace, delivery, payments: Phases 4–7)
                                                                       │
                                                         PostgreSQL 17 + PostGIS 3.5 (+ pg_trgm)
```

* **One API process, one database.** Domain modules (`geography`, `services/*`, and later
  `multiplayer`, `marketplace`, `delivery`, `payments`) share one transaction boundary. Split
  services out only when load or team boundaries demand it.
* **One origin for the browser.** The SvelteKit server proxies `/api` to FastAPI. The session
  cookie stays HTTP-only and first-party, so no CORS is needed. In Phase 3 the multiplayer
  WebSocket goes through the same origin.
* **One authoritative world process.** The WebSocket hub (rooms, presence, interest
  management, chat) runs inside the API process, so a deployment runs **one** API worker.
  Redis is deliberately **not** used yet: with a single process it would add an operational
  dependency without solving a problem. Scale-out plan (Phase 8): pin rooms to processes and
  use Redis pub/sub for cross-process presence, direct messages and invites, plus a shared
  rate-limit store.

## Data flow: entering the world

1. `GET /api/v1/auth/me` (layout load) reports the onboarding `next_step`. The client renders
   whatever the server reports, and the server validates every step.
2. `GET /world/bootstrap` returns the player, the avatar, the spawn point (lat/lon and world
   x/z) and the world config (origin, CRS, chunk index).
3. The client streams `GET /world/chunks/{ix}_{iz}`, a 200 m tile of pre-projected roads,
   buildings, areas, landmarks and furniture. Each tile has an ETag, `max-age=300`, and is
   cached by the browser.
4. Chunks within ~420 m load nearest-first, three at a time. Chunks beyond ~670 m unload,
   freeing GPU memory and colliders.

## Multiplayer (Phase 3)

```text
 browser A ─ws─┐                        ┌─ Room "daun-penh-central-1" (capacity 150; more rooms open when full)
 browser B ─ws─┼─▶ /api/v1/world/ws ──▶ │   grid of 200 m cells → each player sees its 3×3 neighbourhood
 browser C ─ws─┘   (cookie + Origin)    │   tick 10 Hz: spawn / despawn / changed positions only
                                         └─ per-connection send queue (slow clients are dropped)
 REST /social/* (friends, blocks, mutes, DMs, reports)  ──notify──▶ hub (live toasts, visibility)
 REST /admin/reports/*/resolve (warn, chat-mute, suspend) ─────────▶ hub (applies immediately)
```

* **Authoritative movement.** Clients predict their own movement; the server accepts a position
  only if it is reachable (≤ 8.8 m/s plus 2 m of slack), inside the region, and outside building
  footprints and water (the same OSM data, shrunk by 0.6 m). Otherwise it answers `correct`.
  Fast travel and joining a friend are server-side teleports. Arrivals are spread at least
  1.2 m apart.
* **Visibility.** Hidden players (`world_visible = false`) are never broadcast, and their
  presence is not shown even to friends. A block hides both players from each other immediately.
  A mute only hides chat.
* **Persistence.** `player_sessions` stores each connection with its virtual position (saved
  every 30 s and on leave). Reconnecting within 15 minutes resumes there. Every 30 s the hub
  re-validates logins: a revoked session or a suspended account disconnects the player.
* **Chat.** Nearby (40 m) and room-wide channels, plus persistent direct messages over REST.
  All text is normalised and length-capped, with basic profanity masking (flagged messages are
  marked), rate limits, chat-mutes and reports that carry the chat as evidence.

## Geography pipeline

`tools/gis/fetch_osm.py` (Overpass snapshot, committed) → `scripts/import_osm.py` (parse,
validate, upsert into PostGIS, project to UTM 48N, clip to 200 m chunks, place spawn points on
open ground) → `world_chunks.payload`, which is served as-is. The normalised tables (`roads`,
`buildings`, …) with GiST indexes stay the source of truth for spatial queries (search, reverse
lookup, nearby buildings, service-area checks).

## Security model

| Concern | Mechanism |
|---|---|
| Passwords | Argon2id (pwdlib); constant-time path for unknown accounts |
| Sessions | Signed token naming a **server-side session row** (revocable; logout really logs out); HTTP-only, SameSite=Lax, `Secure` required in production |
| CSRF | Origin check plus double-submit token (`ppw_csrf` cookie ↔ `X-CSRF-Token`) on every unsafe request |
| Authorisation | Roles in `user_roles` (`active`/`pending`/…); seller and driver need admin approval; admin cannot be self-assigned; every check runs server-side |
| Abuse | Per-IP and per-account rate limits on register, login, verification and geo search |
| Verification | 6-digit codes, HMAC-hashed with the server secret, bound to one verification row, 15-minute expiry, 5 attempts, resend cooldown, older codes invalidated |
| Privacy | Delivery addresses are private: owner-only endpoints, never in public cards, never in audit logs. Avatars spawn only at curated public places. Browser geolocation is disabled by `Permissions-Policy`. Visibility is an explicit choice with no default. |
| Audit | `audit_logs` for registration, verification, role requests and decisions, addresses (no coordinates), onboarding, blocks, reports and moderation actions |
| WebSocket | The `Origin` is checked before accepting (cookies ride along on cross-site handshakes); the same revocable session as REST; completed onboarding required; 4 KB message cap; schema-validated messages; per-player rate limits (moves 25/s, chat 6 per 10 s, world chat every 4 s, emotes 1/s, travel every 2 s); disconnect after 30 malformed messages |
| Production guards | The API refuses to start in production with a weak secret, without `COOKIE_SECURE`, or with dev verification codes exposed |

## Deployment

`compose.yaml` runs `db` (PostGIS) and, under the `full` profile, `backend` (migrate → import
if empty → uvicorn) and `frontend` (node build). `infrastructure/nginx/ppw.conf` is an
example TLS front proxy. Object storage for assets, CI/CD and monitoring are Phase 8 work.

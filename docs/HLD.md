# High-level design

## Shape: a modular monolith

```text
 Browser ──HTTPS──▶ SvelteKit server (adapter-node)
   │                 ├─ pages: welcome, auth, onboarding, world, admin, /mall (legacy)
   │                 └─ /api/* ──proxy (same-origin cookies)──▶ FastAPI (uvicorn)
   │                                                              ├─ core: config, security, errors, rate limit
   │  WebGL: Three.js city, Blender GLBs                           ├─ api/v1: auth, me, geo, world, players, admin
   │  MapLibre: location picker                                    ├─ services: accounts, onboarding, geo, world, audit
   │                                                               ├─ geography: projection, OSM parser, importer
   └─ static: /models/*.glb                                       └─ (multiplayer, marketplace, delivery, payments: Phases 3–7)
                                                                       │
                                                         PostgreSQL 17 + PostGIS 3.5 (+ pg_trgm)
```

* **One API process, one database.** Domain modules (`geography`, `services/*`, and later
  `multiplayer`, `marketplace`, `delivery`, `payments`) share one transaction boundary. Split
  services out only when load or team boundaries demand it.
* **One origin for the browser.** The SvelteKit server proxies `/api` to FastAPI. The session
  cookie stays HTTP-only and first-party, so no CORS is needed. In Phase 3 the multiplayer
  WebSocket goes through the same origin.
* **Redis** is planned for Phase 3: presence, room fan-out across processes and shared rate limits.
  The current rate limiter is in-process, which is fine for a single API worker.

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
| Audit | `audit_logs` for registration, verification, role requests and decisions, addresses (no coordinates), onboarding |
| Production guards | The API refuses to start in production with a weak secret, without `COOKIE_SECURE`, or with dev verification codes exposed |

## Deployment

`compose.yaml` runs `db` (PostGIS) and, under the `full` profile, `backend` (migrate → import
if empty → uvicorn) and `frontend` (node build). `infrastructure/nginx/ppw.conf` is an
example TLS front proxy. Object storage for assets, CI/CD and monitoring are Phase 8 work.

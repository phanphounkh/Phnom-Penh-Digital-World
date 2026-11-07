# Low-level design (Phase 1)

## Backend modules (`backend/app`)

| Module | Responsibility |
|---|---|
| `core/config.py` | Settings from env / repo `.env`; production safety checks |
| `core/security.py` | Argon2 hashing, session tokens (`sub` + `sid`), CSRF tokens, HMAC verification codes |
| `core/database.py` | Async SQLAlchemy engine; `Base` with naming convention; UUID/timestamp mixins |
| `core/rate_limit.py`, `core/errors.py` | Sliding-window limiter; `{"error": {code, message, details}}` envelope |
| `api/deps.py` | Session resolution (token → `sessions` row → user), `require_role`, client IP |
| `services/accounts.py` | Register, authenticate, open/revoke sessions, start/confirm verification |
| `services/onboarding.py` | Onboarding state machine, role selection, private addresses, spawn choice |
| `services/geo.py` | Search (pg_trgm + LIKE over places, streets, landmarks), reverse lookup, nearby buildings, spawn points, regions |
| `services/world.py` | World config (projection + chunk index), bootstrap, chunk ETags |
| `geography/projection.py` | `WorldProjection` (pyproj, vectorised shapely transforms), chunk maths, geodesic distance |
| `geography/osm.py` | Pure parser: Overpass JSON → typed features (estimates labelled) |
| `geography/importer.py` | Upserts, pruning, landmark→building links, chunk payloads, open-ground spawn placement |

## Onboarding state machine

```text
verify ──▶ avatar ──▶ role ──▶ location ──▶ complete ──▶ world
 (contact      (avatar     (roles_chosen_at   (spawn + explicit visibility
  verified)     saved)      set; visitor-only  + address if buyer)
                            is valid)
```

`GET /auth/me` reports `onboarding.next_step`. `POST /me/onboarding/complete` returns 409 with
`details.next_step` if a step is missing. The web app's onboarding layout lets users revisit
earlier steps but never skip ahead.

## Roles

`user_roles(user_id, role)` is unique. `visitor` is created active at registration. `buyer`
becomes active immediately (verified contact required). `seller` and `driver` start `pending`
and an admin approves or rejects them (`/admin/role-requests/{id}/approve|reject`, audited).
A rejected role can be requested again. Unticking a role sets it to `revoked`. `admin` cannot
be requested.

## World chunk payload (`GET /world/chunks/{ix}_{iz}`)

```jsonc
{
  "key": "0_-1", "ix": 0, "iz": -1, "size": 200,
  "roads":     [{ "id", "name", "name_en", "name_km", "cls": "primary", "w": 14.0,
                  "oneway", "bridge", "layer", "pts": [[x, z], …] }],      // clipped to the chunk
  "buildings": [{ "id", "name", "name_km", "kind", "h": 16.1, "min_h": 0,
                  "hs": "osm|levels|estimated", "colour",
                  "polys": [[outer, hole, …], …] }],                       // owned by the chunk containing its representative point
  "areas":     [{ "kind": "park|water|…", "name", "polys": [...] }],       // clipped to the chunk
  "landmarks": [{ "name", "name_en", "name_km", "cat", "sub", "imp": 1-3, "p": [x, z] }],
  "features":  [{ "k": "tree|street_lamp|traffic_signals|crossing", "p": [x, z] }]
}
```

Coordinates are world metres (2 decimals): `x = east`, `z = −north`. Rings are not closed
(the last point is not repeated).

## Frontend (`frontend/src`)

| Path | Responsibility |
|---|---|
| `hooks.server.ts` | `/api` proxy (hop-by-hop headers stripped, `X-Forwarded-*` overwritten) and security headers |
| `lib/api/*` | Typed client (CSRF echo, error envelope → `ApiError` with `fieldErrors`), endpoint functions, types |
| `lib/stores/session.svelte.ts` | Session store: request-scoped `page.data.user` during SSR (no cross-request leaks), client override after mutations; routing helpers |
| `lib/geo/projection.ts` | proj4 mirror of the backend projection; chunk keys; compass/yaw helpers |
| `lib/game/avatar/avatar.ts` | Loads `avatar.glb` once; per-avatar material clones; option visibility; per-joint batching |
| `lib/game/city/builders.ts` | Chunk → meshes: mitred road ribbons, sidewalks, dashed centre lines, area polygons, extruded buildings (walls with world-UV window texture, roofs split), instanced trees/lamps/signals, landmark label sprites |
| `lib/game/city/collision.ts` | Grid of wall segments per chunk; circle movement with sub-steps and sliding; escape-from-footprint; height-aware 2D camera ray |
| `lib/game/city/ChunkManager.ts` | Nearest-first streaming (3 concurrent), unload with hysteresis, nearest street and landmark |
| `lib/game/city/CityEngine.ts` | Renderer, sky, sun shadows following the player, avatar and `PlayerAnimations`, orbit camera with occlusion, input, adaptive quality, minimap drawing |
| `lib/game/player/PlayerAnimations.js` etc. | Reused unchanged from CampusEats World |

### Movement and camera

Camera-relative WASD; walk at 2.6 m/s, run at 6.5 m/s. The player circle has a radius of 0.35 m
and moves in sub-steps of half the radius, so it cannot tunnel through walls. World bounds are
the playable bbox minus 3 m. The camera orbits at 2.5–22 m. A 2D ray against wall segments,
using each building's height, pulls the camera in front of buildings that would block the view.
Performance mode turns off shadows, lowers the pixel ratio to 0.75 and shrinks the streaming
radius to 300 m. It switches on automatically after about 3 s of frames slower than 24 fps.

## Avatar asset contract (`tools/blender/generate_avatars.py`)

* Joints: `BodyRoot`, `Left/Right` × `Leg/Knee/Ankle`, `Arm/Elbow/Wrist` (the CampusEats rig).
* Materials: `Skin`, `Hair`, `Top`, `Bottom`, `Shoes`, `Accent`, `AccentDark` (recoloured) and
  fixed `Eyes`, `EyeHighlight`, `Lips`, `Sole`, `Laces`, `Frame`.
* Optional parts: `opt__<group>-<value>__<part>`, with groups `body`, `top`, `bottom`, `hair`, `acc`.
  `avatar.test.ts` fails if the GLB lacks any option the API accepts.

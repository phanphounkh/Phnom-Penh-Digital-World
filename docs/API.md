# API (v1)

Interactive OpenAPI docs: **http://127.0.0.1:8000/api/docs**. Through the web app, the same
paths are served at `/api/v1/*`.

Conventions: JSON bodies. Errors use `{"error": {"code", "message", "details"}}`, with 422
`VALIDATION_ERROR` details listed as `[{field, message, type}]`. Unsafe methods need the
`X-CSRF-Token` header (the value of the `ppw_csrf` cookie) once signed in. Coordinates are
WGS84 `lat`/`lon`; world coordinates are metres (`x` east, `z` = −north).

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /health` | – | Liveness |
| `POST /auth/register` | – (5 per 5 min per IP) | Create an account and session, and send the first verification code |
| `POST /auth/login` | – (10/min per IP, 10 per 15 min per account) | Sign in with username, email or phone |
| `POST /auth/logout` | optional | Revoke the server-side session and clear cookies |
| `GET /auth/me` | user | Account, roles and onboarding state (`next_step`) |
| `POST /auth/verification/send` | user (6/h) | New code (60 s cooldown; old codes invalidated) |
| `POST /auth/verification/confirm` | user (20 per 10 min) | Confirm a 6-digit code (5 attempts) |
| `GET /auth/sessions` / `DELETE /auth/sessions/{id}` | user | List or revoke your sessions |
| `PATCH /me/profile` | user | Display name, language, visibility |
| `GET / PUT /me/avatar` | user | Read or replace the avatar customisation |
| `POST /me/roles` | user, verified | Choose roles: buyer active now, seller and driver pending |
| `GET / POST /me/addresses`, `DELETE /me/addresses/{id}` | owner only | Private delivery addresses (must be inside Phnom Penh) |
| `PUT /me/spawn` | user | Public spawn point plus an explicit `world_visible` |
| `POST /me/onboarding/complete` | user | Validate every step (409 with `next_step` otherwise) |
| `GET /geo/regions` | – | City and playable regions with bbox and dataset provenance |
| `GET /geo/service-area` | – | Phnom Penh boundary (simplified GeoJSON) |
| `GET /geo/spawn-points` | – | Public spawn areas with lat/lon and world x/z |
| `GET /geo/search?q=` | – (120/min) | Khans, villages, markets, streets, landmarks (EN and KM) |
| `GET /geo/reverse?lat&lon` | – (120/min) | Nearest street, area, in-playable / in-service-area flags |
| `GET /geo/buildings/nearby?lat&lon&radius_m` | – (120/min) | Buildings by distance (≤ 500 m) |
| `GET /world/config` | – | CRS, origin, chunk size, playable regions and their chunk keys |
| `GET /world/bootstrap` | user, onboarded | Player, avatar, spawn, config |
| `GET /world/chunks/{ix}_{iz}` | – | Chunk payload (ETag; `If-None-Match` → 304) |
| `GET /players/{username}` | user | Public card: username, display name, avatar and badges only; hidden players return 404 to others |
| `WS /world/ws` | user, onboarded, allowed Origin | The multiplayer world (protocol in docs/LLD.md) |
| `GET /social/friends` | user | Friends and requests (online status for accepted friends, only while they are visible) |
| `POST /social/friends {username}` | user (30/h) | Send a request (accepts if they already asked you) |
| `POST /social/friends/{u}/accept` · `/decline`, `DELETE /social/friends/{u}` | user | Respond or unfriend |
| `GET /social/relations` | user | Who you have blocked or muted |
| `POST/DELETE /social/blocks/{u}` · `/social/mutes/{u}` | user | Block (hides both ways, ends friendship) or mute (hides chat) |
| `GET /social/conversations`, `GET /social/messages/{u}` | user | Direct-message inbox (unread counts) and thread (marks read) |
| `POST /social/messages/{u} {text}` | user (20/min) | Send a direct message (live notification if they are online) |
| `POST /social/reports {username, reason, details}` | user (10/h) | Report a player; their recent chat is attached as evidence |
| `GET /social/online` | user | Players online and visible |
| `GET /admin/reports?status=` · `POST /admin/reports/{id}/resolve {action, hours, note}` | admin | Moderate: dismiss, warn, chat-mute for N hours, or suspend (applied to the live session immediately; audited) |
| `GET /admin/role-requests?status=` | admin | Seller and driver applications |
| `POST /admin/role-requests/{id}/approve` · `/reject` | admin | Decide (audited; 409 if already decided) |
| `GET /admin/users?q=` | admin | User list |

Development only: while `EXPOSE_DEV_VERIFICATION_CODES=true` and no SMS or e-mail provider is
configured, verification responses include `dev_code`. The API refuses to start in production
with this enabled.

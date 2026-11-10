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
| **Marketplace (Phase 4)** | | Money is integer US cents (`*_minor`); every payment is a demo |
| `GET /market/units?bbox=w,s,e,n&available=` | – | Shop units in a map area (≤ about 2 × 2 km): code, street, outline, status, verification flag |
| `GET /market/units/{code}` | – | One unit |
| `GET /market/shops?region=` · `GET /market/shops/{id}` | – | Live storefronts (world geometry, theme, catalogue version) · a shop with its purchasable products |
| `GET /market/categories` | – | Product categories with policy: allowed, restricted (review, 18+), prohibited |
| `POST /market/disputes {unit_code, reason, contact}` | verified user (5/day) | Dispute a claim (e.g. the real business owner) |
| `GET /media/products/{name}.webp` | – | Product photos (re-encoded, metadata removed; immutable cache) |
| `GET / POST / PUT /merchant` | user (apply: 5/h) | Merchant profile; applying also requests the seller role |
| `POST /merchant/documents` (multipart `file`, `kind`) | owner (20/h) | Verification document (PDF/JPEG/PNG ≤ 5 MB, private) |
| `GET / POST /merchant/claims {unit_code, evidence_note, document_id}` | approved seller (20/h) | Claim a unit: approved at once, or pending review at a real business. 409 `UNIT_TAKEN`, `CLAIM_LIMIT`; 422 `EVIDENCE_REQUIRED` |
| `POST /merchant/claims/{id}/release` · `/renew` · `/transfer {to_username}` | owner | Give up, extend 30 days, offer to another merchant |
| `GET /merchant/transfers` · `POST /merchant/transfers/{id}/accept\|decline\|cancel` | merchant | Transfers in and out |
| `GET /merchant/shops` · `PATCH /merchant/shops/{id}` | owner | Storefront name (EN/KM), tagline, theme, colours, open/closed |
| `GET / POST /merchant/products`, `PATCH / DELETE /merchant/products/{id}` | owner | Catalogue (archive, never delete); restricted categories go to review |
| `PUT /merchant/products/{id}/stock {on_hand}` · `POST …/image` (multipart) | owner | Stock; photo (≤ 4 MB) |
| `GET /merchant/orders?status=open` · `POST /merchant/orders/{id}/transition {to, reason}` | owner | Fulfil: accept → preparing → ready → completed, or refund |
| `GET /merchant/revenue?days=` | owner | Demo revenue per day, refunds, open orders |
| `GET /cart`, `POST /cart/items {product_id, quantity, shop_id}`, `PATCH / DELETE /cart/items/{id}`, `DELETE /cart` | buyer | Server cart, repriced on every read; stock-checked |
| `POST /checkout {expected_total_minor, note, age_confirmed}` + `Idempotency-Key` | buyer (20/10 min) | One demo payment, one order per merchant, stock reserved. 409 `PRICE_CHANGED`, `ITEMS_UNAVAILABLE`, `IDEMPOTENCY_KEY_REUSED`; same key and body → same checkout |
| `GET /payments/{id}` · `POST /payments/{id}/confirm` · `/cancel` | owner | Demo pay (repeat → same result, `already_confirmed`), cancel; unpaid checkouts expire after 15 min |
| `GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/cancel`, `POST /orders/{id}/received` | buyer | Track, cancel (refund if paid), confirm collection. Other people's orders are 404 |
| `GET /admin/merchants?status=` · `POST /admin/merchants/{id}/approve\|reject\|suspend` · `GET /admin/documents/{id}` | admin | Review merchants and documents (download audited) |
| `GET /admin/claims?status=` · `POST /admin/claims/{id}/approve\|reject\|revoke` | admin | Claims at real businesses |
| `GET /admin/disputes` · `POST /admin/disputes/{id}/resolve {uphold, note}` | admin | Upholding revokes the claim |
| `GET /admin/products` · `POST /admin/products/{id}/approve\|reject` | admin | Restricted-category listings |
| **Transport (Phase 5)** | | World metres (`x` east, `z` = −north); modes `foot`, `bicycle`, `motorbike` |
| `GET /transport/info` | – | Travel modes (top/cruise speeds, sizes), mode bits, mount range, riding margin, kerb band, starter colours |
| `GET /vehicles` | user | My vehicles: kind, name, colour, virtual plate, `parked`/`in_use`, position, street (EN/KM), odometer |
| `POST /vehicles {kind, color?, name?}` | user, onboarded (10/h) | Take a free starter vehicle (one per kind; 409 `VEHICLE_EXISTS`), parked at the nearest legal spot next to you (409 `NO_PARKING_NEARBY`) |
| `PATCH /vehicles/{id} {name?, color?}` · `DELETE /vehicles/{id}` | owner | Rename or repaint (riders see it live) · give it back (409 `VEHICLE_IN_USE` while ridden). Others' vehicles are 404 |
| `POST /vehicles/{id}/summon` | owner, in the world, on foot | Valet: re-park it next to you (once a minute per vehicle: 429) |
| `GET /routes?from_x&from_z&to_x&to_z&mode` | – (120/min) | Fastest route on the road graph: `distance_m`, `duration_s`, `points`, `segments` (edge, width, class, `oneway` for this mode, street EN/KM, OSM speed limit), `steps` (depart, turns, arrive). 404 `NO_ROUTE`, 422 `OUTSIDE_PLAYABLE_AREA` |
| `GET /roads/snap?x&z&mode` | – (120/min) | World → nearest usable road position (edge, metres along, street, modes per direction) |
| `GET /roads/position?edge&along_m` | – | Road position → world position and bearing |
| `GET /admin/role-requests?status=` | admin | Seller and driver applications |
| `POST /admin/role-requests/{id}/approve` · `/reject` | admin | Decide (audited; 409 if already decided) |
| `GET /admin/users?q=` | admin | User list |

Development only: while `EXPOSE_DEV_VERIFICATION_CODES=true` and no SMS or e-mail provider is
configured, verification responses include `dev_code`. The API refuses to start in production
with this enabled.

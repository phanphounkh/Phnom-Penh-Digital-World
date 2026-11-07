# Product requirements: Phnom Penh Digital World

## Vision

A persistent, multiplayer 3D Phnom Penh built on real map data. People register, create an
avatar, walk real streets, meet other online players, run virtual shops and buy products. In
later phases, real orders can be fulfilled by real delivery drivers. The 3D world is the
experience; the backend owns every transaction.

## Principles

1. Geography comes from real map data (OpenStreetMap), never invented layouts. Gaps and
   estimates are labelled.
2. Only registered, online players who chose to be visible appear. There are no fake crowds.
3. Secure accounts. A user can hold several roles; seller and driver need approval.
4. Virtual property is never real property. Real business owners can dispute claims (Phase 4).
5. Money is simulated until a licensed provider and Cambodian legal advice are in place.
6. Every financial or marketplace action is validated by the backend.
7. The world is multiplayer, not single-player with scripted characters (Phase 3).
8. It must run on ordinary computers (streaming, LOD, adaptive quality).
9. A modular monolith that is testable and documented.

## Personas

| Role | Wants | Phase |
|---|---|---|
| Visitor | Explore and see what's there | 1 |
| Buyer | Shop, order, track deliveries | 1 (role), 4–7 (features) |
| Seller | Run a storefront, manage stock and orders | 1 (application), 4 |
| Driver | Take delivery jobs, earn | 1 (application), 6 |
| Administrator | Approve roles, moderate, resolve disputes | 1 (role review), 8 |

## Phase 1 scope (this build)

| Area | Delivered |
|---|---|
| Welcome | Enter / Sign in / Create account / Learn about the platform; hero drawn from the real street data |
| Account | Username, email **or** phone (+855 normalisation), password, display name, language, terms and privacy consent |
| Verification | One-time codes (dev banner; no provider yet) |
| Avatar | Modular Blender GLB: 2 builds, 6 skin tones, 4 hairstyles, tee or hoodie, trousers or shorts, colours, up to 3 accessories (cap, glasses, backpack, krama); live 3D preview |
| Roles | Visitor always; buyer immediate; seller and driver pending admin approval; admin review page |
| Location | MapLibre map of Phnom Penh: search, pin a **private** delivery address (validated inside the city boundary), choose a **public** spawn area, explicit visibility choice |
| World | One playable neighbourhood (Daun Penh, 2.8 km²) streamed from PostGIS: 2,375 real footprints, 787 roads, parks, river, landmarks; avatar with gait animation; third-person camera; collisions; minimap; bilingual street names; fast travel between spawn areas |
| Platform | FastAPI, PostGIS, Alembic, Docker Compose, 56 API tests, 39 unit tests, browser E2E |

## Phase 1 acceptance (all verified; see the README test log)

* A new user goes Register → Verify → Avatar → Role → Location → 3D world in a real
  browser, walks, and returns to the world after a reload.
* The steps cannot be skipped (server-enforced), and the world requires sign-in.
* Addresses outside Phnom Penh are rejected. Addresses are invisible to other users and
  absent from audit logs.
* Seller and driver roles stay pending until an admin approves them; non-admins get 403.
* Client and server projections agree to within 1 cm. Spawn points are on open public ground.

## Out of scope for Phase 1

Multiplayer, chat, shops and products, carts, vehicles, routing, delivery, wallet, real money,
Khmer UI translation, mobile apps.

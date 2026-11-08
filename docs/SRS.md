# Software requirements specification (status as of Phase 1)

Status: ✅ done and tested · 🟡 partial · ⏳ planned (phase). Tests are in `backend/tests`
(`B:`), `frontend/src/**/*.test.ts` (`U:`) and `frontend/tests/phase1.spec.ts` (`E:`).

## Functional

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| F-AUTH-1 | Register with a username plus email or phone, password ≥ 10, display name, language, consent | ✅ | B: test_auth (register, validation, phone normalisation); E |
| F-AUTH-2 | Unique username, email and phone (DB constraints plus friendly 409) | ✅ | B: test_register_rejects_duplicates |
| F-AUTH-3 | Verify the contact method with expiring, attempt-limited one-time codes | ✅ | B: test_verification (6 tests) |
| F-AUTH-4 | Sign in with username, email or phone; generic errors; rate limits | ✅ | B: test_login_* |
| F-AUTH-5 | Revocable server-side sessions; list and revoke; logout invalidates replayed cookies | ✅ | B: test_logout_*, test_sessions_* |
| F-ROLE-1 | Visitor always; buyer immediate; seller and driver pending admin approval; admin never self-assigned | ✅ | B: test_roles (8 tests) |
| F-ROLE-2 | Admin approves or rejects with a reason; decisions audited; rejected users can re-apply | ✅ | B: test_admin_approves_*, test_role_decisions_are_audited |
| F-AVA-1 | Customise appearance, clothing, hairstyle, accessories and name, with a live 3D preview | ✅ | B: test_avatar_validation; U: avatar.test.ts; E |
| F-LOC-1 | Real Phnom Penh map: search, zoom, select a point | ✅ | B: test_search_finds_real_places; E |
| F-LOC-2 | Private delivery address inside the Phnom Penh boundary; one default | ✅ | B: test_addresses_must_be_inside_phnom_penh, test_only_one_default_address |
| F-LOC-3 | Public spawn area (curated, on open ground); explicit visibility opt-in | ✅ | B: test_spawn_points_are_on_open_public_ground, test_visibility_must_be_an_explicit_choice |
| F-ONB-1 | Server-enforced onboarding order; world requires completion | ✅ | B: test_steps_are_enforced_in_order; E |
| F-GEO-1 | Real OSM roads, buildings, areas and landmarks in PostGIS with provenance | ✅ | B: test_import_produced_real_neighbourhood |
| F-GEO-2 | lat/lon ↔ world conversion (UTM 48N), distances, chunk indexing | ✅ | B: projection tests; U: projection.test.ts |
| F-GEO-3 | Nearby buildings, reverse lookup, search | ✅ | B: test_reverse_lookup_and_nearby_buildings |
| F-WORLD-1 | Stream chunks near the player and unload distant ones | ✅ | E (chunk counts in the HUD); ChunkManager |
| F-WORLD-2 | Avatar movement (walk, run, turn), third-person camera, collisions | ✅ | U: collision.test.ts; E (player moves) |
| F-WORLD-4 | Recognisable landmarks, terrain, street furniture, street signs, day/night (Phase 2) | ✅ | B: test_streetscape (10); U: chunkGeometry/terrain tests (18); E: phase2.spec.ts |
| F-WORLD-3 | Road-position → world, route calculation | ⏳ 5 | Navigation graph planned |
| F-MP-1 | Real players only; presence on connect, despawn and session close on disconnect; one connection per account | ✅ | B: test_two_players…, test_departure…, test_a_second_connection…; E: phase3.spec.ts |
| F-MP-2 | Position sync with interpolation; spatial interest management | ✅ | B: test_far_players…; U: Interpolator.test.ts; E: phase3 (B's walk seen by A) |
| F-MP-3 | Server validation of speed, bounds and footprints; authoritative travel and teleports | ✅ | B: test_server_rejects_teleports_walls_and_bounds, test_players_arriving… |
| F-MP-4 | Opt-in visibility; hidden players never broadcast | ✅ | B: test_hidden_players_are_never_broadcast, test_hidden_players_do_not_show_as_online… |
| F-MP-5 | Usernames, emotes, nearby/world chat, private messages | ✅ | B: test_nearby_and_world_chat, test_emotes…, test_direct_messages; E: phase3 |
| F-MP-6 | Friend requests, friend invitations (join a friend), mute, block, report | ✅ | B: test_social.py (8 tests); E: phase3 (friend via UI) |
| F-MP-7 | Moderation and rate limiting (chat filter, limits, chat-mute, suspend, session re-validation) | ✅ | B: test_chat_is_rate_limited, test_reports_capture_context…, test_signing_out_elsewhere… |
| F-SHOP-*, F-CART-*, F-ORD-* | Shop claims, products, cart, orders | ⏳ 4 | Legacy cart/checkout kept at `/mall` |
| F-VEH-* | Vehicles | ⏳ 5 | |
| F-DEL-* | Delivery jobs | ⏳ 6 | |
| F-PAY-* | Demo wallet and ledger | ⏳ 7 | |

## Non-functional

| ID | Requirement | Status | Notes |
|---|---|---|---|
| N-SEC-1 | Argon2id passwords; CSRF protection; secure cookie flags; production guards | ✅ | B: test_state_changes_require_csrf_token, test_cross_origin_writes_are_blocked, test_password_is_hashed_with_argon2 |
| N-SEC-2 | Rate limiting on auth, verification, search, social and WebSocket messages | ✅ | In-process (one API process); a shared Redis store comes with Phase 8 scale-out |
| N-SEC-3 | WebSocket hijacking protection (Origin), session binding, revocation | ✅ | B: test_connection_requires_origin_session_and_onboarding, test_signing_out_elsewhere… |
| N-SCALE-1 | Multiple API processes for the world | ⏳ 8 | Single authoritative process today (docs/HLD.md) |
| N-PRIV-1 | Addresses owner-only; never in public cards or audit logs; avatar position ≠ GPS | ✅ | B: test_privacy (5 tests) |
| N-DATA-1 | Dataset dates, coverage, accuracy and estimates documented and labelled per feature | ✅ | docs/DATA.md; `*_source` columns |
| N-PERF-1 | Usable on ordinary computers: streaming, merged meshes, instancing, adaptive quality | ✅ | 60 fps (p5 ≥ 59.5, no frame over 16.8 ms while streaming) at high quality on an Intel Alder Lake-N iGPU, 1280×720; render ≈ 4 ms/frame. docs/perf/README.md |
| N-PERF-2 | 3D assets are lazy-loaded | ✅ | Three.js and MapLibre load only on the pages that need them |
| N-I18N-1 | Preferred language stored; Khmer place names | 🟡 | UI text is English only |
| N-OPS-1 | Docker Compose, migrations, idempotent import | ✅ | Images built and the stack smoke-tested |
| N-OPS-2 | CI/CD, monitoring, object storage | ⏳ 8 | |

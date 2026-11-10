# Software requirements specification (status as of Phase 5)

Status: ✅ done and tested · 🟡 partial · ⏳ planned (phase). Tests are in `backend/tests`
(`B:`), `frontend/src/**/*.test.ts` (`U:`) and `frontend/tests/phase*.spec.ts` (`E:`).

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
| F-WORLD-3 | Road-position ↔ world, route calculation on the real road graph | ✅ | B: test_road_positions_round_trip, test_route_on_real_streets, test_imported_road_graph_is_connected_and_consistent |
| F-MP-1 | Real players only; presence on connect, despawn and session close on disconnect; one connection per account | ✅ | B: test_two_players…, test_departure…, test_a_second_connection…; E: phase3.spec.ts |
| F-MP-2 | Position sync with interpolation; spatial interest management | ✅ | B: test_far_players…; U: Interpolator.test.ts; E: phase3 (B's walk seen by A) |
| F-MP-3 | Server validation of speed, bounds and footprints; authoritative travel and teleports | ✅ | B: test_server_rejects_teleports_walls_and_bounds, test_players_arriving… |
| F-MP-4 | Opt-in visibility; hidden players never broadcast | ✅ | B: test_hidden_players_are_never_broadcast, test_hidden_players_do_not_show_as_online… |
| F-MP-5 | Usernames, emotes, nearby/world chat, private messages | ✅ | B: test_nearby_and_world_chat, test_emotes…, test_direct_messages; E: phase3 |
| F-MP-6 | Friend requests, friend invitations (join a friend), mute, block, report | ✅ | B: test_social.py (8 tests); E: phase3 (friend via UI) |
| F-MP-7 | Moderation and rate limiting (chat filter, limits, chat-mute, suspend, session re-validation) | ✅ | B: test_chat_is_rate_limited, test_reports_capture_context…, test_signing_out_elsewhere… |
| F-PROP-1 | Claimable virtual shop units with unique IDs, cut from real non-residential OSM buildings facing real streets | ✅ | B: test_units_are_storefronts_of_real_non_residential_buildings, test_unit_map_api |
| F-PROP-2 | Two sellers can never hold the same unit (database-level partial unique index; transactional claims) | ✅ | B: test_two_sellers_cannot_claim_the_same_unit (concurrent + bypassing app code); E: phase4 race |
| F-PROP-3 | No claiming someone else's real business: units at a named OSM business need evidence and admin review; disputes | ✅ | B: test_real_business_unit_needs_evidence_review_and_can_be_disputed |
| F-PROP-4 | Claim expiry and renewal, release, transfer between merchants, admin revoke; per-merchant limit | ✅ | B: test_claim_limit_release_and_expiry, test_transfer_moves_the_unit_to_another_merchant |
| F-MER-1 | Merchant registration (name, category, contacts, private address, hours, documents) with approve/reject/suspend | ✅ | B: test_merchant_application_needs_admin_approval; E: phase4 (dashboard + admin UI) |
| F-MER-2 | Seller dashboard: units map, storefront customisation, products, stock, orders, revenue, customer messages | ✅ | E: phase4; B: catalogue/order tests |
| F-CAT-1 | Products with price (integer cents), currency, stock, images (EXIF stripped), display model, availability, fulfilment | ✅ | B: test_catalogue_rules_and_storefront, test_image_upload_strips_metadata |
| F-CAT-2 | Regulated categories: prohibited (refused) and restricted (admin review, 18+ confirmation) | ✅ | B: test_catalogue_rules_and_storefront, test_age_restricted_items_need_confirmation |
| F-SHOP-1 | Walk-in 3D storefronts at the real frontage: sign, awning, shelves, products with price tags, cart, counter | ✅ | U: layout.test.ts, collision doorway tests; B: test_shop_floor_is_walkable…; E: phase4 |
| F-SHOP-2 | Press E to pick up a product (held in hand), put it in the cart (server cart), pay at the counter | ✅ | E: phase4.spec.ts |
| F-CART-1 | Server cart (product, merchant, quantity, quoted price, owner); repriced on every view; stock checks | ✅ | B: test_cart_reprices_and_checks_stock |
| F-ORD-1 | One checkout → one order per merchant; server recalculates prices (PRICE_CHANGED on mismatch) | ✅ | B: test_multi_merchant_checkout_is_server_priced_and_idempotent |
| F-ORD-2 | Explicit order state machine (13 states) with actor rules and history | ✅ | B: test_order_lifecycle_refunds_and_revenue; E: phase4 |
| F-ORD-3 | Users cannot see or modify other users' payments or orders | ✅ | B: test_users_cannot_touch_other_peoples_payments_or_orders |
| F-PAY-0 | Demo checkout: idempotent creation (Idempotency-Key), a payment cannot be completed twice, expiry releases stock, simulated refunds | ✅ | B: test_payment_cannot_be_completed_twice, test_unpaid_checkout_expires…, test_multi_merchant… |
| F-NET-1 | Routing graph from OSM ways (split at shared nodes, clipped to the playable area) with per-direction access for foot, bicycle, motorbike (class + access/oneway tags) | ✅ | B: test_access_masks_follow_osm_tags (15 cases), test_ways_are_split_at_shared_nodes_and_clipped_to_the_area, test_chunk_roads_carry_direction_masks |
| F-NET-2 | Routes respect one-way streets for vehicles, not for pedestrians; turn-by-turn steps with EN/KM street names | ✅ | B: test_one_way_streets_bind_vehicles_not_pedestrians, test_route_on_real_streets; U: route guidance |
| F-VEH-1 | Vehicles (bicycle, motorbike) owned by players: free starter per kind, parked on the nearest street, repaint, valet, give back; owner-only | ✅ | B: test_starter_vehicles_are_parked_legally_next_to_you; E: phase5.spec.ts |
| F-VEH-2 | Mount within 3 m of your own vehicle; server-validated speed per vehicle type; vehicles stay on roads their mode may use and off shop floors | ✅ | B: test_riding_a_motorbike_is_validated_by_the_server, test_vehicles_stay_on_roads_and_park_at_the_kerb; U: riding physics, road network |
| F-VEH-3 | Parking: kerb, pavement, alleys, car parks; never mid-carriageway or on another vehicle; auto-park on disconnect and fast travel | ✅ | B: test_vehicles_stay_on_roads…, test_disconnecting_or_travelling_parks_the_vehicle; E: phase5 |
| F-VEH-4 | Vehicle sync: riders shown on their vehicle; parked vehicles visible in the area without owner identity; hidden/blocked owners leave no trace | ✅ | B: test_riding_a_motorbike…, test_hidden_and_blocked_owners_leave_no_trace; E: phase5 (second browser) |
| F-VEH-5 | Lane-aware guidance (right-hand lane, one-way lanes, pavement for walkers), route line and minimap, autopilot, re-planning, wrong-way warning | ✅ | U: route guidance, path follower; E: phase5 (autopilot rides 120 m with no off-road correction) |
| F-VEH-6 | Cars and tuk-tuks | ⏳ | Mode bit and access rules exist; models and handling deferred |
| F-DEL-* | Delivery jobs | ⏳ 6 | |
| F-PAY-* | Demo wallet balance and double-entry ledger | ⏳ 7 | Phase 4 has the idempotent demo payment intent; the wallet debits it in Phase 7 |

## Non-functional

| ID | Requirement | Status | Notes |
|---|---|---|---|
| N-SEC-1 | Argon2id passwords; CSRF protection; secure cookie flags; production guards | ✅ | B: test_state_changes_require_csrf_token, test_cross_origin_writes_are_blocked, test_password_is_hashed_with_argon2 |
| N-SEC-2 | Rate limiting on auth, verification, search, social and WebSocket messages | ✅ | In-process (one API process); a shared Redis store comes with Phase 8 scale-out |
| N-SEC-3 | WebSocket hijacking protection (Origin), session binding, revocation | ✅ | B: test_connection_requires_origin_session_and_onboarding, test_signing_out_elsewhere… |
| N-SCALE-1 | Multiple API processes for the world | ⏳ 8 | Single authoritative process today (docs/HLD.md) |
| N-PRIV-1 | Addresses owner-only; never in public cards or audit logs; avatar position ≠ GPS | ✅ | B: test_privacy (5 tests) |
| N-PRIV-3 | Parked vehicles never reveal who owns them to others; hidden players' vehicles are not shown | ✅ | B: test_hidden_and_blocked_owners_leave_no_trace |
| N-PRIV-2 | Merchant addresses and verification documents admin-only; uploaded photos re-encoded without metadata | ✅ | B: test_merchant_application…, test_image_upload_strips_metadata |
| N-TEST-1 | Browser tests never run against the shared development world | ✅ | Isolated E2E stack: API :8001, database `ppw_e2e` (`backend/scripts/e2e_stack.py`) |
| N-DATA-1 | Dataset dates, coverage, accuracy and estimates documented and labelled per feature | ✅ | docs/DATA.md; `*_source` columns |
| N-PERF-1 | Usable on ordinary computers: streaming, merged meshes, instancing, adaptive quality | ✅ | 60 fps (p5 ≥ 59.5, no frame over 16.8 ms while streaming) at high quality on an Intel Alder Lake-N iGPU, 1280×720; render ≈ 4 ms/frame. docs/perf/README.md |
| N-PERF-2 | 3D assets are lazy-loaded | ✅ | Three.js and MapLibre load only on the pages that need them |
| N-I18N-1 | Preferred language stored; Khmer place names | 🟡 | UI text is English only |
| N-OPS-1 | Docker Compose, migrations, idempotent import | ✅ | Images built and the stack smoke-tested |
| N-OPS-2 | CI/CD, monitoring, object storage | ⏳ 8 | |

# First city adventure: Daun Penh

Open the compass toolbar button (**J**) or **Places → Discovery passport**.
The small adventure card introduces this activity without forcing a tutorial.

## Playable slice

- Three discoveries: Wat Phnom, Canadia Garden, and Phsar Thmei. Stop on foot
  within 25 m of each imported public arrival point and collect its stamp.
- Existing public-point descriptions and Khmer names appear on the cards. The
  locations are sourced from `/api/v1/geo/spawn-points`; these safe arrival points
  can differ from landmark centers. No new geographic coordinates are authored.
- Collecting all three earns the **Daun Penh Explorer** passport badge.
- **Coffee for the garden** selects the nearest open, active virtual café within
  1.2 km of Wat Phnom. Its pickup uses the same sidewalk offset as shop navigation.
  Collect fictional drinks there, then leave them at the imported Canadia Garden
  public arrival point. Both delivery actions now require stopping on foot within 3 m.
- The **City Helper** badge is a keepsake for completing the practice delivery.
  Walk, cycle, or ride between stops. Existing route guidance and route following
  remain available. Fast-travel requests cancel a practice delivery. There is no
  deadline or penalty, and players can cancel or repeat the activity.
- Existing multiplayer remains running when the activity panel is open. Friends
  may accompany each other; stamps and delivery progress are individual.

## Scope and persistence

This is an introductory activity, separate from marketplace orders, purchases,
roles, driver jobs, wallets and monetary rewards. The café and garden handoff are
fictional gameplay; no actual business partnership or delivery recipient is claimed.
The later [in-world delivery milestone](in-world-delivery.md) adds a nearby fictional
host, drinks parcel and contextual interactions. Shared co-op jobs, clothing unlocks
and a photo album remain outside these milestones.

Completed stamps and the City Helper badge now merge into the authenticated account's
`player_passports` database row through `/api/v1/me/passport`. Browser storage under
`ppw-passport-v1:<account id>` remains a backup and an import source for older local
achievements. Existing discoveries are never removed by an older browser snapshot.
Badges remain client-earned keepsakes, with no monetary value or tamper-resistant
claim. Active practice deliveries remain browser-local; they do not sync to another
device. Restored JSON is validated and storage failure is shown to the player.

Account sync runs at entry, after activity changes, on focus/online events and every
30 seconds while visible. Failed requests preserve local progress and expose Retry
sync. Requests are coalesced and aborted on world teardown. The server locks the
account row before merging, including concurrent first saves; no account identifier
is accepted in the request body. Ordinary session authentication and CSRF apply.

## Implementation

- `frontend/src/lib/game/activities/passport.ts`: destination selection, proximity,
  stamp and delivery transitions, achievements, persistence validation.
- `frontend/src/lib/components/world/PassportPanel.svelte`: activity cards, progress,
  route buttons, pickup/dropoff controls and reward explanation.
- `frontend/src/routes/world/+page.svelte`: account-scoped storage, existing HUD and
  navigation integration, J shortcut, compact layouts and fast-travel cancellation.
- `frontend/src/lib/game/activities/passport.test.ts`: state/proximity/restore tests.
- `frontend/tests/perf/passport.mjs`: actual-browser full adventure and reload test.

No new textures, models, audio, external APIs or dependencies. Icons reuse the
existing Lucide dependency. The initial passport release added no rendering geometry or simulation loop;
positions use existing HUD updates. No matched before/after FPS benchmark is claimed.

Next: add explicit party invitations and shared delivery state; test the introduction with
new players before expanding the number of tasks.

## Validation

Baseline: 245 unit tests and three Node asset tests passed before this change.
After implementation: 250 unit tests and the three asset tests passed; Svelte/TS
check reported zero errors and zero warnings. `git diff --check` passed.

`tests/perf/passport.mjs` completed in Chrome against the actual local Docker game:
remote stamp rejection, all three discoveries, Explorer badge, café pickup, walking
the existing route toward the garden (117.9 seconds in that run), delivery completion,
City Helper badge, cancellation on fast travel, and persistence after reload. No page
errors. Raw results: `docs/perf/passport-smoke.json`. The test respects the existing
server's two-second fast-travel cooldown rather than changing that protection.
Screenshots from this actual run: `/tmp/ppg-passport-discoveries.png`,
`/tmp/ppg-passport-completed.png`, `/tmp/ppg-passport-mobile.png`.

This verifies the introductory on-foot loop and existing route follower. It does not
establish co-op synchronization, every vehicle route, photo sharing, cloud storage,
new cosmetic assets, or FPS improvements; these remain outside this milestone.

Final deployed layout checks also passed in Chrome at 1280×720, 844×390 and 390×844.
The adventure card remains compact on portrait screens and hides in short landscape
viewports; the compass entry remains available. The passport panel stays inside the
viewport and its delivery controls are reachable by scrolling. A portrait CSS
inheritance issue found during testing was corrected before the final run. Report:
`docs/perf/passport-layout.json`; screenshots: `/tmp/ppg-passport-1280x720.png`,
`/tmp/ppg-passport-844x390.png`, `/tmp/ppg-passport-390x844.png`.


## Account-save milestone

Added `PlayerPassport`, additive migration `0008`, authenticated GET/POST merge
endpoints, and `PassportSync.ts` with retry and migration of previous local badges.
No existing user/geographic records or monetary rewards are changed. Revision 0008
is applied to the local game and readiness checks require it.

Validation: all 177 backend tests passed against the isolated PostGIS test database;
all 255 frontend unit tests and three Node asset tests passed; frontend check reported
zero errors/warnings, and targeted Python lint passed. Tests cover authentication,
CSRF, account isolation, malformed input, concurrent first saves, stale snapshots,
client request coalescing, late responses, offline preservation and retry.

Actual Chrome test `tests/perf/passport-cloud.mjs` passed against the deployed game:
legacy local achievement import, earning a stamp through the HUD, restoring in a
fresh browser context, preserving a new stamp while the passport API fails, Retry
sync, and a third authenticated session reading the combined account state. Zero
page errors. Report: `docs/perf/passport-cloud.json`; actual game screenshot:
`/tmp/ppg-passport-cloud.png`. Browser contexts simulate separate browsers; no physical
second device was tested. No rendering/FPS improvement is claimed.


The browser check also exposed city streaming being paused by a newly opened menu.
`CityEngine.ts` now advances the existing chunk manager each rendered frame, while
only movement remains paused. The cross-browser test waits for nearby chunks to
finish loading with the passport open, preventing an empty-world screenshot from
being accepted as completed rendering.

# In-world café delivery milestone

Open the compass (**J**) and choose **Try a café delivery** near the top of the
passport. A compact objective stays on screen while travelling, with Route and
Cancel controls. The original passport stamps and account-synced badges remain.

## Player flow

1. Follow the existing streets to the virtual café's sidewalk pickup point. A gold
   ring, arrow and label mark it when within 180 m.
2. Stop on foot within **3 m** and press **E**, or tap the contextual action button.
   Two drinks in an original low-poly carrier attach to the existing right-hand
   socket, using the avatar's existing carry pose.
3. Follow the route to Canadia Garden. One fictional garden host loads within 35 m
   of the public arrival point. Its body has a small walking collider.
4. Stop nearby and press **E** / tap to hand over the drinks. The parcel disappears,
   the host gives a sampeah and a brief thank-you, and the existing City Helper
   passport badge is saved through account sync. The host unloads after the gesture.

No purchase, real order or payment is involved. The host is fictional; no association
with an actual café or park employee is claimed. The pickup and dropoff coordinates
are unchanged: existing virtual-shop doorway data and imported public arrival points.
Discovery stamps retain their separate 25 m interaction radius.

## Reuse and budgets

- `DeliveryWorld.ts` owns one marker, one reused parcel and at most one nearby host.
  It reuses `createCharacter`, existing idle/emote clips, labels and terrain queries.
- The player avatar is preserved. Wardrobe changes reattach the parcel to the current
  RightWrist socket. A shopping basket/bag gets priority; the drinks stow while riding
  or while that hand is occupied, and reappear when free and on foot.
- No new dynamic lights, external assets, APIs or dependencies. Carrier and marker
  geometry are authored in code. The host reuses the project's existing character
  assets under their existing licenses. No new downloaded media or reference pixels.
- Cancelling, fast travel and world teardown remove delivery visuals. Pending NPC
  loads use generation guards so an abandoned load cannot attach a stray character.
  Owned meshes, materials, sprites and the host collider are released appropriately.
- Only nearby hosts animate; geometry is not rebuilt each frame. Labels change only
  when the task changes or the handoff completes. Measurements are in the browser
  report; a short stationary sample cannot establish city-wide frame-rate stability.

## Boundaries

This is still an individual practice task. The host, marker and parcel are local
presentation, not networked entities visible identically to other players. Active
runs remain browser-local; completed stamps and badges sync to the account. The
parcel does not create marketplace inventory or currency. Existing riding, shopping,
building interactions and character identity are retained.

Next: invite a friend to a server-backed shared task, then validate party completion
and reconnect behavior before adding valuable rewards or more delivery types.

## Verification

- Frontend check: zero errors/warnings; 260 unit tests and three Node asset tests
  passed. Added tests exercise the 3 m delivery range, unchanged stamp range,
  hand-occupancy/riding stow, avatar wrist rebinding, one-host reuse, thanks/cleanup,
  and asynchronous character loading after teardown. No backend code changed.
- `tests/perf/in-world-delivery.mjs` completed the actual route in Chrome: quick start,
  keyboard pickup, restored parcel after reload, navigation to the garden, nearby
  host, keyboard handoff, City Helper badge, clean cancellation, and phone-size
  objective/prompt checks. Zero page errors. Report: `docs/perf/in-world-delivery.json`.
- In that 1280×720 Medium scene, a 2.5-second sample with the host measured 59.8 FPS,
  209 calls and 152,803 triangles. After handoff/despawn the sample measured 59.8 FPS,
  186 calls and 130,998 triangles. These are stationary samples in one view, not an
  all-device or city-wide performance guarantee. They do not measure GPU memory.
- Final screenshot review found the existing navigation card translated halfway
  off-screen on portrait phones. The compact HUD now resets Tailwind's independent
  translate property. The focused `--layout-only` browser check verifies navigation
  and task-card bounds at 390×844 in `docs/perf/delivery-navigation-layout.json`.
- Screenshots are actual game captures under `/tmp/ppg-delivery-pickup.png`,
  `/tmp/ppg-delivery-host.png`, `/tmp/ppg-delivery-completed.png`,
  `/tmp/ppg-delivery-844.png`, `/tmp/ppg-delivery-390.png`, and
  `/tmp/ppg-delivery-portrait-navigation.png`.

The hand-occupancy and riding behavior is unit-tested; this browser scenario exercises
walking, not mounting a vehicle or paying for marketplace products with the parcel.
Existing multiplayer is retained, but a multi-player shared-delivery session is not
implemented or claimed. Changes are local on `milestone/in-world-delivery`.

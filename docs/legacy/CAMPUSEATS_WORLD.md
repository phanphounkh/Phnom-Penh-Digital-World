> **Legacy document.** This is the README of the original CampusEats World prototype that Phnom Penh Digital World grew from. Its food court still runs at `/mall`, and its commands now run from `frontend/`. See the repository README for the current project.

# CampusEats World

A playable third-person food-shopping game, upgraded in the existing SvelteKit / Three.js project. All 29 shipped GLB assets are original models made with Blender's official `bpy` runtime. No third-party game assets or paid services are required.

## Run

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. Chrome/Chromium with WebGL 2 is recommended. On a phone, use the directional pad and tap the interaction prompt; drag the scene to turn the camera.

```bash
npm run check
npm run build
npm test
npm run test:e2e
# Test the production build:
CAMPUS_PRODUCTION_TEST=1 npm run test:e2e
```

Browser tests use `/usr/bin/google-chrome`; set `CHROME_PATH` for another installed Chromium executable. They launch headlessly with software WebGL so a GPU is not required. `npm run preview` serves the production build.

## Controls and shopping

- **WASD / arrow keys:** camera-relative movement, with smooth acceleration and collision against counters, planters, furniture and world bounds.
- **Shift:** run. **Drag mouse / touch:** orbit the third-person camera, including camera height.
- **E near food:** pick up exactly one item. It appears in the character's hand; this does not change the cart total.
- **Q while carrying:** animate the food into the attached cart. Only then does inventory and price change.
- **E while carrying:** return the item. The cart has an 18-item capacity.
- **Click an inventory slot or cart heading:** inspect and remove individual items.
- **Minimap:** click or keyboard-activate a kitchen to set a destination; nearby kitchens are highlighted.
- **The shops:** choose Burger Bay, Pizza Planet, Noodle Nook or Sweet & Sip to reveal a mint destination trail. Navigation does not teleport the player.
- **Let's check out:** find the cashier. Walk to the green checkout on the right side of the atrium and press **E**. Payment cannot be opened remotely.
- **Simulate payment:** create a local demo receipt, earn food points, and clear the purchased cart. KHQR artwork is decorative and cannot process money.
- **Esc:** pause and open settings, or close the current dialog. Modal dialogs pause movement, NPCs and transfers.
- **Orders:** review saved receipts. **Settings:** toggle synthesized ambient sound, switch graphics quality, read controls or end the shopping session.

After payment, continue in place, follow another kitchen's trail, inspect the receipt or exit. Exiting ends the active session and returns unpaid food; it does not delete completed orders.

## Implementation

```text
src/
  routes/+page.svelte                  HUD, modal flows, session orchestration
  app.css                             Responsive ivory / forest glass interface
  lib/
    world.js                          Three.js mall assembly and game loop
    game/
      core/AssetManager.js            Cached GLB loading and material batching
      data/products.js                Four kitchens, product catalog and prices
      player/PlayerAnimations.js      Distance-driven gait and two-bone arm targets
      cart/CartController.js          Cart footprint, swept turns, grips and wheels
      camera/CameraController.js      Camera collision and per-instance foliage fading
      npc/NPCController.js            Routes, personal space, reserved queues and yielding
    actions/focusDialog.js            Dialog keyboard focus and restoration
    stores/cartStore.js               Inventory, integer-cent totals and receipts
    components/game/
      MiniMap.svelte                  Live player position and shop destinations
      InventoryBar.svelte             Physical cart and carried-item HUD
      MissionPanel.svelte             Expandable completed milestones
static/models/
  characters/                         5 GLBs
  food/                               10 GLBs
  equipment/                          5 GLBs
  environment/                        9 GLBs
static/models/LICENSE.txt             Original asset license
tools/blender/generate_assets.py     Reproducible Blender model source
tests/logic.test.js                  Receipt arithmetic and GLB integrity
tests/polish.test.js                 Grip accuracy, cart/camera collision and crowd rules
tests/shopping.spec.js               Real keyboard shopping / checkout / UI tests
artifacts/                          Rendered browser screenshots
```

### Generated GLB assets

- Characters: `player`, `customer`, `customer-female`, `cashier`, `employee`.
- Food: `burger`, `pizza`, `pizza-slice`, `pizza-combo`, `fries`, `noodles`, `rice`, `drink`, `coffee`, `cake`.
- Equipment: `shopping-cart`, `shopping-basket`, `checkout-counter`, `display-counter`, `food-tray`.
- Environment: `burger-shop`, `pizza-shop`, `noodle-shop`, `dessert-shop`, `table`, `chair`, `plant`, `food-mall`, `entrance`.

The cart has wire basket geometry, a chassis, four separately animated wheels and a colored handle. Characters have continuous tailored clothing surfaces, connected shoulders, knees, elbows, wrist targets, detailed sneakers, and articulated limb pivots. Walking/running cadence follows actual distance, ankle compensation keeps the stance foot grounded, and two-bone arm targets keep hands on the cart handle while moving or stopped. The model files contain embedded materials and buffers and total approximately 2.9 MB before HTTP compression.

### Regenerate assets

With Blender installed:

```bash
blender --background --python tools/blender/generate_assets.py
```

The initial assets were generated with the official Blender Python module. The five articulated character GLBs were subsequently rebuilt with Blender 4.3.2. An optional Python-module workflow is:

```bash
uv python install 3.11
uv pip install --python 3.11 --target /tmp/campuseats-bpy bpy
PYTHONPATH=/tmp/campuseats-bpy uv run --python 3.11 --no-project python tools/blender/generate_assets.py
```

The script clears Blender’s default scene and writes each GLB atomically. It creates original smooth low-poly meshes, beveled furniture, shared PBR materials and self-contained GLBs. It fixes its random seed for reproducibility. Licensed under CC0; see `static/models/LICENSE.txt`.

### Performance and cleanup

GLBs are cached and cloned. Static parts are merged by material, including facial and clothing details within each character joint. Wheels and the joint hierarchy remain independently animated. The tiled floor uses four instanced meshes and a deterministic canvas stone texture. Pixel ratio is capped at 1.5 (0.65 in performance mode), only one directional light casts 1024px shadows, and sustained slow rendering automatically reduces pixel ratio and disables shadows. Performance mode disables real-time shadows but retains lightweight contact shadows. Softer sunlight, warm counter lights and a generated indoor environment map provide the lighting. The architectural roof grid does not cast harsh floor shadows. Movement uses collision substeps so slow frames do not let the player tunnel through furniture. Three.js frustum culling remains enabled. Resize observers, event handlers, animation mixers, render frames, GPU resources and audio nodes are disposed on unmount.

## Current limitations

- Original stylized, smooth low-poly art, rather than photorealistic characters or the reference image's production-level lighting. Animations use articulated object pivots and generated clips rather than skinned motion-capture rigs.
- Shops use open food-court counters with wide, collision-aware center aisles and approachable staff. The mall shell, skylight, gallery, windows, entrance doors, storefronts, food, people, furniture and equipment use Blender GLBs. The tiled floor, pendant lights and illuminated signs are assembled with Three.js. Basket and tray models are shipped as reusable props.
- The cart remains attached and uses a controlled footprint and swept turn checks against scenery and customers. It has no free parking or full rigid-body physics. Tight spaces can require backing out before turning.
- NPCs use authored routes, local personal-space avoidance and reserved checkout positions. They browse, yield to the player/cart, queue and leave; two additional customers sit at tables. There is no stock simulation, global crowd pathfinder or spoken dialogue.
- Navigation draws a direct destination trail, not a computed obstacle-avoiding path. Walk around furniture along the way.
- Ambient sound is synthesized. There are no recorded voices or restaurant sound files.
- Receipts and reward points persist in browser storage; active unpaid carts do not. No accounts, backend, real KHQR, multiplayer or real purchases.
- 60 FPS is a target on suitable hardware, not a measured guarantee. Software WebGL is slower; mobile devices may need performance mode.

## Initial review

The existing prototype already supplied a working SvelteKit page, Three.js renderer, four shops, a cart HUD, scripted NPCs and demo checkout. Its single renderer module and page were retained and refactored. The original problems were primitive-only assets, direct-to-cart pickups, no solid collision, inert navigation labels, remote checkout access, static minimap, oversized introduction panels, unanimated characters and incomplete GPU cleanup.

## Verified results

- `npm run check`: zero errors and zero warnings.
- `npm run build`: production build succeeds. Vite reports the expected large lazy-loaded Three.js chunk (approximately 609 KB minified / 158 KB gzip); deployment still uses the existing auto adapter.
- `npm test`: 10 focused tests covering receipt arithmetic, GLB integrity and articulated pivots, insecure-context IDs, cart clearance and wheel motion, camera obstruction/fading, arm grip accuracy, blocked locomotion, crowd spacing, queue reservations, and yielding from the player/cart gap.
- `CAMPUS_PRODUCTION_TEST=1 npm run test:e2e`: both real-browser scenarios passed against the production preview, including the new full-cart clearance and camera/crowd checks (headless software rendering is slower than normal hardware acceleration). Covers completed-mission reveal/collapse, foliage fading during a camera orbit, crowd clearance, physical pickup/return/placement, duplicate-place prevention, item removal, counter collision, paused movement, entering a kitchen and greeting staff, reaching the cashier, KHQR simulation, receipt reload persistence, session exit/resume, all shop navigation buttons and mobile HUD bounds.
- Screenshots: `artifacts/desktop.png`, `artifacts/mobile.png`, `artifacts/checkout.png`, and `artifacts/camera-foliage.png`.

No 60-FPS claim was verified on representative consumer hardware. Headless tests explicitly use software WebGL and the complete shopping test selects performance mode.

## November 8 polish pass

- Regenerated the five original character assets with connected clothing geometry, knee/elbow/wrist articulation, improved shoes and varied staff/customer styling.
- The cart uses one pose with its player, signed actual-travel wheel rotation and arm targets on the handle. Backing out reverses the footsteps and wheels. Collision checks include the basket footprint, intervening turn angles, furniture and customers. Food follows the carrying wrist.
- Customer clothing colors and heights vary; two seated patrons populate the dining area. Walking patrons maintain personal space, reserve separate queue positions and yield outside the combined player/cart area.
- The third-person camera pulls forward against architecture, fades obstructing or nearby foliage per instance and restores opacity after passing it.
- Correctly proportioned sign textures, larger displayed food and larger price tags improve storefront readability. Desktop HUD text is larger; nearby kitchens highlight on the interactive minimap.
- Completed missions collapse behind an accessible reveal button. The first-meal milestone is restored from saved receipts. Background HUD controls become inert while a modal is open.

To rebuild only the character models:

```bash
CAMPUSEATS_ASSET_FILTER=characters/ blender --background --python tools/blender/generate_assets.py
```

This environment's distribution Blender was missing NumPy. It was supplied for its Python 3.13 interpreter without modifying project runtime dependencies:

```bash
uv pip install --python /usr/bin/python3.13 --target /tmp/campus-blender-deps numpy
CAMPUSEATS_ASSET_FILTER=characters/ PYTHONPATH=/tmp/campus-blender-deps blender --python-use-system-env --background --python tools/blender/generate_assets.py
```

"""Modular player avatar for Phnom Penh Digital World.

Run:  blender --background --python tools/blender/generate_avatars.py
Writes frontend/static/models/characters/avatar.glb (original work, CC0).

One GLB contains every customisable part on the same articulated rig used by the CampusEats
characters (BodyRoot, Left/Right Leg-Knee-Ankle, Arm-Elbow-Wrist), so PlayerAnimations works
unchanged. The runtime customises it without re-exporting:

* Materials have semantic names. The client recolours Skin, Hair, Top, Bottom, Shoes and Accent.
* Optional parts are named  opt__<group>-<value>__<part>. The client keeps only the parts whose
  <group>-<value> matches the player's choices (e.g. hair-long, top-tee, acc-cap) and removes
  the rest before batching meshes.

Groups: body-a|b, top-hoodie|tee, bottom-trousers|shorts, hair-short|long|bun|buzz,
        acc-cap|glasses|backpack|krama.
"""

import math
import os

import bpy

OUT = os.path.abspath(
    os.environ.get(
        "PPW_MODEL_OUTPUT",
        os.path.join(os.path.dirname(__file__), "../../frontend/static/models"),
    )
)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

DEFAULTS = {
    "Skin": "#c8946b",
    "Hair": "#2b2220",
    "Top": "#2f7d6d",
    "Bottom": "#343b4a",
    "Shoes": "#eee5d5",
    "Accent": "#d9a441",
    "Eyes": "#30282a",
    "EyeHighlight": "#fff3dd",
    "Lips": "#995e53",
    "Sole": "#b6b4a6",
    "Laces": "#f9f1e4",
    "Frame": "#1d1f24",
    "AccentDark": "#2a3330",
}
MATERIALS = {}


def mat(name, metal=0.0, rough=0.5):
    if name in MATERIALS:
        return MATERIALS[name]
    color = DEFAULTS[name]
    rgb = tuple((int(color[i : i + 2], 16) / 255) ** 2.2 for i in (1, 3, 5))
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*rgb, 1)
    p.inputs["Metallic"].default_value = metal
    p.inputs["Roughness"].default_value = rough
    MATERIALS[name] = m
    return m


def pivot(name, loc, parent=None):
    p = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(p)
    p.location = loc
    if parent:
        p.parent = parent
    return p


def obj(name, loc, scale, material, kind="sphere", parent=None, rot=None):
    if kind == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, location=loc)
    elif kind == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=18, radius=1, depth=2, location=loc)
    elif kind == "torus":
        bpy.ops.mesh.primitive_torus_add(
            major_segments=24, minor_segments=8, major_radius=1, minor_radius=0.12, location=loc
        )
    else:
        bpy.ops.mesh.primitive_cube_add(size=2, location=loc)
    o = bpy.context.object
    o.name = name
    o.data.name = name
    o.scale = scale
    if rot:
        o.rotation_euler = rot
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    o.data.materials.append(mat(material))
    if kind == "cube":
        b = o.modifiers.new("Bevel", "BEVEL")
        b.width = 0.02
        b.segments = 2
    else:
        for poly in o.data.polygons:
            poly.use_smooth = True
    if parent:
        # Locations are local to the parent pivot (identity parent-inverse), as in the CampusEats rig.
        o.parent = parent
    return o


def cloth(name, rings, material, parent=None, n=16):
    """A continuous tailored surface with rounded-rectangle cross sections (z, rx, ry, cy)."""
    vertices = []
    for z, rx, ry, cy in rings:
        for i in range(n):
            a = i * math.tau / n
            c, s = math.cos(a), math.sin(a)
            vertices.append(
                (math.copysign(abs(c) ** 0.72, c) * rx, cy + math.copysign(abs(s) ** 0.72, s) * ry, z)
            )
    faces = []
    for row in range(len(rings) - 1):
        for i in range(n):
            faces.append((row * n + i, row * n + (i + 1) % n, (row + 1) * n + (i + 1) % n, (row + 1) * n + i))
    faces.append(tuple(reversed(range(n))))
    faces.append(tuple(range((len(rings) - 1) * n, len(rings) * n)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(mat(material))
    o = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(o)
    if parent:
        o.parent = parent
    for poly in mesh.polygons:
        poly.use_smooth = True
    sub = o.modifiers.new("Smooth", "SUBSURF")
    sub.levels = 1
    sub.render_levels = 1
    return o


def opt(group, value, part):
    return f"opt__{group}-{value}__{part}"


body = pivot("BodyRoot", (0, 0, 0))

# ── Torso variants (both use the Top material) ──────────────────────────────────────────
cloth(
    opt("body", "a", "torso"),
    [(0.85, 0.19, 0.12, 0), (0.88, 0.22, 0.15, 0), (1.10, 0.245, 0.16, 0), (1.32, 0.27, 0.16, 0),
     (1.40, 0.235, 0.14, 0), (1.45, 0.105, 0.10, 0)],
    "Top", body,
)
cloth(
    opt("body", "b", "torso"),
    [(0.85, 0.205, 0.13, 0), (0.88, 0.215, 0.15, 0), (1.06, 0.20, 0.135, 0), (1.28, 0.235, 0.15, 0),
     (1.40, 0.215, 0.13, 0), (1.45, 0.10, 0.095, 0)],
    "Top", body,
)
obj("Top hem", (0, 0, 0.87), (0.21, 0.145, 0.035), "Top", "cube", body)
obj(opt("top", "hoodie", "hood"), (0, 0.08, 1.42), (0.18, 0.13, 0.09), "Top", parent=body)
for x in (-0.045, 0.045):
    obj(opt("top", "hoodie"# MASTER DEVELOPMENT PROMPT — PHNOM PENH DIGITAL WORLD

## Project: Phnom Penh Digital World
### A Realistic Multiplayer 3D City, Marketplace, Transportation and Delivery Platform

**Role:** You are a principal software architect, senior full-stack engineer, multiplayer game developer, 3D graphics engineer, Blender artist, GIS specialist, database architect, and technical product manager.

**Mission:** Transform my existing CampusEats 3D Shopping World into a geographically accurate, multiplayer virtual representation of Phnom Penh, Cambodia.

This is not a normal website. It is a persistent 3D online world connected to real-world businesses, products, locations, orders, and delivery services.

Users should be able to register, create avatars, choose locations on a real map, explore Phnom Penh, open virtual businesses, buy and sell products, drive vehicles, interact with other users, and deliver orders.

Build the actual software, not only documentation or static mockups.

---

# PART 1 — PRODUCT VISION

## 1.1 What We Are Building

Imagine a user visiting our platform.

They register an account, customize their avatar, and choose a location on a real map of Phnom Penh.

After completing registration, they enter a realistic 3D city.

They can see streets, buildings, shops, landmarks, and other registered players who are currently online.

They can walk, run, ride a bicycle, drive a motorcycle, drive a car, or travel in a tuk-tuk.

They can visit a virtual shop, inspect products, pick up items, put them into a shopping cart, and pay.

If a merchant sells real products, the order can be fulfilled in the real world through pickup or delivery.

A registered delivery driver can receive an order, travel to the merchant, collect the real product, and deliver it to the customer.

The 3D world provides the interactive experience, while the backend manages real transactions and order fulfillment.

## 1.2 Core Principles

1. The city geography must be based on real Phnom Penh map data.
2. Only registered, currently online users who opt into visibility should appear as player avatars initially.
3. Users must have secure accounts.
4. Users may activate multiple roles with appropriate permissions.
5. Virtual property ownership must be separate from real-world land ownership.
6. Real money must never be simulated as if it were an actual deposit.
7. Important financial and marketplace actions must be validated by the backend.
8. The world must be multiplayer, not a single-player scene with fake characters.
9. The application must remain usable on ordinary computers.
10. The project must be modular, scalable, maintainable, and testable.

---

# PART 2 — USER ROLES AND REGISTRATION

## 2.1 User Types

Support the following roles:

### Visitor

Visitors can:
- Explore permitted public areas.
- View public shops and products.
- See other visible online players.
- Use limited interactions.
- Upgrade to a buyer account.

Visitors cannot purchase products, claim stores, or accept deliveries without activating the required role.

### Buyer

Buyers can:
- Explore the city.
- Visit shops.
- Search for products.
- Add products to carts.
- Place orders.
- Make supported payments.
- Track deliveries.
- Communicate with merchants.
- Save favorite shops.
- Review completed purchases.

### Seller

Sellers can:
- Apply for merchant status.
- Create and manage a business.
- Claim available virtual shop units.
- Upload products.
- Set prices.
- Manage stock.
- Receive orders.
- Manage store opening hours.
- Communicate with customers.
- View revenue reports.
- Customize approved virtual storefronts.

### Delivery Driver

Drivers can:
- Register for delivery services.
- Select supported vehicle types.
- Set their availability.
- Receive delivery requests.
- Accept or decline assignments.
- Navigate to pickup locations.
- Update delivery status.
- View completed jobs and earnings.

### Administrator

Administrators can:
- Manage users and roles.
- Verify businesses.
- Approve drivers.
- Manage virtual property claims.
- Moderate public interactions.
- Investigate fraud.
- Manage marketplace disputes.
- Monitor transactions.
- Review platform performance.

## 2.2 Registration Flow

When a user opens the platform for the first time:

**Screen 1 — Welcome**

Display:
- Enter Phnom Penh Digital World
- Sign In
- Create Account
- Learn About the Platform

**Screen 2 — Create Account**

Collect:
- Username
- Email or phone number
- Password
- Display name
- Preferred language
- Agreement to terms and privacy policy

Verify the user's contact method.

Use secure password hashing and session management.

**Screen 3 — Avatar Creation**

Allow users to customize:
- Appearance
- Clothing
- Hairstyle
- Accessories
- Avatar name

Use Blender-created GLB character models with reusable animation rigs.

**Screen 4 — Choose Role**

Options:
- Buyer
- Seller
- Delivery Driver
- Visitor

A user may have multiple roles, but seller and delivery permissions require additional approval.

**Screen 5 — Choose Location**

Display a real interactive map of Phnom Penh.

Users can:
- Search by neighborhood or address.
- Zoom into the map.
- Select a map location.
- Confirm a private delivery address.
- Choose a public avatar spawn area.

Do not publicly reveal exact residential addresses.

**Screen 6 — Enter World**

Load the player's selected public spawn area and nearby 3D city environment.

---

# PART 3 — REAL PHNOM PENH 3D CITY

## 3.1 Geographic Accuracy

The city must be based on actual Phnom Penh geography.

Use suitable licensed geographic datasets such as OpenStreetMap for:

- Road networks
- Road intersections
- Building footprints
- Public landmarks
- Parks
- Rivers
- Bridges
- Public spaces
- Commercial areas

Use MapLibre or another appropriate mapping renderer, combined with Three.js for interactive 3D objects.

Use PostGIS for geographic data storage and spatial queries.

Do not invent street layouts when reliable map data exists.

Do not claim the virtual city is an exact live replica of Phnom Penh.

Document dataset dates, coverage, accuracy, and missing information.

## 3.2 Coordinate System

The world must have a consistent mapping between geographic coordinates and 3D positions.

Implement functions conceptually equivalent to:

- latitude/longitude to world coordinates
- world coordinates to latitude/longitude
- road position to world position
- geographic distance calculation
- nearby building search
- nearby player search
- route calculation

Use a suitable local projected coordinate system or a local origin with correct geospatial transformations.

Avoid treating latitude and longitude directly as ordinary 3D meter coordinates.

## 3.3 City Streaming

Do not load all of Phnom Penh at once.

Divide the city into geographic chunks.

Load nearby chunks based on player location.

Unload or reduce detail for distant chunks.

Each chunk may contain:
- Roads
- Buildings
- Trees
- Streetlights
- Signs
- Public objects
- Virtual shop entrances

Use level-of-detail techniques.

## 3.4 Visual Quality

The city should look like a modern, semi-realistic 3D simulation.

Use:
- Detailed roads
- Sidewalks
- Building materials
- Street signs
- Trees
- Streetlights
- Shops
- Vehicle models
- Ambient lighting
- Shadows
- Day/night cycle
- Weather effects later

Prioritize recognizable Phnom Penh landmarks and streets over fictional architecture.

---

# PART 4 — VIRTUAL PROPERTY AND LOCATION OWNERSHIP

## 4.1 Unique Virtual Shop Claims

Users should be able to select available virtual shop units from the real map.

Each claimable unit must have a unique ID.

Two sellers must not be able to own the same virtual unit simultaneously.

Implement database-level uniqueness and transactional claim handling.

## 4.2 Important Ownership Rules

Virtual property claims do not grant legal ownership of real property.

Do not allow the first user to register to automatically claim someone else's real business.

Real business owners must be able to request verification and dispute incorrect claims.

Residential addresses cannot be publicly claimed as exclusive property.

Multiple buyers may share a real address, apartment building, or household.

Virtual storefronts should be managed separately from real residential addresses.

## 4.3 Shop Claim Workflow

1. Seller opens the property map.
2. Available virtual units appear.
3. Seller selects a unit.
4. System displays its details.
5. Seller submits a claim request.
6. Backend checks availability.
7. System verifies eligibility.
8. Claim is approved or rejected.
9. Approved shop appears in the 3D world.

Support claim expiry, transfer, disputes, and administrative review.

---

# PART 5 — MULTIPLAYER SYSTEM

## 5.1 Real Players Only

Initially, do not populate the city with fake player accounts.

Display real registered players who are online and have enabled visibility.

When a player logs in:
- Create their world session.
- Spawn their avatar.
- Register them in the relevant world room.
- Notify nearby players.

When they disconnect:
- Mark their session offline.
- Remove their avatar from active rooms.
- Preserve their account and persistent data.

## 5.2 Player Movement

Support:
- Walking
- Running
- Turning
- Jumping if appropriate
- Entering buildings
- Interacting with shops
- Entering and exiting vehicles

Use smooth third-person camera controls.

## 5.3 Real-Time Networking

Use WebSockets for multiplayer state synchronization.

The server should validate:
- Movement speed
- Player position
- Vehicle state
- Item interactions
- Shop permissions
- Important world actions

Clients may predict movement for responsiveness.

Use interpolation for remote players.

Avoid broadcasting every player to the entire city.

Use spatial interest management so clients receive nearby entities.

## 5.4 Multiplayer Features

Implement:
- Player usernames
- Nearby player visibility
- Emotes
- Public chat
- Private messaging
- Friend requests
- Friend invitations
- Mute
- Block
- Report

Use appropriate moderation and rate limiting.

---

# PART 6 — VEHICLE SYSTEM

## 6.1 Supported Vehicles

Create Blender GLB models for:

- Bicycle
- Motorcycle
- Car
- Tuk-tuk
- Delivery motorcycle

Each vehicle should have:
- A visible 3D model
- Wheels
- Steering animation
- Appropriate movement speed
- Acceleration
- Braking
- Collision boundaries
- Entry and exit animations where practical

## 6.2 Driving

Players should be able to:
- Approach a vehicle.
- Press E to enter.
- Drive using keyboard controls.
- Follow mapped roads.
- Park.
- Exit.

Vehicle movement must synchronize with nearby players.

## 6.3 Ownership and Access

Separate:
- Free demo vehicles
- Player-owned virtual vehicles
- Rented virtual vehicles
- Registered real delivery vehicles

A virtual vehicle does not prove ownership of a real vehicle.

Real delivery drivers must supply appropriate verification where required.

## 6.4 Road Navigation

Use real road geometry to create a navigation graph.

Support:
- Route finding
- Road direction rules
- Distance estimates
- Destination markers
- GPS-style guidance
- Pickup and drop-off locations

Real delivery ETAs must use appropriate routing and operational data, not simulated game movement alone.

---

# PART 7 — SELLER MARKETPLACE

## 7.1 Merchant Registration

Sellers provide:
- Business name
- Business category
- Contact information
- Business location
- Operating hours
- Verification documents where required

Support approval and rejection.

## 7.2 Seller Dashboard

Create a professional dashboard for:

- Product management
- Categories
- Prices
- Stock
- Orders
- Fulfillment
- Store customization
- Customer messages
- Revenue reporting

## 7.3 Products

Each product includes:
- Product ID
- Merchant ID
- Name
- Description
- Category
- Price
- Currency
- Stock
- Images
- Optional GLB model
- Availability
- Fulfillment options

Support food and other permitted product categories.

Implement appropriate restrictions for regulated products.

## 7.4 3D Storefronts

Merchants should be able to use customizable storefront templates.

A seller should not need Blender skills to operate a business.

The system should automatically display product information in the 3D shop.

Support:
- Product shelves
- Product displays
- Store signs
- Store themes
- Interactive products
- Checkout counters

---

# PART 8 — BUYING AND SHOPPING

## 8.1 Shopping Experience

A buyer walks into a store.

They approach a product.

A small prompt appears.

They press E to inspect or pick up the product.

The product appears in their character's hand.

They move toward the cart and place it inside.

The cart displays the selected product.

The backend cart records:
- Product ID
- Merchant ID
- Quantity
- Current quoted price
- Cart ownership

The server must recalculate final prices before checkout.

## 8.2 Multi-Store Shopping

Users should be able to shop from multiple stores.

The platform may display one combined cart interface, but the backend must separate fulfillment by merchant.

A single checkout may create multiple merchant orders.

Each merchant manages its own items and fulfillment.

## 8.3 Order Status

Support:
- Draft
- Pending payment
- Paid
- Merchant accepted
- Preparing
- Ready for pickup
- Assigned to driver
- Picked up
- In transit
- Delivered
- Completed
- Cancelled
- Refunded

Use explicit allowed state transitions.

---

# PART 9 — DELIVERY SYSTEM

## 9.1 Delivery Flow

1. Buyer places an order.
2. Payment is confirmed.
3. Merchant accepts the order.
4. Merchant prepares the products.
5. System identifies eligible nearby drivers.
6. Driver accepts the delivery.
7. Driver travels to the merchant.
8. Driver confirms pickup.
9. Driver travels to the customer.
10. Delivery is confirmed.
11. Order is completed.

## 9.2 Driver Dashboard

Show:
- Available jobs
- Pickup location
- Drop-off area
- Delivery distance
- Estimated earnings
- Current job
- Completed deliveries
- Earnings history

Only reveal the customer's necessary delivery details to an assigned, authorized driver.

## 9.3 Real vs. Virtual Delivery

Keep real-world fulfillment separate from game animation.

The virtual driver avatar may represent a delivery in progress, but the actual delivery must be verified through backend events.

Do not treat virtual arrival as proof of physical delivery.

For the first release, implement simulated delivery jobs.

---

# PART 10 — DIGITAL WALLET AND PAYMENT

## 10.1 Wallet Vision

Users should eventually be able to pay for:
- Products
- Delivery
- Eligible virtual services
- Vehicle rentals
- Approved platform fees

Sellers and drivers should be able to receive their legitimate earnings.

## 10.2 Initial Implementation

Build a demo wallet first.

Use clearly labeled simulated credits.

Do not accept actual deposits.

Do not enable real withdrawals.

Do not imply demo credits have monetary value.

## 10.3 Wallet Architecture

Design a ledger-based system with:
- Wallet accounts
- Transaction records
- Double-entry ledger entries
- Idempotency keys
- Payment references
- Refund records
- Audit logs

Use integer minor currency units rather than floating-point arithmetic.

Never trust client-submitted balances.

## 10.4 Real Money Integration

Before enabling real deposits, stored balances, withdrawals, or transfers, obtain appropriate Cambodian legal and regulatory advice and integrate with a properly licensed payment provider.

Prefer provider-managed payments for the first real-commerce version.

Do not independently operate a real-money stored-value wallet without the necessary regulatory arrangements.

---

# PART 11 — TECHNOLOGY STACK

## Frontend

- SvelteKit
- TypeScript
- Tailwind CSS
- Three.js
- Threlte where useful
- MapLibre GL JS
- GSAP

## Backend

- FastAPI
- Python
- Pydantic
- SQLAlchemy
- Alembic
- WebSockets

## Database

- PostgreSQL
- PostGIS
- Redis

## 3D Assets

- Blender
- GLB / glTF
- GLTFLoader
- AnimationMixer
- Optimized textures

## Deployment

- Docker
- Docker Compose
- Nginx
- Object storage for assets
- CI/CD
- Monitoring and logging

Use a modular monolith initially. Split services only when real operational requirements justify it.

---

# PART 12 — DATABASE DESIGN

Design a relational schema including:

### Identity
- users
- user_roles
- user_profiles
- sessions
- avatar_customizations

### Geographic World
- geographic_regions
- world_chunks
- roads
- buildings
- virtual_properties
- property_claims
- player_spawn_points

### Multiplayer
- world_rooms
- player_sessions
- friendships
- chat_messages
- player_reports

### Marketplace
- merchants
- merchant_verifications
- shops
- products
- product_categories
- inventory
- carts
- cart_items
- orders
- order_items

### Delivery
- driver_profiles
- vehicles
- delivery_jobs
- delivery_assignments
- delivery_events

### Payments
- wallet_accounts
- ledger_transactions
- ledger_entries
- payment_intents
- refunds
- merchant_payouts

### Administration
- audit_logs
- moderation_cases
- notifications
- platform_settings

Use:
- UUID primary keys where appropriate
- Foreign keys
- Database constraints
- Appropriate indexes
- Geospatial indexes
- Unique virtual property constraints
- Transactional operations

Create Alembic migrations.

---

# PART 13 — SYSTEM ARCHITECTURE

Organize the application into clear modules.

```text
phnom-penh-world/
├── frontend/
│   ├── src/
│   │   ├── lib/
│   │   │   ├── game/
│   │   │   │   ├── core/
│   │   │   │   ├── player/
│   │   │   │   ├── camera/
│   │   │   │   ├── world/
│   │   │   │   ├── vehicles/
│   │   │   │   ├── multiplayer/
│   │   │   │   ├── interactions/
│   │   │   │   └── assets/
│   │   │   ├── components/
│   │   │   ├── stores/
│   │   │   └── api/
│   │   └── routes/
│   │       ├── login/
│   │       ├── register/
│   │       ├── onboarding/
│   │       ├── world/
│   │       ├── marketplace/
│   │       ├── seller/
│   │       ├── driver/
│   │       ├── wallet/
│   │       └── admin/
│   └── static/
│       ├── models/
│       ├── textures/
│       └── audio/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── core/
│   │   ├── api/
│   │   ├── models/
│   │   ├── schemas/
│   │   ├── services/
│   │   ├── repositories/
│   │   ├── multiplayer/
│   │   ├── geography/
│   │   ├── marketplace/
│   │   ├── delivery/
│   │   └── payments/
│   ├── migrations/
│   └── tests/
├── tools/
│   ├── blender/
│   ├── gis/
│   └── data-import/
├── infrastructure/
│   ├── docker/
│   └── nginx/
├── docs/
│   ├── PRD.md
│   ├── SRS.md
│   ├── HLD.md
│   ├── LLD.md
│   ├── ERD.md
│   ├── API.md
│   └── ROADMAP.md
├── compose.yaml
├── .env.example
└── README.md
```

Preserve useful existing project structure and adapt this layout rather than deleting working code.

---

# PART 14 — BLENDER ASSET PIPELINE

Blender-created GLB models are required for the playable world.

Create assets for:

### Players
- Male and female character bases
- Clothing variations
- Walking animations
- Running animations
- Vehicle riding poses

### Vehicles
- Bicycle
- Motorcycle
- Car
- Tuk-tuk
- Delivery motorcycle

### Environment
- Phnom Penh-style buildings
- Shops
- Roadside stalls
- Street furniture
- Trees
- Signs
- Streetlights

### Marketplace
- Food products
- Shelves
- Shopping carts
- Cash registers
- Store counters

Create reusable Blender Python scripts.

Export optimized GLB assets.

If Blender is unavailable, provide scripts and clearly identify any placeholder assets.

Do not claim primitive placeholder models are photorealistic.

---

# PART 15 — SECURITY AND PRIVACY

Implement:

- Authentication
- Role-based authorization
- Password hashing
- Rate limiting
- Input validation
- Secure sessions
- Server-side pricing
- Payment idempotency
- Audit logging
- Fraud prevention
- Chat moderation
- Account reporting
- Privacy controls

Protect precise home locations.

Do not publicly display a player's residential address or real-time physical location.

Virtual avatar positions and real-world GPS locations must be handled as separate data.

Users must explicitly consent to any optional live location sharing.

---

# PART 16 — IMPLEMENTATION PHASES

## Phase 1 — Foundation

Inspect the existing CampusEats repository.

Preserve reusable functionality.

Implement:
- Authentication
- Registration
- Role selection
- Profile creation
- PostgreSQL
- Backend APIs
- Real Phnom Penh map
- One playable neighborhood

## Phase 2 — 3D City

Implement:
- Geographic coordinate conversion
- Roads
- Buildings
- Player avatar
- Third-person camera
- Collisions
- Blender GLB asset loading

## Phase 3 — Multiplayer

Implement:
- WebSocket connections
- Player rooms
- Position synchronization
- Player visibility
- Chat
- Disconnect handling

## Phase 4 — Marketplace

Implement:
- Virtual shop claims
- Seller dashboard
- Product catalog
- Product interactions
- Shopping cart
- Demo checkout

## Phase 5 — Transportation

Implement:
- Bicycle
- Motorcycle
- Car
- Tuk-tuk
- Vehicle controls
- Road navigation
- Multiplayer vehicle synchronization

## Phase 6 — Delivery

Implement:
- Driver registration
- Delivery assignment
- Pickup
- Delivery tracking
- Order completion

## Phase 7 — Payments

Implement:
- Demo wallet
- Simulated deposits
- Demo purchases
- Transaction ledger
- Refund simulation

Keep real money disabled until a compliant integration is ready.

## Phase 8 — Optimization and Production Readiness

Implement:
- Chunk streaming
- Asset caching
- Performance monitoring
- Automated tests
- Security checks
- Deployment configuration
- Documentation

---

# PART 17 — FIRST PLAYABLE MVP

Do not attempt to finish all of Phnom Penh before delivering a working prototype.

Build a complete vertical slice containing:

- One real Phnom Penh neighborhood
- Actual mapped roads
- Available building footprints
- Registration and login
- Avatar creation
- Buyer and seller roles
- One claimable virtual shop
- One functional merchant storefront
- Product selection
- Shopping cart
- Demo wallet
- Demo checkout
- One bicycle or motorcycle
- Multiplayer synchronization
- Two or more simultaneous players
- Simulated delivery workflow

The prototype must demonstrate this complete flow:

**Register → Choose Role → Choose Map Location → Enter 3D City → Visit Shop → Select Product → Pay With Demo Funds → Assign Delivery → Complete Order.**

---

# PART 18 — TESTING REQUIREMENTS

Create automated tests for:

- Registration
- Authentication
- Role permissions
- Property claim conflicts
- Product management
- Cart calculations
- Order creation
- Payment idempotency
- Wallet ledger balancing
- Delivery state transitions
- WebSocket connections
- Multiplayer disconnects

Test with multiple browser sessions.

Verify that two sellers cannot claim the same exclusive virtual shop unit.

Verify that one user cannot modify another user's orders or wallet.

Verify that a payment cannot be completed twice.

Verify that online players can see one another in the same world.

Run the production build and report actual results.

---

# PART 19 — DEVELOPMENT INSTRUCTIONS

Follow these rules strictly:

1. Inspect the existing codebase before making changes.
2. Do not delete working functionality unnecessarily.
3. Create a practical implementation plan.
4. Implement real working code.
5. Work in small, testable phases.
6. Use TypeScript where appropriate.
7. Keep modules clean and maintainable.
8. Generate actual Blender GLB assets where the environment supports it.
9. Use real geographic data with correct licensing and attribution.
10. Do not invent successful test results.
11. Do not simulate real payments without clearly labeling them.
12. Keep secrets in environment variables.
13. Do not deploy publicly without authorization.
14. Document limitations and unfinished features.
15. Prioritize functional gameplay over decorative UI.

At the end of each phase, provide:

- Files created or modified
- Features implemented
- Commands to run
- Tests executed
- Known limitations
- Next development tasks

## FINAL OBJECTIVE

Create a functioning multiplayer 3D Phnom Penh marketplace where users can explore a geographically grounded city, interact with other players, operate virtual stores, purchase products, use vehicles, and participate in simulated delivery and payment workflows.

Build the smallest complete playable version first, then expand toward the full city.

**Begin by inspecting the existing CampusEats repository and implementing Phase 1. Do not stop after writing a plan.**
, "drawstring"), (x, -0.145, 1.33), (0.006, 0.006, 0.08), "Laces", "cylinder", body)
obj(opt("top", "hoodie", "pocket"), (0, -0.155, 1.02), (0.13, 0.013, 0.06), "Top", "cube", body)
obj(opt("top", "tee", "collar"), (0, -0.02, 1.455), (0.11, 0.095, 0.022), "Top", parent=body)

# ── Head ────────────────────────────────────────────────────────────────────────────────
obj("Neck", (0, 0, 1.51), (0.07, 0.072, 0.085), "Skin", "cylinder", body)
obj("Head", (0, -0.008, 1.72), (0.158, 0.137, 0.197), "Skin", parent=body)
obj("Jaw", (0, -0.018, 1.63), (0.124, 0.116, 0.095), "Skin", parent=body)
for x in (-0.059, 0.059):
    obj("Eye", (x, -0.139, 1.74), (0.014, 0.011, 0.019), "Eyes", parent=body)
    obj("Eye highlight", (x - 0.004, -0.149, 1.746), (0.004, 0.003, 0.005), "EyeHighlight", parent=body)
    obj("Brow", (x, -0.136, 1.784), (0.028, 0.009, 0.007), "Hair", parent=body)
obj("Nose", (0, -0.15, 1.69), (0.023, 0.026, 0.032), "Skin", parent=body)
obj("Smile", (0, -0.132, 1.635), (0.028, 0.009, 0.006), "Lips", parent=body)
for x in (-0.154, 0.154):
    obj("Ear", (x, 0, 1.715), (0.027, 0.027, 0.049), "Skin", parent=body)

# ── Hair styles ─────────────────────────────────────────────────────────────────────────
for style in ("short", "long"):
    obj(opt("hair", style, "cap"), (0, 0.025, 1.85), (0.166, 0.142, 0.11), "Hair", parent=body)
    for i in range(5):
        obj(opt("hair", style, "fringe"), ((i - 2) * 0.048, -0.092, 1.84 + (i % 2) * 0.008),
            (0.048, 0.058, 0.056), "Hair", parent=body)
obj(opt("hair", "long", "back"), (0, 0.1, 1.67), (0.158, 0.06, 0.235), "Hair", parent=body)
obj(opt("hair", "bun", "cap"), (0, 0.02, 1.84), (0.164, 0.142, 0.105), "Hair", parent=body)
obj(opt("hair", "bun", "bun"), (0, 0.095, 1.94), (0.075, 0.075, 0.068), "Hair", parent=body)
obj(opt("hair", "bun", "sweep"), (-0.04, -0.1, 1.845), (0.11, 0.05, 0.05), "Hair", parent=body)
obj(opt("hair", "buzz", "cap"), (0, 0.02, 1.80), (0.163, 0.143, 0.115), "Hair", parent=body)

# ── Accessories ─────────────────────────────────────────────────────────────────────────
obj(opt("acc", "cap", "crown"), (0, 0.01, 1.875), (0.172, 0.152, 0.085), "Accent", parent=body)
obj(opt("acc", "cap", "brim"), (0, -0.16, 1.875), (0.12, 0.09, 0.012), "Accent", "cube", body)
for x in (-0.059, 0.059):
    obj(opt("acc", "glasses", "rim"), (x, -0.152, 1.742), (0.036, 0.036, 0.036), "Frame", "torus",
        body, rot=(math.pi / 2, 0, 0))
obj(opt("acc", "glasses", "bridge"), (0, -0.155, 1.748), (0.022, 0.004, 0.004), "Frame", "cube", body)
for x in (-0.151, 0.151):
    obj(opt("acc", "glasses", "arm"), (x, -0.075, 1.75), (0.004, 0.075, 0.004), "Frame", "cube", body)
obj(opt("acc", "backpack", "bag"), (0, 0.2, 1.16), (0.205, 0.105, 0.255), "AccentDark", "cube", body)
obj(opt("acc", "backpack", "pocket"), (0, 0.305, 1.07), (0.151, 0.025, 0.105), "Accent", "cube", body)
for x in (-0.18, 0.18):
    obj(opt("acc", "backpack", "strap"), (x, -0.143, 1.22), (0.023, 0.018, 0.19), "AccentDark", "cube", body)
obj(opt("acc", "krama", "wrap"), (0, 0, 1.475), (0.115, 0.105, 0.11), "Accent", "torus", body)
obj(opt("acc", "krama", "tail"), (0.06, -0.12, 1.33), (0.035, 0.012, 0.12), "Accent", "cube", body)

# ── Limbs (same pivots and lengths as the CampusEats rig) ───────────────────────────────
for side, x in (("Left", -0.135), ("Right", 0.135)):
    leg = pivot(side + "Leg", (x, 0, 0.92), body)
    cloth("Trouser thigh", [(0, 0.109, 0.114, 0), (-0.07, 0.112, 0.112, 0), (-0.33, 0.088, 0.09, 0),
                            (-0.42, 0.084, 0.086, 0)], "Bottom", leg)
    knee = pivot(side + "Knee", (0, 0, -0.42), leg)
    obj(opt("bottom", "trousers", "knee"), (0, 0, 0), (0.084, 0.086, 0.075), "Bottom", parent=knee)
    cloth(opt("bottom", "trousers", "shin"), [(0.025, 0.084, 0.086, 0), (-0.10, 0.082, 0.087, 0),
                                              (-0.34, 0.067, 0.076, 0), (-0.40, 0.069, 0.077, 0)], "Bottom", knee)
    obj(opt("bottom", "shorts", "knee"), (0, 0, 0), (0.074, 0.076, 0.07), "Skin", parent=knee)
    cloth(opt("bottom", "shorts", "shin"), [(0.025, 0.072, 0.074, 0), (-0.10, 0.07, 0.076, 0),
                                            (-0.34, 0.055, 0.062, 0), (-0.40, 0.052, 0.06, 0)], "Skin", knee)
    ankle = pivot(side + "Ankle", (0, 0, -0.40), knee)
    obj("Sneaker", (0, -0.048, -0.023), (0.092, 0.151, 0.065), "Shoes", parent=ankle)
    obj("Shoe sole", (0, -0.048, -0.066), (0.095, 0.154, 0.02), "Sole", "cube", ankle)
    for ly in (-0.04, -0.075, -0.11):
        obj("Laces", (0, ly, 0.02), (0.061, 0.006, 0.006), "Laces", "cube", ankle)

    arm = pivot(side + "Arm", (x / abs(x) * 0.285, 0, 1.405), body)
    cloth("Upper sleeve", [(0.035, 0.094, 0.095, 0), (-0.05, 0.096, 0.096, 0), (-0.15, 0.085, 0.087, 0),
                           (-0.17, 0.084, 0.086, 0)], "Top", arm)
    cloth(opt("top", "tee", "upperarm"), [(-0.15, 0.066, 0.068, 0), (-0.24, 0.06, 0.063, 0),
                                          (-0.29, 0.058, 0.061, 0)], "Skin", arm)
    cloth(opt("top", "hoodie", "upperarm"), [(-0.15, 0.085, 0.087, 0), (-0.24, 0.076, 0.08, 0),
                                             (-0.29, 0.074, 0.078, 0)], "Top", arm)
    elbow = pivot(side + "Elbow", (0, 0, -0.29), arm)
    obj(opt("top", "hoodie", "elbow"), (0, 0, 0), (0.073, 0.076, 0.07), "Top", parent=elbow)
    cloth(opt("top", "hoodie", "forearm"), [(0.02, 0.073, 0.076, 0), (-0.10, 0.068, 0.072, 0),
                                            (-0.25, 0.057, 0.063, 0), (-0.28, 0.057, 0.062, 0)], "Top", elbow)
    obj(opt("top", "tee", "elbow"), (0, 0, 0), (0.06, 0.062, 0.06), "Skin", parent=elbow)
    cloth(opt("top", "tee", "forearm"), [(0.02, 0.06, 0.062, 0), (-0.10, 0.056, 0.058, 0),
                                         (-0.25, 0.046, 0.05, 0), (-0.28, 0.045, 0.049, 0)], "Skin", elbow)
    wrist = pivot(side + "Wrist", (0, 0, -0.28), elbow)
    obj(opt("top", "hoodie", "cuff"), (0, 0, 0.015), (0.058, 0.063, 0.025), "Top", "cube", wrist)
    obj(side + "Hand", (0, -0.006, -0.045), (0.052, 0.043, 0.066), "Skin", parent=wrist)
    obj("Thumb", (-0.045 if x < 0 else 0.045, -0.02, -0.03), (0.021, 0.026, 0.038), "Skin", parent=wrist)

target = os.path.join(OUT, "characters", "avatar.glb")
os.makedirs(os.path.dirname(target), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=target + ".tmp.glb", export_format="GLB", export_yup=True, export_apply=True
)
os.replace(target + ".tmp.glb", target)
print("Wrote", target)

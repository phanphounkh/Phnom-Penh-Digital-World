# Running and operating the local app

## Start and populate

```bash
docker compose --profile full up -d --build
docker compose exec backend python scripts/seed.py
docker compose exec backend python scripts/seed_demo.py
```

Open http://localhost:3000 (http://127.0.0.1:3000 also works). Admin seeding is idempotent;
it prints a randomly generated password once, and never changes an existing user's password.
The optional demo seed is refused in production. It creates a clearly labelled offline demo
seller, claims an available virtual shop near Central Market, and adds three products with
pickup and simulated delivery. It never creates fake online players or overwrites real shops.

For this installation, the initial admin seed output was saved to the Git-ignored
`backend/var/bootstrap-admin.txt` with owner-only permissions. Keep it private.

## Try delivery and the wallet

1. Register a buyer and complete onboarding. In the city, open Places → Shops, browse the
   demo market, and add an item to the cart.
2. Choose pickup, or virtual delivery and a public drop-off point. Delivery is $1.50 in demo
   credits **per shop**. The backend validates the product's supported fulfillment method,
   drop-off, route, stock and final total.
3. Confirm with demo credits. A new wallet gets $100 once. Add free $50 demo credits through
   More → Demo wallet, or `/wallet`. Credits have no monetary value or cash withdrawal.
4. The seller accepts the paid order, prepares it, then marks it ready for pickup in `/seller`.
   Sign in as `demo_market` using its separately generated seed password to try the demo shop.
5. A separate account requests the driver role, and an admin approves it in `/admin` → Role
   requests. In the city use More → Delivery jobs, go online and accept an offer.
6. Follow directions to the pickup, collect within 15 m, start delivery, then deliver within
   15 m of the virtual drop-off. Routing uses the existing OSM graph. Walking and riding
   positions are validated by the world server. An assignment survives disconnection.
7. The buyer sees order progress and the assigned driver's current virtual position on
   `/orders` (five-second polling). Private delivery addresses never enter delivery jobs.

A driver can hold only one active job, enforced both by row locks and a database unique index.
An uncollected job can be released for another driver. For an abandoned or failed delivery,
an admin can cancel and refund it under Operations with a recorded reason.

Payments reserve credits in an escrow account. Collection/delivery transfers the subtotal to
the seller and the delivery fee to the assigned driver. Refunds return reserved credits.
Every transfer has two balanced immutable ledger entries; PostgreSQL checks the journal at
commit. Payment confirmations, demo credit requests and payouts use unique references.
Payments created before migration 0005 have no wallet debit and are not retroactively charged.
The demo journal serializes transfers with a database advisory lock; higher-volume financial
workloads need a separate capacity review.

## Production configuration

Set these in `.env`, then recreate the containers with the start command above:

```dotenv
APP_ENV=production
PUBLIC_ORIGIN=https://your-domain.example
COOKIE_SECURE=true
EXPOSE_DEV_VERIFICATION_CODES=false
SMTP_HOST=your-smtp-host
SMTP_PORT=587
SMTP_USERNAME=your-service-account
SMTP_PASSWORD=your-secret
SMTP_FROM=accounts@your-domain.example
SMTP_STARTTLS=true
```

Keep strong `JWT_SECRET` and database passwords. Use the TLS reverse proxy example in
`infrastructure/nginx/ppw.conf` with your real hostname and certificate. No domain or
certificate is configured automatically. Docker exposes the web port only on loopback;
the backend stays internal.

Email uses SMTP STARTTLS with certificate verification. SMS optionally uses `SMS_WEBHOOK_URL`
and `SMS_WEBHOOK_TOKEN`: HTTPS POST JSON `{"to":"+855...","message":"..."}` with
`Authorization: Bearer <token>`. The gateway must return 2xx and must not redirect.
Unavailable channels are disabled on the registration page. Provider credentials are not
bundled; configure and test your delivery service before inviting public users. Development
messages stay in local logs and developer banners, with no external notification sent.

`/forgot-password` sends a random token to an already verified contact. Tokens expire in
15 minutes, are stored as hashes, and can be used once. A reset revokes all sessions and
disconnects a live player. Unknown accounts receive the same public response.

## Monitoring and retention

- `/api/v1/health`: process liveness.
- `/api/v1/health/ready`: database and migration readiness; Docker checks this endpoint.
- `/admin` → Operations: connected players, room count, delivery queues, migration version,
  journal sum, and balance reconciliation. Journal sum and wallet mismatches must be zero.
- `docker compose --profile full logs -f backend frontend`: service logs.

The existing housekeeping task expires unpaid checkouts and claims, deletes chat older than
`CHAT_RETENTION_DAYS` (default 30), and removes expired reset tokens after a day. Moderation
reports retain their evidence snapshots. Run one API process: world rooms and rate limiting
still live in process memory. Redis and room ownership are required before adding replicas.

## Backups

```bash
bash infrastructure/scripts/backup.sh
# Optional destination outside the default backend/var/backups:
bash infrastructure/scripts/backup.sh /private/backup-directory
```

The script creates a timestamped PostgreSQL custom-format dump and a media archive, with
owner-only permissions. Copy completed backups to protected storage on another machine.
To schedule daily backups, install the script with your own system timer or cron job.
No system-wide schedule is installed by this change.

Rehearse restoration into a **separate empty database** using `pg_restore --no-owner
--no-privileges --dbname=<restore-database> database.dump`. Restore media into a separate
directory, point an isolated app at both restored destinations, then check readiness and
an authenticated product/order. Never run a restore over the live database without a
maintenance plan. Database and media dumps are sequential; take a quiet-window backup when
you need strict consistency between uploads and database references.

## Checks

`.github/workflows/ci.yml` runs backend lint, formatting and real-PostGIS tests, frontend
type checks, unit tests and the production build. Browser checks run separately:

```bash
cd frontend
npx playwright test tests/mobile-commerce.spec.ts tests/phase1.spec.ts tests/phase3.spec.ts tests/phase4.spec.ts tests/phase5.spec.ts
```

Playwright uses an isolated E2E database, API and web server. The mobile commerce tests cover
landscape/portrait controls, chat, wallet crediting, delivery checkout, driver acceptance and
buyer tracking. The backend tests cover completion, reconnects, authorization, races,
insufficient credits, refunding, journal protection and token replay.

Remaining launch work includes real provider/domain setup, off-machine backups and restore
drills, shared rate limits and room scaling, more device/performance coverage, and full Khmer
translation with native review. Mobile HUD navigation labels support Khmer; the whole app is
not yet translated.

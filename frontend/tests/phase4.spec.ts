/**
 * Phase 4 end-to-end, on the isolated E2E stack (API :8001 with its own database):
 * a seller applies, an administrator approves, the seller walks to a real shop unit in the city
 * and claims it there, then stocks it from My shop (the in-game panel); a buyer walks into the
 * shop in 3D, puts products in the basket at the shelf (E), and pays at the counter in one step:
 * handed over at once, nothing for the seller to do. Then an order placed ahead for pickup: the
 * seller prepares it in My shop as it arrives, and the buyer collects it at the same counter.
 * A shopkeeper stands behind the counter: greets, quotes the price, thanks.
 * Two sellers racing for one unit: exactly one wins.
 */
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** A noisy (incompressible) PNG of about 1 MB: larger than adapter-node's default body limit. */
function photo(size = 600): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body), body.length + 4);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
	const rows = Buffer.alloc((size * 3 + 1) * size);
	for (let i = 0; i < rows.length; i++) rows[i] = i % (size * 3 + 1) === 0 ? 0 : (i * 2654435761) >>> 24;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(rows, { level: 0 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

type Who = { context: BrowserContext; page: Page; api: APIRequestContext; headers: () => Promise<Record<string, string>> };

async function contextFor(browser: Browser, baseURL: string): Promise<Who> {
	const context = await browser.newContext({ baseURL, viewport: { width: 1100, height: 720 } });
	const page = await context.newPage();
	const headers = async () => ({ 'X-CSRF-Token': (await context.cookies()).find((c) => c.name === 'ppw_csrf')?.value ?? '' });
	return { context, page, api: page.request, headers };
}

async function onboard(browser: Browser, baseURL: string, username: string, roles: string[]): Promise<Who> {
	const who = await contextFor(browser, baseURL);
	const { api, headers } = who;
	const reg = await (await api.post('/api/v1/auth/register', { data: { username, email: `${username}@example.com`, password: 'correct-horse-battery', display_name: username.toUpperCase(), preferred_language: 'en', accept_terms: true, accept_privacy: true } })).json();
	expect(reg.verification?.dev_code, JSON.stringify(reg)).toBeTruthy();
	await api.post('/api/v1/auth/verification/confirm', { data: { code: reg.verification.dev_code }, headers: await headers() });
	await api.put('/api/v1/me/avatar', { headers: await headers(), data: { avatar_name: username, body: 'b', skin_tone: '#a8744f', hair_style: 'long', hair_color: '#1b1514', top_style: 'tee', top_color: '#c4552f', bottom_style: 'trousers', bottom_color: '#343b4a', shoe_color: '#eee5d5', accent_color: '#e8a33d', accessories: [] } });
	await api.post('/api/v1/me/roles', { headers: await headers(), data: { roles } });
	if (roles.includes('buyer'))
		await api.post('/api/v1/me/addresses', { headers: await headers(), data: { label: 'Home', lat: 11.5689, lon: 104.9211, address_line: 'Street 130' } });
	const spawn = (await (await api.get('/api/v1/geo/spawn-points')).json()).find((s: { slug: string }) => s.slug === 'central-market');
	await api.put('/api/v1/me/spawn', { headers: await headers(), data: { spawn_point_id: spawn.id, world_visible: true } });
	expect((await api.post('/api/v1/me/onboarding/complete', { headers: await headers() })).ok()).toBe(true);
	return who;
}

const ev = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;

test('a seller opens a shop on a real street and a buyer shops in it in 3D', async ({ browser, baseURL }) => {
	test.setTimeout(600_000);
	const id = Date.now().toString(36).slice(-6);
	const admin = await contextFor(browser, baseURL!);
	expect((await admin.api.post('/api/v1/auth/login', { data: { identifier: 'e2eadmin', password: 'e2e-admin-password' } })).ok()).toBe(true);
	const sellerName = `sel_${id}`, rivalName = `riv_${id}`, buyerName = `buy_${id}`;
	const seller = await onboard(browser, baseURL!, sellerName, ['buyer', 'seller']);
	const rival = await onboard(browser, baseURL!, rivalName, ['seller']);
	const buyer = await onboard(browser, baseURL!, buyerName, ['buyer']);

	// ── The buyer enters the city at Central Market. ──────────────────────────────────
	await buyer.page.goto('/world');
	await expect(buyer.page.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 180_000 });
	await expect(buyer.page.getByTestId('hud-net')).toHaveAttribute('data-status', 'open', { timeout: 30_000 });

	// Pick a free unit near the buyer with a clear straight walk to its door (checked against
	// the same building footprints the game collides with).
	const unit = await buyer.page.evaluate(async () => {
		const net = (globalThis as unknown as { __ppwNet: { city: { localState(): { x: number; z: number }; collision: { containing(x: number, z: number): unknown } } } }).__ppwNet;
		const me = net.city.localState();
		const res = await fetch('/api/v1/market/units?available=true&bbox=104.9165,11.5645,104.9255,11.5735');
		const units = (await res.json()) as { code: string; requires_verification: boolean; lat: number; lon: number }[];
		const proj = (globalThis as unknown as { __ppwNet: { city: { projection: { toWorld(lat: number, lon: number): { x: number; z: number } } } } }).__ppwNet.city.projection;
		let best: { code: string; d: number; start: { x: number; z: number } } | null = null;
		for (const u of units) {
			if (u.requires_verification) continue;
			const door = proj.toWorld(u.lat, u.lon);
			const d = Math.hypot(door.x - me.x, door.z - me.z);
			if (d > 70 || (best && d >= best.d)) continue;
			let clear = true;
			for (let t = 0.02; t < 0.9 && clear; t += 0.02) {
				const x = me.x + (door.x - me.x) * t, z = me.z + (door.z - me.z) * t;
				if (net.city.collision.containing(x, z)) clear = false;
			}
			if (clear) best = { code: u.code, d, start: { x: me.x, z: me.z } };
		}
		return best;
	});
	expect(unit, 'a free unit with a clear path near Central Market').not.toBeNull();

	// ── The seller registers; the old dashboard's address opens My shop in the city. ──────
	// (In the game sellers register at the System Office: tests/system-office.spec.ts. Here the
	// application goes through the API.)
	expect(
		(await seller.api.post('/api/v1/merchant', { headers: await seller.headers(), data: { business_name: `Sokha Snacks ${id}`, category: 'food_drink', contact_phone: '012 345 678' } })).status()
	).toBe(201);
	const sp = seller.page;
	await sp.goto('/seller');
	await expect(sp).toHaveURL(/\/world/);
	await expect(sp.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 180_000 });
	await expect(sp.getByTestId('hud-net')).toHaveAttribute('data-status', 'open', { timeout: 30_000 });
	const myShop = sp.getByTestId('my-shop');
	await expect(myShop).toBeVisible({ timeout: 15_000 });
	// (Loading is slow while software rendering keeps the page busy.)
	await expect(myShop.getByTestId('merchant-status')).toHaveAttribute('data-status', 'pending', { timeout: 20_000 });
	await expect(myShop.getByTestId('myshop-tab-spot')).toBeDisabled(); // nothing to claim before approval
	await sp.keyboard.press('Escape');
	await expect(myShop).toHaveCount(0);
	expect(
		(await rival.api.post('/api/v1/merchant', { headers: await rival.headers(), data: { business_name: `Rival ${id}`, category: 'grocery', contact_phone: '097 111 222' } })).status()
	).toBe(201);

	await admin.page.goto('/admin');
	await admin.page.getByTestId('admin-merchants').click();
	for (const name of [`Sokha Snacks ${id}`, `Rival ${id}`]) {
		await admin.page.getByTestId('admin-merchant').filter({ hasText: name }).getByTestId('approve-merchant').click();
		await expect(admin.page.getByTestId('admin-merchant').filter({ hasText: name })).toHaveCount(0);
	}

	// ── Approved: My shop (toolbar) shows what to do next; Spot lists free spots nearby. ──
	await sp.getByTestId('open-my-shop').click();
	await expect(myShop.getByTestId('merchant-status')).toHaveAttribute('data-status', 'approved', { timeout: 20_000 });
	await expect(myShop.getByText('Get your shop open')).toBeVisible();
	await myShop.getByTestId('myshop-tab-spot').click();
	await expect(myShop.getByTestId('free-spot').first()).toBeVisible({ timeout: 15_000 });
	// "Go there" closes the panel and draws the route in the city.
	const far = myShop.getByTestId('spot-route').first();
	if (await far.count()) {
		await far.click();
		await expect(myShop).toHaveCount(0);
		await expect(sp.getByTestId('hud-nav')).toBeVisible({ timeout: 15_000 });
	} else await sp.keyboard.press('Escape');

	// The seller walks to the unit (the buyer's clear line from the same start), then claims it there.
	const sellerCanvas = sp.locator('[data-testid="world-canvas"] canvas');
	await sellerCanvas.click({ position: { x: 20, y: 300 } }); // keyboard focus on the game
	await sp.evaluate(
		async ([start, code]) => {
			const net = (globalThis as unknown as { __ppwNet: { city: { projection: { toWorld(lat: number, lon: number): { x: number; z: number } }; walkTo(p: [number, number][], done: () => void): void } } }).__ppwNet;
			const u = (await (await fetch(`/api/v1/market/units/${code}`)).json()) as { lat: number; lon: number };
			const door = net.city.projection.toWorld(u.lat, u.lon);
			const near: [number, number] = [start.x + (door.x - start.x) * 0.85, start.z + (door.z - start.z) * 0.85];
			await new Promise<void>((done) => net.city.walkTo([[start.x, start.z], near], done));
		},
		[unit!.start, unit!.code] as const
	);
	await sp.keyboard.press('b'); // B opens My shop
	await expect(myShop).toBeVisible();
	await myShop.getByTestId('myshop-tab-spot').click();
	const spot = myShop.locator(`[data-testid="free-spot"][data-code="${unit!.code}"]`);
	await spot.getByTestId('claim-unit').click({ timeout: 15_000 }); // offered once standing there
	await expect(myShop.getByTestId('units-notice')).toContainText('is yours');
	await expect(myShop.getByTestId('claim')).toContainText(unit!.code);
	const taken = await rival.api.post('/api/v1/merchant/claims', { headers: await rival.headers(), data: { unit_code: unit!.code } });
	expect(taken.status()).toBe(409);

	// Both sellers race for another unit at the same moment: exactly one wins.
	const other = (await (await rival.api.get('/api/v1/market/units?available=true&bbox=104.9165,11.5645,104.9255,11.5735')).json()).find(
		(u: { requires_verification: boolean; code: string }) => !u.requires_verification && u.code !== unit!.code
	);
	const race = await Promise.all([
		seller.api.post('/api/v1/merchant/claims', { headers: await seller.headers(), data: { unit_code: other.code } }),
		rival.api.post('/api/v1/merchant/claims', { headers: await rival.headers(), data: { unit_code: other.code } })
	]);
	expect(race.map((r) => r.status()).sort()).toEqual([201, 409]);

	// ── Products: one through My shop's editor (with a photo), one through the API. ──────
	await myShop.getByTestId('myshop-tab-products').click();
	await myShop.getByTestId('add-product').click();
	await myShop.locator('input[name="product_name"]').fill('Num pang');
	await myShop.locator('input[name="product_price"]').fill('2.50');
	await myShop.locator('select[name="product_category"]').selectOption('food');
	await myShop.getByRole('radio', { name: 'Box' }).click();
	await myShop.getByTestId('product-submit').click();
	await expect(myShop.getByTestId('products-notice')).toContainText('Num pang is on your shelves');
	// A photo through the panel and the web server's proxy (multipart, ~1 MB).
	const picture = photo();
	expect(picture.length).toBeGreaterThan(900_000);
	await myShop.getByTestId('product-photo').setInputFiles({ name: 'num-pang.png', mimeType: 'image/png', buffer: picture });
	await expect(myShop.getByTestId('products-notice')).toContainText('Photo updated', { timeout: 30_000 });
	await myShop.getByRole('button', { name: '← All products' }).click();
	await expect(myShop.getByTestId('product-Num pang').locator('img')).toHaveAttribute('src', /\/api\/v1\/media\/products\/[0-9a-f]{32}\.webp/);
	expect(
		(await seller.api.post('/api/v1/merchant/products', { headers: await seller.headers(), data: { name: 'Iced coffee', category: 'drinks', price_minor: 150, model: 'coffee', stock: 12 } })).status()
	).toBe(201);

	// ── The shop's look: a tagline, saved to the city. ──────────────────────────────────
	await myShop.getByTestId('myshop-tab-today').click();
	const pick = myShop.getByTestId('shop-pick');
	if (await pick.count()) await pick.selectOption((await pick.locator('option', { hasText: unit!.code }).getAttribute('value'))!);
	await myShop.getByTestId('myshop-tab-look').click();
	await myShop.locator('input[name="shop_tagline"]').fill('Fresh num pang every morning');
	await myShop.getByTestId('shop-save').click();
	await expect(myShop.getByTestId('shop-notice')).toContainText('Saved');
	await sp.keyboard.press('Escape');
	const shop = (await (await seller.api.get('/api/v1/merchant/shops')).json()).find((s: { unit: { code: string } }) => s.unit.code === unit!.code);

	// ── The buyer walks to the shop (directory → Walk) and into it. ─────────────────────
	const canvas = buyer.page.locator('[data-testid="world-canvas"] canvas');
	await expect.poll(() => ev<number>(buyer.page, `__ppwShops.list.length`), { timeout: 20_000 }).toBeGreaterThan(0);
	await buyer.page.getByLabel('Places & shops (M)').click();
	await buyer.page.getByTestId(`shop-row-${unit!.code}`).getByRole('button', { name: 'Walk' }).click();
	const inShop = `(() => { const p = __ppwNet.city.localState(); return __ppwShops.shopAt(p.x, p.z)?.id ?? null; })()`;
	await expect.poll(() => ev<string | null>(buyer.page, inShop), { timeout: 150_000, intervals: [1000] }).toBe(shop.id);
	await expect.poll(() => ev<number>(buyer.page, `__ppwShops.points('${shop.id}')?.slots.length ?? 0`), { timeout: 60_000 }).toBeGreaterThan(1);

	const walk = async (target: string) => {
		await buyer.page.evaluate(`new Promise((done) => { const p = __ppwShops.points('${shop.id}'); const t = ${target}; __ppwNet.city.walkTo([[t.x, t.z]], done); })`);
	};
	await canvas.click({ position: { x: 20, y: 300 } }); // keyboard focus on the game
	const carrying = () => ev<string>(buyer.page, `__ppwShops.carrying`);
	type Keeper = { name: string; ready: boolean; line: string | null } | null;
	const keeper = () => ev<Keeper>(buyer.page, `__ppwShops.keeper('${shop.id}')`);

	// ── The shopkeeper behind the counter greets the buyer who walked in. ────────────────
	await expect.poll(async () => (await keeper())?.ready, { timeout: 30_000 }).toBe(true);
	const keeperName = (await keeper())!.name;
	await expect.poll(async () => (await keeper())?.line ?? '', { timeout: 10_000 }).toContain('Welcome to');
	const basket = buyer.page.getByTestId('basket');

	// ── E at the shelf puts it in the basket, which appears in the buyer's hand. ─────────
	await walk(`p.slots.find((s) => s.product === 'Num pang')`);
	await expect(buyer.page.getByTestId('shop-prompt')).toHaveAttribute('data-kind', 'take', { timeout: 20_000 });
	await expect(buyer.page.getByTestId('shop-prompt')).toContainText('Put Num pang in your basket · $2.50');
	await buyer.page.screenshot({ path: 'artifacts/phase4-shelf.png' });
	await buyer.page.keyboard.press('e');
	await expect(basket).toHaveAttribute('data-count', '1', { timeout: 15_000 });
	await buyer.page.keyboard.press('e'); // one more
	await expect(basket).toHaveAttribute('data-count', '2', { timeout: 15_000 });
	await expect(basket).toContainText('$5.00');
	await expect.poll(carrying, { timeout: 15_000 }).toMatch(/^basket:/);

	// ── At the counter: one screen, one Pay. It is handed over at once. ─────────────────
	await walk('p.counter');
	await expect(buyer.page.getByTestId('shop-prompt')).toHaveAttribute('data-kind', 'counter', { timeout: 20_000 });
	await expect(buyer.page.getByTestId('shop-prompt')).toContainText('Pay at the counter · $5.00');
	await buyer.page.screenshot({ path: 'artifacts/phase4-shop-interior.png' });
	await buyer.page.keyboard.press('e');
	const counter = buyer.page.getByTestId('counter');
	await expect(counter).toContainText(`${keeperName}, at the counter`);
	await expect(counter.getByTestId('counter-line-said')).toHaveText("“That's $5.00, please.”");
	await expect.poll(async () => (await keeper())?.line).toBe("That's $5.00, please.");
	await expect(counter.getByTestId('counter-total')).toHaveText('$5.00');
	await counter.getByRole('button', { name: 'One less Num pang' }).click();
	await expect(counter.getByTestId('counter-total')).toHaveText('$2.50');
	await counter.getByTestId('counter-pay').click();
	await expect(counter.getByTestId('counter-receipt')).toContainText("Paid. It's yours.");
	await expect(counter.getByTestId('counter-receipt')).toContainText('1 × Num pang');
	await expect.poll(carrying, { timeout: 15_000 }).toBe('bag');
	await expect.poll(async () => (await keeper())?.line).toContain('Orkun');
	await expect(basket).toHaveCount(0);
	await buyer.page.screenshot({ path: 'artifacts/phase4-checkout.png' });
	await counter.getByTestId('counter-done').click();
	await expect(counter).toHaveCount(0);

	// The seller did nothing: the sale is done, and their figures show it.
	await sp.getByTestId('open-my-shop').click();
	await expect(myShop.getByTestId('revenue')).toContainText('$2.50', { timeout: 15_000 });
	await myShop.getByTestId('myshop-tab-orders').click();
	await myShop.getByRole('radio', { name: 'All' }).click();
	await expect(myShop.getByTestId('merchant-order').filter({ hasText: buyerName })).toHaveAttribute('data-status', 'completed');

	// ── Ordering ahead still works: browse, order for pickup, the seller prepares it, and
	// the buyer collects it at the same counter. ─────────────────────────────────────────
	await buyer.page.getByLabel('Places & shops (M)').click();
	await buyer.page.getByTestId(`shop-row-${unit!.code}`).getByRole('button', { name: 'Browse' }).click();
	await buyer.page.getByTestId('add-Iced coffee').click();
	await expect(buyer.page.getByTestId('shop-panel')).toContainText('Iced coffee is in your basket');
	await buyer.page.keyboard.press('c'); // the cart: order ahead
	await expect(buyer.page.getByTestId('cart-total')).toHaveText('$1.50');
	await buyer.page.getByTestId('place-order').click();
	await buyer.page.getByTestId('pay-demo').click();
	await expect(buyer.page.getByTestId('checkout-done')).toContainText('Paid (demo)');
	await buyer.page.keyboard.press('Escape');

	const order = myShop.getByTestId('merchant-order').filter({ hasText: 'Iced coffee' });
	await expect(order).toHaveAttribute('data-status', 'paid', { timeout: 15_000 });
	for (const step of ['merchant_accepted', 'preparing', 'ready_for_pickup']) {
		await order.getByTestId(`order-${step}`).click();
		await expect(order).toHaveAttribute('data-status', step);
	}
	await sp.screenshot({ path: 'artifacts/phase4-seller-orders.png' });
	await myShop.getByTestId('myshop-tab-today').click();
	await expect(myShop.getByTestId('revenue')).toContainText('$4.00');

	await canvas.click({ position: { x: 20, y: 300 } });
	await expect(buyer.page.getByTestId('shop-prompt')).toHaveAttribute('data-kind', 'counter', { timeout: 20_000 });
	await buyer.page.keyboard.press('e');
	await expect(counter.getByTestId('counter-line-said')).toContainText('is ready');
	await counter.getByTestId('counter-collect').click();
	await expect(counter.getByTestId('counter-notice')).toContainText('is yours');
	const mine = (await (await buyer.api.get('/api/v1/orders')).json()) as { status: string; in_person: boolean }[];
	expect(mine.map((o) => [o.status, o.in_person]).sort()).toEqual([
		['completed', false],
		['completed', true]
	]);

	// Leave the units free for the next run (the isolated stack also resets on start).
	for (const who of [seller, rival])
		for (const c of await (await who.api.get('/api/v1/merchant/claims')).json())
			if (c.status === 'approved') await who.api.post(`/api/v1/merchant/claims/${c.id}/release`, { headers: await who.headers() });
	for (const who of [admin, seller, rival, buyer]) await who.context.close();
});

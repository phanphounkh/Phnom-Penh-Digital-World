/**
 * Phase 4 end-to-end, on the isolated E2E stack (API :8001 with its own database):
 * a seller applies, an administrator approves, the seller claims a real shop unit and stocks
 * it through the dashboard; a buyer walks into the shop in 3D, picks a product up (E), puts it
 * in the cart (E), pays at the counter with the demo checkout; the seller fulfils the order.
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
		let best: { code: string; d: number } | null = null;
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
			if (clear) best = { code: u.code, d };
		}
		return best;
	});
	expect(unit, 'a free unit with a clear path near Central Market').not.toBeNull();

	// ── The seller applies through the dashboard; the administrator approves. ────────────
	await seller.page.goto('/seller');
	await seller.page.locator('input[name="business_name"]').fill(`Sokha Snacks ${id}`);
	await seller.page.locator('input[name="contact_phone"]').fill('012 345 678');
	await seller.page.getByTestId('merchant-submit').click();
	await expect(seller.page.getByTestId('merchant-status')).toHaveAttribute('data-status', 'pending');
	expect(
		(await rival.api.post('/api/v1/merchant', { headers: await rival.headers(), data: { business_name: `Rival ${id}`, category: 'grocery', contact_phone: '097 111 222' } })).status()
	).toBe(201);

	await admin.page.goto('/admin');
	await admin.page.getByTestId('admin-merchants').click();
	for (const name of [`Sokha Snacks ${id}`, `Rival ${id}`]) {
		await admin.page.getByTestId('admin-merchant').filter({ hasText: name }).getByTestId('approve-merchant').click();
		await expect(admin.page.getByTestId('admin-merchant').filter({ hasText: name })).toHaveCount(0);
	}

	// ── The seller claims the unit on the map page; the rival cannot take it. ─────────────
	await seller.page.reload();
	await expect(seller.page.getByTestId('merchant-status')).toHaveAttribute('data-status', 'approved');
	await seller.page.getByTestId('tab-units').click();
	await seller.page.getByTestId('unit-code').fill(unit!.code);
	await seller.page.getByRole('button', { name: 'Find' }).click();
	await expect(seller.page.getByTestId('unit-detail')).toContainText(unit!.code);
	await seller.page.getByTestId('claim-unit').click();
	await expect(seller.page.getByTestId('units-notice')).toContainText('is yours');
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

	// ── Products: one through the dashboard form, one through the API. ───────────────────
	await seller.page.getByTestId('tab-products').click();
	await seller.page.locator('input[name="product_name"]').fill('Num pang');
	await seller.page.locator('input[name="product_price"]').fill('2.50');
	await seller.page.locator('select[name="product_category"]').selectOption('food');
	await seller.page.getByTestId('product-submit').click();
	await expect(seller.page.getByTestId('products-notice')).toContainText('Num pang is on your shelves');
	// A photo through the dashboard and the web server's proxy (multipart, ~1 MB).
	const picture = photo();
	expect(picture.length).toBeGreaterThan(900_000);
	await seller.page.getByTestId('product-list').locator('input[type="file"]').first().setInputFiles({ name: 'num-pang.png', mimeType: 'image/png', buffer: picture });
	await expect(seller.page.getByTestId('products-notice')).toContainText('Photo updated');
	await expect(seller.page.getByTestId('product-list').locator('img').first()).toHaveAttribute('src', /\/api\/v1\/media\/products\/[0-9a-f]{32}\.webp/);
	expect(
		(await seller.api.post('/api/v1/merchant/products', { headers: await seller.headers(), data: { name: 'Iced coffee', category: 'drinks', price_minor: 150, model: 'coffee', stock: 12 } })).status()
	).toBe(201);
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
	await walk(`p.slots.find((s) => s.product === 'Num pang')`);
	await expect(buyer.page.getByTestId('shop-prompt')).toHaveAttribute('data-kind', 'pickup', { timeout: 20_000 });
	await buyer.page.screenshot({ path: 'artifacts/phase4-shelf.png' });
	await buyer.page.keyboard.press('e');
	await expect(buyer.page.getByTestId('held-product')).toContainText('Num pang');
	await walk('p.cart');
	await expect(buyer.page.getByTestId('shop-prompt')).toHaveAttribute('data-kind', 'cart', { timeout: 20_000 });
	await buyer.page.screenshot({ path: 'artifacts/phase4-shop-interior.png' });
	await buyer.page.keyboard.press('e');
	await expect(buyer.page.getByTestId('cart-count')).toHaveText('1', { timeout: 15_000 });
	await expect(buyer.page.getByTestId('held-product')).toHaveCount(0);

	// ── Pay at the counter with the demo checkout. ───────────────────────────────────────
	await walk('p.counter');
	await expect(buyer.page.getByTestId('shop-prompt')).toHaveAttribute('data-kind', 'counter', { timeout: 20_000 });
	await buyer.page.keyboard.press('e');
	await expect(buyer.page.getByTestId('cart-total')).toHaveText('$2.50');
	await buyer.page.getByTestId('place-order').click();
	await buyer.page.getByTestId('pay-demo').click();
	await expect(buyer.page.getByTestId('checkout-done')).toContainText('Paid (demo)');
	await buyer.page.screenshot({ path: 'artifacts/phase4-checkout.png' });

	// ── The seller fulfils the order; the buyer collects it. ─────────────────────────────
	await seller.page.getByTestId('tab-orders').click();
	const order = seller.page.getByTestId('merchant-order').filter({ hasText: buyerName });
	await expect(order).toHaveAttribute('data-status', 'paid', { timeout: 15_000 });
	for (const step of ['merchant_accepted', 'preparing', 'ready_for_pickup']) {
		await order.getByTestId(`order-${step}`).click();
		await expect(order).toHaveAttribute('data-status', step);
	}
	await expect(seller.page.getByTestId('revenue')).toContainText('$2.50');
	await seller.page.screenshot({ path: 'artifacts/phase4-seller-orders.png', fullPage: true });

	await buyer.page.goto('/orders');
	await buyer.page.getByTestId('order-received').click();
	await expect(buyer.page.getByTestId('buyer-order').first()).toHaveAttribute('data-status', 'completed');

	// Leave the units free for the next run (the isolated stack also resets on start).
	for (const who of [seller, rival])
		for (const c of await (await who.api.get('/api/v1/merchant/claims')).json())
			if (c.status === 'approved') await who.api.post(`/api/v1/merchant/claims/${c.id}/release`, { headers: await who.headers() });
	for (const who of [admin, seller, rival, buyer]) await who.context.close();
});

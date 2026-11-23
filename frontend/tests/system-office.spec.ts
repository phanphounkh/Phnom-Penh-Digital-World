/**
 * The System Office (isolated stack): a new player walks from the Central Market spawn to the
 * office, opens its door, goes to the counter ("Register a Work Role", E) and registers as a
 * driver; a second work role is not offered (one at a time) until they leave the first; then
 * they register as a seller with their business, an administrator approves it, and the counter
 * says so. The server only accepts it at the office (tests/test_work_roles.py).
 * Screenshots go to test-results/system-office/.
 */
import { expect, test, type Page } from '@playwright/test';
import { findPath } from '../src/lib/game/buildings/nav';

const SHOTS = 'test-results/system-office';
const OFFICE = 'osm:1518';
const FRAMES = { timeout: 60_000 };

type XZ = [number, number];
type Office = { spec: { doors: { center: XZ }[]; walls: XZ[][]; blockers: XZ[][]; interior: { min: XZ; max: XZ }; services: { id: string; x: number; z: number }[] }; frame: { x: number; z: number; yaw: number } };
const ev = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;
const toWorld = (f: Office['frame'], [lx, lz]: XZ): XZ => [f.x + lx * Math.cos(f.yaw) + lz * Math.sin(f.yaw), f.z - lx * Math.sin(f.yaw) + lz * Math.cos(f.yaw)];
const toLocal = (f: Office['frame'], x: number, z: number): XZ => {
	const dx = x - f.x,
		dz = z - f.z;
	return [dx * Math.cos(f.yaw) - dz * Math.sin(f.yaw), dx * Math.sin(f.yaw) + dz * Math.cos(f.yaw)];
};
const me = (page: Page) => ev<{ x: number; z: number }>(page, `globalThis.__ppwNet.city.localState()`);
async function navTo(page: Page, office: Office, to: XZ) {
	const { spec, frame } = office;
	const leaves = await ev<XZ[][]>(page, `globalThis.__ppwBuildings.loaded.get('${OFFICE}').doors.map((d) => d.door.leafRing())`);
	const [x0, z0] = spec.interior.min,
		[x1, z1] = spec.interior.max;
	const at = await me(page);
	const path = findPath({ bounds: [x0, x1, z0, z1 + 4], obstacles: [...spec.walls, ...spec.blockers, ...leaves], radius: 0.3 }, toLocal(frame, at.x, at.z), to);
	expect(path, `a way to ${to}`).not.toBeNull();
	expect(await ev<boolean>(page, `new Promise((r) => globalThis.__ppwNet.city.walkTo(${JSON.stringify(path!.map((p) => toWorld(frame, p)))}, r))`)).toBe(true);
}
async function face(page: Page, office: Office, target: XZ) {
	const at = await me(page);
	const [tx, tz] = toWorld(office.frame, target);
	await ev(page, `globalThis.__ppwNet.city.setPosition(${at.x}, ${at.z}, ${Math.atan2(tx - at.x, tz - at.z)})`);
}

test('a new player registers a work role at the System Office, one at a time', async ({ browser, baseURL }) => {
	test.setTimeout(600_000);
	const id = Date.now().toString(36).slice(-6);
	const username = `office_${id}`;
	const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 760 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	const api = page.request;
	const headers = async () => ({ 'X-CSRF-Token': (await context.cookies()).find((c) => c.name === 'ppw_csrf')?.value ?? '' });
	const reg = await (
		await api.post('/api/v1/auth/register', {
			data: { username, email: `${username}@example.com`, password: 'correct-horse-battery', display_name: 'Office Test', preferred_language: 'en', accept_terms: true, accept_privacy: true }
		})
	).json();
	await api.post('/api/v1/auth/verification/confirm', { data: { code: reg.verification.dev_code }, headers: await headers() });
	await api.put('/api/v1/me/avatar', {
		headers: await headers(),
		data: { avatar_name: 'Office', body: 'a', skin_tone: '#c8946b', hair_style: 'short', hair_color: '#1b1514', top_style: 'tee', top_color: '#2f7d6d', bottom_style: 'trousers', bottom_color: '#343b4a', shoe_color: '#eee5d5', accent_color: '#e8a33d', accessories: [] }
	});
	await api.post('/api/v1/me/addresses', { headers: await headers(), data: { label: 'Home', lat: 11.5689, lon: 104.9211, address_line: 'Street 130' } });
	const spawn = (await (await api.get('/api/v1/geo/spawn-points')).json()).find((s: { slug: string }) => s.slug === 'central-market');
	await api.put('/api/v1/me/spawn', { headers: await headers(), data: { spawn_point_id: spawn.id, world_visible: true } });
	expect((await api.post('/api/v1/me/onboarding/complete', { headers: await headers() })).ok()).toBe(true);

	await page.goto('/world');
	await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 180_000 });
	await expect(page.getByTestId('hud-net')).toHaveAttribute('data-status', 'open', { timeout: 90_000 });

	// Places lists the office, with directions.
	await page.getByLabel('Places & shops (M)').click();
	await expect(page.getByTestId('place-system-office')).toContainText('Register a work role');
	await page.keyboard.press('Escape');

	await expect.poll(() => ev<boolean>(page, `!!globalThis.__ppwBuildings?.loaded.has('${OFFICE}')`), FRAMES).toBe(true);
	const office = await ev<Office>(page, `(() => { const b = globalThis.__ppwBuildings.loaded.get('${OFFICE}'); return { spec: b.spec, frame: { x: b.frame.x, z: b.frame.z, yaw: b.frame.yaw } }; })()`);
	const [dx, dz] = office.spec.doors[0].center;
	const counter = office.spec.services.find((s) => s.id === 'roles')!;

	// To its door (stand still long enough for the server's speed check), open it, in, to the counter.
	await page.locator('[data-testid="world-canvas"] canvas').click({ position: { x: 300, y: 300 } });
	const [ox, oz] = toWorld(office.frame, [dx, dz + 4]);
	const start = await me(page);
	await page.waitForTimeout(((Math.hypot(ox - start.x, oz - start.z) - 2) / 7 + 3) * 1000);
	await ev(page, `globalThis.__ppwNet.city.setPosition(${ox}, ${oz}, 0)`);
	await navTo(page, office, [dx, dz + 1.1]);
	await face(page, office, [dx, dz]);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Open Door/, FRAMES);
	await page.keyboard.press('e');
	// (Fully open: a leaf still swinging would stand in the way.)
	await expect.poll(() => ev<{ open: boolean; t: number }>(page, `globalThis.__ppwBuildings.list.find((b) => b.id === '${OFFICE}').door`), FRAMES).toEqual({ open: true, t: 1 });
	await navTo(page, office, [dx, dz - 2]);
	await navTo(page, office, [counter.x, counter.z]);
	await face(page, office, [counter.x, counter.z - 1]);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Register a Work Role/, FRAMES);
	await page.keyboard.press('e');
	const panel = page.getByTestId('system-office');
	await expect(panel).toBeVisible();

	// Driver first.
	await panel.getByTestId('pick-driver').click();
	await panel.getByRole('textbox').fill('I ride a motorbike around Daun Penh.');
	await panel.getByTestId('register-role').click();
	await expect(panel.getByTestId('work-role')).toHaveAttribute('data-status', 'pending');
	await expect(panel.getByTestId('work-role')).toHaveAttribute('data-role', 'driver');
	// One at a time: no other role is offered, and the server says no too.
	await expect(panel.getByTestId('pick-seller')).toHaveCount(0);
	await expect(panel).toContainText('One work role at a time');
	const second = await api.post('/api/v1/me/work-role', { headers: await headers(), data: { role: 'seller', business: { business_name: 'Second Shop', category: 'food_drink', contact_phone: '012 345 678' } } });
	expect(second.status()).toBe(409);
	await page.screenshot({ path: `${SHOTS}/driver-pending.png` });

	// Leave it; then a seller with their business.
	await panel.getByTestId('leave-role').click();
	await panel.getByTestId('leave-confirm').click();
	await expect(panel.getByTestId('pick-seller')).toBeVisible();
	await panel.getByTestId('pick-seller').click();
	await panel.getByTestId('business-name').fill(`Bopha Noodles ${id}`);
	await panel.getByTestId('business-phone').fill('012 345 678');
	await panel.getByTestId('register-role').click();
	await expect(panel.getByTestId('work-role')).toHaveAttribute('data-role', 'seller');
	await expect(panel.getByTestId('work-role')).toHaveAttribute('data-status', 'pending');

	// An administrator approves the business; back at the counter it says so.
	const admin = await browser.newContext({ baseURL });
	expect((await admin.request.post('/api/v1/auth/login', { data: { identifier: 'e2eadmin', password: 'e2e-admin-password' } })).ok()).toBe(true);
	const adminHeaders = { 'X-CSRF-Token': (await admin.cookies()).find((c) => c.name === 'ppw_csrf')?.value ?? '' };
	const pending = await (await admin.request.get('/api/v1/admin/merchants?status=pending')).json();
	const mine = pending.find((m: { business_name: string }) => m.business_name === `Bopha Noodles ${id}`);
	expect((await admin.request.post(`/api/v1/admin/merchants/${mine.id}/approve`, { headers: adminHeaders, data: {} })).ok()).toBe(true);
	await page.keyboard.press('Escape');
	await expect(panel).toHaveCount(0);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Register a Work Role/, FRAMES);
	await page.keyboard.press('e');
	await expect(panel.getByTestId('work-role')).toHaveAttribute('data-status', 'active', FRAMES);
	await expect(panel).toContainText('Approved');
	await page.waitForTimeout(800);
	await page.screenshot({ path: `${SHOTS}/seller-approved.png` });

	// The counter leads straight to My shop, the seller's panel in the city.
	await panel.getByTestId('office-my-shop').click();
	await expect(panel).toHaveCount(0);
	const myShop = page.getByTestId('my-shop');
	await expect(myShop.getByTestId('merchant-status')).toHaveAttribute('data-status', 'approved');
	await expect(myShop).toContainText(`Bopha Noodles ${id}`);
	await page.keyboard.press('Escape');
	await expect(myShop).toHaveCount(0);

	// Walking out closes the counter.
	await navTo(page, office, [dx, dz + 3]);
	await expect.poll(() => ev<string | null>(page, `globalThis.__ppwBuildings.insideOf`), FRAMES).toBeNull();
	expect(errors).toEqual([]);
	await admin.close();
	await context.close();
});

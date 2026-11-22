/**
 * A real OpenStreetMap building opened as a café (isolated stack): the generated interior loads
 * near the Riverside, a doorway is cut into the OSM facade, "Press E to Open Door" opens it, the
 * player walks in through the OSM wall (the server accepts standing inside an enterable building:
 * no position corrections), turns on the coffee machine, reads the menu and walks out again.
 * Screenshots go to test-results/osm-interior/ (not committed).
 */
import { expect, test, type Page } from '@playwright/test';
import { findPath } from '../src/lib/game/buildings/nav';

const SHOTS = 'test-results/osm-interior';
const CAFE = 'osm:308';
/** Software rendering (SwiftShader, ~1–5 fps): give frame-driven state time. */
const FRAMES = { timeout: 60_000 };

type XZ = [number, number];
type Cafe = {
	spec: { doors: { center: XZ }[]; toggles: { id: string; x: number; z: number }[]; items: { id: string; x: number; z: number }[]; walls: XZ[][]; blockers: XZ[][]; interior: { min: XZ; max: XZ } };
	frame: { x: number; z: number; yaw: number };
};
const ev = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;
const state = (page: Page) =>
	ev<{ x: number; z: number; inside: string | null; door: { open: boolean; t: number } | null; coffee: boolean | undefined; corrections: number; prompt: string | null }>(
		page,
		`(() => {
			const b = globalThis.__ppwBuildings, st = globalThis.__ppwNet.city.localState();
			const l = b.list.find((x) => x.id === '${CAFE}');
			return { x: st.x, z: st.z, inside: b.insideOf, door: l?.door ?? null, coffee: l?.appliances.coffee, corrections: globalThis.__ppwNet.corrections,
				prompt: document.querySelector('[data-testid="house-prompt"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null };
		})()`
	);
/** The café's local (model) points in world coordinates, and back. */
const toWorld = (f: Cafe['frame'], [lx, lz]: XZ): XZ => [f.x + lx * Math.cos(f.yaw) + lz * Math.sin(f.yaw), f.z - lx * Math.sin(f.yaw) + lz * Math.cos(f.yaw)];
const toLocal = (f: Cafe['frame'], x: number, z: number): XZ => {
	const dx = x - f.x,
		dz = z - f.z;
	return [dx * Math.cos(f.yaw) - dz * Math.sin(f.yaw), dx * Math.sin(f.yaw) + dz * Math.cos(f.yaw)];
};
/** Walk like a player (the engine's autopilot: collision, no teleport); resolves on arrival. */
const walkWorld = async (page: Page, pts: XZ[]) => expect(await ev<boolean>(page, `new Promise((r) => globalThis.__ppwNet.city.walkTo(${JSON.stringify(pts)}, r))`)).toBe(true);
/** Walk to `stand` around the tables (the game's own path finder), then settle on it facing
 * `target`, as a player turns towards what they want before pressing E. */
async function approach(page: Page, cafe: Cafe, stand: XZ, target: XZ) {
	const { spec, frame } = cafe;
	const me = await state(page);
	const leaf = await ev<XZ[]>(page, `globalThis.__ppwBuildings.loaded.get('${CAFE}').doors[0].door.leafRing()`);
	const [x0, z0] = spec.interior.min,
		[x1, z1] = spec.interior.max;
	const path = findPath({ bounds: [x0, x1, z0, z1 + 4], obstacles: [...spec.walls, ...spec.blockers, leaf], radius: 0.3 }, toLocal(frame, me.x, me.z), stand);
	expect(path, `a way to ${stand}`).not.toBeNull();
	await walkWorld(page, path!.map((p) => toWorld(frame, p)));
	const [[sx, sz], [tx, tz]] = [toWorld(frame, stand), toWorld(frame, target)];
	await ev(page, `globalThis.__ppwNet.city.setPosition(${sx}, ${sz}, ${Math.atan2(tx - sx, tz - sz)})`);
}

test('a player opens the door of a generated café, walks in, makes coffee, reads the menu and walks out', async ({ browser, baseURL }) => {
	test.setTimeout(600_000);
	const id = Date.now().toString(36).slice(-6);
	const username = `cafe_${id}`;
	const context = await browser.newContext({ baseURL, viewport: { width: 1100, height: 720 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
	const api = page.request;
	const headers = async () => ({ 'X-CSRF-Token': (await context.cookies()).find((c) => c.name === 'ppw_csrf')?.value ?? '' });
	const reg = await (
		await api.post('/api/v1/auth/register', {
			data: { username, email: `${username}@example.com`, password: 'correct-horse-battery', display_name: 'Cafe', preferred_language: 'en', accept_terms: true, accept_privacy: true }
		})
	).json();
	await api.post('/api/v1/auth/verification/confirm', { data: { code: reg.verification.dev_code }, headers: await headers() });
	await api.put('/api/v1/me/avatar', {
		headers: await headers(),
		data: { avatar_name: username, body: 'a', skin_tone: '#c8946b', hair_style: 'short', hair_color: '#1b1514', top_style: 'hoodie', top_color: '#e9e9ee', bottom_style: 'trousers', bottom_color: '#1b1b1e', shoe_color: '#eee5d5', accent_color: '#2b4ea0', accessories: [] }
	});
	await api.post('/api/v1/me/roles', { headers: await headers(), data: { roles: ['visitor'] } });
	const spawn = (await (await api.get('/api/v1/geo/spawn-points')).json()).find((s: { slug: string }) => s.slug === 'riverside');
	await api.put('/api/v1/me/spawn', { headers: await headers(), data: { spawn_point_id: spawn.id, world_visible: true } });
	expect((await api.post('/api/v1/me/onboarding/complete', { headers: await headers() })).ok()).toBe(true);

	await page.goto('/world');
	await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 180_000 });
	await expect(page.getByTestId('hud-net')).toHaveAttribute('data-status', 'open', { timeout: 90_000 });
	// The café (a real OSM building ~65 m from the Riverside spawn) is generated once near.
	await expect.poll(() => ev<boolean>(page, `!!globalThis.__ppwBuildings?.list.some((b) => b.id === '${CAFE}')`), FRAMES).toBe(true);
	const cafe = await ev<Cafe>(page, `(() => { const b = globalThis.__ppwBuildings.list.find((x) => x.id === '${CAFE}'); return { spec: b.spec, frame: { x: b.frame.x, z: b.frame.z, yaw: b.frame.yaw } }; })()`);
	const [dx, dz] = cafe.spec.doors[0].center;
	await page.getByTestId('world-canvas').click({ position: { x: 20, y: 300 } });

	// Across the street to the café: stand still long enough that the server accepts the jump at
	// running speed (it checks distance against time), then step 5 m out from its door.
	const [ox, oz] = toWorld(cafe.frame, [dx, dz + 5]);
	const me = await state(page);
	await page.waitForTimeout(((Math.hypot(ox - me.x, oz - me.z) - 2) / 7 + 3) * 1000);
	const [doorX, doorZ] = toWorld(cafe.frame, [dx, dz]);
	await ev(page, `globalThis.__ppwNet.city.setPosition(${ox}, ${oz}, ${Math.atan2(doorX - ox, doorZ - oz)})`);
	const corrections = (await state(page)).corrections;

	// Up to the door: the prompt, a door in the OSM facade.
	await walkWorld(page, [toWorld(cafe.frame, [dx, dz + 1.1])]);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Press\s*E\s*to Open Door/, FRAMES);
	await page.screenshot({ path: `${SHOTS}/door.png` });
	// The closed door is solid.
	await page.keyboard.down('w');
	await page.waitForTimeout(2500);
	await page.keyboard.up('w');
	expect((await state(page)).inside).toBeNull();

	// E opens it, and the prompt offers to close it.
	await approach(page, cafe, [dx, dz + 1.1], [dx, dz]);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Open Door/, FRAMES);
	await page.screenshot({ path: `${SHOTS}/before-e.png` });
	await page.keyboard.press('e');
	await expect.poll(async () => (await state(page)).door, FRAMES).toEqual({ open: true, t: 1 });
	await expect(page.getByTestId('house-prompt')).toHaveText(/Close Door/, FRAMES);

	// In through the OSM wall: inside the café, and the server never pushed the player back out.
	await approach(page, cafe, [dx, dz - 2.2], [dx, dz - 4]);
	await expect.poll(async () => (await state(page)).inside, FRAMES).toBe(CAFE);
	await page.waitForTimeout(2000);
	expect((await state(page)).corrections).toBe(corrections);
	await page.screenshot({ path: `${SHOTS}/inside.png` });

	// The coffee machine on the back counter.
	const coffee = cafe.spec.toggles.find((t) => t.id === 'coffee')!;
	await approach(page, cafe, [coffee.x, coffee.z + 0.75], [coffee.x, coffee.z]);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Turn On Coffee Machine/, FRAMES);
	await page.keyboard.press('e');
	await expect.poll(async () => (await state(page)).coffee, FRAMES).toBe(true);
	await page.screenshot({ path: `${SHOTS}/coffee.png` });

	// The menu board: a card; E closes it.
	const menu = cafe.spec.items.find((i) => i.id === 'menu')!;
	await approach(page, cafe, [menu.x + 0.4, menu.z + 0.7], [menu.x, menu.z]);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Inspect Menu/, FRAMES);
	await page.keyboard.press('e');
	await expect(page.getByTestId('inspect-card')).toContainText('Iced coffee', FRAMES);
	await page.keyboard.press('e');
	await expect(page.getByTestId('inspect-card')).toHaveCount(0, FRAMES);

	// Out again, still without a correction.
	await approach(page, cafe, [dx, dz + 3], [dx, dz + 5]);
	await expect.poll(async () => (await state(page)).inside, FRAMES).toBeNull();
	expect((await state(page)).corrections).toBe(corrections);

	expect(errors, errors.join('\n')).toEqual([]);
	await context.close();
});

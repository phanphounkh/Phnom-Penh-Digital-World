/**
 * Doors, lights and storeys shared between players (isolated stack). Two players at the
 * Riverside: the first opens the door of the generated café and the second, across the street,
 * sees it swing open. The first climbs the stairs: the second sees them upstairs (drawn on the
 * upper floor, not on the ground floor) and sees the upstairs light they switch. The second
 * reloads the page: the café comes back with the door open and the light as it was left (the
 * server keeps what players changed). Screenshots go to test-results/shared-buildings/.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { findPath } from '../src/lib/game/buildings/nav';

const SHOTS = 'test-results/shared-buildings';
const CAFE = 'osm:308';
/** Software rendering (SwiftShader, ~1–5 fps, two pages at once): give frame-driven state time. */
const FRAMES = { timeout: 90_000 };

type XZ = [number, number];
type Solid = { walls: XZ[][]; blockers: XZ[][] };
type Spec = Solid & {
	doors: { id: string; center: XZ; level?: number }[];
	lights: { id: string; switches: XZ[] }[];
	stairs?: { rect: [number, number, number, number]; axis: 'x' | 'z'; dir: number }[];
	levels?: (Solid & { floor: number })[];
	interior: { min: XZ; max: XZ };
	floor: number;
};
type Cafe = { spec: Spec; frame: { x: number; z: number; yaw: number; ground: number } };

const ev = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;
const toWorld = (f: Cafe['frame'], [lx, lz]: XZ): XZ => [f.x + lx * Math.cos(f.yaw) + lz * Math.sin(f.yaw), f.z - lx * Math.sin(f.yaw) + lz * Math.cos(f.yaw)];
const toLocal = (f: Cafe['frame'], x: number, z: number): XZ => {
	const dx = x - f.x,
		dz = z - f.z;
	return [dx * Math.cos(f.yaw) - dz * Math.sin(f.yaw), dx * Math.sin(f.yaw) + dz * Math.cos(f.yaw)];
};
/** The café as this page has it: door, lights, and the storey the player is on. */
const seen = (page: Page) =>
	ev<{ doors: Record<string, { open: boolean; t: number }>; lights: Record<string, boolean>; storey: number; corrections: number } | null>(
		page,
		`(() => { const B = globalThis.__ppwBuildings, l = B?.list.find((x) => x.id === '${CAFE}');
			return l ? { doors: l.doors, lights: l.lights, storey: B.storeyOn, corrections: globalThis.__ppwNet.corrections } : null; })()`
	);
const me = (page: Page) => ev<{ x: number; z: number }>(page, `globalThis.__ppwNet.city.localState()`);
/** Walk like a player (the engine's autopilot: collision, no teleport); resolves on arrival. */
const walkWorld = async (page: Page, pts: XZ[]) => expect(await ev<boolean>(page, `new Promise((r) => globalThis.__ppwNet.city.walkTo(${JSON.stringify(pts)}, r))`)).toBe(true);
/** Walk to a model-space point on a storey, round walls, furniture and door leaves. */
async function navTo(page: Page, cafe: Cafe, to: XZ, level: number) {
	const { spec, frame } = cafe;
	const solid = level ? spec.levels![level - 1] : spec;
	const leaves = await ev<XZ[][]>(page, `globalThis.__ppwBuildings.loaded.get('${CAFE}').doors.filter((d) => (d.door.spec.level ?? 0) === ${level}).map((d) => d.door.leafRing())`);
	const [x0, z0] = spec.interior.min,
		[x1, z1] = spec.interior.max;
	const at = await me(page);
	const path = findPath({ bounds: [x0, x1, z0, z1 + 4], obstacles: [...solid.walls, ...solid.blockers, ...leaves], radius: 0.3 }, toLocal(frame, at.x, at.z), to);
	expect(path, `a way to ${to}`).not.toBeNull();
	await walkWorld(page, path!.map((p) => toWorld(frame, p)));
}
/** Turn towards a model-space point, as a player does before pressing E. */
async function face(page: Page, cafe: Cafe, target: XZ) {
	const at = await me(page);
	const [tx, tz] = toWorld(cafe.frame, target);
	await ev(page, `globalThis.__ppwNet.city.setPosition(${at.x}, ${at.z}, ${Math.atan2(tx - at.x, tz - at.z)})`);
}

async function join(browser: Browser, baseURL: string | undefined, username: string) {
	const context = await browser.newContext({ baseURL, viewport: { width: 960, height: 640 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|WebSocket/.test(m.text()) && errors.push(m.text()));
	const api = page.request;
	const headers = async () => ({ 'X-CSRF-Token': (await context.cookies()).find((c) => c.name === 'ppw_csrf')?.value ?? '' });
	const reg = await (
		await api.post('/api/v1/auth/register', {
			data: { username, email: `${username}@example.com`, password: 'correct-horse-battery', display_name: username, preferred_language: 'en', accept_terms: true, accept_privacy: true }
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
	await enter(page);
	return { page, errors };
}

async function enter(page: Page) {
	await page.goto('/world');
	await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 180_000 });
	await expect(page.getByTestId('hud-net')).toHaveAttribute('data-status', 'open', { timeout: 90_000 });
	await expect.poll(async () => !!(await seen(page)), FRAMES).toBe(true);
}

test('doors, lights and storeys are shared between players', async ({ browser, baseURL }) => {
	test.setTimeout(900_000);
	const id = Date.now().toString(36).slice(-6);
	const a = await join(browser, baseURL, `share_a_${id}`);
	const b = await join(browser, baseURL, `share_b_${id}`);
	const aId = await ev<number>(a.page, `globalThis.__ppwNet.me.id`);
	await expect.poll(() => ev<number | null>(b.page, `globalThis.__ppwNet.remotes.storeyOf(${aId})`), FRAMES).toBe(0);

	const cafe = await ev<Cafe>(a.page, `(() => { const b = globalThis.__ppwBuildings.list.find((x) => x.id === '${CAFE}'); return { spec: b.spec, frame: { x: b.frame.x, z: b.frame.z, yaw: b.frame.yaw, ground: b.frame.ground } }; })()`);
	const { spec } = cafe;
	expect(spec.stairs?.length, 'the café has an upper floor').toBeTruthy();
	const front = spec.doors[0];
	const [dx, dz] = front.center;
	expect((await seen(b.page))!.doors[front.id]).toEqual({ open: false, t: 0 });
	await face(b.page, cafe, [dx, dz]); // the second player looks across at the café

	// The first player crosses to the café (standing still long enough for the server to accept
	// the jump at running speed), walks up to the door and opens it.
	await a.page.getByTestId('world-canvas').click({ position: { x: 20, y: 300 } });
	const [ox, oz] = toWorld(cafe.frame, [dx, dz + 5]);
	const start = await me(a.page);
	await a.page.waitForTimeout(((Math.hypot(ox - start.x, oz - start.z) - 2) / 7 + 3) * 1000);
	await ev(a.page, `globalThis.__ppwNet.city.setPosition(${ox}, ${oz}, 0)`);
	const corrections = (await seen(a.page))!.corrections;
	await navTo(a.page, cafe, [dx, dz + 1.1], 0);
	await face(a.page, cafe, [dx, dz]);
	await expect(a.page.getByTestId('house-prompt')).toHaveText(/Open Door/, FRAMES);
	await a.page.keyboard.press('e');
	await expect.poll(async () => (await seen(a.page))!.doors[front.id].open, FRAMES).toBe(true);

	// Across the street, the second player sees it swing open.
	await expect.poll(async () => (await seen(b.page))!.doors[front.id], FRAMES).toEqual({ open: true, t: 1 });
	await b.page.screenshot({ path: `${SHOTS}/door-open-seen-by-the-other.png` });

	// Up the stairs.
	const { rect: [x0, x1, z0, z1], axis, dir } = spec.stairs![0];
	const mid = axis === 'x' ? (z0 + z1) / 2 : (x0 + x1) / 2;
	const along = (v: number): XZ => (axis === 'x' ? [v, mid] : [mid, v]);
	const [lo, hi] = axis === 'x' ? [x0, x1] : [z0, z1];
	const foot = along(dir > 0 ? lo - 0.45 : hi + 0.45),
		head = along(dir > 0 ? hi + 0.45 : lo - 0.45);
	await navTo(a.page, cafe, [dx, dz - 1.8], 0);
	await navTo(a.page, cafe, foot, 0);
	await walkWorld(a.page, [toWorld(cafe.frame, along((lo + hi) / 2)), toWorld(cafe.frame, head)]);
	await expect.poll(async () => (await seen(a.page))!.storey, FRAMES).toBe(1);

	// The second player has them upstairs, standing on the upper floor.
	await expect.poll(() => ev<number | null>(b.page, `globalThis.__ppwNet.remotes.storeyOf(${aId})`), FRAMES).toBe(1);
	const upper = cafe.frame.ground + spec.levels![0].floor;
	const drawnAt = () => ev<number>(b.page, `globalThis.__ppwNet.remotes.players.get(${aId}).group.position.y`);
	await expect.poll(drawnAt, FRAMES).toBeCloseTo(upper, 1);
	expect(upper - (cafe.frame.ground + spec.floor)).toBeGreaterThan(2.5);

	// The upstairs family room's lights, from beside the head of the stairs.
	const family = spec.lights.find((l) => l.id === 'up-family')!;
	const [sx, sz] = family.switches[0];
	await navTo(a.page, cafe, [(head[0] + sx) / 2 + (sx - head[0]) * 0.1, (head[1] + sz) / 2 + (sz - head[1]) * 0.1], 1);
	await face(a.page, cafe, [sx, sz]);
	const before = (await seen(a.page))!.lights['up-family'];
	await expect(a.page.getByTestId('house-prompt')).toHaveText(before ? /Turn Lights Off/ : /Turn Lights On/, FRAMES);
	await a.page.keyboard.press('e');
	await expect.poll(async () => (await seen(a.page))!.lights['up-family'], FRAMES).toBe(!before);
	await expect.poll(async () => (await seen(b.page))!.lights['up-family'], FRAMES).toBe(!before);

	// The second player reloads: the server still has the door open and the light switched.
	await enter(b.page);
	await expect.poll(async () => (await seen(b.page))!.doors[front.id].open, FRAMES).toBe(true);
	await expect.poll(async () => (await seen(b.page))!.lights['up-family'], FRAMES).toBe(!before);
	await expect.poll(() => ev<number | null>(b.page, `globalThis.__ppwNet.remotes.storeyOf(${aId})`), FRAMES).toBe(1);

	expect((await seen(a.page))!.corrections, 'the server never pushed the first player back').toBe(corrections);
	expect(a.errors).toEqual([]);
	expect(b.errors).toEqual([]);
});

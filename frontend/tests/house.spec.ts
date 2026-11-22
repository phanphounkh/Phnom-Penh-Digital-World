/**
 * The enterable house at the Riverside (isolated stack): a player walks up to the door, sees
 * "Press E to Open Door", is stopped by the closed door, opens it, walks in (no teleport), gets
 * the indoor camera, switches the living-room lights on, opens the bedroom door, sits at the
 * dining table, stands up, inspects the painting, walks out and closes the front door.
 * Screenshots go to test-results/house/ (not committed).
 */
import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'test-results/house';
/** Software rendering (SwiftShader, ~1–5 fps): give frame-driven state time. */
const FRAMES = { timeout: 60_000 };

type State = {
	x: number;
	z: number;
	inside: string | null;
	door: { open: boolean; t: number } | null;
	doors: Record<string, { open: boolean; t: number }>;
	lights: Record<string, boolean>;
	prompt: string | null;
	gait: string | null;
	seated: boolean;
};
const ev = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;
const state = (page: Page) =>
	ev<State>(
		page,
		`(() => {
			const b = globalThis.__ppwBuildings, st = globalThis.__ppwNet.city.localState();
			const l = b.list.find((x) => x.id === 'riverside-house');
			return { x: st.x, z: st.z, inside: b.insideOf, door: l?.door ?? null, doors: l?.doors ?? {}, lights: l?.lights ?? {}, gait: globalThis.__ppwPerf.avatar().gait, seated: globalThis.__ppwNet.city.seated,
				prompt: document.querySelector('[data-testid="house-prompt"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null };
		})()`
	);
/** Model-space points of the house, in world coordinates. */
const world = (page: Page, pts: [number, number][]) => ev<[number, number][]>(page, `${JSON.stringify(pts)}.map((p) => globalThis.__ppwBuildings.list.find((b) => b.id === 'riverside-house').frame.toWorld(p))`);
/** Walk like a player (the engine's autopilot: collision, no teleport); resolves on arrival. */
const walk = async (page: Page, pts: [number, number][]) =>
	expect(await ev<boolean>(page, `new Promise((r) => globalThis.__ppwNet.city.walkTo(${JSON.stringify(await world(page, pts))}, r))`)).toBe(true);
/** Walk to `stand`, then settle on it facing `target` (a walk stops within 35 cm, and a player
 * turns towards what they want before pressing E). */
const approach = async (page: Page, pts: [number, number][], stand: [number, number], target: [number, number]) => {
	await walk(page, [...pts, stand]);
	const [[sx, sz], [tx, tz]] = await world(page, [stand, target]);
	await ev(page, `globalThis.__ppwNet.city.setPosition(${sx}, ${sz}, ${Math.atan2(tx - sx, tz - sz)})`);
};

test('a player opens the house door, walks in, switches the lights, sits at the table, inspects the painting and walks out', async ({ browser, baseURL }) => {
	test.setTimeout(600_000);
	const id = Date.now().toString(36).slice(-6);
	const username = `house_${id}`;
	const context = await browser.newContext({ baseURL, viewport: { width: 1100, height: 720 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
	const api = page.request;
	const headers = async () => ({ 'X-CSRF-Token': (await context.cookies()).find((c) => c.name === 'ppw_csrf')?.value ?? '' });
	const reg = await (
		await api.post('/api/v1/auth/register', {
			data: { username, email: `${username}@example.com`, password: 'correct-horse-battery', display_name: 'House', preferred_language: 'en', accept_terms: true, accept_privacy: true }
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
	// The house loads lazily once the player is near it (the Riverside spawn is 25 m away; the
	// generated café across the street may load too).
	await expect.poll(() => ev<boolean>(page, `!!globalThis.__ppwBuildings?.list.some((b) => b.id === 'riverside-house')`), FRAMES).toBe(true);
	await page.getByTestId('world-canvas').click({ position: { x: 20, y: 300 } });

	// Up the porch towards the front door: the prompt.
	await walk(page, [[-2.4, 6.4], [-2.4, 5.0]]);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Press\s*E\s*to Open Door/, FRAMES);
	await page.screenshot({ path: `${SHOTS}/porch.png` });
	// The closed door is solid.
	await page.keyboard.down('w');
	await page.waitForTimeout(2500);
	await page.keyboard.up('w');
	expect((await state(page)).inside).toBeNull();

	// E opens it (the leaf swings), and the prompt offers to close it.
	await approach(page, [[-2.4, 6.0]], [-2.4, 5.0], [-2.4, 4.3]);
	await page.keyboard.press('e');
	await expect.poll(async () => (await state(page)).doors.front, FRAMES).toEqual({ open: true, t: 1 });
	await expect(page.getByTestId('house-prompt')).toHaveText(/Close Door/, FRAMES);
	await page.screenshot({ path: `${SHOTS}/door-open.png` });

	// Walk in through the doorway (collision as for any step): the indoor camera takes over.
	await walk(page, [[-2.4, 2.6]]);
	await expect.poll(async () => (await state(page)).inside, FRAMES).toBe('riverside-house');
	await page.waitForTimeout(1500);
	await page.screenshot({ path: `${SHOTS}/inside.png` });

	// The light switch by the front door: the living and dining room lamps (off by day, on after
	// dark: the world runs on live Phnom Penh time).
	await approach(page, [[-2.75, 2.6]], [-2.75, 3.45], [-3.12, 4.15]);
	const lit = (await state(page)).lights.front;
	await expect(page.getByTestId('house-prompt')).toHaveText(lit ? /Turn Lights Off/ : /Turn Lights On/, FRAMES);
	await page.keyboard.press('e');
	await expect.poll(async () => (await state(page)).lights.front, FRAMES).toBe(!lit);
	await expect(page.getByTestId('house-prompt')).toHaveText(lit ? /Turn Lights On/ : /Turn Lights Off/, FRAMES);

	// The bedroom door opens from the living room.
	await approach(page, [[-2.0, 2.2]], [-2.0, 1.15], [-2.0, 0.3]);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Open Bedroom Door/, FRAMES);
	await page.keyboard.press('e');
	await expect.poll(async () => (await state(page)).doors.bedroom, FRAMES).toEqual({ open: true, t: 1 });

	// Sit at the dining table (the nearest chair), then stand up again.
	await approach(page, [[0.6, 2.6], [1.6, 3.85], [2.8, 3.9]], [2.8, 3.5], [2.8, 2.35]);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Sit at the Table/, FRAMES);
	await page.keyboard.press('e');
	await expect.poll(async () => (await state(page)).gait, FRAMES).toBe('sit');
	await expect(page.getByTestId('house-prompt')).toHaveText(/Stand Up/, FRAMES);
	await page.waitForTimeout(1500);
	await page.screenshot({ path: `${SHOTS}/seated.png` });
	await page.keyboard.press('e');
	await expect.poll(async () => (await state(page)).seated, FRAMES).toBe(false);

	// Inspect the painting above the sofa: a card with its story; E closes it. (Round the dining
	// table from whichever side the avatar stood up on.)
	const [lx] = await ev<[number, number]>(page, `(() => { const s = globalThis.__ppwNet.city.localState(); return globalThis.__ppwBuildings.list.find((b) => b.id === 'riverside-house').frame.toLocal(s.x, s.z); })()`);
	const round: [number, number][] = lx > 2.8 ? [[4.1, 2.3], [3.9, 1.0], [1.6, 1.0]] : [[1.4, 3.6]];
	await approach(page, [...round, [-2.6, 2.8]], [-3.7, 2.65], [-3.7, 0.42]);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Inspect Painting/, FRAMES);
	await page.keyboard.press('e');
	await expect(page.getByTestId('inspect-card')).toContainText('Sunset over the temples', FRAMES);
	await page.screenshot({ path: `${SHOTS}/inspect.png` });
	await page.keyboard.press('e');
	await expect(page.getByTestId('inspect-card')).toHaveCount(0, FRAMES);

	// Out through the doorway, then close the door from the porch.
	await walk(page, [[-2.4, 3.0], [-2.4, 6.2]]);
	expect((await state(page)).inside).toBeNull();
	await approach(page, [[-2.4, 6.2]], [-2.4, 5.1], [-2.4, 4.3]);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Close Door/, FRAMES);
	await page.keyboard.press('e');
	await expect.poll(async () => (await state(page)).doors.front, FRAMES).toEqual({ open: false, t: 0 });
	await page.screenshot({ path: `${SHOTS}/closed.png` });

	expect(errors, errors.join('\n')).toEqual([]);
	await context.close();
});

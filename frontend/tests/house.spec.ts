/**
 * The enterable house at the Riverside (isolated stack): a player walks up to the door, sees
 * "Press E to Open Door", is stopped by the closed door, opens it, walks in (no teleport), gets
 * the indoor camera, sits in the armchair, stands up, walks out and closes the door.
 * Screenshots go to test-results/house/ (not committed).
 */
import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'test-results/house';
/** Software rendering (SwiftShader, ~1–5 fps): give frame-driven state time. */
const FRAMES = { timeout: 60_000 };

type State = { x: number; z: number; inside: string | null; door: { open: boolean; t: number } | null; prompt: string | null; gait: string | null; seated: boolean };
const ev = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;
const state = (page: Page) =>
	ev<State>(
		page,
		`(() => {
			const b = globalThis.__ppwBuildings, st = globalThis.__ppwNet.city.localState();
			return { x: st.x, z: st.z, inside: b.insideOf, door: b.list[0]?.door ?? null, gait: globalThis.__ppwPerf.avatar().gait, seated: globalThis.__ppwNet.city.seated,
				prompt: document.querySelector('[data-testid="house-prompt"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null };
		})()`
	);
/** Model-space points of the house, in world coordinates. */
const world = (page: Page, pts: [number, number][]) => ev<[number, number][]>(page, `${JSON.stringify(pts)}.map((p) => globalThis.__ppwBuildings.list[0].frame.toWorld(p))`);
/** Walk like a player (the engine's autopilot: collision, no teleport); resolves on arrival. */
const walk = async (page: Page, pts: [number, number][]) =>
	expect(await ev<boolean>(page, `new Promise((r) => globalThis.__ppwNet.city.walkTo(${JSON.stringify(await world(page, pts))}, r))`)).toBe(true);

test('a player opens the house door, walks in, sits in the armchair and walks out again', async ({ browser, baseURL }) => {
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
	// The house loads lazily once the player is near it (the Riverside spawn is 25 m away).
	await expect.poll(() => ev<number>(page, 'globalThis.__ppwBuildings?.list.length ?? 0'), FRAMES).toBe(1);
	await page.getByTestId('world-canvas').click({ position: { x: 20, y: 300 } });

	// Up the porch towards the door: the prompt.
	await walk(page, [[-1.6, 6], [-1.6, 3.95]]);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Press\s*E\s*to Open Door/, FRAMES);
	await page.screenshot({ path: `${SHOTS}/porch.png` });
	// The closed door is solid.
	await page.keyboard.down('w');
	await page.waitForTimeout(2500);
	await page.keyboard.up('w');
	expect((await state(page)).inside).toBeNull();

	// E opens it (the leaf swings), and the prompt offers to close it.
	await walk(page, [[-1.6, 5], [-1.6, 3.95]]);
	await page.keyboard.press('e');
	await expect.poll(async () => (await state(page)).door, FRAMES).toEqual({ open: true, t: 1 });
	await expect(page.getByTestId('house-prompt')).toHaveText(/Close Door/, FRAMES);
	await page.screenshot({ path: `${SHOTS}/door-open.png` });

	// Walk in through the doorway (collision as for any step; the camera follows behind): the
	// indoor camera takes over.
	await walk(page, [[-1.6, 1.6]]);
	await expect.poll(async () => (await state(page)).inside, FRAMES).toBe('riverside-house');
	await page.waitForTimeout(1500);
	await page.screenshot({ path: `${SHOTS}/inside.png` });

	// The armchair: in front of it, E sits down; E again stands up.
	const seat = await ev<{ stand: [number, number] }>(page, `globalThis.__ppwBuildings.list[0].spec.seats.find((s) => s.id === 'armchair')`);
	await walk(page, [[-0.3, -0.5], seat.stand]);
	await expect(page.getByTestId('house-prompt')).toHaveText(/Sit Down/, FRAMES);
	await page.keyboard.press('e');
	await expect.poll(async () => (await state(page)).gait, FRAMES).toBe('sit');
	await expect(page.getByTestId('house-prompt')).toHaveText(/Stand Up/, FRAMES);
	await page.waitForTimeout(1500);
	await page.screenshot({ path: `${SHOTS}/seated.png` });
	await page.keyboard.press('e');
	await expect.poll(async () => (await state(page)).seated, FRAMES).toBe(false);
	expect((await state(page)).gait).not.toBe('sit');

	// Out through the doorway, then close the door from the porch.
	await walk(page, [[-1.6, 1.4], [-1.6, 5.4], [-1.6, 4.4]]);
	expect((await state(page)).inside).toBeNull();
	await expect(page.getByTestId('house-prompt')).toHaveText(/Close Door/, FRAMES);
	await page.keyboard.press('e');
	await expect.poll(async () => (await state(page)).door, FRAMES).toEqual({ open: false, t: 0 });
	await page.screenshot({ path: `${SHOTS}/closed.png` });

	expect(errors, errors.join('\n')).toEqual([]);
	await context.close();
});

/**
 * Phase 5 end-to-end, on the isolated E2E stack (API :8001 with its own database):
 * a player takes a free motorbike from the garage (it is parked on the nearest street), walks
 * to it, gets on (F), asks for directions on the real road graph, lets the autopilot ride the
 * route in the right-hand lane (the server validates every move at motorbike speed), stops and
 * parks at the kerb (F). A second player sees the rider on the motorbike, then the parked
 * motorbike without its owner's name.
 */
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';

type Who = { context: BrowserContext; page: Page; api: APIRequestContext; headers: () => Promise<Record<string, string>> };

async function onboard(browser: Browser, baseURL: string, username: string): Promise<Who> {
	const context = await browser.newContext({ baseURL, viewport: { width: 1100, height: 720 } });
	const page = await context.newPage();
	const api = page.request;
	const headers = async () => ({ 'X-CSRF-Token': (await context.cookies()).find((c) => c.name === 'ppw_csrf')?.value ?? '' });
	const reg = await (await api.post('/api/v1/auth/register', { data: { username, email: `${username}@example.com`, password: 'correct-horse-battery', display_name: username.toUpperCase(), preferred_language: 'en', accept_terms: true, accept_privacy: true } })).json();
	expect(reg.verification?.dev_code, JSON.stringify(reg)).toBeTruthy();
	await api.post('/api/v1/auth/verification/confirm', { data: { code: reg.verification.dev_code }, headers: await headers() });
	await api.put('/api/v1/me/avatar', { headers: await headers(), data: { avatar_name: username, body: 'a', skin_tone: '#c8946b', hair_style: 'short', hair_color: '#1b1514', top_style: 'tee', top_color: '#2f7d6d', bottom_style: 'trousers', bottom_color: '#343b4a', shoe_color: '#eee5d5', accent_color: '#e8a33d', accessories: ['cap'] } });
	await api.post('/api/v1/me/roles', { headers: await headers(), data: { roles: ['visitor'] } });
	const spawn = (await (await api.get('/api/v1/geo/spawn-points')).json()).find((s: { slug: string }) => s.slug === 'central-market');
	await api.put('/api/v1/me/spawn', { headers: await headers(), data: { spawn_point_id: spawn.id, world_visible: true } });
	expect((await api.post('/api/v1/me/onboarding/complete', { headers: await headers() })).ok()).toBe(true);
	return { context, page, api, headers };
}

const ev = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;

async function enter(page: Page) {
	await page.goto('/world');
	await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 180_000 });
	await expect(page.getByTestId('hud-net')).toHaveAttribute('data-status', 'open', { timeout: 30_000 });
}

test('a player rides a motorbike on real streets with directions and parks it; others see it', async ({ browser, baseURL }) => {
	test.setTimeout(600_000);
	const id = Date.now().toString(36).slice(-6);
	const rider = await onboard(browser, baseURL!, `ride_${id}`);
	const watcher = await onboard(browser, baseURL!, `watch_${id}`);
	await enter(rider.page);
	await enter(watcher.page);
	const page = rider.page;

	// ── The garage: a free motorbike, parked on the nearest street. ──────────────────────
	await page.getByTestId('world-canvas').click({ position: { x: 20, y: 300 } });
	await page.keyboard.press('v');
	await page.getByTestId('get-motorbike').click();
	const moto = page.getByTestId('vehicle-motorbike');
	await expect(moto).toBeVisible();
	await expect(moto.getByTestId('vehicle-where')).not.toContainText('Off-street');
	await expect.poll(() => ev<number>(page, '__ppwNet.parked.count'), { timeout: 20_000 }).toBeGreaterThan(0);
	// The watcher (also at Central Market) sees a parked motorbike, without the owner's name.
	await expect.poll(() => ev<number>(watcher.page, '__ppwNet.parked.count'), { timeout: 20_000 }).toBeGreaterThan(0);
	expect(await ev<unknown[]>(watcher.page, '__ppwNet.parked.list().filter((v) => v.mine || v.name)')).toEqual([]);

	// ── Walk to it (route on foot + autopilot), then get on with F. ──────────────────────
	// (Placed within reach of where you stand? Then the garage offers "Ride" straight away.)
	if (await moto.getByTestId('vehicle-ride').isVisible()) await page.keyboard.press('v');
	else await moto.getByText('Walk there').click();
	await expect(page.getByTestId('ride-prompt')).toHaveAttribute('data-kind', 'ride', { timeout: 180_000 });
	await page.screenshot({ path: 'artifacts/phase5-garage-parked.png' });
	await page.getByTestId('world-canvas').click({ position: { x: 20, y: 300 } });
	await page.keyboard.press('f');
	await expect(page.getByTestId('hud-ride')).toHaveAttribute('data-mode', 'motorbike', { timeout: 20_000 });
	await expect.poll(() => ev<number>(watcher.page, '__ppwNet.remotes.ridingCount'), { timeout: 20_000 }).toBe(1);
	// A closer look from the side (orbit and zoom), and the rider as the other player sees it.
	await page.mouse.move(550, 400);
	await page.mouse.down();
	await page.mouse.move(760, 380, { steps: 6 });
	await page.mouse.up();
	for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -300);
	await page.waitForTimeout(4000);
	await page.screenshot({ path: 'artifacts/phase5-on-the-motorbike.png' });
	await watcher.page.screenshot({ path: 'artifacts/phase5-watcher.png' });

	// ── Directions by motorbike to Wat Phnom, ridden by the autopilot. ───────────────────
	await page.keyboard.press('m');
	await page.getByTestId('nav-mode-motorbike').click();
	await page.getByTestId('place-wat-phnom').getByTestId('place-route').click();
	const nav = page.getByTestId('hud-nav');
	await expect(nav).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('hud-nav-step')).not.toBeEmpty();
	const before = Number(await nav.getAttribute('data-remaining'));
	expect(before).toBeGreaterThan(300);
	const corrections = await ev<number>(page, '__ppwNet.corrections');
	await page.getByTestId('nav-follow').click();
	await expect.poll(async () => Number(await page.getByTestId('hud-ride').getAttribute('data-speed')), { timeout: 60_000 }).toBeGreaterThan(10);
	await page.screenshot({ path: 'artifacts/phase5-riding.png' });
	// Ride at least 120 m of the route; every move is checked by the server at motorbike speed.
	await expect.poll(async () => before - Number(await nav.getAttribute('data-remaining')), { timeout: 240_000, intervals: [2000] }).toBeGreaterThan(120);
	expect(await ev<number>(page, '__ppwNet.corrections')).toBeLessThanOrEqual(corrections + 2);
	expect(await ev<string>(page, '__ppwNet.lastCorrection')).not.toBe('offroad');
	await page.screenshot({ path: 'artifacts/phase5-route.png' });

	// ── Stop and park at the kerb. ─────────────────────────────────────────────────────────
	await page.keyboard.down('s');
	await expect.poll(async () => Number(await page.getByTestId('hud-ride').getAttribute('data-speed')), { timeout: 60_000 }).toBeLessThan(2);
	await page.keyboard.up('s');
	await expect(page.getByTestId('ride-prompt')).toHaveAttribute('data-kind', 'park', { timeout: 30_000 });
	await page.keyboard.press('f');
	await expect(page.getByTestId('hud-ride')).toHaveCount(0, { timeout: 20_000 });
	await expect(page.getByTestId('ride-prompt')).toHaveAttribute('data-kind', 'ride', { timeout: 20_000 }); // standing beside it
	await expect.poll(() => ev<number>(watcher.page, '__ppwNet.remotes.ridingCount'), { timeout: 20_000 }).toBe(0);
	await page.keyboard.press('v');
	await expect(page.getByTestId('vehicle-motorbike')).toHaveAttribute('data-status', 'parked');
	await expect(page.getByTestId('vehicle-motorbike').getByTestId('vehicle-where')).not.toContainText('Off-street');
	const odometer = await page.getByTestId('vehicle-motorbike').textContent();
	expect(odometer).toMatch(/0\.[1-9]|[1-9]\.\d km/);
	await page.screenshot({ path: 'artifacts/phase5-parked.png' });

	// The server agrees: parked, at a legal spot (the API reports its street).
	const vehicles = await (await rider.api.get('/api/v1/vehicles')).json();
	expect(vehicles).toHaveLength(1);
	expect(vehicles[0].status).toBe('parked');
	expect(vehicles[0].odometer_m).toBeGreaterThan(100);
});

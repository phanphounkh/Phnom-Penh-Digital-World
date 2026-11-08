/**
 * Phase 3 end-to-end: two real browser sessions in the same world.
 * Needs the API on :8000 and the web app (dev :5173 or preview :4173); the world WebSocket is
 * proxied by Vite (dev/preview) or server.js (production).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

type NetDebug = {
	nearby: { username: string; x: number; z: number; distance: number }[];
	status: string;
	remotes: { count: number };
};

async function player(browser: Browser, baseURL: string, username: string): Promise<Page> {
	const context = await browser.newContext({ baseURL, viewport: { width: 1100, height: 700 } });
	const page = await context.newPage();
	const api = page.request;
	const csrf = async () => ({ 'X-CSRF-Token': (await context.cookies()).find((c) => c.name === 'ppw_csrf')!.value });
	const reg = await (await api.post('/api/v1/auth/register', { data: { username, email: `${username}@example.com`, password: 'correct-horse-battery', display_name: username.toUpperCase(), preferred_language: 'en', accept_terms: true, accept_privacy: true } })).json();
	await api.post('/api/v1/auth/verification/confirm', { data: { code: reg.verification.dev_code }, headers: await csrf() });
	await api.put('/api/v1/me/avatar', { headers: await csrf(), data: { avatar_name: username, body: 'a', skin_tone: '#a8744f', hair_style: 'bun', hair_color: '#1b1514', top_style: 'tee', top_color: '#3d6fb6', bottom_style: 'shorts', bottom_color: '#343b4a', shoe_color: '#eee5d5', accent_color: '#e8a33d', accessories: ['cap'] } });
	await api.post('/api/v1/me/roles', { headers: await csrf(), data: { roles: [] } });
	const spawn = (await (await api.get('/api/v1/geo/spawn-points')).json()).find((s: { slug: string }) => s.slug === 'canadia-garden');
	await api.put('/api/v1/me/spawn', { headers: await csrf(), data: { spawn_point_id: spawn.id, world_visible: true } });
	expect((await api.post('/api/v1/me/onboarding/complete', { headers: await csrf() })).ok()).toBe(true);
	await page.goto('/world');
	await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 180_000 });
	await expect(page.getByTestId('hud-net')).toHaveAttribute('data-status', 'open', { timeout: 30_000 });
	return page;
}

const net = (page: Page) => page.evaluate(() => {
	const n = (globalThis as unknown as { __ppwNet: NetDebug }).__ppwNet;
	return { nearby: n.nearby, status: n.status };
});

test('two players see, follow, hear and befriend each other', async ({ browser, baseURL }) => {
	test.setTimeout(300_000);
	const id = Date.now().toString(36);
	const [nameA, nameB] = [`mpa_${id}`, `mpb_${id}`];
	const a = await player(browser, baseURL!, nameA);
	const b = await player(browser, baseURL!, nameB);

	// Each sees the other (and not themselves).
	await expect.poll(async () => (await net(a)).nearby.map((p) => p.username), { timeout: 20_000 }).toContain(nameB);
	await expect.poll(async () => (await net(b)).nearby.map((p) => p.username), { timeout: 20_000 }).toContain(nameA);
	expect((await net(a)).nearby.map((p) => p.username)).not.toContain(nameA);

	// Movement replicates: B walks, A sees B's position change. Software-rendered CI browsers
	// can run at ~1 fps, so walk until B's own client has moved rather than for a fixed time.
	const before = (await net(a)).nearby.find((p) => p.username === nameB)!;
	const own = () => b.evaluate(() => (globalThis as unknown as { __ppwNet: { city: { localState(): { x: number; z: number } } } }).__ppwNet.city.localState());
	const start = await own();
	await b.locator('[data-testid="world-canvas"] canvas').click({ position: { x: 12, y: 12 } });
	await b.keyboard.down('w');
	await expect.poll(async () => { const p = await own(); return Math.hypot(p.x - start.x, p.z - start.z); }, { timeout: 60_000 }).toBeGreaterThan(2);
	await b.keyboard.up('w');
	await expect
		.poll(async () => {
			const now = (await net(a)).nearby.find((p) => p.username === nameB);
			return now ? Math.hypot(now.x - before.x, now.z - before.z) : 0;
		}, { timeout: 20_000 })
		.toBeGreaterThan(1.5);

	// Nearby chat, typed in the chat box, arrives in the other player's log.
	await b.keyboard.press('Enter');
	await b.getByTestId('chat-input').fill('(e2e) hello from B');
	await b.keyboard.press('Enter');
	await expect(a.getByTestId('chat-log')).toContainText('(e2e) hello from B');

	// Emote button → broadcast (A's copy of B starts the sampeah).
	await b.getByTestId('emote-sampeah').click();

	// Friend request through the People panel; B accepts from theirs.
	await a.getByLabel('People (P)').click();
	await a.getByRole('button', { name: new RegExp(nameB) }).click();
	await a.getByTestId(`actions-${nameB}`).getByRole('button', { name: 'Add friend' }).click();
	await expect(a.getByTestId('people-panel')).toContainText('Friend request sent');
	await expect(b.getByTestId('toast').filter({ hasText: 'sent you a friend request' })).toBeVisible({ timeout: 10_000 });
	await b.getByLabel('People (P)').click();
	await b.getByRole('tab', { name: /Friends/ }).click();
	await b.getByTestId('friends-list').getByRole('button', { name: 'Accept' }).click();
	await expect(b.getByTestId('friends-list')).toContainText(nameA.toUpperCase());
	await a.getByRole('tab', { name: /Friends/ }).click();
	await expect(a.getByTestId('friends-list').locator('[title="Online"]')).toHaveCount(1, { timeout: 10_000 });
	await a.screenshot({ path: 'artifacts/phase3-two-players.png' });

	// Disconnect: B leaves, A no longer sees B.
	await b.context().close();
	await expect.poll(async () => (await net(a)).nearby.map((p) => p.username), { timeout: 15_000 }).not.toContain(nameB);
	await a.context().close();
});

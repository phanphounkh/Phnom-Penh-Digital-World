/**
 * The wardrobe in the game (isolated stack): a player opens it (O), the camera turns to face
 * them and the HUD gives way to a glass panel; they turn the colour wheels with the mouse wheel
 * and the keys and see it on their avatar at once; Save keeps it, and another player nearby sees
 * the new outfit without reconnecting. Item wheels choose garments (a t-shirt, jeans, sandals, a
 * cap): only those show on the avatar, here and for the other player. Escape puts back what was
 * worn. There is only the realistic look (no Classic switch).
 * Screenshots go to test-results/wardrobe/.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

const SHOTS = 'test-results/wardrobe';
const FRAMES = { timeout: 60_000 };
const ev = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;

async function join(browser: Browser, baseURL: string | undefined, username: string) {
	const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 760 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e)));
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
		data: { avatar_name: username, body: 'a', skin_tone: '#c8946b', hair_style: 'short', hair_color: '#1b1514', top_style: 'tee', top_color: '#2f7d6d', bottom_style: 'trousers', bottom_color: '#343b4a', shoe_color: '#eee5d5', accent_color: '#e8a33d', accessories: [] }
	});
	await api.post('/api/v1/me/roles', { headers: await headers(), data: { roles: ['visitor'] } });
	const spawn = (await (await api.get('/api/v1/geo/spawn-points')).json()).find((s: { slug: string }) => s.slug === 'riverside');
	await api.put('/api/v1/me/spawn', { headers: await headers(), data: { spawn_point_id: spawn.id, world_visible: true } });
	expect((await api.post('/api/v1/me/onboarding/complete', { headers: await headers() })).ok()).toBe(true);
	await page.goto('/world');
	await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 180_000 });
	await expect(page.getByTestId('hud-net')).toHaveAttribute('data-status', 'open', { timeout: 90_000 });
	return { page, api, errors };
}

/** Visible wardrobe meshes of a character root, by their game names ("…outfittoptee" → "top.tee"). */
const WORN = `(root) => { const out = []; root?.traverse((o) => { const m = /game(?:outfit|decals)(top|bottom|shoes|hat|bag)(\\w+?)(?:@|$)/.exec(o.name); if (o.isMesh && m && o.visible) out.push(m[1] + '.' + m[2]); }); return [...new Set(out)].sort(); }`;
const wornBy = (page: Page, root: string) => ev<string[]>(page, `(${WORN})(${root})`);

/** Turn a wheel with the mouse wheel, one notch at a time. */
async function scroll(page: Page, drum: string, notches: number) {
	const box = (await page.getByTestId(`drum-${drum}`).boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	for (let i = 0; i < Math.abs(notches); i++) {
		await page.mouse.wheel(0, Math.sign(notches) * 100);
		await page.waitForTimeout(150);
	}
}

test('the wardrobe: wheels, a live avatar, saved for everyone around', async ({ browser, baseURL }) => {
	test.setTimeout(600_000);
	const id = Date.now().toString(36).slice(-6);
	const a = await join(browser, baseURL, `wear_a_${id}`);
	const b = await join(browser, baseURL, `wear_b_${id}`);
	const aId = await ev<number>(a.page, `globalThis.__ppwNet.me.id`);
	const seenByB = () => ev<{ top_color: string } | null>(b.page, `globalThis.__ppwNet.remotes.players.get(${aId})?.card.av ?? null`);
	await expect.poll(seenByB, FRAMES).toMatchObject({ top_color: '#2f7d6d' });

	// The other player steps aside (both start on the same spot) so the screenshots show A.
	await b.page.evaluate(
		`new Promise((done) => { const c = globalThis.__ppwNet.city; const p = c.localState(); c.walkTo([[p.x + 3.5, p.z + 3.5]], done); setTimeout(done, 15000); })`
	);
	// Daylight for the screenshots (the city otherwise follows Phnom Penh's real time).
	await a.page.evaluate(`globalThis.__ppwNet.city.setTimeMode('noon')`);
	// O opens it: the panel, no HUD.
	await a.page.locator('[data-testid="world-canvas"] canvas').click({ position: { x: 300, y: 300 } });
	await a.page.keyboard.press('o');
	await expect(a.page.getByTestId('wardrobe')).toBeVisible();
	await expect(a.page.getByRole('navigation', { name: 'World controls' })).toBeHidden();
	await expect(a.page.getByTestId('wardrobe-now')).toHaveText('Jade jacket');
	await expect(a.page.getByTestId('wardrobe').getByText(/Classic/)).toHaveCount(0);
	await a.page.waitForTimeout(2500);
	await a.page.screenshot({ path: `${SHOTS}/open.png` });

	// The wheel: two colours on (Jade → River → Saffron).
	await scroll(a.page, 'top-colour', 2);
	await expect(a.page.getByTestId('drum-top-colour')).toHaveAttribute('data-value', '#e8a33d');
	await expect(a.page.getByTestId('wardrobe-now')).toHaveText('Saffron jacket');
	// Worn at once, before saving.
	await expect.poll(() => ev<string>(a.page, `globalThis.__ppwNet.city.outfit.top_color`), FRAMES).toBe('#e8a33d');
	// Keys too: down on the bottoms' colour wheel goes from Slate to Orchid.
	await a.page.getByTestId('cat-bottom').click();
	await a.page.getByTestId('drum-bottom-colour').focus();
	await a.page.keyboard.press('ArrowDown');
	await expect(a.page.getByTestId('wardrobe-now')).toHaveText('Orchid joggers');
	await a.page.waitForTimeout(2000);
	await a.page.screenshot({ path: `${SHOTS}/changed.png` });

	// Garments: the original outfit until an item wheel turns.
	const mine = `globalThis.__ppwNet.city.avatar`;
	expect(await wornBy(a.page, mine)).toEqual(['bag.backpack', 'bottom.trousers', 'shoes.sneakers', 'top.hoodie']);
	await a.page.getByTestId('cat-top').click();
	await scroll(a.page, 'top-item', 1);
	await expect(a.page.getByTestId('wardrobe-now')).toHaveText('Saffron T-shirt');
	await a.page.getByTestId('cat-bottom').click();
	await scroll(a.page, 'bottom-item', 1);
	await expect(a.page.getByTestId('wardrobe-now')).toHaveText('Orchid jeans');
	await a.page.getByTestId('cat-shoes').click();
	await scroll(a.page, 'shoes-item', 1);
	await expect(a.page.getByTestId('wardrobe-now')).toContainText('sandals');
	await a.page.getByTestId('cat-hat').click();
	await scroll(a.page, 'hat-item', 1);
	await expect(a.page.getByTestId('wardrobe-now')).toHaveText('Saffron cap');
	await expect.poll(() => wornBy(a.page, mine), FRAMES).toEqual(['bag.backpack', 'bottom.jeans', 'hat.cap', 'shoes.sandals', 'top.tee']);
	await a.page.waitForTimeout(2000);
	await a.page.screenshot({ path: `${SHOTS}/garments.png` });
	await a.page.screenshot({ path: 'artifacts/wardrobe-garments.png' }); // README

	// Save: kept, and the other player sees it without reconnecting.
	await a.page.getByTestId('wardrobe-save').click();
	await expect(a.page.getByTestId('wardrobe')).toHaveCount(0);
	await expect(a.page.getByRole('navigation', { name: 'World controls' })).toBeVisible();
	const saved = await (await a.api.get('/api/v1/me/avatar')).json();
	expect(saved).toMatchObject({ model: 'outfit', top_style: 'tee', top_color: '#e8a33d', bottom_style: 'jeans', bottom_color: '#6b4fa0', shoe_style: 'sandals', accessories: ['backpack', 'cap'] });
	await expect.poll(seenByB, FRAMES).toMatchObject({ top_color: '#e8a33d' });
	await expect.poll(() => wornBy(b.page, `globalThis.__ppwNet.remotes.players.get(${aId})?.character?.root`), FRAMES).toEqual([
		'bag.backpack',
		'bottom.jeans',
		'hat.cap',
		'shoes.sandals',
		'top.tee'
	]);

	// Escape puts back what was worn.
	await a.page.getByTestId('open-wardrobe').click();
	await a.page.getByTestId('cat-bag').click();
	await scroll(a.page, 'bag-colour', 1);
	await expect(a.page.getByTestId('wardrobe-now')).toHaveText('Brick backpack');
	await expect.poll(() => ev<string>(a.page, `globalThis.__ppwNet.city.outfit.accent_color`), FRAMES).toBe('#c4552f');
	await a.page.keyboard.press('Escape');
	await expect(a.page.getByTestId('wardrobe')).toHaveCount(0);
	await expect.poll(() => ev<string>(a.page, `globalThis.__ppwNet.city.outfit.accent_color`), FRAMES).toBe('#e8a33d');
	expect((await (await a.api.get('/api/v1/me/avatar')).json()).accent_color).toBe('#e8a33d');

	// A phone: the panel is a sheet below the avatar.
	await a.page.setViewportSize({ width: 390, height: 844 });
	await a.page.getByTestId('open-wardrobe').click();
	await expect(a.page.getByTestId('wardrobe')).toBeVisible();
	await a.page.waitForTimeout(2500);
	await a.page.screenshot({ path: `${SHOTS}/phone.png` });
	await a.page.keyboard.press('Escape');

	expect(a.errors).toEqual([]);
	expect(b.errors).toEqual([]);
});

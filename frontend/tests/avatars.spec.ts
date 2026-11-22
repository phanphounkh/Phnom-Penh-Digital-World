/**
 * Realistic avatars end to end (isolated stack): two players with different builds see
 * themselves and each other as realistic models, walk, play an emote (seen by the other player),
 * switch to the classic style and back at runtime; the avatar editor previews the realistic
 * model. Screenshots go to test-results/avatars/ (not committed).
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

type Who = { context: BrowserContext; page: Page; errors: string[] };
const SHOTS = 'test-results/avatars';
/** The E2E browser renders in software (SwiftShader, ~1–5 fps): give frame-driven state time. */
const FRAMES = { timeout: 30_000 };

async function account(browser: Browser, baseURL: string, username: string) {
	const context = await browser.newContext({ baseURL, viewport: { width: 1100, height: 720 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
	const api = page.request;
	const headers = async () => ({ 'X-CSRF-Token': (await context.cookies()).find((c) => c.name === 'ppw_csrf')?.value ?? '' });
	const reg = await (
		await api.post('/api/v1/auth/register', {
			data: { username, email: `${username}@example.com`, password: 'correct-horse-battery', display_name: username.toUpperCase(), preferred_language: 'en', accept_terms: true, accept_privacy: true }
		})
	).json();
	expect(reg.verification?.dev_code, JSON.stringify(reg)).toBeTruthy();
	await api.post('/api/v1/auth/verification/confirm', { data: { code: reg.verification.dev_code }, headers: await headers() });
	return { context, page, errors, api, headers };
}

async function onboard(browser: Browser, baseURL: string, username: string, look: Record<string, string>): Promise<Who> {
	const { context, page, errors, api, headers } = await account(browser, baseURL, username);
	await api.put('/api/v1/me/avatar', {
		headers: await headers(),
		data: { avatar_name: username, body: 'a', skin_tone: '#c8946b', hair_style: 'short', hair_color: '#1b1514', top_style: 'hoodie', top_color: '#2f7d6d', bottom_style: 'trousers', bottom_color: '#343b4a', shoe_color: '#eee5d5', accent_color: '#e8a33d', accessories: [], ...look }
	});
	await api.post('/api/v1/me/roles', { headers: await headers(), data: { roles: ['visitor'] } });
	const spawn = (await (await api.get('/api/v1/geo/spawn-points')).json()).find((s: { slug: string }) => s.slug === 'central-market');
	await api.put('/api/v1/me/spawn', { headers: await headers(), data: { spawn_point_id: spawn.id, world_visible: true } });
	expect((await api.post('/api/v1/me/onboarding/complete', { headers: await headers() })).ok()).toBe(true);
	return { context, page, errors };
}

const ev = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;
type AvatarInfo = { style: string; model: string; bones: number; riding: boolean; gait: string | null; emote: string | null };
const avatar = (page: Page) => ev<AvatarInfo>(page, '__ppwPerf.avatar()');
/** Model name of the other player's avatar as this page draws it (or null). */
const remoteModel = (page: Page, username: string) =>
	ev<string | null>(page, `(() => { const g = __ppwPerf.scene.getObjectByName('remote:${username}'); const m = g?.children.find((c) => c.name.startsWith('realistic:') || c.type === 'Group' && c.children.length); return m ? m.name || 'classic' : null; })()`);

async function enter(page: Page) {
	await page.goto('/world');
	await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 180_000 });
	await expect(page.getByTestId('hud-net')).toHaveAttribute('data-status', 'open', { timeout: 30_000 });
}

/** Orbit the camera to look at the player's front and zoom in. */
async function closeUp(page: Page) {
	await page.mouse.move(550, 400);
	await page.mouse.down();
	await page.mouse.move(550 + 380, 380, { steps: 8 });
	await page.mouse.up();
	for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -300);
	await page.waitForTimeout(1500);
}

test('realistic avatars: builds, remote players, walking, emotes and the classic switch', async ({ browser, baseURL }) => {
	test.setTimeout(600_000);
	const id = Date.now().toString(36).slice(-6);
	const a = await onboard(browser, baseURL!, `real_${id}`, { body: 'a', top_color: '#e9e9ee', accent_color: '#2b4ea0', bottom_color: '#1b1b1e' });
	const b = await onboard(browser, baseURL!, `realb_${id}`, { body: 'b', top_color: '#d8d4d3', accent_color: '#8a4fd6', hair_color: '#2b2220' });
	await enter(a.page);
	await enter(b.page);

	// Each player is drawn with the realistic model of their build.
	expect(await avatar(a.page)).toMatchObject({ style: 'realistic', model: 'realistic:male', riding: false });
	expect(await avatar(b.page)).toMatchObject({ style: 'realistic', model: 'realistic:female' });
	expect((await avatar(a.page)).bones).toBeGreaterThanOrEqual(52);
	// ... and sees the other one as a realistic remote avatar.
	await expect.poll(() => remoteModel(a.page, `realb_${id}`), { timeout: 30_000 }).toBe('realistic:female');
	await expect.poll(() => remoteModel(b.page, `real_${id}`), { timeout: 30_000 }).toBe('realistic:male');

	await closeUp(a.page);
	await a.page.screenshot({ path: `${SHOTS}/realistic-idle.png` });

	// Walking: the walk clip plays while W is held, idle again after.
	await a.page.getByTestId('world-canvas').click({ position: { x: 20, y: 300 } });
	await a.page.keyboard.down('w');
	await expect.poll(async () => (await avatar(a.page)).gait, FRAMES).toBe('walk');
	await a.page.waitForTimeout(700);
	await a.page.screenshot({ path: `${SHOTS}/realistic-walk.png` });
	await a.page.keyboard.down('Shift');
	await expect.poll(async () => (await avatar(a.page)).gait, FRAMES).toBe('run');
	await a.page.waitForTimeout(500);
	await a.page.screenshot({ path: `${SHOTS}/realistic-run.png` });
	await a.page.keyboard.up('Shift');
	await a.page.keyboard.up('w');
	await expect.poll(async () => (await avatar(a.page)).gait, FRAMES).toBe('idle');

	// Emote: the sampeah plays locally and the other player receives it.
	await b.page.getByTestId('emote-sampeah').click();
	await expect.poll(async () => (await avatar(b.page)).emote, FRAMES).toBe('sampeah');
	await closeUp(b.page);
	await b.page.waitForTimeout(800);
	await b.page.screenshot({ path: `${SHOTS}/realistic-sampeah.png` });

	// Switch to classic and back at runtime (Settings → Avatars).
	await a.page.getByRole('button', { name: 'Settings' }).click();
	const styles = a.page.getByTestId('avatar-style');
	await styles.getByRole('radio', { name: 'Classic' }).click();
	await expect.poll(async () => (await avatar(a.page)).style, { timeout: 30_000 }).toBe('classic');
	await expect.poll(() => remoteModel(a.page, `realb_${id}`), { timeout: 30_000 }).not.toBe('realistic:female');
	await a.page.screenshot({ path: `${SHOTS}/classic-switch.png` });
	await styles.getByRole('radio', { name: 'Realistic' }).click();
	await expect.poll(async () => (await avatar(a.page)).model, { timeout: 30_000 }).toBe('realistic:male');
	await expect.poll(() => remoteModel(a.page, `realb_${id}`), { timeout: 30_000 }).toBe('realistic:female');
	// The choice is remembered for the next visit.
	expect(await ev<string>(a.page, `localStorage.getItem('ppw.avatarStyle')`)).toBe('realistic');

	expect(a.errors, a.errors.join('\n')).toEqual([]);
	expect(b.errors, b.errors.join('\n')).toEqual([]);
	await a.context.close();
	await b.context.close();
});

test('the avatar editor previews the realistic model and can switch to classic', async ({ browser, baseURL }) => {
	test.setTimeout(240_000);
	const id = Date.now().toString(36).slice(-6);
	const { page, errors, context } = await account(browser, baseURL!, `prev_${id}`);
	await page.goto('/onboarding/avatar');
	const preview = page.getByTestId('avatar-preview');
	await expect(preview).toHaveAttribute('data-ready', 'true', { timeout: 120_000 });
	await expect(preview).toHaveAttribute('data-style', 'realistic');
	await page.waitForTimeout(800);
	await preview.screenshot({ path: `${SHOTS}/editor-realistic.png` });
	await preview.getByRole('radio', { name: 'Classic' }).click();
	await expect(preview).toHaveAttribute('data-style', 'classic', { timeout: 60_000 });
	await preview.getByRole('radio', { name: 'Realistic' }).click();
	await expect(preview).toHaveAttribute('data-style', 'realistic', { timeout: 60_000 });
	expect(errors, errors.join('\n')).toEqual([]);
	await context.close();
});

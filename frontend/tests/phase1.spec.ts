/**
 * Phase 1 end-to-end: Welcome → Register → Verify → Your place → 3D city, where the wardrobe
 * opens to make the avatar.
 * Needs the API on :8000 (with the OSM import) and the web app on :5173 (or :4173 with
 * CAMPUS_PRODUCTION_TEST=1). Uses software WebGL, so it is slower than real hardware.
 */
import { expect, test, type Page } from '@playwright/test';

const shots = 'artifacts';

async function hudXZ(page: Page): Promise<[number, number]> {
	const text = (await page.getByTestId('hud-coords').textContent()) ?? '';
	const m = /x (-?\d+) z (-?\d+)/.exec(text);
	expect(m, text).not.toBeNull();
	return [Number(m![1]), Number(m![2])];
}

test('a new player registers, onboards and walks the real streets of Daun Penh', async ({ page }) => {
	test.setTimeout(240_000);
	const username = `pp_${Date.now().toString(36)}`;

	await page.goto('/');
	await expect(page.getByRole('heading', { name: /Phnom Penh\s*Digital World/ })).toBeVisible();
	await page.getByRole('link', { name: 'Create account' }).click();

	// Screen 2 — account
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Display name').fill('Sokha Test');
	await page.getByLabel('Email').fill(`${username}@example.com`);
	await page.getByLabel('Password').fill('correct-horse-battery');
	await page.getByLabel(/Terms of Use/).check();
	await page.getByLabel(/Privacy Policy/).check();
	await page.getByRole('button', { name: 'Create account' }).click();

	// Verify — the development code is shown in a clearly labelled banner.
	await expect(page).toHaveURL(/\/onboarding\/verify/);
	const devCode = page.getByTestId('dev-code');
	await expect(devCode).toContainText('Developer mode');
	const code = (await devCode.locator('.font-mono').textContent())!.trim();
	await page.getByLabel('Verification code').fill(code);
	await page.getByRole('button', { name: 'Verify' }).click();

	// Your place: a private pin anywhere in Phnom Penh; the nearest public start is chosen for it.
	await expect(page).toHaveURL(/\/onboarding\/location/);
	const map = page.getByTestId('location-map');
	await expect(map).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
	await page.getByLabel('Search places in Phnom Penh').fill('central market');
	await expect(page.getByRole('button', { name: /Central Market/ }).first()).toBeVisible();
	await page.getByRole('button', { name: /Central Market/ }).first().click();
	await page.waitForTimeout(2500); // fly-to animation
	const box = (await map.boundingBox())!;
	await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.6);
	await expect(page.getByText('Inside Phnom Penh')).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId('start-at')).toContainText('Central Market');
	await page.getByTestId('visible-yes').click();
	await page.screenshot({ path: `${shots}/phase1-location.png`, fullPage: true });
	await page.getByTestId('enter-city').click();

	// The city: the wardrobe opens to make the avatar (no avatar page before it).
	await expect(page).toHaveURL(/\/world/);
	await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 120_000 });
	const wardrobe = page.getByTestId('wardrobe');
	await expect(wardrobe).toBeVisible({ timeout: 60_000 });
	await expect(wardrobe).toContainText('Make your avatar');
	await expect(wardrobe.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
	const drum = (await page.getByTestId('drum-top-colour').boundingBox())!;
	await page.mouse.move(drum.x + drum.width / 2, drum.y + drum.height / 2);
	for (let i = 0; i < 2; i++) {
		await page.mouse.wheel(0, 100);
		await page.waitForTimeout(200);
	}
	await expect(page.getByTestId('wardrobe-now')).toHaveText('Saffron jacket');
	// The wardrobe as a laptop shows it.
	const viewport = page.viewportSize()!;
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.waitForTimeout(2500);
	await page.screenshot({ path: `${shots}/phase1-avatar.png` });
	await page.setViewportSize(viewport);
	await page.getByTestId('wardrobe-save').click();
	await expect(wardrobe).toHaveCount(0);
	expect((await (await page.request.get('/api/v1/me/avatar')).json()).top_color).toBe('#e8a33d');
	await expect(page.getByTestId('hud-location')).toBeVisible();
	await expect(page.getByTestId('hud-coords')).toContainText('11.56');
	await page.waitForTimeout(1500);
	await page.screenshot({ path: `${shots}/phase1-world-spawn.png` });

	const before = await hudXZ(page);
	await page.locator('[data-testid="world-canvas"] canvas').click({ position: { x: 20, y: 20 } });
	await page.keyboard.down('Shift');
	await page.keyboard.down('w');
	await page.waitForTimeout(3500);
	await page.keyboard.up('w');
	await page.keyboard.up('Shift');
	await page.waitForTimeout(600);
	const after = await hudXZ(page);
	expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeGreaterThan(3);
	await page.screenshot({ path: `${shots}/phase1-world-walk.png` });

	// Session survives a reload and returns straight to the world.
	await page.goto('/');
	await page.getByTestId('enter-world').click();
	await expect(page).toHaveURL(/\/world/);
});

test('signed-out visitors are sent to sign in; onboarding cannot be skipped', async ({ page }) => {
	await page.goto('/world');
	await expect(page).toHaveURL(/\/login/);
	await page.goto('/onboarding/location');
	await expect(page).toHaveURL(/\/login/);
});

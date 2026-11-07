/**
 * Phase 1 end-to-end: Welcome → Register → Verify → Avatar → Role → Location → 3D city.
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

	// Screen 3 — avatar (Blender GLB preview)
	await expect(page).toHaveURL(/\/onboarding\/avatar/);
	await expect(page.getByTestId('avatar-preview')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
	await page.getByRole('radio', { name: 'Long' }).click();
	await page.getByRole('radio', { name: 'Hoodie' }).click();
	await page.getByRole('button', { name: 'Krama scarf' }).click();
	await page.screenshot({ path: `${shots}/phase1-avatar.png`, fullPage: true });
	await page.getByRole('button', { name: /Save avatar/ }).click();

	// Screen 4 — roles: buyer (immediate) + seller (needs approval)
	await expect(page).toHaveURL(/\/onboarding\/role/);
	await page.getByTestId('role-seller').click();
	await page.getByRole('button', { name: /Save roles/ }).click();

	// Screen 5 — location: private pin + public spawn + explicit visibility
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
	await page.getByTestId('spawn-central-market').click();
	await page.getByTestId('visible-yes').click();
	await page.screenshot({ path: `${shots}/phase1-location.png`, fullPage: true });
	await page.getByTestId('enter-city').click();

	// Screen 6 — the 3D city
	await expect(page).toHaveURL(/\/world/);
	await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 120_000 });
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

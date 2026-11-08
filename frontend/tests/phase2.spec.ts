/**
 * Phase 2 end-to-end: terrain, Blender props and landmarks, workers, day/night.
 * Needs the API on :8000 (with the OSM import) and the web app (dev :5173 or preview :4173).
 */
import { expect, test } from '@playwright/test';

test('Wat Phnom stands on its hill, chunks build in workers, and night falls', async ({ page }) => {
	test.setTimeout(240_000);
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => m.type() === 'error' && !m.text().includes('401') && errors.push(m.text()));

	// Onboard through the API (the UI flow is covered by phase1.spec.ts).
	const api = page.request;
	const user = `p2_${Date.now().toString(36)}`;
	const reg = await (await api.post('/api/v1/auth/register', { data: { username: user, email: `${user}@example.com`, password: 'correct-horse-battery', display_name: 'Phase Two', preferred_language: 'en', accept_terms: true, accept_privacy: true } })).json();
	const csrf = async () => ({ 'X-CSRF-Token': (await page.context().cookies()).find((c) => c.name === 'ppw_csrf')!.value });
	await api.post('/api/v1/auth/verification/confirm', { data: { code: reg.verification.dev_code }, headers: await csrf() });
	await api.put('/api/v1/me/avatar', { headers: await csrf(), data: { avatar_name: 'P2', body: 'a', skin_tone: '#7e5236', hair_style: 'buzz', hair_color: '#1b1514', top_style: 'hoodie', top_color: '#c4552f', bottom_style: 'trousers', bottom_color: '#343b4a', shoe_color: '#eee5d5', accent_color: '#e8a33d', accessories: ['glasses'] } });
	await api.post('/api/v1/me/roles', { headers: await csrf(), data: { roles: [] } });
	const spawn = (await (await api.get('/api/v1/geo/spawn-points')).json()).find((s: { slug: string }) => s.slug === 'wat-phnom');
	await api.put('/api/v1/me/spawn', { headers: await csrf(), data: { spawn_point_id: spawn.id, world_visible: false } });
	expect((await api.post('/api/v1/me/onboarding/complete', { headers: await csrf() })).ok()).toBe(true);

	await page.goto('/world');
	const world = page.getByTestId('world-canvas');
	await expect(world).toHaveAttribute('data-ready', 'true', { timeout: 180_000 });
	await expect(page.getByTestId('hud-location')).toContainText('Wat Phnom');

	// The avatar stands on the 27 m hilltop (terrain shared with the server).
	await expect.poll(async () => Number(await world.getAttribute('data-ground'))).toBeGreaterThan(20);

	// Chunk geometry is built in Web Workers; Blender props and the stupa model are in the scene.
	const scene = await page.evaluate(() => {
		const perf = (globalThis as unknown as { __ppwPerf: { chunks: () => { workerCount: number }; scene: { traverse: (f: (n: { isInstancedMesh?: boolean; name?: string; userData?: { shared?: boolean } }) => void) => void } } }).__ppwPerf;
		let instanced = 0;
		let models = 0;
		perf.scene.traverse((n) => {
			if (n.isInstancedMesh) instanced++;
			if (n.userData?.shared && !n.isInstancedMesh) models++;
		});
		return { workers: perf.chunks().workerCount, instanced, models };
	});
	expect(scene.workers).toBe(2);
	expect(scene.instanced).toBeGreaterThan(10);
	await expect.poll(async () => page.evaluate(() => {
		let n = 0;
		(globalThis as unknown as { __ppwPerf: { scene: { traverse: (f: (o: { userData?: { shared?: boolean }; isInstancedMesh?: boolean }) => void) => void } } }).__ppwPerf.scene.traverse((o) => { if (o.userData?.shared && !o.isInstancedMesh) n++; });
		return n;
	})).toBeGreaterThan(0);

	// Night: fixed preset → 21:00 Phnom Penh time, night factor 1.
	await page.getByLabel('Settings').click();
	await page.getByRole('radio', { name: 'Night' }).click();
	await page.getByLabel('Close').click();
	await expect(page.getByTestId('hud-clock')).toContainText('21:00');
	await expect.poll(async () => Number(await world.getAttribute('data-night'))).toBeGreaterThan(0.95);
	await page.waitForTimeout(1500);
	await page.screenshot({ path: 'artifacts/phase2-wat-phnom-night.png' });

	await page.getByLabel('Settings').click();
	await page.getByRole('radio', { name: 'Midday' }).click();
	await page.getByLabel('Close').click();
	await expect(page.getByTestId('hud-clock')).toContainText('12:00');
	await expect.poll(async () => Number(await world.getAttribute('data-night'))).toBe(0);

	expect(errors).toEqual([]);
});

/**
 * Gameplay polish end-to-end: the third-person camera in the real engine (software WebGL).
 *
 *  - Trees: the patched leaf shader compiles, and when a canopy stands between the camera and
 *    the player it is dithered away (rendered pixels around the player change).
 *  - Buildings: orbiting a dense street zoomed right out, the line of sight from the camera to
 *    the player never passes through a building, while the camera does pull in for them.
 *  - Touch: a second finger on the canvas does not swing the camera.
 */
import { expect, test, type Page } from '@playwright/test';

type View = {
	camera: [number, number, number];
	focus: [number, number, number];
	yaw: number;
	pitch: number;
	distance: number;
	boom: number;
	zoom: number;
	sightBlocked: boolean;
	foliageMaterials: string[];
};
type Point = { x: number; y: number; z: number };

const view = (page: Page) => page.evaluate(() => (globalThis as unknown as { __ppwPerf: { view: () => View } }).__ppwPerf.view());

/** Drag on the canvas like a player orbiting the camera (yaw −0.006 rad/px, pitch +0.004 rad/px). */
async function orbit(page: Page, dx: number, dy = 0, steps = 12) {
	await page.mouse.move(500, 380);
	await page.mouse.down();
	for (let i = 1; i <= steps; i++) await page.mouse.move(500 + (dx * i) / steps, 380 + (dy * i) / steps);
	await page.mouse.up();
}

test('the camera keeps trees and buildings from hiding the player', async ({ page }) => {
	test.setTimeout(360_000);
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => m.type() === 'error' && !m.text().includes('401') && errors.push(m.text()));

	// Onboard through the API (the UI flow is covered by phase1.spec.ts), spawning in the
	// Wat Phnom park, where the trees are.
	const api = page.request;
	const user = `cam_${Date.now().toString(36)}`;
	const reg = await (await api.post('/api/v1/auth/register', { data: { username: user, email: `${user}@example.com`, password: 'correct-horse-battery', display_name: 'Camera Test', preferred_language: 'en', accept_terms: true, accept_privacy: true } })).json();
	const csrf = async () => ({ 'X-CSRF-Token': (await page.context().cookies()).find((c) => c.name === 'ppw_csrf')!.value });
	await api.post('/api/v1/auth/verification/confirm', { data: { code: reg.verification.dev_code }, headers: await csrf() });
	await api.put('/api/v1/me/avatar', { headers: await csrf(), data: { avatar_name: 'Cam', body: 'b', skin_tone: '#a8744f', hair_style: 'bun', hair_color: '#1b1514', top_style: 'tee', top_color: '#e8a33d', bottom_style: 'shorts', bottom_color: '#123b3a', shoe_color: '#c4552f', accent_color: '#c4552f', accessories: [] } });
	await api.post('/api/v1/me/roles', { headers: await csrf(), data: { roles: [] } });
	const spawn = (await (await api.get('/api/v1/geo/spawn-points')).json()).find((s: { slug: string }) => s.slug === 'wat-phnom');
	await api.put('/api/v1/me/spawn', { headers: await csrf(), data: { spawn_point_id: spawn.id, world_visible: false } });
	expect((await api.post('/api/v1/me/onboarding/complete', { headers: await csrf() })).ok()).toBe(true);

	await page.goto('/world');
	await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 180_000 });
	await expect(page.getByTestId('hud-net')).toHaveAttribute('data-status', 'open', { timeout: 30_000 });
	const start = await view(page);
	expect(start.foliageMaterials.sort()).toEqual(['Leaves', 'LeavesLight', 'PalmLeaves']);
	expect(start.sightBlocked).toBe(false);

	// ── touch: only the first finger orbits ──────────────────────────────────────────────
	const cdp = await page.context().newCDPSession(page);
	const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: [number, number][]) =>
		cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
	await touch('touchStart', [[450, 420]]);
	await touch('touchMove', [[490, 420]]);
	const oneFinger = (await view(page)).yaw;
	expect(Math.abs(oneFinger - start.yaw)).toBeGreaterThan(0.15); // 40 px ≈ 0.24 rad
	await touch('touchStart', [[490, 420], [760, 420]]);
	await touch('touchMove', [[490, 420], [880, 420]]); // the second finger moves 120 px
	await touch('touchMove', [[490, 420], [940, 420]]);
	const twoFingers = (await view(page)).yaw;
	expect(Math.abs(twoFingers - oneFinger)).toBeLessThan(0.01);
	await touch('touchEnd', []);

	// ── trees: put a canopy between the camera and the player ──────────────────────────
	await expect
		.poll(() => page.evaluate(() => {
			const g = globalThis as unknown as { __ppwPerf: { scene: { traverse: (f: (n: { isInstancedMesh?: boolean; material?: { name?: string } }) => void) => void } } };
			let n = 0;
			g.__ppwPerf.scene.traverse((o) => { if (o.isInstancedMesh && o.material?.name === 'Leaves') n++; });
			return n;
		}), { timeout: 60_000 })
		.toBeGreaterThan(0);
	// Walk (the normal autopilot, like the "Walk" button) to 3.5 m from the nearest broadleaf
	// canopy, on the side we are coming from.
	const tree = await page.evaluate(() => new Promise<{ canopy: Point; arrived: boolean }>((resolve) => {
		type Mesh = { isInstancedMesh?: boolean; material?: { name?: string }; count: number; geometry: { boundingBox: { getCenter: (v: unknown) => { clone: () => { applyMatrix4: (m: unknown) => Point } } } | null; computeBoundingBox: () => void }; position: { clone: () => unknown }; matrixWorld: { constructor: new () => unknown }; getMatrixAt: (i: number, m: unknown) => void };
		const g = globalThis as unknown as { __ppwPerf: { scene: { traverse: (f: (n: Mesh) => void) => void } }; __ppwNet: { city: { localState: () => Point; walkTo: (p: [number, number][], done: (ok: boolean) => void) => void } } };
		const city = g.__ppwNet.city;
		const me = city.localState();
		let best: (Point & { d: number }) | null = null;
		g.__ppwPerf.scene.traverse((n) => {
			if (!n.isInstancedMesh || n.material?.name !== 'Leaves') return;
			if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
			const centre = n.geometry.boundingBox!.getCenter(n.position.clone());
			const m = new n.matrixWorld.constructor();
			for (let i = 0; i < n.count; i++) {
				n.getMatrixAt(i, m);
				const p = centre.clone().applyMatrix4(m);
				const d = Math.hypot(p.x - me.x, p.z - me.z);
				if (!best || d < best.d) best = { ...p, d };
			}
		});
		const t = best as unknown as Point & { d: number };
		const k = 3.5 / Math.max(t.d, 0.1);
		city.walkTo([[t.x + (me.x - t.x) * k, t.z + (me.z - t.z) * k]], (arrived) => resolve({ canopy: { x: t.x, y: t.y, z: t.z }, arrived }));
	}));
	await page.waitForTimeout(800);
	// Orbit so that the camera looks at the player through the canopy centre.
	let v = await view(page);
	const head = { x: v.focus[0], y: v.focus[1], z: v.focus[2] };
	const c = tree.canopy;
	const wantYaw = Math.atan2(c.x - head.x, c.z - head.z);
	const wantPitch = Math.min(1.2, Math.max(0.1, Math.atan2(c.y - head.y, Math.hypot(c.x - head.x, c.z - head.z))));
	const turn = Math.atan2(Math.sin(wantYaw - v.yaw), Math.cos(wantYaw - v.yaw));
	await orbit(page, -turn / 0.006, (wantPitch - v.pitch) / 0.004);
	await page.waitForTimeout(1500);
	v = await view(page);
	const fade = await page.evaluate((p) => (globalThis as unknown as { __ppwPerf: { foliage: { fadeAt: (p: Point) => number } } }).__ppwPerf.foliage.fadeAt(p), c);
	expect(fade).toBeGreaterThan(0.5); // the engine feeds the shader the camera → player cone

	// Render the same frame with the fade on and off and compare the pixels around the player
	// (the camera looks at the head, so it sits at the centre of the screen).
	const centrePixels = (on: boolean) => page.evaluate((on) => {
		const g = globalThis as unknown as {
			__ppwPerf: { renderer: { render: (s: unknown, c: unknown) => void; getContext: () => WebGL2RenderingContext }; scene: unknown; foliage: { enabled: boolean } };
			__ppwNet: { city: { camera: unknown; setPaused: (p: boolean) => void } };
		};
		const p = g.__ppwPerf;
		p.foliage.enabled = on;
		p.renderer.render(p.scene, g.__ppwNet.city.camera);
		const gl = p.renderer.getContext();
		const size = 48;
		const out = new Uint8Array(size * size * 4);
		gl.readPixels(gl.drawingBufferWidth / 2 - size / 2, gl.drawingBufferHeight / 2 - size / 2, size, size, gl.RGBA, gl.UNSIGNED_BYTE, out);
		p.foliage.enabled = true;
		return Array.from(out);
	}, on);
	await page.evaluate(() => (globalThis as unknown as { __ppwNet: { city: { setPaused: (p: boolean) => void } } }).__ppwNet.city.setPaused(true));
	const faded = await centrePixels(true);
	const solid = await centrePixels(false);
	await page.evaluate(() => (globalThis as unknown as { __ppwNet: { city: { setPaused: (p: boolean) => void } } }).__ppwNet.city.setPaused(false));
	let changed = 0;
	for (let i = 0; i < faded.length; i += 4)
		if (Math.abs(faded[i] - solid[i]) + Math.abs(faded[i + 1] - solid[i + 1]) + Math.abs(faded[i + 2] - solid[i + 2]) > 40) changed++;
	const changedShare = changed / (faded.length / 4);
	test.info().annotations.push({ type: 'tree', description: `canopy fade ${fade.toFixed(2)}; ${(changedShare * 100).toFixed(0)} % of pixels around the player change when the fade is on` });
	expect(changedShare).toBeGreaterThan(0.3);
	await page.screenshot({ path: test.info().outputPath('camera-tree-faded.png') });

	// ── buildings: Central Market's streets, zoomed right out, orbit all the way round ──
	await page.getByLabel('Places & shops (M)').click();
	await page.getByTestId('place-central-market').getByRole('button', { name: 'Go' }).click();
	await expect
		.poll(() => page.evaluate(() => {
			const me = (globalThis as unknown as { __ppwNet: { city: { localState: () => Point } } }).__ppwNet.city.localState();
			return Math.hypot(me.x - 2, me.z - 72); // the Central Market spawn area
		}), { timeout: 30_000 })
		.toBeLessThan(40);
	await page.waitForTimeout(4000);
	await page.mouse.move(500, 380);
	for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 100);
	// A low camera (≈ 5 m up at full zoom) so that the buildings really get in the way.
	await orbit(page, 0, (0.2 - (await view(page)).pitch) / 0.004);
	await page.waitForTimeout(1500);
	let blocked = 0,
		pulledIn = 0,
		samples = 0;
	for (let step = 0; step < 24; step++) {
		await orbit(page, 44, 0, 3); // 24 × 44 px ≈ 360°
		for (let k = 0; k < 2; k++) {
			await page.waitForTimeout(150);
			v = await view(page);
			samples++;
			if (v.sightBlocked) blocked++;
			if (v.boom < v.zoom - 1) pulledIn++;
		}
	}
	test.info().annotations.push({ type: 'buildings', description: `${samples} samples zoomed out to ${v.zoom.toFixed(1)} m: ${blocked} with the view blocked, ${pulledIn} with the camera pulled in` });
	expect(v.zoom).toBeGreaterThan(18);
	expect(blocked).toBe(0);
	expect(pulledIn).toBeGreaterThanOrEqual(3); // the buildings did get in the way, and the camera moved in
	expect(samples).toBe(48);
	await page.screenshot({ path: test.info().outputPath('camera-street.png') });

	expect(errors).toEqual([]);
});

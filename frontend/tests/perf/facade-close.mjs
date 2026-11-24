// Inspect actual raised facade geometry in the running game; no replacement scene or artwork.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { perfSession } from './session.mjs';
const browser = await chromium.launch({
	executablePath: '/usr/bin/google-chrome',
	args: [
		'--no-sandbox',
		'--use-angle=vulkan',
		'--enable-features=Vulkan',
		'--ignore-gpu-blocklist'
	]
});
try {
	const context = await browser.newContext({
		baseURL: 'http://localhost:3000',
		viewport: { width: 1280, height: 720 }
	});
	const bot = await perfSession(context, `frame_${Date.now().toString(36)}`);
	await bot.moveTo('wat-phnom');
	const page = await context.newPage(),
		errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto('/world');
	await page
		.locator('[data-testid="world-canvas"][data-ready="true"]')
		.waitFor({ timeout: 120000 });
	await expect(page.getByTestId('hud-net')).toHaveAttribute(
		'data-status',
		'open',
		{ timeout: 30000 }
	);
	await page.evaluate(() => {
		globalThis.__ppwNet.city.setQuality('high');
		globalThis.__ppwNet.city.setTimeMode('morning');
	});
	await page.waitForTimeout(2000);
	const view = await page.evaluate(() => {
		const p = globalThis.__ppwPerf,
			city = globalThis.__ppwNet.city,
			at = city.localState(),
			choices = [];
		p.scene.traverse((o) => {
			if (o.name !== 'facade-relief' || !o.parent.visible) return;
			const pos = o.geometry.attributes.position,
				n = o.geometry.attributes.normal;
			for (let i = 0; i < pos.count; i += 180) {
				let x = 0,
					y = 0,
					z = 0;
				for (let k = i; k < i + 36; k++) {
					x += pos.getX(k) / 36;
					y += pos.getY(k) / 36;
					z += pos.getZ(k) / 36;
				}
				const nx = n.getX(i),
					nz = n.getZ(i),
					eye = [x + nx * 6 + nz * 2, y - 0.5, z + nz * 6 - nx * 2];
				if (city.collision.containing(eye[0], eye[2])) continue;
				choices.push({
					eye,
					target: [x, y, z],
					distance: Math.hypot(x - at.x, z - at.z)
				});
			}
		});
		choices.sort((a, b) => a.distance - b.distance);
		return choices[0];
	});
	assert.ok(view, 'actual raised geometry must be available');
	await page.evaluate((view) => {
		const p = globalThis.__ppwPerf,
			render = p.renderer.render;
		p.renderer.render = function (s, c) {
			if (s !== p.scene) return render.call(this, s, c);
			const cam = c.clone();
			cam.position.fromArray(view.eye);
			cam.fov = 55;
			cam.updateProjectionMatrix();
			cam.lookAt(...view.target);
			render.call(this, s, cam);
		};
	}, view);
	await page.waitForTimeout(300);
	await page.screenshot({ path: '/tmp/ppg-wat-architecture-close.png' });
	await expect(page.getByTestId('hud-net')).toHaveAttribute(
		'data-status',
		'open'
	);
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ passed: true, view, errors }));
} finally {
	await browser.close();
}

// Real canvas and WebGL regression: atlas masks, recess depth, day/night and both presets.
import assert from 'node:assert/strict';
import { RepeatWrapping } from 'three';
import { writeFile } from 'node:fs/promises';
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
		baseURL: process.argv[2] ?? 'http://localhost:3000',
		viewport: { width: 1280, height: 720 }
	});
	const bot = await perfSession(context, `facade_${Date.now().toString(36)}`);
	await bot.moveTo('central-market');
	const page = await context.newPage(),
		errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error' && /THREE|WebGL|shader/i.test(m.text()))
			errors.push(m.text());
	});
	await page.goto('/world');
	await page
		.locator('[data-testid="world-canvas"][data-ready="true"]')
		.waitFor({ timeout: 180000 });
	const atlas = await page.evaluate(() => {
		const m = globalThis.__ppwPerf.materials;
		const pixel = (texture, x, y) =>
			Array.from(
				texture.image.getContext('2d').getImageData(x * 2, y * 2, 1, 1).data
			);
		const count = m.doorCount.value;
		// A temporary doorway owner must coexist with the existing shops and be removable.
		m.setDoorSet('material-smoke', [
			{ x: 123, z: 456, ux: 1, uz: 0, y: 0, halfWidth: 0.5 }
		]);
		const added = m.doorCount.value;
		m.setDoorSet('material-smoke', []);
		return {
			width: m.facadeMap.image.width,
			height: m.facadeMap.image.height,
			wall: pixel(m.facadeMap, 4, 4),
			pane: pixel(m.facadeMap, 35, 35),
			wallMask: pixel(m.glassMask, 4, 4),
			paneMask: pixel(m.glassMask, 35, 35),
			wallHeight: pixel(m.facadeHeight, 4, 4),
			paneHeight: pixel(m.facadeHeight, 35, 35),
			grain: {
				width: m.streetGrain.image.width,
				height: m.streetGrain.image.height,
				wrap: [m.streetGrain.wrapS, m.streetGrain.wrapT]
			},
			doors: { before: count, added, after: m.doorCount.value },
			image: m.facadeMap.image.toDataURL()
		};
	});
	await writeFile(
		'/tmp/ppg-facade-atlas.png',
		Buffer.from(atlas.image.split(',')[1], 'base64')
	);
	delete atlas.image;
	assert.equal(atlas.width, 1536);
	assert.equal(atlas.height, 256);
	assert.equal(atlas.grain.width, 256);
	assert.equal(atlas.grain.height, 256);
	assert.deepEqual(atlas.grain.wrap, [RepeatWrapping, RepeatWrapping]);
	assert.equal(atlas.wallMask[0], 0);
	assert.equal(atlas.paneMask[0], 255);
	assert.ok(atlas.paneHeight[0] < atlas.wallHeight[0]);
	assert.ok(atlas.pane[0] < atlas.wall[0]);
	assert.equal(atlas.doors.after, atlas.doors.before);
	assert.equal(atlas.doors.added, atlas.doors.before + 1);
	// Fixed, closer street camera for visual review; does not change player coordinates.
	await page.evaluate(() => {
		const p = globalThis.__ppwPerf,
			original = p.renderer.render;
		p.renderer.render = function (scene, camera) {
			if (scene !== p.scene) return original.call(this, scene, camera);
			const me = globalThis.__ppwNet.city.localState(),
				close = camera.clone();
			const ground = p.avatar().ground;
			if (![me.x, me.z, ground].every(Number.isFinite))
				throw Error('Invalid review camera position');
			close.position.set(me.x + 5, ground + 2.5, me.z - 5);
			close.fov = 62;
			close.updateProjectionMatrix();
			close.lookAt(me.x, ground + 2, me.z + 14);
			original.call(this, scene, close);
		};
	});
	const cases = [];
	for (const [preset, time] of [
		['Performance', 'Midday'],
		['Quality', 'Midday'],
		['Quality', 'Night'],
		['Performance', 'Night']
	]) {
		await page.getByLabel('Settings', { exact: true }).click();
		await page.getByRole('button', { name: preset, exact: true }).click();
		await page.getByRole('radio', { name: time, exact: true }).click();
		await page.getByLabel('Close', { exact: true }).click();
		await page.waitForTimeout(1800);
		const state = await page.evaluate(() => {
			const p = globalThis.__ppwPerf;
			return {
				night: p.materials.night.value,
				detail: p.materials.detail.value,
				shadows: p.renderer.shadowMap.enabled,
				calls: p.renderer.info.render.calls,
				triangles: p.renderer.info.render.triangles,
				doors: p.materials.doorCount.value
			};
		});
		assert.equal(state.detail, preset === 'Quality' ? 1 : 0);
		assert.equal(state.night > 0.5, time === 'Night');
		assert.ok(state.calls > 0);
		cases.push({ preset, time, ...state });
		await page.screenshot({
			path: `/tmp/ppg-street-${preset.toLowerCase()}-${time.toLowerCase()}.png`
		});
	}
	await expect(page.getByTestId('hud-net')).toHaveAttribute(
		'data-status',
		'open'
	);
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ passed: true, atlas, cases, errors }, null, 2));
} finally {
	await browser.close();
}

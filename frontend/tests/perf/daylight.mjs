// Repeatable real-game comparison at the rounded HUD coordinates supplied by the player.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { perfSession } from './session.mjs';
const label = process.argv[2] ?? 'before';
const baseURL = process.argv[3] ?? 'http://localhost:3000';
const browser = await chromium.launch({
	executablePath: '/usr/bin/google-chrome',
	args: [
		'--no-sandbox',
		'--use-angle=vulkan',
		'--enable-features=Vulkan',
		'--ignore-gpu-blocklist'
	]
});
const deadline = setTimeout(() => {
	console.error('Graphics run exceeded 240 seconds');
	void browser.close();
}, 240000);
let progress;
try {
	const context = await browser.newContext({
		baseURL,
		viewport: { width: 1672, height: 941 }
	});
	const bot = await perfSession(
		context,
		label === 'before'
			? 'daylight_compare'
			: `daylight_final_${Date.now().toString(36)}`
	);
	await bot.moveTo('central-market');
	const csrf = (await context.cookies()).find(
		(c) => c.name === 'ppw_csrf'
	).value;
	await context.request.put('/api/v1/me/avatar', {
		headers: { 'X-CSRF-Token': csrf },
		data: {
			avatar_name: 'Graphics test',
			body: 'a',
			skin_tone: '#c8946b',
			hair_style: 'short',
			hair_color: '#666666',
			top_style: 'tee',
			top_color: '#e8e6df',
			bottom_style: 'trousers',
			bottom_color: '#deddd7',
			shoe_color: '#eee5d5',
			accent_color: '#3a8bc0',
			accessories: []
		}
	});
	const page = await context.newPage(),
		errors = [];
	const cdp = await context.newCDPSession(page);
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error' && /THREE|Shader|WebGL/.test(m.text()))
			errors.push(m.text());
	});
	// Freeze only the solar Date clock. Keep native rAF, timers and performance.now for
	// authoritative movement, WebSocket cadence and genuine frame-time measurements.
	await page.addInitScript((fixed) => {
		const Original = Date;
		globalThis.Date = new Proxy(Original, {
			construct(target, args, newTarget) {
				return Reflect.construct(
					target,
					args.length ? args : [fixed],
					newTarget
				);
			},
			apply() {
				return new Original(fixed).toString();
			},
			get(target, key) {
				return key === 'now' ? () => fixed : Reflect.get(target, key);
			}
		});
	}, new Date('2026-11-24T09:42:00Z').getTime());
	await page.goto('/world');
	await page
		.locator('[data-testid="world-canvas"][data-ready="true"]')
		.waitFor({ timeout: 180000 });
	await expect(page.getByTestId('hud-net')).toHaveAttribute(
		'data-status',
		'open',
		{ timeout: 30000 }
	);
	progress = setInterval(async () => {
		try {
			console.error(
				JSON.stringify(
					await page.evaluate(() => ({
						...globalThis.__ppwNet.city.localState(),
						quality: globalThis.__ppwNet.city.quality,
						status: globalThis.__ppwNet.status,
						corrections: globalThis.__ppwNet.corrections,
						reason: globalThis.__ppwNet.lastCorrection
					}))
				)
			);
		} catch {}
	}, 10000);
	await page.evaluate(() => globalThis.__ppwNet.city.setQuality('high'));
	const startPosition = await page.evaluate(() =>
		globalThis.__ppwNet.city.localState()
	);
	const routeResponse = await context.request.get(
		`/api/v1/routes?from_x=${startPosition.x}&from_z=${startPosition.z}&to_x=-16&to_z=-271&mode=foot`
	);
	assert.ok(routeResponse.ok(), await routeResponse.text());
	const route = await routeResponse.json();
	await page.evaluate(
		(points) =>
			new Promise((resolve) =>
				globalThis.__ppwNet.city.walkTo(points, resolve)
			),
		route.points
	);
	const near = await page.evaluate(() => globalThis.__ppwNet.city.localState());
	if (Math.hypot(near.x + 16, near.z + 271) > 0.1)
		await page.evaluate(
			() =>
				new Promise((resolve) =>
					globalThis.__ppwNet.city.walkTo([[-16, -271]], resolve)
				)
		);
	await page.keyboard.up('Shift');
	await page.evaluate(() => {
		globalThis.__ppwNet.city.setPosition(-16, -271, 0);
	});
	await page.waitForTimeout(1000);
	const target = await page.evaluate(() =>
		globalThis.__ppwNet.city.localState()
	);
	assert.ok(
		Math.hypot(target.x + 16, target.z + 271) < 0.1,
		`target was corrected: ${JSON.stringify(target)}`
	);
	await page.evaluate(() => {
		const p = globalThis.__ppwPerf,
			original = p.renderer.render;
		p.renderer.render = function (scene, camera) {
			if (scene !== p.scene) return original.call(this, scene, camera);
			const c = camera.clone();
			c.position.set(-7, 2.7, -282);
			c.fov = 60;
			c.updateProjectionMatrix();
			c.lookAt(-16, 1.6, -253);
			original.call(this, scene, c);
		};
	});
	const cases = [];
	for (const preset of label === 'before'
		? ['Performance', 'Quality']
		: ['Performance', 'Balanced', 'Quality']) {
		await page.getByLabel('Settings', { exact: true }).click();
		await page.getByRole('button', { name: preset, exact: true }).click();
		await page.getByLabel('Close', { exact: true }).click();
		await page.waitForTimeout(2500);
		await page.screenshot({
			path: `/tmp/ppg-daylight-${label}-${preset.toLowerCase()}.png`
		});
		const sample = await page.evaluate(
			() =>
				new Promise((resolve) => {
					const samples = [];
					let last = performance.now(),
						end = last + 8000;
					function tick(t) {
						samples.push(t - last);
						last = t;
						if (t < end) requestAnimationFrame(tick);
						else resolve(samples);
					}
					requestAnimationFrame(tick);
				})
		);
		const state = await page.evaluate(() => {
			const p = globalThis.__ppwPerf,
				gl = p.renderer.getContext(),
				ext = gl.getExtension('WEBGL_debug_renderer_info');
			let eligible = 0,
				casting = 0;
			p.scene.traverse((o) => {
				if (o.userData.shadowCaster) {
					eligible++;
					casting += o.castShadow ? 1 : 0;
				}
			});
			return {
				casters: { eligible, casting },
				effectiveQuality: globalThis.__ppwNet.city.quality,
				position: globalThis.__ppwNet.city.localState(),
				night: p.materials.night.value,
				shadows: p.renderer.shadowMap.enabled,
				shadowSize: p.scene.children
					.find((o) => o.isDirectionalLight)
					?.shadow.mapSize.toArray(),
				pixelRatio: p.renderer.getPixelRatio(),
				chunks: p.chunks().loadedCount,
				calls: p.calls,
				triangles: p.triangles,
				geometries: p.renderer.info.memory.geometries,
				textures: p.renderer.info.memory.textures,
				heapBytes: performance.memory?.usedJSHeapSize ?? null,
				renderer: ext
					? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
					: 'unknown',
				avatar: p.avatar(),
				clouds: p.daylight?.() ?? null
			};
		});
		if (label !== 'before') {
			assert.equal(
				state.casters.casting,
				state.shadows ? state.casters.eligible : 0
			);
			assert.ok(state.casters.eligible > 0);
			assert.ok(state.clouds && state.clouds.day > 0.9);
		}
		state.heapBytes = (await cdp.send('Runtime.getHeapUsage')).usedSize;
		sample.sort((a, b) => a - b);
		cases.push({
			preset,
			fps: 1000 / (sample.reduce((a, b) => a + b, 0) / sample.length),
			p95Ms: sample[Math.floor(sample.length * 0.95)],
			...state
		});
	}
	let night = null;
	if (label !== 'before') {
		await page.evaluate(() => {
			globalThis.__ppwNet.city.setQuality('medium');
			globalThis.__ppwNet.city.setTimeMode('night');
		});
		await page.waitForTimeout(1800);
		night = await page.evaluate(() => ({
			clouds: globalThis.__ppwPerf.daylight(),
			avatar: globalThis.__ppwPerf.avatar(),
			night: globalThis.__ppwPerf.materials.night.value
		}));
		assert.equal(night.clouds.day, 0);
		assert.equal(night.night, 1);
		await page.screenshot({ path: '/tmp/ppg-daylight-after-night.png' });
	}
	await page.mouse.click(800, 600);
	const start = await page.evaluate(() =>
		globalThis.__ppwNet.city.localState()
	);
	await page.keyboard.down('w');
	await page.keyboard.down('Shift');
	await page.waitForTimeout(1500);
	await page.keyboard.up('w');
	await page.keyboard.up('Shift');
	const end = await page.evaluate(() => globalThis.__ppwNet.city.localState());
	assert.ok(
		Math.hypot(end.x - start.x, end.z - start.z) > 1,
		'player must move through the test area'
	);
	assert.deepEqual(errors, []);
	const result = {
		label,
		viewport: { width: 1672, height: 941 },
		clock: '2026-11-24 16:42 UTC+7',
		camera: { position: [-7, 2.7, -282], target: [-16, 1.6, -253], fov: 60 },
		target,
		movement: { start, end },
		cases,
		night,
		errors
	};
	await writeFile(
		`/tmp/ppg-daylight-${label}.json`,
		JSON.stringify(result, null, 2)
	);
	console.log(JSON.stringify(result, null, 2));
} finally {
	clearTimeout(deadline);
	clearInterval(progress);
	await browser.close();
}

// Real Wat Phnom comparison with native clocks, a fixed solar Date and reproducible cameras.
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { perfSession } from './session.mjs';
import { findPath } from '../../src/lib/game/buildings/nav.ts';
const stage = process.argv[2] ?? 'baseline';
const browser = await chromium.launch({
	executablePath: '/usr/bin/google-chrome',
	args: [
		'--no-sandbox',
		'--use-angle=vulkan',
		'--enable-features=Vulkan',
		'--ignore-gpu-blocklist'
	]
});
const deadline = setTimeout(() => void browser.close(), 180000);
try {
	const context = await browser.newContext({
		baseURL: 'http://localhost:3000',
		viewport: { width: 1280, height: 720 }
	});
	const bot = await perfSession(context, `wat_${Date.now().toString(36)}`);
	await bot.moveTo('wat-phnom');
	const page = await context.newPage(),
		errors = [];
	const cdp = await context.newCDPSession(page);
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error' && /THREE|Shader|WebGL/.test(m.text()))
			errors.push(m.text());
	});
	await page.addInitScript((fixed) => {
		const Real = Date;
		globalThis.Date = new Proxy(Real, {
			construct(t, a, n) {
				return Reflect.construct(t, a.length ? a : [fixed], n);
			},
			apply() {
				return new Real(fixed).toString();
			},
			get(t, k) {
				return k === 'now' ? () => fixed : Reflect.get(t, k);
			}
		});
	}, new Date('2026-11-24T00:30:00Z').getTime());
	await page.goto('/world');
	await page
		.locator('[data-testid="world-canvas"][data-ready="true"]')
		.waitFor({ timeout: 120000 });
	await expect(page.getByTestId('hud-net')).toHaveAttribute(
		'data-status',
		'open',
		{ timeout: 30000 }
	);
	{
		const from = await page.evaluate(() =>
			globalThis.__ppwNet.city.localState()
		);
		const obstacles = await page.evaluate(() =>
			[...globalThis.__ppwNet.city.collision.chunks.values()].flatMap((c) =>
				c.polys.filter((p) => !p.overhead).map((p) => p.ring)
			)
		);
		const points = findPath(
			{
				bounds: [
					Math.min(from.x, 207) - 25,
					Math.max(from.x, 207) + 25,
					Math.min(from.z, -628) - 25,
					Math.max(from.z, -628) + 25
				],
				obstacles,
				radius: 0.55
			},
			[from.x, from.z],
			[207, -628]
		);
		assert.ok(points, 'collision-aware route to southern frontage');
		console.error('Walking frontage route', points.length, 'waypoints');
		const arrived = await page.evaluate(
			(points) =>
				new Promise((r) => globalThis.__ppwNet.city.walkTo(points, r)),
			points
		);
		const near = await page.evaluate(() =>
			globalThis.__ppwNet.city.localState()
		);
		assert.ok(
			arrived && Math.hypot(near.x - 207, near.z + 628) < 1,
			`frontage approach failed ${JSON.stringify(near)}`
		);
		await page.evaluate(() =>
			globalThis.__ppwNet.city.setPosition(207, -628, Math.PI)
		);
	}
	let setup;
	if (stage !== 'baseline')
		setup = JSON.parse(
			await readFile('/tmp/ppg-wat-baseline.json', 'utf8')
		).setup;
	else
		setup = await page.evaluate(() => {
			const city = globalThis.__ppwNet.city,
				s = city.localState(),
				h =
					city.terrain.mounds.find((m) => m.slug === 'wat-phnom') ??
					city.terrain.mounds[0];
			const y = city.terrain.height(s.x, s.z);
			return {
				position: { x: s.x, z: s.z, yaw: s.yaw },
				hill: { x: h.x, z: h.z, height: h.height_m },
				eye: [s.x + 5, y + 2.7, s.z + 16],
				target: [h.x, y + 10, h.z],
				fov: 58
			};
		});
	await page.evaluate(
		(s) => globalThis.__ppwNet.city.setPosition(s.x, s.z, s.yaw),
		setup.position
	);
	await page.evaluate((config) => {
		const p = globalThis.__ppwPerf,
			render = p.renderer.render;
		globalThis.__watCamera = config;
		p.renderer.render = function (s, c) {
			if (s !== p.scene) return render.call(this, s, c);
			const cam = c.clone(),
				view = globalThis.__watCamera;
			cam.position.fromArray(view.eye);
			cam.fov = view.fov ?? 55;
			cam.updateProjectionMatrix();
			cam.lookAt(...view.target);
			render.call(this, s, cam);
		};
	}, setup);
	const cases = [];
	for (const [mode, preset] of stage === 'night'
		? [['medium', 'Balanced']]
		: [
				['low', 'Performance'],
				['medium', 'Balanced'],
				['high', 'Quality']
			]) {
		await page.getByLabel('Settings', { exact: true }).click();
		await page.getByRole('button', { name: preset, exact: true }).click();
		await page.getByLabel('Close', { exact: true }).click();
		await page.waitForTimeout(2000);
		await page.screenshot({ path: `/tmp/ppg-wat-${stage}-${mode}.png` });
		const times = await page.evaluate(
			() =>
				new Promise((resolve) => {
					const a = [];
					let last = performance.now(),
						end = last + 6000;
					const tick = (t) => {
						a.push(t - last);
						last = t;
						t < end ? requestAnimationFrame(tick) : resolve(a);
					};
					requestAnimationFrame(tick);
				})
		);
		times.sort((a, b) => a - b);
		const state = await page.evaluate(() => {
			const p = globalThis.__ppwPerf,
				city = globalThis.__ppwNet.city,
				gl = p.renderer.getContext(),
				ext = gl.getExtension('WEBGL_debug_renderer_info');
			let facadeTriangles = 0,
				facadeBatches = 0;
			p.scene.traverse((o) => {
				if (o.name === 'facade-relief') {
					facadeBatches++;
					facadeTriangles +=
						(o.geometry.index?.count ?? o.geometry.attributes.position.count) /
						3;
				}
			});
			return {
				effective: city.quality,
				position: city.localState(),
				calls: p.calls,
				triangles: p.triangles,
				chunks: p.chunks().loadedCount,
				textures: p.renderer.info.memory.textures,
				geometries: p.renderer.info.memory.geometries,
				avatar: p.avatar(),
				facadeTriangles,
				facadeBatches,
				renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'
			};
		});
		assert.ok(
			Math.hypot(
				state.position.x - setup.position.x,
				state.position.z - setup.position.z
			) < 0.1
		);
		cases.push({
			mode,
			fps: 1000 / (times.reduce((a, b) => a + b, 0) / times.length),
			p95Ms: times[Math.floor(times.length * 0.95)],
			heap: (await cdp.send('Runtime.getHeapUsage')).usedSize,
			...state
		});
	}
	let night = null;
	if (stage === 'architecture' || stage === 'night') {
		const view = await page.evaluate(() => {
			const p = globalThis.__ppwPerf,
				city = globalThis.__ppwNet.city,
				at = city.localState(),
				choices = [];
			p.scene.traverse((o) => {
				if (o.name !== 'facade-relief' || !o.parent.visible) return;
				const pos = o.geometry.attributes.position,
					norm = o.geometry.attributes.normal;
				for (let i = 0; i < pos.count; i += 180) {
					let x = 0,
						y = 0,
						z = 0;
					for (let k = i; k < i + 36; k++) {
						x += pos.getX(k) / 36;
						y += pos.getY(k) / 36;
						z += pos.getZ(k) / 36;
					}
					const nx = norm.getX(i),
						nz = norm.getZ(i),
						eye = [x + nx * 7 + nz * 2, y - 0.7, z + nz * 7 - nx * 2];
					if (city.collision.containing(eye[0], eye[2])) continue;
					choices.push({
						eye,
						target: [x, y, z],
						d: Math.hypot(x - at.x, z - at.z)
					});
				}
			});
			choices.sort((a, b) => a.d - b.d);
			return choices[0];
		});
		assert.ok(view, 'a near, actual raised façade to inspect');
		// Update the same renderer review camera; the geographic scene and player stay intact.
		await page.evaluate((view) => (globalThis.__watCamera = view), view);
		await page.waitForTimeout(400);
		await page.screenshot({ path: '/tmp/ppg-wat-architecture-close.png' });
		await page.evaluate((setup) => (globalThis.__watCamera = setup), setup);
		await page.evaluate(() => {
			globalThis.__ppwNet.city.setQuality('medium');
			globalThis.__ppwNet.city.setTimeMode('night');
		});
		await page.waitForTimeout(stage === 'night' ? 6000 : 1500);
		if (stage === 'night') {
			const samples = await page.evaluate(
				() =>
					new Promise((r) => {
						const a = [];
						let last = performance.now(),
							end = last + 6000;
						function tick(t) {
							a.push(t - last);
							last = t;
							t < end ? requestAnimationFrame(tick) : r(a);
						}
						requestAnimationFrame(tick);
					})
			);
			samples.sort((a, b) => a - b);
			const lights = await page.evaluate(() => {
				let n = 0;
				globalThis.__ppwPerf.scene.traverse((o) => {
					if (o.isPointLight && o.visible) n++;
				});
				return n;
			});
			assert.ok(lights <= 2, 'Medium local light budget');
			night = {
				fps: 1000 / (samples.reduce((a, b) => a + b, 0) / samples.length),
				p95Ms: samples[Math.floor(samples.length * 0.95)],
				activePointLights: lights
			};
		}
		await page.screenshot({ path: '/tmp/ppg-wat-architecture-night.png' });
	}
	await page.mouse.click(640, 400);
	const start = await page.evaluate(() =>
		globalThis.__ppwNet.city.localState()
	);
	await page.keyboard.down('w');
	await page.waitForTimeout(1800);
	await page.keyboard.up('w');
	const end = await page.evaluate(() => globalThis.__ppwNet.city.localState());
	assert.ok(
		Math.hypot(start.x - end.x, start.z - end.z) > 0.3,
		'walkable ground'
	);
	await expect(page.getByTestId('hud-net')).toHaveAttribute(
		'data-status',
		'open'
	);
	assert.deepEqual(errors, []);
	const result = {
		stage,
		viewport: [1280, 720],
		date: '2026-11-24 07:30 UTC+7',
		setup,
		cases,
		night,
		movement: { start, end },
		errors
	};
	await writeFile(
		`/tmp/ppg-wat-${stage}.json`,
		JSON.stringify(result, null, 2)
	);
	console.log(JSON.stringify(result, null, 2));
} finally {
	clearTimeout(deadline);
	await browser.close();
}

// Actual-game NPC check. Disconnect only this QA client's movement sync for camera setup.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { perfSession } from './session.mjs';
const browser = await chromium.launch({
	executablePath: '/usr/bin/google-chrome',
	args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist']
});
const timeout = setTimeout(() => void browser.close(), 240000);
try {
	const context = await browser.newContext({
		baseURL: 'http://localhost:3000',
		viewport: { width: 1280, height: 720 }
	});
	const bot = await perfSession(context, 'npc_life_qa');
	await bot.moveTo('riverside');
	const page = await context.newPage(),
		errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (/Realistic avatar unavailable|THREE.WebGLProgram/.test(m.text())) errors.push(m.text());
	});
	await page.goto('/world');
	await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({ timeout: 120000 });
	await page.locator('[data-testid="hud-net"][data-status="open"]').waitFor();
	await page.evaluate(async () => {
		globalThis.__ppwNet.stop();
		const c = globalThis.__ppwNet.city;
		c.setQuality('medium');
		c.setTimeMode('noon');
		await c.teleport(763, -60, 270);
		c.setShowcase({ distance: 7.5, pitch: 0.25 });
	});
	await page.waitForFunction(() => !!globalThis.__ppwTraffic);
	await page.evaluate(() => {
		__ppwTraffic.remove();
		__ppwTraffic.nextKind = 'motorbike';
		__ppwTraffic.clock = 0;
	});
	await page.waitForFunction(
		() => globalThis.__ppwStreetLife?.diagnostics().actors > 0 && globalThis.__ppwTraffic?.diagnostics().active,
		null,
		{ timeout: 45000 }
	);
	console.log(
		'NPCs loaded',
		await page.evaluate(() => ({
			life: __ppwStreetLife.diagnostics(),
			traffic: __ppwTraffic.diagnostics()
		}))
	);
	await page.screenshot({ path: '/tmp/ppg-npc-life.png' });
	const initial = await page.evaluate(() => ({
		life: __ppwStreetLife.diagnostics(),
		traffic: __ppwTraffic.diagnostics(),
		player: __ppwPerf.avatar()
	}));
	assert.ok(
		initial.life.routes.every((r) => r.model?.includes(':npc-')),
		'NPC-only faces loaded'
	);
	// Approach a real pavement actor, then trigger the regular player jump input.
	await page.evaluate(async () => {
		const a = __ppwStreetLife.diagnostics().routes.find((a) => !a.bag);
		if (!a) throw Error('No actor without a bag');
		__ppwNet.city.setShowcase(null);
		await __ppwNet.city.teleport(a.x + 1, a.z, 0);
	});
	await page.waitForTimeout(250);
	await page.keyboard.press('Space');
	await page.waitForFunction(() => __ppwStreetLife.diagnostics().hops > 0, null, { timeout: 5000 });
	const jumping = await page.evaluate(() => __ppwStreetLife.diagnostics());
	await page.keyboard.press('g'); // Greeting during the hop must not cancel landing physics.
	await page.screenshot({ path: '/tmp/ppg-npc-jump.png' });
	await page.waitForFunction(() => __ppwStreetLife.diagnostics().routes.every((a) => a.lift === 0));
	// Close camera follows the real actor; animation, skinning and lighting keep running.
	await page.evaluate(() => {
		const actor = [...__ppwStreetLife.actors.values()][0],
			r = __ppwPerf.renderer;
		globalThis.__npcOriginalRender = r.render;
		r.render = function (s, c) {
			const p = actor.group.position,
				yaw = actor.group.rotation.y;
			c.position.set(p.x + Math.sin(yaw) * 1.1, p.y + 1.65, p.z + Math.cos(yaw) * 1.1);
			c.lookAt(p.x, p.y + 1.53, p.z);
			return __npcOriginalRender.call(this, s, c);
		};
	});
	await page.waitForTimeout(500);
	await page.screenshot({ path: '/tmp/ppg-npc-face.png' });
	await page.evaluate(() => {
		__ppwPerf.renderer.render = __npcOriginalRender;
	});
	await page.waitForTimeout(6000);
	const motorbike = await page.evaluate(() => __ppwTraffic.diagnostics());
	assert.equal(motorbike.kind, 'motorbike');
	assert.ok(motorbike.distance > 1, 'motorbike actually moved');
	// Exercise the other supported vehicle deterministically; road planning and riding run normally.
	await page.evaluate(() => {
		__ppwTraffic.remove();
		__ppwTraffic.nextKind = 'bicycle';
		__ppwTraffic.clock = 0;
	});
	await page.waitForFunction(() => __ppwTraffic.diagnostics().kind === 'bicycle', null, { timeout: 30000 });
	const bikeStart = await page.evaluate(() => __ppwTraffic.diagnostics().distance);
	await page.waitForFunction((start) => __ppwTraffic.diagnostics().distance > start + 1, bikeStart, { timeout: 15000 });
	const bicycle = await page.evaluate(() => __ppwTraffic.diagnostics());
	await page.evaluate(() => {
		__ppwPerf.renderer.render = function (s, c) {
			const p = __ppwTraffic.diagnostics().position;
			if (p) {
				c.position.set(p.x + 4, 2.2, p.z + 4);
				c.lookAt(p.x, 1, p.z);
			}
			return __npcOriginalRender.call(this, s, c);
		};
	});
	await page.waitForTimeout(500);
	await page.screenshot({ path: '/tmp/ppg-npc-bicycle.png' });
	await page.evaluate(() => {
		__ppwPerf.renderer.render = __npcOriginalRender;
	});
	const shopping = await page.evaluate(() => __ppwStreetLife.diagnostics());
	const perf = await page.evaluate(
		() =>
			new Promise((resolve) => {
				const frames = [],
					start = performance.now();
				let prev = start;
				const tick = (t) => {
					frames.push(t - prev);
					prev = t;
					if (t - start < 5000) return requestAnimationFrame(tick);
					frames.sort((a, b) => a - b);
					const r = __ppwPerf.renderer;
					resolve({
						fps: frames.length / ((t - start) / 1000),
						p95ms: frames[Math.floor(frames.length * 0.95)],
						calls: r.info.render.calls,
						triangles: r.info.render.triangles,
						heapMB: performance.memory?.usedJSHeapSize / 1048576,
						textures: r.info.memory.textures,
						geometries: r.info.memory.geometries
					});
				};
				requestAnimationFrame(tick);
			})
	);
	await page.evaluate(() => __ppwNet.city.setQuality('low'));
	await page.waitForTimeout(500);
	const low = await page.evaluate(() => ({
		life: __ppwStreetLife.diagnostics(),
		traffic: __ppwTraffic.diagnostics()
	}));
	assert.ok(low.life.actors <= 1);
	assert.equal(low.traffic.active, false);
	assert.deepEqual(errors, []);
	const report = {
		passed: true,
		qaMovementDisconnected: true,
		initial,
		jumping,
		motorbike,
		bicycle,
		shopping,
		perf,
		low,
		errors
	};
	await writeFile('docs/perf/npc-life.json', JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 2));
} finally {
	clearTimeout(timeout);
	await browser.close();
}

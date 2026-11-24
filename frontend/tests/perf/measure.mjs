/**
 * Frame-rate measurement on real GPU hardware (not part of the automated suite).
 *
 *   node tests/perf/measure.mjs [baseURL] [--software] [--uncapped] [--label name]
 *
 * Creates a throw-away account through the API, finishes onboarding, then for each spawn
 * area and quality mode: waits for the initial chunks, records frame times for 8 s standing and
 * 8 s running (Shift+W) and prints JSON (mean fps, 5th-percentile fps, worst frame).
 * `--gpu` uses ANGLE/Vulkan so headless Chrome renders on the machine's GPU.
 */
import { chromium } from '@playwright/test';
import { perfSession } from './session.mjs';

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:5173';
const gpu = !args.includes('--software');
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : 'run';
const width = args.includes('--width') ? Number(args[args.indexOf('--width') + 1]) : 1280;
const height = args.includes('--height') ? Number(args[args.indexOf('--height') + 1]) : 720;
if (![width, height].every(v => Number.isInteger(v) && v >= 320 && v <= 3840)) throw new Error('Invalid viewport');
const viewport = { width, height };
const selectedQuality = args.includes('--quality') ? args[args.indexOf('--quality') + 1] : null;
if (selectedQuality && !['high','low'].includes(selectedQuality)) throw new Error('Invalid quality');
const selectedSpawn = args.includes('--spawn') ? args[args.indexOf('--spawn') + 1] : null;
const timeMode = args.includes('--time') ? args[args.indexOf('--time') + 1] : null;
const timeLabels = { morning: 'Morning', noon: 'Midday', sunset: 'Sunset', night: 'Night', live: 'Live' };
if (timeMode && !timeLabels[timeMode]) throw new Error(`Unknown time mode: ${timeMode}`);
// --uncapped disables vsync and the frame-rate limiter so the numbers show real headroom.
const uncapped = args.includes('--uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
const flags = (gpu
	? ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist']
	: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
).concat(uncapped);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: flags });
const context = await browser.newContext({ baseURL: base, viewport });
// Fresh accounts avoid /world/bootstrap resuming a previous position in the same
// region instead of the spawn under test. Keep reuse available for quick profiling.
const fresh = args.includes('--fresh');
const bot = fresh ? null : await perfSession(context);

async function sample(page, ms) {
	return page.evaluate((ms) => new Promise((resolve) => {
		const times = [];
		let last = performance.now();
		const end = last + ms;
		const tick = (t) => {
			times.push(t - last);
			last = t;
			if (t < end) requestAnimationFrame(tick);
			else resolve(times);
		};
		requestAnimationFrame(tick);
	}), ms);
}

const stats = (times) => {
	const sorted = [...times].sort((a, b) => a - b);
	const mean = times.reduce((a, b) => a + b, 0) / times.length;
	return {
		fps: +(1000 / mean).toFixed(1),
		mean_ms: +mean.toFixed(2),
		p95_ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
		p5_fps: +(1000 / sorted[Math.floor(sorted.length * 0.95)]).toFixed(1),
		worst_ms: +sorted[sorted.length - 1].toFixed(1)
	};
};

const results = [];
const renderErrors = [];
for (const slug of selectedSpawn ? [selectedSpawn] : ['central-market', 'wat-phnom', 'riverside']) {
	if (bot) await bot.moveTo(slug);
	for (const quality of selectedQuality ? [selectedQuality] : ['high', 'low']) {
		const caseContext = fresh
			? await browser.newContext({ baseURL: base, viewport })
			: context;
		if (fresh) {
			const freshBot = await perfSession(caseContext, `perf_${Date.now().toString(36)}_${quality}`);
			await freshBot.moveTo(slug);
		}
		const bootstrap = await (await caseContext.request.get('/api/v1/world/bootstrap')).json();
		const page = await caseContext.newPage();
		page.on('pageerror', error => renderErrors.push(`${slug}/${quality}: ${error.message}`));
		page.on('console', message => {
			if (message.type() === 'error' && /THREE|Shader Error|WebGLProgram/.test(message.text()))
				renderErrors.push(`${slug}/${quality}: ${message.text()}`);
		});
		const renderer = await page.evaluate(() => {
			const gl = document.createElement('canvas').getContext('webgl2');
			const ext = gl?.getExtension('WEBGL_debug_renderer_info');
			return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
		});
		const started = Date.now();
		await page.goto('/world');
		await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({ timeout: 180000 });
		const loadMs = Date.now() - started;
		if (quality === 'low' || timeMode) {
			await page.getByLabel('Settings').click();
			if (quality === 'low') await page.getByRole('button', { name: 'Performance' }).click();
			if (timeMode) await page.getByRole('radio', { name: timeLabels[timeMode], exact: true }).click();
			await page.getByLabel('Close').click();
		}
		await page.waitForTimeout(2500);
		if (quality === 'high' && process.env.PERF_SCREENSHOT)
			await page.screenshot({ path: process.env.PERF_SCREENSHOT });
		const idle = stats(await sample(page, 8000));
		await page.locator('[data-testid="world-canvas"] canvas').click({ position: { x: 10, y: 10 } });
		await page.keyboard.down('Shift');
		await page.keyboard.down('w');
		const moving = stats(await sample(page, 8000));
		await page.keyboard.up('w');
		await page.keyboard.up('Shift');
		const hud = await page.getByTestId('hud-perf').textContent();
		const metrics = await page.evaluate(() => {
			const p = globalThis.__ppwPerf;
			const gl = p.renderer;
			return {
				effective_quality: gl.shadowMap.enabled ? 'high' : 'low',
				draw_calls: p.calls, triangles: p.triangles,
				loaded_chunks: p.chunks().loadedCount,
				geometries: gl.info.memory.geometries, textures: gl.info.memory.textures,
				js_heap_bytes: performance.memory?.usedJSHeapSize ?? null
			};
		});
		results.push({ slug, quality, time_mode: timeMode ?? 'live', spawn: bootstrap.spawn, start: bootstrap.start,
			load_ms: loadMs, idle, moving, metrics, hud: hud?.trim(), renderer });
		await page.close();
		if (fresh) await caseContext.close();
	}
}
await browser.close();
console.log(JSON.stringify({ label, gpu, uncapped: uncapped.length > 0, base, viewport: `${width}x${height}`, results, render_errors: renderErrors }, null, 2));
if (renderErrors.length) process.exitCode = 1;

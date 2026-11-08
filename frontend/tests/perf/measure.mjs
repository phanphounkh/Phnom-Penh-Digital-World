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
// --uncapped disables vsync and the frame-rate limiter so the numbers show real headroom.
const uncapped = args.includes('--uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
const flags = (gpu
	? ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist']
	: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
).concat(uncapped);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: flags });
const context = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 720 } });
const bot = await perfSession(context);

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
		p5_fps: +(1000 / sorted[Math.floor(sorted.length * 0.95)]).toFixed(1),
		worst_ms: +sorted[sorted.length - 1].toFixed(1)
	};
};

const results = [];
for (const slug of ['central-market', 'wat-phnom', 'riverside']) {
	await bot.moveTo(slug);
	for (const quality of ['high', 'low']) {
		const page = await context.newPage();
		const renderer = await page.evaluate(() => {
			const gl = document.createElement('canvas').getContext('webgl2');
			const ext = gl?.getExtension('WEBGL_debug_renderer_info');
			return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
		});
		const started = Date.now();
		await page.goto('/world');
		await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({ timeout: 180000 });
		const loadMs = Date.now() - started;
		if (quality === 'low') {
			await page.getByLabel('Settings').click();
			await page.getByRole('button', { name: 'Performance' }).click();
			await page.getByLabel('Close').click();
		}
		await page.waitForTimeout(2500);
		const idle = stats(await sample(page, 8000));
		await page.locator('[data-testid="world-canvas"] canvas').click({ position: { x: 10, y: 10 } });
		await page.keyboard.down('Shift');
		await page.keyboard.down('w');
		const moving = stats(await sample(page, 8000));
		await page.keyboard.up('w');
		await page.keyboard.up('Shift');
		const hud = await page.getByTestId('hud-perf').textContent();
		results.push({ slug, quality, load_ms: loadMs, idle, moving, hud: hud?.trim(), renderer });
		await page.close();
	}
}
await browser.close();
console.log(JSON.stringify({ label, gpu, uncapped: uncapped.length > 0, base, viewport: '1280x720', results }, null, 2));

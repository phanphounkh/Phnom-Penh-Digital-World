// Frame-cost breakdown at one spawn (GPU, uncapped). node tests/perf/probe.mjs [spawn]
import { chromium } from '@playwright/test';
import { perfSession } from './session.mjs';
const slug = process.argv[2] ?? 'central-market';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'].concat(process.env.UNCAPPED ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []) });
const ctx = await b.newContext({ baseURL: 'http://127.0.0.1:5173', viewport: { width: 1280, height: 720 } });
const bot = await perfSession(ctx);
await bot.moveTo(slug);
const page = await ctx.newPage();
await page.goto('/world');
await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({ timeout: 180000 });
await page.waitForTimeout(4000);
const sample = async (label, moving) => {
	await page.evaluate(() => globalThis.__ppwPerf.reset());
	if (moving) { await page.locator('[data-testid="world-canvas"] canvas').click({ position: { x: 10, y: 10 } }); await page.keyboard.down('Shift'); await page.keyboard.down('w'); }
	await page.waitForTimeout(6000);
	if (moving) { await page.keyboard.up('w'); await page.keyboard.up('Shift'); }
	const r = await page.evaluate(() => { const p = globalThis.__ppwPerf; const c = p.chunks(); return { frames: p.frames, step: +(p.step / p.frames).toFixed(2), render: +(p.render / p.frames).toFixed(2), maxStep: +p.maxStep.toFixed(1), maxRender: +p.maxRender.toFixed(1), calls: p.calls, triangles: p.triangles, assembleMs: +c.assembleMs.toFixed(1), chunks: c.loadedCount, workers: c.workerCount }; });
	console.log(label.padEnd(8), JSON.stringify(r));
};
await sample('idle', false);
await sample('moving', true);
await b.close();

/**
 * Visual tour (not part of the automated suite): screenshots of each spawn at chosen times of
 * day, rendered on the machine's GPU. Used to review landmarks, lighting and props.
 *
 *   node tests/perf/tour.mjs <outDir> [baseURL]
 * Shots are defined below as [spawn, time mode, zoom steps, drag dx, drag dy, walk ms].
 */
import { chromium } from '@playwright/test';
import { perfSession } from './session.mjs';

const out = process.argv[2] ?? 'artifacts';
const base = process.argv[3] ?? 'http://127.0.0.1:5173';
const SHOTS = (process.env.SHOTS ?? 'central-market:noon:4:0:-40:0,wat-phnom:morning:5:120:-30:0,riverside:night:3:0:-10:0,central-market:sunset:6:200:-20:0')
	.split(',')
	.map((s) => s.split(':'));

const browser = await chromium.launch({
	executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
	args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist']
});
const context = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 720 } });
const bot = await perfSession(context);
const errors = [];

for (const [slug, mode, zoom, dx, dy, walk] of SHOTS) {
	await bot.moveTo(slug);
	const page = await context.newPage();
	page.on('pageerror', (e) => errors.push(`${slug}: ${e.message}`));
	page.on('console', (m) => m.type() === 'error' && !m.text().includes('401') && errors.push(`${slug}: ${m.text()}`));
	await page.goto('/world');
	await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({ timeout: 180000 });
	await page.getByLabel('Settings').click();
	await page.getByRole('radio', { name: { morning: 'Morning', noon: 'Midday', sunset: 'Sunset', night: 'Night', live: 'Live' }[mode] }).click();
	await page.getByLabel('Close').click();
	const canvas = page.locator('[data-testid="world-canvas"] canvas');
	const box = await canvas.boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	for (let i = 0; i < +zoom; i++) {
		await page.mouse.wheel(0, 300);
		await page.waitForTimeout(50);
	}
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + +dx, box.y + box.height / 2 + +dy, { steps: 8 });
	await page.mouse.up();
	if (+walk) {
		await page.keyboard.down('w');
		await page.waitForTimeout(+walk);
		await page.keyboard.up('w');
	}
	await page.waitForTimeout(3500);
	await page.screenshot({ path: `${out}/tour-${slug}-${mode}.png` });
	await page.close();
}
await browser.close();
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');

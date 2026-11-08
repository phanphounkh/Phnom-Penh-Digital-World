// Two real browsers in the same world (GPU): checks sync and captures what each player sees.
// node tests/perf/two-players.mjs <outDir>
import { chromium } from '@playwright/test';
import { perfSession } from './session.mjs';
const out = process.argv[2] ?? 'artifacts';
const args = ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args });
const pages = [];
const errors = [];
for (const name of ['perfbot', 'perfbot2']) {
	const context = await browser.newContext({ baseURL: process.env.BASE ?? 'http://127.0.0.1:5173', viewport: { width: 1100, height: 680 } });
	const bot = await perfSession(context, name);
	await bot.moveTo('central-market');
	await context.request.patch('/api/v1/me/profile', { data: { world_visible: true }, headers: { 'X-CSRF-Token': (await context.cookies()).find((c) => c.name === 'ppw_csrf').value } });
	const page = await context.newPage();
	page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
	page.on('console', (m) => m.type() === 'error' && !m.text().includes('401') && errors.push(`${name}: ${m.text()}`));
	await page.goto('/world');
	await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({ timeout: 120000 });
	pages.push(page);
}
const [a, b] = pages;
await a.locator('[data-testid="hud-net"][data-status="open"]').waitFor({ timeout: 20000 });
await b.locator('[data-testid="hud-net"][data-status="open"]').waitFor({ timeout: 20000 });
// Reconnecting players resume where they left off, so bring both to the same place first.
for (const page of pages) await page.evaluate(() => globalThis.__ppwNet.travel('central-market'));
await a.waitForFunction(() => globalThis.__ppwNet?.nearby.some((p) => p.username === 'perfbot2'), null, { timeout: 15000 });
console.log('A sees:', await a.evaluate(() => globalThis.__ppwNet.nearby.map((p) => `${p.username} @ ${p.distance.toFixed(1)} m`)));
// B walks; A should see B move.
const findB = () => a.evaluate(() => globalThis.__ppwNet.nearby.find((p) => p.username === 'perfbot2'));
const before = await findB();
await b.locator('[data-testid="world-canvas"] canvas').click({ position: { x: 10, y: 10 } });
await b.keyboard.down('w');
await b.waitForTimeout(1500);
await b.keyboard.up('w');
await a.waitForTimeout(800);
const after = await findB();
console.log('B moved (as seen by A):', Math.hypot(after.x - before.x, after.z - before.z).toFixed(2), 'm');
// Chat + emote from B, seen by A.
await b.keyboard.press('Enter');
await b.keyboard.type('(test bot) sync check');
await b.keyboard.press('Enter');
await b.keyboard.press('2'); // sampeah
await a.waitForTimeout(600);
console.log('A chat log:', await a.getByTestId('chat-log').innerText());
// A turns the camera to face B and zooms out a bit.
await a.locator('[data-testid="world-canvas"] canvas').click({ position: { x: 10, y: 10 } });
await a.screenshot({ path: `${out}/phase3-a-sees-b.png` });
await b.screenshot({ path: `${out}/phase3-b-view.png` });
await browser.close();
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');

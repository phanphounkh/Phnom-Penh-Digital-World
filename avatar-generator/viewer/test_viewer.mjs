// Browser test of the exported avatars in the Three.js viewer (real GPU through ANGLE/Vulkan,
// falls back to SwiftShader if there is none).
//   node viewer/test_viewer.mjs            → previews/viewer/*.png + previews/viewer/report.json
// Checks: both GLBs load in both qualities without console errors; every clip moves the rig in
// the way its name says (numeric checks on bone positions); every face morph applies; draw calls,
// triangles and frame rate are recorded.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pw = join(root, '..', 'frontend', 'node_modules', '@playwright', 'test', 'index.mjs');
const { chromium } = await import(pw);
const out = join(root, 'previews', 'viewer');
mkdirSync(out, { recursive: true });
const port = 5191 + Math.floor(Math.random() * 300);
const server = spawn(process.execPath, [join(root, 'viewer', 'serve.mjs'), String(port)], { stdio: 'pipe' });
await new Promise((ok) => server.stdout.once('data', ok));

const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const browser = await chromium.launch({
	executablePath: chrome,
	args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('requestfailed', (r) => consoleErrors.push(`request failed: ${r.url()}`));

const report = { renderer: null, qualities: {}, clips: {}, morphs: {}, checks: [], consoleErrors };
const check = (name, ok, detail) => {
	report.checks.push({ name, ok: Boolean(ok), detail });
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`);
};

await page.goto(`http://127.0.0.1:${port}/viewer/`);
await page.waitForFunction(() => window.__viewer, null, { timeout: 30000 });
await page.evaluate(() => window.__viewer.ready);
await page.evaluate(() => window.__viewer.hideUI());
report.renderer = await page.evaluate(() => {
	const gl = document.createElement('canvas').getContext('webgl2');
	const ext = gl?.getExtension('WEBGL_debug_renderer_info');
	return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});

const BONES = ['Hips', 'Head', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'].map((b) => 'mixamorig' + b);
const bones = (model) => page.evaluate(([m, list]) => Object.fromEntries(list.map((b) => [b, window.__viewer.boneWorld(m, b)])), [model, BONES]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function measureFps(ms) {
	return page.evaluate((ms) => new Promise((resolve) => {
		const times = [];
		let last = performance.now();
		const end = last + ms;
		const tick = (t) => { times.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else resolve(times); };
		requestAnimationFrame(tick);
	}).then((times) => {
		times.sort((a, b) => a - b);
		const mean = times.reduce((a, b) => a + b, 0) / times.length;
		return { fps: +(1000 / mean).toFixed(1), p95_frame_ms: +times[Math.floor(times.length * 0.95)].toFixed(1) };
	}), ms);
}

for (const quality of ['high', 'game']) {
	await page.evaluate((q) => window.__viewer.setQuality(q), quality);
	await page.evaluate(() => window.__viewer.play(''));
	await page.evaluate(() => window.__viewer.setView('both'));
	await frame();
	const clips = await page.evaluate(() => window.__viewer.clips());
	const morphs = await page.evaluate(() => window.__viewer.morphs());
	check(`${quality}: 9 animation clips`, ['Idle', 'Walk', 'Run', 'Wave', 'Sit', 'Talk', 'Dance', 'Greet', 'Cheer'].every((c) => clips.includes(c)), clips);
	check(`${quality}: 7 face morphs`, ['Smile', 'Excited', 'Surprised', 'Thinking', 'Wink', 'Blink', 'MouthOpen'].every((c) => morphs.includes(c)), morphs);
	await page.screenshot({ path: join(out, `${quality}_rest.png`) });
	await page.evaluate(() => window.__viewer.play('Walk'));
	const perf = await measureFps(4000);
	const s = await page.evaluate(() => window.__viewer.stats());
	report.qualities[quality] = { ...s, ...perf };
	check(`${quality}: loads both characters`, s.triangles > 1000 && Object.keys(s.bytes).length === 2, s);

	const rest = { male: null, female: null };
	await page.evaluate(() => window.__viewer.play(''));
	await frame();
	for (const m of ['male', 'female']) rest[m] = await bones(m);
	for (const m of ['male', 'female']) check(`${quality}: ${m} stands on the ground (A-pose)`, Math.abs(Math.min(rest[m].mixamorigLeftFoot[1], rest[m].mixamorigRightFoot[1]) - 0.08) < 0.08, rest[m].mixamorigLeftFoot);

	const durations = { Idle: 4, Walk: 0.95, Run: 0.7, Wave: 3, Sit: 4, Talk: 3, Dance: 2, Greet: 3, Cheer: 2.2 };
	for (const [clip, dur] of Object.entries(durations)) {
		const samples = {};
		for (const f of [0.25, 0.5, 0.75]) {
			await page.evaluate(([c, t]) => window.__viewer.pose(c, t), [clip, dur * f]);
			samples[f] = { male: await bones('male'), female: await bones('female') };
		}
		if (quality === 'high') {
			await page.evaluate(([c, t]) => window.__viewer.pose(c, t), [clip, dur * (clip === 'Walk' || clip === 'Run' ? 0.25 : 0.5)]);
			await frame();
			await page.screenshot({ path: join(out, `clip_${clip}.png`) });
		}
		for (const m of ['male', 'female']) {
			const moved = Math.max(...BONES.map((b) => dist(samples[0.5][m][b], rest[m][b])));
			const mid = samples[0.5][m];
			let ok = moved > 0.04, detail = { moved: +moved.toFixed(3) };
			if (clip === 'Walk' || clip === 'Run') {
				const a = samples[0.25][m], c = samples[0.75][m];
				const lead1 = a.mixamorigLeftFoot[2] - a.mixamorigRightFoot[2];
				const lead2 = c.mixamorigLeftFoot[2] - c.mixamorigRightFoot[2];
				ok = ok && Math.sign(lead1) !== Math.sign(lead2) && Math.abs(lead1) > 0.15;
				detail.feet_alternate = [+lead1.toFixed(2), +lead2.toFixed(2)];
			}
			if (clip === 'Sit') {
				const drop = rest[m].mixamorigHips[1] - mid.mixamorigHips[1];
				ok = ok && drop > 0.25 && mid.mixamorigLeftFoot[1] < 0.2;
				detail.hips_drop = +drop.toFixed(2);
			}
			if (clip === 'Wave') {
				ok = ok && mid.mixamorigRightHand[1] > mid.mixamorigHead[1] - 0.15;
				detail.hand_vs_head = +(mid.mixamorigRightHand[1] - mid.mixamorigHead[1]).toFixed(2);
			}
			if (clip === 'Cheer') {
				ok = ok && mid.mixamorigLeftHand[1] > mid.mixamorigHead[1] && mid.mixamorigRightHand[1] > mid.mixamorigHead[1];
				detail.hands_above_head = [+(mid.mixamorigLeftHand[1] - mid.mixamorigHead[1]).toFixed(2), +(mid.mixamorigRightHand[1] - mid.mixamorigHead[1]).toFixed(2)];
			}
			if (clip === 'Greet') {
				const gap = dist(mid.mixamorigLeftHand, mid.mixamorigRightHand);
				ok = ok && gap < 0.12 && mid.mixamorigLeftHand[2] > mid.mixamorigHips[2] + 0.1;
				detail.hand_gap = +gap.toFixed(3);
			}
			report.clips[`${quality}/${m}/${clip}`] = detail;
			check(`${quality}: ${m} ${clip}`, ok, detail);
		}
	}

	await page.evaluate(() => window.__viewer.play(''));
	await page.evaluate(() => window.__viewer.setView('face'));
	for (const morph of morphs) {
		await page.evaluate((n) => { window.__viewer.clearMorphs(); window.__viewer.setMorph(n, 1); }, morph);
		await frame();
		const v = await page.evaluate((n) => [window.__viewer.morphInfluence('male', n), window.__viewer.morphInfluence('female', n)], morph);
		report.morphs[`${quality}/${morph}`] = v;
		check(`${quality}: morph ${morph}`, v[0] === 1 && v[1] === 1, v);
		if (quality === 'high') await page.screenshot({ path: join(out, `face_${morph}.png`) });
	}
	await page.evaluate(() => window.__viewer.clearMorphs());
	await frame();
	await page.screenshot({ path: join(out, `${quality}_faces.png`) });
}

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5));
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
await browser.close();
server.kill();
const failed = report.checks.filter((c) => !c.ok);
console.log(`\n${report.checks.length - failed.length}/${report.checks.length} checks passed · renderer: ${report.renderer}`);
for (const [q, s] of Object.entries(report.qualities)) console.log(`${q}: ${s.triangles} tris, ${s.drawCalls} draw calls, ${s.fps} fps (p95 ${s.p95_frame_ms} ms)`);
process.exit(failed.length ? 1 : 0);

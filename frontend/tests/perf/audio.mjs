// Real Web Audio graph/control smoke test; does not assert physical speaker output.
// node tests/perf/audio.mjs [http://127.0.0.1:3000]
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { perfSession } from './session.mjs';

const browser = await chromium.launch({executablePath:'/usr/bin/google-chrome',args:[
	'--no-sandbox','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist'
]});
try {
	const context = await browser.newContext({baseURL:process.argv[2] ?? 'http://127.0.0.1:3000',viewport:{width:1280,height:720}});
	const bot=await perfSession(context,`sound_${Date.now().toString(36)}`);
	await bot.moveTo('central-market');
	const page=await context.newPage(); const errors=[];
	page.on('pageerror',e=>errors.push(e.message));
	await page.goto('/world');
	const ready=()=>page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({timeout:180000});
	await ready();
	const state=()=>page.evaluate(()=>globalThis.__ppwPerf.audio());
	assert.equal((await state()).state,'not_started');
	await page.mouse.click(600,500);
	await page.waitForFunction(()=>globalThis.__ppwPerf.audio().state==='running');
	await page.waitForFunction(()=>globalThis.__ppwPerf.audio().rms>0.00001);
	await page.keyboard.down('w'); await page.waitForTimeout(1800); await page.keyboard.up('w');
	await page.keyboard.down('d'); await page.waitForTimeout(1800); await page.keyboard.up('d');
	assert.ok((await state()).footsteps>0,'moving should generate footsteps');
	await page.getByLabel('Settings',{exact:true}).click();
	await page.getByLabel('Master volume',{exact:true}).evaluate(el=>{
		el.value='25';el.dispatchEvent(new Event('input',{bubbles:true}));
	});
	assert.equal((await state()).settings.master,.25);
	await page.getByLabel('Mute all sounds',{exact:true}).check();
	await page.waitForTimeout(600);
	assert.ok((await state()).rms<.000001,'mute should silence the output graph');
	const muted=await state();
	await page.reload(); await ready();
	assert.equal((await state()).settings.muted,true);
	assert.equal((await state()).settings.master,.25);
	assert.equal((await state()).state,'not_started');
	await page.getByLabel('Settings',{exact:true}).click();
	await page.getByLabel('Mute all sounds',{exact:true}).uncheck();
	await page.waitForFunction(()=>globalThis.__ppwPerf.audio().rms>0.00001);
	await page.screenshot({path:'/tmp/ppg-audio-settings.png'});
	assert.deepEqual(errors,[]);
	console.log(JSON.stringify({passed:true,checks:['gesture unlock','nonzero audio signal','movement footsteps','master slider','mute silence','saved preferences','unmute after reload'],muted,playing:await state()},null,2));
} finally { await browser.close(); }

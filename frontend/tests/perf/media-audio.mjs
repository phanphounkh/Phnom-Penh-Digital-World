// Verify action playback independently of AudioContext, using normal HTML media.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { perfSession } from './session.mjs';
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
try{
	const context=await browser.newContext({baseURL:process.argv[2] ?? 'http://127.0.0.1:3000',viewport:{width:1280,height:720}});
	await context.addInitScript(()=>Object.defineProperty(window,'AudioContext',{value:undefined,configurable:true}));
	const bot=await perfSession(context,`media_${Date.now().toString(36)}`);await bot.moveTo('central-market');
	const file=await context.request.get('/audio/test-tone.wav');assert.equal(file.status(),200);assert.ok((await file.body()).length>10000);
	const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
	await page.goto('/world');await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({timeout:180000});
	await page.getByRole('button',{name:'Enable sound',exact:true}).click();
	await page.waitForFunction(()=>{const m=globalThis.__ppwPerf.audio().media;return m.testPlaying && m.testTime>.05;});
	const tone=await page.evaluate(()=>globalThis.__ppwPerf.audio());
	await page.keyboard.down('d');
	await page.waitForFunction(()=>globalThis.__ppwPerf.audio().media.steps.some(s=>s.playing && s.time>.01 && s.volume>0 && s.ready>=2));
	const walking=await page.evaluate(()=>globalThis.__ppwPerf.audio());await page.keyboard.up('d');
	assert.ok(walking.footsteps>0);assert.equal(walking.error,'');assert.deepEqual(errors,[]);
	console.log(JSON.stringify({passed:true,webAudioDisabled:true,tone,walking},null,2));
}finally{await browser.close();}

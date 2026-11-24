// Reproduce saved-muted/zero-volume settings and recover via the visible sound button.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { perfSession } from './session.mjs';
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
try {
	const context=await browser.newContext({baseURL:process.argv[2] ?? 'http://127.0.0.1:3000',viewport:{width:1280,height:720}});
	const bot=await perfSession(context,`enable_${Date.now().toString(36)}`);await bot.moveTo('central-market');
	const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
	await page.goto('/');
	await page.evaluate(()=>localStorage.setItem('ppw-audio-v1',JSON.stringify({master:0,ambience:0,effects:0,muted:true})));
	await page.goto('/world');
	await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({timeout:180000});
	const state=()=>page.evaluate(()=>globalThis.__ppwPerf.audio());
	assert.equal((await state()).state,'not_started');assert.equal((await state()).settings.muted,true);
	await page.getByRole('button',{name:'Enable sound',exact:true}).click();
	await page.waitForFunction(()=>{const a=globalThis.__ppwPerf.audio();return a.media.testPlaying && a.media.testTime>.02;});
	const test=await state();assert.equal(test.settings.muted,false);assert.equal(test.settings.master,.6);assert.equal(test.settings.effects,.8);
	await page.getByLabel('Settings',{exact:true}).click();
	await expect(page.getByTestId('sound-status')).toHaveText('Sound playback is enabled.');
	await expect(page.getByLabel('Master volume',{exact:true})).toHaveValue('60');
	await expect(page.getByLabel('Effects volume',{exact:true})).toHaveValue('80');
	await page.screenshot({path:'/tmp/ppg-audio-enable.png'});
	assert.deepEqual(errors,[]);
	console.log(JSON.stringify({passed:true,test,checks:['saved mute and zero volume reproduced','explicit speaker gesture','test tone signal','audible volume defaults restored','visible playback status']},null,2));
} finally {await browser.close();}

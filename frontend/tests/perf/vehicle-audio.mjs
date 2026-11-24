// Exercise actual vehicle gameplay and inspect the resulting Web Audio state.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { perfSession } from './session.mjs';
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
const results=[];
try {
	for(const kind of ['bicycle','motorbike']) {
		const context=await browser.newContext({baseURL:process.argv[2] ?? 'http://127.0.0.1:3000',viewport:{width:1280,height:720}});
		const bot=await perfSession(context,`sfx_${kind}_${Date.now().toString(36)}`);
		await bot.moveTo('central-market');
		const page=await context.newPage(), errors=[];
		page.on('pageerror',e=>errors.push(e.message));
		await page.goto('/world');
		await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({timeout:180000});
		await expect(page.getByTestId('hud-net')).toHaveAttribute('data-status','open',{timeout:30000});
		await page.mouse.click(600,500);
		await page.keyboard.press('v'); await page.getByTestId(`get-${kind}`).click();
		const vehicle=page.getByTestId(`vehicle-${kind}`);
		await expect(vehicle).toBeVisible();
		if(await vehicle.getByTestId('vehicle-ride').isVisible()) await page.keyboard.press('v');
		else await vehicle.getByText('Walk there',{exact:true}).click();
		await expect(page.getByTestId('ride-prompt')).toHaveAttribute('data-kind','ride',{timeout:180000});
		await page.locator('[data-testid="world-canvas"] canvas').click({position:{x:20,y:300}});
		await page.keyboard.press('f');
		await expect(page.getByTestId('hud-ride')).toHaveAttribute('data-mode',kind,{timeout:30000});
		const audio=()=>page.evaluate(()=>globalThis.__ppwPerf.audio());
		await page.waitForTimeout(400);
		const idle=await audio();
		assert.equal(idle.vehicle.engine>0,kind==='motorbike');
		await page.keyboard.down('w');
		await page.waitForFunction(()=>globalThis.__ppwPerf.audio().vehicle.tyres>0,{},{timeout:10000});
		if(kind==='bicycle') await page.waitForFunction(()=>globalThis.__ppwPerf.audio().bikeTicks>0);
		await page.waitForTimeout(1200);
		const moving=await audio(); await page.keyboard.up('w');
		assert.ok(moving.media.loops.some(loop=>loop.kind.startsWith(kind) && loop.playing && loop.time>.1 && loop.volume>.001),'vehicle media should be playing at audible volume');
		await page.waitForTimeout(250);const coast=await audio();
		if(kind==='bicycle') {assert.equal(moving.vehicle.engine,0);assert.equal(coast.vehicle.coasting,true);}
		else assert.ok(moving.vehicle.rpm>idle.vehicle.rpm);
		await page.screenshot({path:`/tmp/ppg-audio-${kind}.png`});
		assert.deepEqual(errors,[]);results.push({kind,idle,moving,coast});
		await context.close();
	}
	console.log(JSON.stringify({passed:true,results},null,2));
} finally {await browser.close();}

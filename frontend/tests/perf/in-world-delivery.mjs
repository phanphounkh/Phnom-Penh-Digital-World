import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { perfSession } from './session.mjs';
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
const deadline=setTimeout(()=>void browser.close(),360000);
try {
 const context=await browser.newContext({baseURL:'http://localhost:3000',viewport:{width:1280,height:720}});
 const bot=await perfSession(context,`delivery_world_${Date.now().toString(36)}`);await bot.moveTo('central-market');
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const ready=async()=>{await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({timeout:180000});await page.locator('[data-testid="hud-net"][data-status="open"]').waitFor({timeout:30000});};
 const saved=()=>page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('ppw-passport-v1:')))||'null'));
 const diag=()=>page.evaluate(()=>globalThis.__ppwDelivery.diagnostics());
 const walk=async(target,timeout)=>{
  const me=await page.evaluate(()=>globalThis.__ppwNet.city.localState());
  if(Math.hypot(me.x-target.x,me.z-target.z)>2.8)await page.getByTestId('nav-follow').click();
  try {await page.waitForFunction(p=>{const me=globalThis.__ppwNet.city.localState();return Math.hypot(me.x-p.x,me.z-p.z)<=3&&Math.abs(me.speed)<.5;},target,{timeout});}
  catch(error){console.log('Route state',await page.evaluate(()=>({position:globalThis.__ppwNet.city.localState(),text:document.body.innerText.slice(0,1500)})));await page.screenshot({path:'/tmp/ppg-delivery-route-failure.png'});throw error;}
 };
 const sample=()=>page.evaluate(()=>new Promise(resolve=>{const start=performance.now();let frames=0;const tick=t=>{frames++;if(t-start<2500)return requestAnimationFrame(tick);const r=globalThis.__ppwPerf.renderer;resolve({fps:frames/((t-start)/1000),calls:r.info.render.calls,triangles:r.info.render.triangles,geometries:r.info.memory.geometries,textures:r.info.memory.textures});};requestAnimationFrame(tick);}));
 await page.goto('/world');await ready();await page.evaluate(()=>globalThis.__ppwNet.city.setTimeMode('noon'));
 await page.getByRole('button',{name:'Discovery passport (J)',exact:true}).click();await page.getByTestId('delivery-quick-start').click();
 await page.getByTestId('delivery-objective').waitFor();const job=(await saved()).delivery;
 console.log('Walking to pickup',job.pickup);await walk(job.pickup,45000);
 await expect(page.getByTestId('delivery-world-interact')).toBeEnabled();
 assert.equal((await diag()).marker,true);await page.keyboard.press('e');
 await page.waitForFunction(()=>globalThis.__ppwDelivery.diagnostics().parcel);
 assert.equal((await saved()).delivery.stage,'carrying');await page.screenshot({path:'/tmp/ppg-delivery-pickup.png'});
 await page.reload();await ready();await page.evaluate(()=>globalThis.__ppwNet.city.setTimeMode('noon'));
 await page.waitForFunction(()=>globalThis.__ppwDelivery?.diagnostics().parcel);
 await page.getByTestId('delivery-route').click();
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);
 await expect(page.getByTestId('delivery-objective').locator('..')).toHaveClass(/with-navigation/);
 const objectiveBefore=await page.getByTestId('delivery-objective').boundingBox(),navBefore=await page.getByTestId('hud-nav').boundingBox();
 console.log('Portrait bounds',{objectiveBefore,navBefore});await page.screenshot({path:'/tmp/ppg-delivery-portrait-navigation.png'});
 assert.ok(objectiveBefore.y>=navBefore.y+navBefore.height-1);
 assert.ok(navBefore.x>=0&&navBefore.x+navBefore.width<=390+1);
 await page.setViewportSize({width:1280,height:720});
 if(process.argv.includes('--layout-only')) {
  const layoutReport={passed:true,viewport:{width:390,height:844},objective:objectiveBefore,navigation:navBefore,errors};
  assert.deepEqual(errors,[]);await writeFile('docs/perf/delivery-navigation-layout.json',JSON.stringify(layoutReport,null,2)+'\n');console.log(JSON.stringify(layoutReport,null,2));
 } else {
 console.log('Walking to garden',job.dropoff);
 const start=Date.now();await walk(job.dropoff,180000);
 await page.waitForFunction(()=>globalThis.__ppwDelivery.diagnostics().host);
 await expect(page.getByTestId('delivery-world-interact')).toBeEnabled();
 await page.mouse.move(640,340);await page.mouse.down();await page.mouse.move(820,340,{steps:12});await page.mouse.up();await page.waitForTimeout(400);
 const carrying=await diag(),withHost=await sample();
 assert.equal(carrying.parcel,true);assert.equal(carrying.host,true);await page.screenshot({path:'/tmp/ppg-delivery-host.png'});
 // Active task and navigation should fit both phone orientations.
 const layouts=[];
 for(const viewport of [{width:844,height:390},{width:390,height:844}]){
  await page.setViewportSize(viewport);await page.waitForTimeout(250);
  const objective=await page.getByTestId('delivery-objective').boundingBox();assert.ok(objective&&objective.x>=0&&objective.x+objective.width<=viewport.width+1);
  const prompt=await page.getByTestId('delivery-world-interact').boundingBox();assert.ok(prompt&&prompt.x>=0&&prompt.x+prompt.width<=viewport.width+1);
  const nav=await page.getByTestId('hud-nav').isVisible()?await page.getByTestId('hud-nav').boundingBox():null;
  if(viewport.width===390&&nav)assert.ok(objective.y>=nav.y+nav.height-1);
  await page.screenshot({path:`/tmp/ppg-delivery-${viewport.width}.png`});layouts.push({viewport,objective,prompt});
 }
 await page.setViewportSize({width:1280,height:720});await page.keyboard.press('e');
 await expect.poll(async()=>(await saved()).delivered).toBe(true);
 assert.equal((await saved()).delivery,null);await page.waitForFunction(()=>!globalThis.__ppwDelivery.diagnostics().parcel);
 await page.screenshot({path:'/tmp/ppg-delivery-completed.png'});
 await page.waitForFunction(()=>!globalThis.__ppwDelivery.diagnostics().host);
 const afterHandoff=await sample();await page.getByRole('button',{name:'Discovery passport (J)',exact:true}).click();
 await expect(page.getByTestId('passport-progress')).toContainText('City Helper');
 await page.getByTestId('delivery-quick-start').click();await page.getByRole('button',{name:'Cancel practice delivery',exact:true}).click();
 assert.equal((await saved()).delivery,null);await page.waitForFunction(()=>!globalThis.__ppwDelivery.diagnostics().marker);
 assert.deepEqual(errors,[]);
 const report={passed:true,keyboardPickup:true,restoredParcelAfterReload:true,keyboardHandoff:true,nearbyHost:true,cancelledCleanly:true,walkingSeconds:(Date.now()-start)/1000,withHost,afterHandoff,layouts,errors};
 await writeFile('docs/perf/in-world-delivery.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
}finally{clearTimeout(deadline);await browser.close();}

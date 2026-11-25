// Complete a first adventure through the real HUD and route follower, with native clocks.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { perfSession } from './session.mjs';
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
const deadline=setTimeout(()=>void browser.close(),360000);
try {
 const context=await browser.newContext({baseURL:'http://localhost:3000',viewport:{width:1280,height:720}});
 const user=`passport_${Date.now().toString(36)}`;
 const bot=await perfSession(context,user);await bot.moveTo('wat-phnom');
 const places=await (await context.request.get('/api/v1/geo/spawn-points')).json();
 const page=await context.newPage(),errors=[];
 page.on('close',()=>console.log('Browser page closed')); page.on('pageerror',e=>errors.push(e.message));
 const ready=async()=>{await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({timeout:180000});await page.locator('[data-testid="hud-net"][data-status="open"]').waitFor({timeout:60000});};
 const open=()=>page.getByRole('button',{name:'Discovery passport (J)',exact:true}).click();
 const saved=()=>page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('ppw-passport-v1:')))||'null'));
 const close=()=>page.getByRole('button',{name:'Close',exact:true}).click();
 let lastTravel=0;
 const travel=async(slug)=>{
  // The server rate-limits public travel to one request every two seconds.
  const pause=2100-(Date.now()-lastTravel);if(pause>0)await page.waitForTimeout(pause);
  if(await page.getByRole('button',{name:'Close',exact:true}).isVisible())await close();
  await page.getByRole('button',{name:'Places & shops (M)',exact:true}).click();
  await page.getByTestId(`place-${slug}`).getByRole('button',{name:'Go',exact:true}).click();
  lastTravel=Date.now();
  const p=places.find(p=>p.slug===slug);
  try { await page.waitForFunction(p=>{const c=globalThis.__ppwNet.city.localState();return Math.hypot(c.x-p.x,c.z-p.z)<24;},p,{timeout:30000}); } catch(error) { console.log('Travel failed',p,await page.evaluate(()=>({position:globalThis.__ppwNet.city.localState(),toasts:document.querySelectorAll('[data-testid=toast]').length,text:document.body.innerText.slice(-1800)})));await page.screenshot({path:'/tmp/ppg-passport-travel-failure.png'});throw error; }
 };
 const walkRoute=async(point)=>{
  await page.getByTestId('nav-follow').waitFor({timeout:15000});await page.getByTestId('nav-follow').click();
  const started=Date.now();
  try { await page.waitForFunction(p=>{const c=globalThis.__ppwNet.city.localState();return Math.hypot(c.x-p.x,c.z-p.z)<2.7;},point,{timeout:150000}); } catch(error) { console.log(await page.evaluate(()=>({position:globalThis.__ppwNet.city.localState(),nav:document.querySelector('[data-testid=\"hud-nav\"]')?.textContent})));await page.screenshot({path:'/tmp/ppg-passport-route-failure.png'});throw error; }
  // Opening the passport stops manual movement and the route follower without teleporting.
  await open();
  return {seconds:(Date.now()-started)/1000,position:await page.evaluate(()=>globalThis.__ppwNet.city.localState())};
 };
 console.log('Opening Wat Phnom');await page.goto('/world');await ready();
 await open();await expect(page.getByTestId('stamp-central-market')).toBeDisabled();
 await expect(page.getByTestId('stamp-wat-phnom')).toBeEnabled();await page.getByTestId('stamp-wat-phnom').click();
 assert.deepEqual((await saved()).stamps,['wat-phnom']);
 console.log('Collecting Central Market stamp');await travel('central-market');await open();await page.getByTestId('stamp-central-market').click();
 console.log('Collecting Canadia Garden stamp');await travel('canadia-garden');await open();await page.getByTestId('stamp-canadia-garden').click();
 await expect(page.getByTestId('passport-progress')).toContainText('Daun Penh Explorer badge earned');
 await page.screenshot({path:'/tmp/ppg-passport-discoveries.png'});
 await travel('central-market');await open();await page.getByTestId('delivery-start').click();
 await travel('central-market');assert.equal((await saved()).delivery,null);assert.equal((await saved()).delivered,false);
 await open();await page.getByTestId('delivery-start').click();
 const accepted=await saved();assert.equal(accepted.delivery.stage,'pickup');
 console.log('Walking to café',accepted.delivery.pickup);const pickupWalk=await walkRoute(accepted.delivery.pickup);
 await expect(page.getByTestId('delivery-interact')).toBeEnabled();await page.getByTestId('delivery-interact').click();
 assert.equal((await saved()).delivery.stage,'carrying');
 console.log('Walking delivery route',accepted.delivery.dropoff);const deliveryWalk=await walkRoute(accepted.delivery.dropoff);
 await expect(page.getByTestId('delivery-interact')).toBeEnabled();await page.getByTestId('delivery-interact').click();
 const completed=await saved();assert.equal(completed.delivered,true);assert.equal(completed.delivery,null);
 await expect(page.getByTestId('passport-progress')).toContainText('City Helper badge earned');
 await page.screenshot({path:'/tmp/ppg-passport-completed.png'});
 await page.reload();await ready();await open();
 await expect(page.getByTestId('passport-progress')).toContainText('City Helper badge earned');
 assert.deepEqual(await saved(),completed);
 // Narrow layout: panel is scrollable, buttons remain within viewport.
 await page.setViewportSize({width:844,height:390});
 await page.getByTestId('practice-delivery').scrollIntoViewIfNeeded();
 const bounds=await page.getByTestId('passport-panel').boundingBox();assert.ok(bounds.width<844);
 await page.screenshot({path:'/tmp/ppg-passport-mobile.png'});
 assert.deepEqual(errors,[]);
 const report={passed:true,user,stamps:completed.stamps,badges:['Daun Penh Explorer','City Helper'],fastTravelCancels:true,pickupWalk,deliveryWalk,persisted:true,errors};
 await writeFile('docs/perf/passport-smoke.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{clearTimeout(deadline);await browser.close();}

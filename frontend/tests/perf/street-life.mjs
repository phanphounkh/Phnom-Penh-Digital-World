// Controlled actual-game camera comparison at the user's Street 144 position.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { perfSession } from './session.mjs';
const stage=process.argv[2]??'before';
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
try{
 const context=await browser.newContext({baseURL:'http://localhost:3000',viewport:{width:1280,height:720}});
 const bot=await perfSession(context,`sl_${stage[0]}_${Date.now().toString(36)}`);await bot.moveTo('riverside');
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/world');await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({timeout:180000});await page.locator('[data-testid="hud-net"][data-status="open"]').waitFor();
 // Stop this QA connection before repositioning; do not bypass multiplayer movement validation.
 await page.evaluate(async()=>{globalThis.__ppwNet.stop();const c=globalThis.__ppwNet.city;c.setQuality('medium');c.setTimeMode('noon');await c.teleport(763,-60,270);c.setShowcase({distance:7.5,pitch:.25});});
 await page.waitForFunction(()=>globalThis.__ppwPerf.chunks().pendingCount===0);
 await page.waitForTimeout(4000);
 if(stage!=='before') {await writeFile('/tmp/ppg-street-snapshot.json',JSON.stringify(await page.evaluate(()=>{const c=globalThis.__ppwNet.city;return {roads:c.chunkData().flatMap(p=>p.roads).filter(r=>r.pts.some(p=>Math.hypot(p[0]-763,p[1]+60)<100)),polys:[...c.collision.chunks.values()].flatMap(c=>c.polys).filter(p=>p.minX<850&&p.maxX>680&&p.minZ<30&&p.maxZ>-150).map(p=>p.ring)};})));try{await page.waitForFunction(()=>globalThis.__ppwStreetLife?.diagnostics().actors>0,null,{timeout:15000});}catch(error){console.log(await page.evaluate(()=>({life:globalThis.__ppwStreetLife?.diagnostics(),roads:globalThis.__ppwNet.city.chunkData().flatMap(p=>p.roads).slice(0,15),body:document.body.innerText.slice(0,400)})));await page.screenshot({path:'/tmp/ppg-street-life-debug.png'});throw error;}}
 await page.screenshot({path:`/tmp/ppg-street-life-${stage}.png`});
 const perf=await page.evaluate(()=>new Promise(resolve=>{const start=performance.now(),frames=[];let prev=start;const tick=t=>{frames.push(t-prev);prev=t;if(t-start<5000)return requestAnimationFrame(tick);frames.sort((a,b)=>a-b);const r=globalThis.__ppwPerf.renderer;resolve({fps:frames.length/((t-start)/1000),p95ms:frames[Math.floor(frames.length*.95)],calls:r.info.render.calls,triangles:r.info.render.triangles,geometries:r.info.memory.geometries,textures:r.info.memory.textures,heapMB:performance.memory?.usedJSHeapSize/1048576,streetLife:globalThis.__ppwStreetLife?.diagnostics()??null,position:globalThis.__ppwNet.city.localState()});};requestAnimationFrame(tick);}));
 assert.deepEqual(errors,[]);const report={stage,visualComparisonOnly:true,multiplayerStoppedForCameraSetup:true,viewport:{width:1280,height:720},time:'noon',quality:'medium',perf,errors};
 await writeFile(`docs/perf/street-life-${stage}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}

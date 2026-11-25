import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { chromium,expect } from '@playwright/test';
import { perfSession } from './session.mjs';
import { findPath } from '../../src/lib/game/buildings/nav.ts';
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
const timeout=setTimeout(()=>void browser.close(),300000);
try {
 const context=await browser.newContext({baseURL:'http://localhost:3000',viewport:{width:1280,height:720},acceptDownloads:true});
 const bot=await perfSession(context,`sl_play_${Date.now().toString(36)}`);await bot.moveTo('riverside');
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Shader Error|THREE.WebGLProgram/.test(m.text()))errors.push(m.text());});
 await page.goto('/world');await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({timeout:120000});await page.locator('[data-testid="hud-net"][data-status="open"]').waitFor();
 await page.evaluate(()=>globalThis.__ppwNet.city.setTimeMode('noon'));
 // Reach the inspected Street 144 area using the real street graph and live movement sync.
 const me=await page.evaluate(()=>globalThis.__ppwNet.city.localState());
 const result=await context.request.get('/api/v1/routes',{params:{from_x:me.x,from_z:me.z,to_x:763,to_z:-60,mode:'foot'}});assert.equal(result.status(),200);
 const route=await result.json();console.log('Walking to Street 144',route.distance_m);
 await page.evaluate(route=>new Promise(resolve=>{const city=globalThis.__ppwNet.city;city.setRoute(route,[763,-60]);city.followRoute(resolve);}),route);
 await page.waitForFunction(()=>globalThis.__ppwStreetLife?.diagnostics().actors>0,null,{timeout:45000});
 await page.waitForFunction(()=>globalThis.__ppwStreetLife.diagnostics().walkedMeters>1,null,{timeout:20000});
 const initial=await page.evaluate(()=>globalThis.__ppwStreetLife.diagnostics());
 for(let attempt=0;attempt<5;attempt++){
  if(await page.evaluate(()=>!!globalThis.__ppwStreetLife.nearest()))break;
  const {me,actors,obstacles}=await page.evaluate(()=>({me:globalThis.__ppwNet.city.localState(),actors:globalThis.__ppwStreetLife.diagnostics().routes,obstacles:[...globalThis.__ppwNet.city.collision.chunks.values()].flatMap(c=>c.polys.filter(p=>!p.overhead).map(p=>p.ring))}));
  let points=null;
  approach:for(const actor of actors)for(const offset of [[1.1,0],[-1.1,0],[0,1.1],[0,-1.1]]){
   const to=[actor.x+offset[0],actor.z+offset[1]];
   points=findPath({bounds:[Math.min(me.x,to[0])-5,Math.max(me.x,to[0])+5,Math.min(me.z,to[1])-5,Math.max(me.z,to[1])+5],obstacles,radius:.5},[me.x,me.z],to);
   if(points)break approach;
  }
  assert.ok(points,'collision-aware approach to a neighbour');
  await page.evaluate(points=>new Promise(resolve=>globalThis.__ppwNet.city.walkTo(points,resolve)),points);
 }
 assert.ok(await page.evaluate(()=>globalThis.__ppwStreetLife.nearest()),'a visible neighbour is within greeting reach');
 await page.keyboard.press('g');await page.waitForFunction(()=>globalThis.__ppwStreetLife.diagnostics().greetings>0);
 await page.screenshot({path:'/tmp/ppg-street-neighbour.png'});
 await page.keyboard.press('k');await page.getByTestId('postcard-image').waitFor();
 const photo=await page.getByTestId('postcard-image').evaluate(img=>new Promise(resolve=>{const ready=()=>resolve({width:img.naturalWidth,height:img.naturalHeight});if(img.complete)ready();else img.onload=ready;}));
 assert.ok(photo.width>0&&photo.width<=1600&&photo.height>0);
 assert.equal(await page.evaluate(()=>globalThis.__ppwPerf.scene.getObjectByName('route').visible),true);
 const download=page.waitForEvent('download');await page.getByTestId('postcard-download').click();const file=await download;await file.saveAs('/tmp/ppg-street-postcard.png');
 const png=await readFile('/tmp/ppg-street-postcard.png');assert.equal(png.readUInt32BE(0),0x89504e47);assert.ok(png.length>10000);
 await page.screenshot({path:'/tmp/ppg-street-postcard-preview.png'});
 await page.getByRole('button',{name:'Retake',exact:true}).click();await expect(page.getByTestId('postcard-image')).toHaveCount(0);
 await page.evaluate(()=>globalThis.__ppwNet.city.setQuality('low'));await page.waitForTimeout(1000);
 const low=await page.evaluate(()=>globalThis.__ppwStreetLife.diagnostics());assert.ok(low.actors<=1);await expect(page.getByTestId('hud-net')).toHaveAttribute('data-status','open');
 assert.deepEqual(errors,[]);const report={passed:true,multiplayerStayedConnected:true,initial,greeting:true,photo,downloadBytes:png.length,low,errors};
 await writeFile('docs/perf/street-life-play.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{clearTimeout(timeout);await browser.close();}

// Two independent browser contexts, legacy migration and a failed-API/retry scenario.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { perfSession } from './session.mjs';
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
try {
 const options={baseURL:'http://localhost:3000',viewport:{width:1280,height:720}};
 const a=await browser.newContext(options),user=`cloud_${Date.now().toString(36)}`,errors=[];
 const bot=await perfSession(a,user);await bot.moveTo('wat-phnom');
 const id=(await (await a.request.get('/api/v1/auth/me')).json()).id;
 await a.addInitScript(({id})=>{if(!localStorage.getItem(`ppw-passport-v1:${id}`))localStorage.setItem(`ppw-passport-v1:${id}`,JSON.stringify({version:1,stamps:['canadia-garden'],delivery:null,delivered:true}));},{id});
 const ready=async(page)=>{page.on('pageerror',e=>errors.push(e.message));await page.goto('/world');await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({timeout:180000});await page.locator('[data-testid="hud-net"][data-status="open"]').waitFor({timeout:60000});await page.getByRole('button',{name:'Discovery passport (J)',exact:true}).click();};
 const read=async(context)=>(await context.request.get('/api/v1/me/passport')).json();
 const page=await a.newPage();await ready(page);
 await expect(page.getByTestId('passport-sync')).toContainText('saved to your account');
 assert.deepEqual((await read(a)).stamps,['canadia-garden']);assert.equal((await read(a)).delivered,true);
 await page.getByTestId('stamp-wat-phnom').click();
 await expect.poll(async()=>(await read(a)).stamps.length).toBe(2);
 const migrated=await read(a);await a.close();
 const b=await browser.newContext(options);await perfSession(b,user);
 assert.equal((await b.storageState()).origins.length,0);
 const fresh=await b.newPage();await ready(fresh);
 await expect(fresh.getByTestId('stamp-wat-phnom')).toHaveText('Stamped');
 await expect(fresh.getByTestId('stamp-canadia-garden')).toHaveText('Stamped');
 await expect(fresh.getByTestId('passport-progress')).toContainText('City Helper');
 // Only the passport API fails; the existing multiplayer travel still works.
 await fresh.route('**/api/v1/me/passport',route=>route.abort('failed'));
 await fresh.getByRole('button',{name:'Close',exact:true}).click();
 await fresh.getByRole('button',{name:'Places & shops (M)',exact:true}).click();
 await fresh.getByTestId('place-central-market').getByRole('button',{name:'Go',exact:true}).click();
 await fresh.getByRole('button',{name:'Discovery passport (J)',exact:true}).click();
 await expect(fresh.getByTestId('stamp-central-market')).toBeEnabled();await fresh.getByTestId('stamp-central-market').click();
 await expect(fresh.getByTestId('passport-sync')).toContainText('sync unavailable');
 assert.equal((await read(b)).stamps.length,2);
 const cached=await fresh.evaluate(id=>JSON.parse(localStorage.getItem(`ppw-passport-v1:${id}`)),id);assert.equal(cached.stamps.length,3);
 await fresh.unroute('**/api/v1/me/passport');await fresh.getByRole('button',{name:'Retry sync',exact:true}).click();
 await expect(fresh.getByTestId('passport-sync')).toContainText('saved to your account');
 const completed=await read(b);assert.equal(completed.stamps.length,3);assert.equal(completed.delivered,true);
 await fresh.waitForFunction(()=>globalThis.__ppwPerf.chunks().pendingCount===0&&globalThis.__ppwPerf.chunks().loadedCount>=12,null,{timeout:60000});
 await fresh.screenshot({path:'/tmp/ppg-passport-cloud.png'});
 await b.close();
 const c=await browser.newContext(options);await perfSession(c,user);
 assert.deepEqual(await read(c),completed);assert.deepEqual(errors,[]);
 const report={passed:true,legacyImport:migrated,freshBrowserRestored:true,failedApiKeptLocalProgress:true,retryMerged:true,streamingContinuesWithMenuOpen:true,thirdSession:await read(c),errors};
 await writeFile('docs/perf/passport-cloud.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}

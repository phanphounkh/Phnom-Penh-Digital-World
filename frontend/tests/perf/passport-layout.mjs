import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { perfSession } from './session.mjs';
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
try {
 const context=await browser.newContext({baseURL:'http://localhost:3000',viewport:{width:1280,height:720}});
 const bot=await perfSession(context,`passport_ui_${Date.now().toString(36)}`);await bot.moveTo('wat-phnom');
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/world');
 await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({timeout:180000});
 const layouts=[];
 for(const viewport of [{width:1280,height:720},{width:844,height:390},{width:390,height:844}]) {
  await page.setViewportSize(viewport);await page.waitForTimeout(250);
  const card=page.getByTestId('adventure-card'),cardVisible=await card.isVisible();
  if(cardVisible){const b=await card.boundingBox();console.log({viewport,card:b});assert.ok(b.height<100);assert.ok(b.x>=0&&b.x+b.width<=viewport.width);}
  if(viewport.height===390)assert.equal(cardVisible,false);
  await page.getByRole('button',{name:'Discovery passport (J)',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'passport',exact:true});const box=await dialog.boundingBox();
  assert.ok(box.x>=0&&box.x+box.width<=viewport.width+1);assert.ok(box.height<=viewport.height);
  await page.getByTestId('practice-delivery').scrollIntoViewIfNeeded();
  await page.screenshot({path:`/tmp/ppg-passport-${viewport.width}x${viewport.height}.png`});
  await page.getByRole('button',{name:'Close',exact:true}).click();layouts.push({viewport,cardVisible,panel:box});
 }
 assert.deepEqual(errors,[]);const report={passed:true,layouts,errors};
 await writeFile('docs/perf/passport-layout.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}

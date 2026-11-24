// Actual native-media playback, controls, loop boundary, persistence and action regression.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { perfSession } from './session.mjs';
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
try {
 const context=await browser.newContext({baseURL:process.argv[2]??'http://127.0.0.1:3000',viewport:{width:1280,height:720}});
 await context.addInitScript(()=>{
  Object.defineProperty(window,'AudioContext',{value:undefined,configurable:true});
  window.Audio=new Proxy(window.Audio,{construct(target,args){const media=Reflect.construct(target,args);if(String(args[0]).includes('riverside-breeze'))globalThis.__musicElement=media;return media;}});
 });
 const bot=await perfSession(context,`music_${Date.now().toString(36)}`);await bot.moveTo('central-market');
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const ready=async()=>{await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({timeout:180000});await page.locator('[data-testid="hud-net"][data-status="open"]').waitFor({timeout:60000});};
 const state=()=>page.evaluate(()=>globalThis.__ppwPerf.audio());
 const slider=async(value)=>page.getByLabel('Music volume').evaluate((el,v)=>{el.value=String(v);el.dispatchEvent(new Event('input',{bubbles:true}));},value);
 await page.goto('/world');await ready();assert.equal((await state()).music.playing,false);
 await page.getByRole('button',{name:'Enable sound',exact:true}).click();
 await page.waitForFunction(()=>{const m=globalThis.__ppwPerf.audio().music;return m.playing&&m.time>.2&&m.ready>=2;});
 const playing=await state();assert.ok(playing.music.duration>51);assert.equal(playing.music.error,'');
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await slider(0);assert.equal((await state()).music.playing,false);assert.equal((await state()).settings.effects,.8);
 await slider(40);await page.waitForFunction(()=>globalThis.__ppwPerf.audio().music.playing);
 assert.ok(Math.abs((await state()).music.volume-.24)<.001);
 await page.getByLabel('Mute all sounds').check();assert.equal((await state()).music.playing,false);
 await page.getByLabel('Mute all sounds').uncheck();await page.waitForFunction(()=>globalThis.__ppwPerf.audio().music.playing);
 await page.evaluate(()=>{globalThis.__musicElement.currentTime=globalThis.__musicElement.duration-.12;});
 await page.waitForFunction(()=>{const m=globalThis.__ppwPerf.audio().music;return m.playing&&m.time<1.5;});
 const looped=await state();
 await page.screenshot({path:'/tmp/ppg-background-music-settings.png'});
 await page.keyboard.press('Escape');await page.keyboard.down('d');
 await page.waitForFunction(()=>globalThis.__ppwPerf.audio().media.steps.some(s=>s.playing&&s.time>.01&&s.volume>0&&s.ready>=2));
 const walking=await state();await page.keyboard.up('d');assert.ok(walking.footsteps>0);
 await page.reload();await ready();const persisted=await state();assert.equal(persisted.settings.music,.4);assert.equal(persisted.music.playing,false);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,webAudioDisabled:true,playing,looped,walking,persisted,errors},null,2));
}finally{await browser.close();}

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { perfSession } from './session.mjs';
const browser = await chromium.launch({
	executablePath: '/usr/bin/google-chrome',
	args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist']
});
try {
	const context = await browser.newContext({
		baseURL: 'http://localhost:3000',
		viewport: { width: 1280, height: 720 }
	});
	await perfSession(context, 'npc_life_qa');
	const response = await context.request.get('/api/v1/market/shops');
	assert.equal(response.status(), 200);
	const shops = await response.json();
	console.log(
		'shops',
		shops.map((s) => ({
			name: s.name,
			open: s.is_open,
			door: [s.unit.door_x, s.unit.door_z]
		}))
	);
	const page = await context.newPage();
	await page.goto('/world');
	await page.locator('[data-testid="world-canvas"][data-ready="true"]').waitFor({ timeout: 120000 });
	await page.waitForFunction(() => !!globalThis.__ppwStreetLife);
	await page.evaluate(() => {
		__ppwNet.stop();
		__ppwNet.city.setQuality('medium');
		__ppwNet.city.setTimeMode('noon');
	});
	let result = null;
	for (const shop of shops.filter((s) => s.is_open).slice(0, 4)) {
		await page.evaluate(async (s) => {
			await __ppwNet.city.teleport(s.unit.door_x, s.unit.door_z);
		}, shop);
		await page.waitForTimeout(20000);
		const snapshot = await page.evaluate(() => ({
			life: __ppwStreetLife.diagnostics(),
			targets: [...__ppwStreetLife.actors.values()].map((a) => ({
				x: a.group.position.x,
				z: a.group.position.z,
				target: __ppwStreetLife.shopNear(a)
			}))
		}));
		console.log(shop.name, JSON.stringify(snapshot));
		if (snapshot.life.shopping > 0) {
			result = { shop: shop.name, ...snapshot };
			break;
		}
	}
	if (!result) {
        await page.evaluate(async()=>{await __ppwNet.city.teleport(763,-60);});
        const candidates=await page.evaluate(()=>{
            const city=__ppwNet.city,data=city.chunkData(),buildings=data.flatMap(c=>c.buildings).filter(b=>['yes','retail','commercial','residential','house'].includes(b.kind)&&b.h<=30&&!b.roof&&!b.model),out=[];
            for(const c of data)for(const r of c.roads)for(let j=1;j<r.pts.length;j++){
                const a=r.pts[j-1],b=r.pts[j],dx=b[0]-a[0],dz=b[1]-a[1],len=Math.hypot(dx,dz);
                if(len<20||r.bridge||r.layer!==0)continue;
                for(const side of [-1,1]){
                    const x=(a[0]+b[0])/2-dz/len*(r.w/2+.8)*side,z=(a[1]+b[1])/2+dx/len*(r.w/2+.8)*side;
                    if(city.collision.containing(x,z))continue;
                    let nearest=Infinity;
                    for(const building of buildings)for(const ring of building.polys.flat())for(let k=0;k<ring.length;k++){
                        const u=ring[k],v=ring[(k+1)%ring.length];if(Math.min(u[0],v[0])>x+2.1||Math.max(u[0],v[0])<x-2.1||Math.min(u[1],v[1])>z+2.1||Math.max(u[1],v[1])<z-2.1)continue;
                        const ex=v[0]-u[0],ez=v[1]-u[1],l=ex*ex+ez*ez,t=l?Math.max(0,Math.min(1,((x-u[0])*ex+(z-u[1])*ez)/l)):0;
                        nearest=Math.min(nearest,Math.hypot(x-u[0]-t*ex,z-u[1]-t*ez));
                    }
                    if(nearest>.65&&nearest<2.1)out.push({x,z,street:r.name,distance:nearest});
                }
            }
            return out.sort((a,b)=>a.distance-b.distance).slice(0,8);
        });console.log('mapped storefront candidates',candidates);
        for(const candidate of candidates){
            await page.evaluate(async p=>{await __ppwNet.city.teleport(p.x+3,p.z+3);},candidate);
            try{await page.waitForFunction(()=>__ppwStreetLife.diagnostics().routes.some(a=>a.bag),null,{timeout:16000});}catch{}
            const life=await page.evaluate(()=>__ppwStreetLife.diagnostics());console.log('candidate result',candidate,life);
            if(life.routes.some(a=>a.bag)){result={decorativeStorefront:true,candidate,life};break;}
        }
    }
	assert.ok(result, 'natural storefront browse and bag observed');
	await page.waitForTimeout(2000);
	console.log('bag pose',await page.evaluate(()=>{
		const a=[...__ppwStreetLife.actors.values()].find(a=>a.bag),v=()=>new a.group.position.constructor();
		a.group.updateWorldMatrix(true,true);
		return {actor:a.group.position.toArray(),hand:a.character.root.getObjectByName('mixamorigRightHand').getWorldPosition(v()).toArray(),bag:a.bag.getWorldPosition(v()).toArray(),body:a.bag.children[0].getWorldPosition(v()).toArray(),state:a.state};
	}));
	await page.evaluate(() => {
		const actor = [...__ppwStreetLife.actors.values()].find((a) => a.bag),
			r = __ppwPerf.renderer,
			original = r.render;
		r.render = function (s, c) {
			const p = actor.group.position;
			const yaw=actor.group.rotation.y;
			c.position.set(p.x+Math.sin(yaw)*3+Math.cos(yaw)*2,p.y+1.8,p.z+Math.cos(yaw)*3-Math.sin(yaw)*2);
			c.lookAt(p.x, p.y + 1, p.z);
			return original.call(this, s, c);
		};
	});
	await page.waitForTimeout(250);
	await page.screenshot({ path: '/tmp/ppg-npc-shopping.png' });
	await writeFile('docs/perf/npc-shopping.json', JSON.stringify(result, null, 2) + '\n');
} finally {
	await browser.close();
}

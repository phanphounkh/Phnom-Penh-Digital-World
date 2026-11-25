import { expect,it } from 'vitest';
import type { ChunkPayload,ChunkRoad } from '$lib/api/types';
import { CollisionWorld } from '$lib/game/city/collision';
import { Terrain } from '$lib/game/city/terrain';
import { sidewalkRoutes,routeClear } from './sidewalkRoutes';
const road: ChunkRoad={id:1,name:'Mapped street',name_km:null,cls:'residential',w:8,bridge:false,layer:0,oneway:false,af:7,ab:7,pts:[[0,0],[100,0]]};
const payload=(roads: ChunkRoad[])=>[{roads}] as ChunkPayload[];
it('derives deterministic pavement routes outside the rendered carriageway and deduplicates shared chunks',()=>{
 const c=new CollisionWorld(),terrain=new Terrain([]),roads=sidewalkRoutes(payload([road,road]),50,0,c,terrain);
 expect(roads).toHaveLength(2);expect(roads[0].a[1]).toBeCloseTo(-4.8);expect(roads[1].a[1]).toBeCloseTo(4.8);
 expect(sidewalkRoutes(payload([road,road]),50,0,c,terrain)).toEqual(roads);
 for(const r of roads)expect(Math.hypot(r.b[0]-r.a[0],r.b[1]-r.a[1])).toBeLessThanOrEqual(26);
});
it('rejects buildings, water barriers, road crossings and raised or foot-forbidden streets',()=>{
 const terrain=new Terrain([]),c=new CollisionWorld();
 c.addRing('building',[[40,3],[60,3],[60,8],[40,8]],10);
 c.addRing('water',[[40,-8],[60,-8],[60,-3],[40,-3]],0);
 expect(sidewalkRoutes(payload([road]),50,0,c,terrain)).toEqual([]);
 for(const r of [{...road,bridge:true},{...road,layer:1},{...road,af:4,ab:4}])expect(sidewalkRoutes(payload([r]),50,0,new CollisionWorld(),terrain)).toEqual([]);
 const crossing={...road,id:2,pts:[[50,-30],[50,30]] as [number,number][]};
 const routes=sidewalkRoutes(payload([road,crossing]),50,0,new CollisionWorld(),terrain);
 for(const route of routes)expect(routeClear(route,[road,crossing],new CollisionWorld(),terrain)).toBe(true);
});
it('uses the centre of mapped paths, and rejects steep unverified shortcuts',()=>{
 const foot={...road,cls:'footway',w:2};const t=new Terrain([]),c=new CollisionWorld();
 const routes=sidewalkRoutes(payload([foot]),50,0,c,t);expect(routes).toHaveLength(1);expect(routes[0].a[1]).toBe(0);
 const steep={height:(x:number)=>x*2} as unknown as Terrain;
 expect(routeClear(routes[0],[],c,steep)).toBe(false);
});
it('retains a safe section of the real Street 144 pavement instead of rejecting the entire block',async()=>{
 const snapshot=(await import('./fixtures/street144.json')).default;
 const collision=new CollisionWorld();snapshot.polys.forEach((ring,i)=>collision.addRing(`fixture-${i}`,ring as [number,number][],10));
 const roads=snapshot.roads as ChunkRoad[],terrain=new Terrain([]);
 const routes=sidewalkRoutes(payload(roads),763,-60,collision,terrain);
 expect(routes.length).toBeGreaterThan(0);
 for(const route of routes)expect(routeClear(route,roads,collision,terrain)).toBe(true);
});

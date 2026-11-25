/** Decorative pedestrian routes on the same sidewalk offsets rendered by the city.
 * These are game routes, not surveyed pedestrian movements or additional GIS features. */
import type { ChunkPayload, ChunkRoad, XZ } from '$lib/api/types';
import { moveCircle, type CollisionWorld } from '$lib/game/city/collision';
import type { Terrain } from '$lib/game/city/terrain';
export interface WalkRoute { id: string; a: XZ; b: XZ; street: string }
const WALK = new Set(['footway','pedestrian','path','living_street']);
const STREET = new Set(['residential','tertiary','secondary','primary','unclassified']);
function segmentDistance(p: XZ,a: XZ,b: XZ): number {
 const dx=b[0]-a[0],dz=b[1]-a[1],length=dx*dx+dz*dz;
 const t=length?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/length)):0;
 return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dz);
}
function pointClear(x: number,z: number,roads: ChunkRoad[],collision: CollisionWorld): boolean {
 if(collision.containing(x,z))return false;
 const stand=moveCircle(collision,x,z,0,0,.4);
 if(Math.hypot(stand.x-x,stand.z-z)>.01)return false;
 for(const road of roads){
  if(!STREET.has(road.cls))continue;
  for(let k=1;k<road.pts.length;k++)if(segmentDistance([x,z],road.pts[k-1],road.pts[k])<road.w/2+.2)return false;
 }
 return true;
}
export function routeClear(route: WalkRoute, roads: ChunkRoad[], collision: CollisionWorld, terrain: Terrain): boolean {
 const length=Math.hypot(route.b[0]-route.a[0],route.b[1]-route.a[1]);if(length<8)return false;
 const steps=Math.ceil(length*2);
 for(let i=0;i<=steps;i++){
  const t=i/steps,x=route.a[0]+(route.b[0]-route.a[0])*t,z=route.a[1]+(route.b[1]-route.a[1])*t;
  if(!pointClear(x,z,roads,collision))return false;
  if(i){const previous=(i-1)/steps,px=route.a[0]+(route.b[0]-route.a[0])*previous,pz=route.a[1]+(route.b[1]-route.a[1])*previous;if(Math.abs(terrain.height(x,z)-terrain.height(px,pz))>.175)return false;}
 }
 return true;
}
/** Keep clear subsegments: one tree or junction must not discard an entire sidewalk. */
function clearRuns(route: WalkRoute,roads: ChunkRoad[],collision: CollisionWorld,terrain: Terrain): WalkRoute[] {
 const length=Math.hypot(route.b[0]-route.a[0],route.b[1]-route.a[1]),steps=Math.ceil(length*2),out:WalkRoute[]=[];
 let first=-1;
 const at=(i:number):XZ=>[route.a[0]+(route.b[0]-route.a[0])*i/steps,route.a[1]+(route.b[1]-route.a[1])*i/steps];
 for(let i=0;i<=steps+1;i++){
  const p=at(i),previous=at(Math.max(0,i-1));
  const clear=i<=steps&&pointClear(p[0],p[1],roads,collision)&&Math.abs(terrain.height(...p)-terrain.height(...previous))<=.175;
  if(clear&&first<0)first=i;
  if(!clear&&first>=0){const candidate={...route,id:`${route.id}:run${first}`,a:at(first),b:at(i-1)};if(Math.hypot(candidate.b[0]-candidate.a[0],candidate.b[1]-candidate.a[1])>=8)out.push(candidate);first=-1;}
 }
 return out;
}
export function sidewalkRoutes(payloads: ChunkPayload[], x: number,z: number,collision: CollisionWorld,terrain: Terrain): WalkRoute[] {
 const roads=payloads.flatMap(p=>p.roads),candidates: WalkRoute[]=[],seen=new Set<string>();
 for(const road of roads){
  if(road.bridge||road.layer!==0||(!WALK.has(road.cls)&&!STREET.has(road.cls)))continue;
  if(road.af!==undefined&&road.ab!==undefined&&((road.af|road.ab)&1)===0)continue;
  for(let i=1;i<road.pts.length;i++){
   const a=road.pts[i-1],b=road.pts[i],dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz);
   if(length<20||segmentDistance([x,z],a,b)>45)continue;
   const t=Math.max(.5,Math.min(length-.5,((x-a[0])*dx+(z-a[1])*dz)/length));
   const start=Math.max(4,t-13),end=Math.min(length-4,t+13);
   if(end-start<10)continue;
   for(const side of WALK.has(road.cls)?[0]:[-1,1]){
    const offset=side*(road.w/2+.8),nx=-dz/length,nz=dx/length;
    const aa: XZ=[a[0]+dx/length*start+nx*offset,a[1]+dz/length*start+nz*offset];
    const bb: XZ=[a[0]+dx/length*end+nx*offset,a[1]+dz/length*end+nz*offset];
    const id=`${road.id}:${a[0].toFixed(1)}:${a[1].toFixed(1)}:${b[0].toFixed(1)}:${b[1].toFixed(1)}:${side}`;
    if(seen.has(id))continue;seen.add(id);
    candidates.push({id,a:aa,b:bb,street:road.name??'Daun Penh'});
   }
  }
 }
 return candidates.sort((a,b)=>segmentDistance([x,z],a.a,a.b)-segmentDistance([x,z],b.a,b.b)).slice(0,24)
  .flatMap(route=>clearRuns(route,roads,collision,terrain));
}

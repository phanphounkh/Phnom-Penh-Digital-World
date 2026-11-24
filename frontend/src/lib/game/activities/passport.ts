/** Small local activities. Destinations come from imported public arrival points and shops;
 * no independent geography, currency, shop orders or server-authoritative rewards. */
import type { SpawnPoint } from '$lib/api/types';
import type { Shop } from '$lib/api/market';
export const STOPS = ['wat-phnom', 'canadia-garden', 'central-market'] as const;
export const REACH = 25;
export interface Point { x: number; z: number; label: string }
export interface Position { x: number; z: number; mode: string; speed: number }
export interface PracticeDelivery { stage: 'pickup' | 'carrying'; pickup: Point; dropoff: Point }
export interface Passport {
 version: 1;
 stamps: string[];
 delivery: PracticeDelivery | null;
 delivered: boolean;
}
export const emptyPassport = (): Passport => ({version:1,stamps:[],delivery:null,delivered:false});
export const passportKey = (user: string) => `ppw-passport-v1:${user}`;
export const distance = (a: Pick<Point,'x'|'z'>, b: Pick<Point,'x'|'z'>) => Math.hypot(a.x-b.x,a.z-b.z);
export function canInteract(position: Position|null, point: Point): boolean {
 return !!position && Number.isFinite(position.x) && Number.isFinite(position.z)
  && position.mode==='foot' && Math.abs(position.speed)<.5 && distance(position,point)<=REACH;
}
export function stops(places: SpawnPoint[]) {
 return STOPS.flatMap(slug=>places.filter(p=>p.slug===slug).slice(0,1));
}
export const publicPoint = (p: SpawnPoint): Point => ({x:p.x,z:p.z,label:p.name});
export function collectStamp(state: Passport, place: SpawnPoint, position: Position|null): Passport {
 if(!STOPS.some(slug=>slug===place.slug) || state.stamps.includes(place.slug) || !canInteract(position,publicPoint(place))) return state;
 return {...state,stamps:[...state.stamps,place.slug]};
}
export function practiceOffer(shops: Shop[], places: SpawnPoint[]): PracticeDelivery|null {
 const wat=places.find(p=>p.slug==='wat-phnom'), garden=places.find(p=>p.slug==='canadia-garden');
 if(!wat||!garden)return null;
 // Existing sidewalk offset used by world shop navigation; no new business is invented.
 const cafes=shops.filter(s=>s.theme==='cafe'&&s.is_open&&s.status==='active')
  .map(s=>({x:s.unit.door_x+Math.sin(s.unit.heading)*2.5,z:s.unit.door_z+Math.cos(s.unit.heading)*2.5,label:s.name}))
  .filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.z)&&distance(p,wat)<1200&&distance(p,garden)>60)
  .sort((a,b)=>distance(a,wat)-distance(b,wat)||a.label.localeCompare(b.label));
 return cafes[0]?{stage:'pickup',pickup:cafes[0],dropoff:publicPoint(garden)}:null;
}
export function deliveryTarget(state: Passport): Point|null {
 return state.delivery ? state.delivery.stage==='pickup'?state.delivery.pickup:state.delivery.dropoff:null;
}
export function advanceDelivery(state: Passport, position: Position|null): Passport {
 const target=deliveryTarget(state);
 if(!target||!state.delivery||!canInteract(position,target))return state;
 return state.delivery.stage==='pickup'
  ? {...state,delivery:{...state.delivery,stage:'carrying'}}
  : {...state,delivery:null,delivered:true};
}
export const explorer = (state: Passport) => STOPS.every(slug=>state.stamps.includes(slug));
export function restorePassport(value: unknown): Passport {
 if(!value||typeof value!=='object')return emptyPassport();
 const v=value as Partial<Passport>;
 if(v.version!==1)return emptyPassport();
 const stamps=Array.isArray(v.stamps)?STOPS.filter(slug=>v.stamps!.includes(slug)):[];
 const point=(p: unknown): p is Point=>!!p&&typeof p==='object'&&Number.isFinite((p as Point).x)&&Number.isFinite((p as Point).z)
  &&typeof (p as Point).label==='string'&&(p as Point).label.length<=200;
 const job=v.delivery;
 const delivery=job&&(job.stage==='pickup'||job.stage==='carrying')&&point(job.pickup)&&point(job.dropoff)
  ? {stage:job.stage,pickup:{...job.pickup},dropoff:{...job.dropoff}}:null;
 return {version:1,stamps,delivery,delivered:v.delivered===true};
}

import { expect, it } from 'vitest';
import type { SpawnPoint } from '$lib/api/types';
import type { Shop } from '$lib/api/market';
import { emptyPassport, restorePassport, collectStamp, canInteract, advanceDelivery, practiceOffer, deliveryTarget, explorer, passportKey, stops } from './passport';
const place=(slug: string,x=0,z=0)=>({slug,x,z,name:slug,description:'Imported public arrival point'} as SpawnPoint);
const here={x:0,z:0,mode:'foot',speed:0};
const shop=(name: string,x: number,open=true)=>({name,theme:'cafe',is_open:open,status:'active',unit:{door_x:x,door_z:0,heading:0}} as Shop);
it('collects only known nearby discoveries while stopped on foot, once per stop',()=>{
 const initial=emptyPassport(),wat=place('wat-phnom');
 for(const position of [null,{...here,x:26},{...here,mode:'motorbike'},{...here,speed:1},{...here,x:NaN}])
  expect(collectStamp(initial,wat,position)).toBe(initial);
 expect(collectStamp(initial,place('invented-landmark'),here)).toBe(initial);
 const next=collectStamp(initial,wat,here);expect(next.stamps).toEqual(['wat-phnom']);expect(initial.stamps).toEqual([]);
 expect(collectStamp(next,wat,here)).toBe(next);expect(explorer(next)).toBe(false);
 expect(canInteract({...here,x:25},{x:0,z:0,label:'Arrival point'})).toBe(true);
});
it('awards the explorer badge only for the complete three-stop set and filters missing destinations',()=>{
 let state=emptyPassport();for(const slug of ['wat-phnom','central-market','canadia-garden'])state=collectStamp(state,place(slug),here);
 expect(explorer(state)).toBe(true);expect(stops([place('riverside'),place('wat-phnom')]).map(p=>p.slug)).toEqual(['wat-phnom']);
});
it('uses existing open café entrances and imported garden coordinates without inventing fallback businesses',()=>{
 const places=[place('wat-phnom',0,-700),place('canadia-garden',0,-300)];
 const offer=practiceOffer([shop('Closed café',0,false),shop('Far café',3000),shop('Existing café',40)],places)!;
 expect(offer.pickup).toEqual({x:40,z:2.5,label:'Existing café'});
 expect(offer.dropoff).toEqual({x:0,z:-300,label:'canadia-garden'});
 expect(practiceOffer([],places)).toBeNull();expect(practiceOffer([shop('Café',40)],[])).toBeNull();
 expect(practiceOffer([shop('Wrong location',NaN)],places)).toBeNull();
});
it('requires pickup before delivery and stopped proximity at both ends, with an idempotent badge',()=>{
 const delivery={stage:'pickup' as const,pickup:{x:0,z:0,label:'Café'},dropoff:{x:80,z:0,label:'Garden'}};
 const initial={...emptyPassport(),delivery};
 expect(advanceDelivery(initial,{...here,x:80})).toBe(initial);
 expect(advanceDelivery(initial,{...here,mode:'bicycle'})).toBe(initial);
 const carrying=advanceDelivery(initial,here);expect(carrying.delivery?.stage).toBe('carrying');expect(carrying.delivered).toBe(false);
 expect(deliveryTarget(carrying)).toEqual(delivery.dropoff);
 expect(advanceDelivery(carrying,here)).toBe(carrying);
 const done=advanceDelivery(carrying,{...here,x:80});expect(done.delivered).toBe(true);expect(done.delivery).toBeNull();
 expect(advanceDelivery(done,{...here,x:80})).toBe(done);
});
it('restores browser progress defensively and separates accounts',()=>{
 for(const value of [null,'bad',[],{version:2}])expect(restorePassport(value)).toEqual(emptyPassport());
 const restored=restorePassport({version:1,stamps:['wat-phnom','wat-phnom','unknown'],delivered:'yes',delivery:{stage:'carrying',pickup:{x:null,z:0,label:'bad'},dropoff:{x:1,z:1,label:'Garden'}}});
 expect(restored.stamps).toEqual(['wat-phnom']);expect(restored.delivery).toBeNull();expect(restored.delivered).toBe(false);
 const job={...emptyPassport(),delivery:{stage:'carrying' as const,pickup:{x:0,z:0,label:'Café'},dropoff:{x:80,z:0,label:'Garden'}},delivered:true};
 expect(restorePassport(JSON.parse(JSON.stringify(job)))).toEqual(job);
 expect(passportKey('a')).not.toBe(passportKey('b'));
});
it('uses a three-metre reach for delivery while leaving discovery stamp reach unchanged',()=>{
 const state={...emptyPassport(),delivery:{stage:'pickup' as const,pickup:{x:0,z:0,label:'Café'},dropoff:{x:80,z:0,label:'Garden'}}};
 expect(advanceDelivery(state,{...here,x:3.01})).toBe(state);
 expect(advanceDelivery(state,{...here,x:3})).not.toBe(state);
 expect(advanceDelivery(state,{...here,speed:.6})).toBe(state);
 expect(collectStamp(emptyPassport(),place('wat-phnom'),{...here,x:20}).stamps).toEqual(['wat-phnom']);
});

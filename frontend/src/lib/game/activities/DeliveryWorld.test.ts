import { expect, it, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { DeliveryWorld } from './DeliveryWorld';
import { createCharacter, type GameCharacter } from '$lib/game/avatar/character';
import type { CityController } from '$lib/game/city/CityEngine';
vi.mock('$lib/game/avatar/character',()=>({createCharacter:vi.fn()}));
vi.mock('$lib/game/avatar/labels',()=>({roundedLabel:()=>new THREE.Sprite(),disposeSprite:(s: THREE.Sprite)=>s.removeFromParent()}));
const job={stage:'carrying' as const,pickup:{x:0,z:0,label:'Café'},dropoff:{x:10,z:0,label:'Garden'}};
function setup(){
 const wrist=new THREE.Object3D();wrist.name='RightWrist';const avatar=new THREE.Group();avatar.add(wrist);
 const raw={scene:new THREE.Scene(),avatar,terrain:{height:()=>7},localState:()=>({x:10,z:0,yaw:0,speed:0}),riding:null as CityController['riding'],collision:{addCircle:vi.fn(),removeOwner:vi.fn()}};
 const world=new DeliveryWorld(raw as unknown as CityController);return {raw,world,wrist};
}
function character(){return {root:new THREE.Group(),animations:{update:vi.fn()},emotes:{play:vi.fn(),update:vi.fn()},dispose:vi.fn()} as unknown as GameCharacter;}
beforeEach(()=>{vi.mocked(createCharacter).mockReset();});
it('reuses one nearby host and marker, carries at the wrist, and yields the hand to shopping or riding',async()=>{
 const npc=character();vi.mocked(createCharacter).mockResolvedValue(npc);const {raw,world,wrist}=setup();
 expect(world.update(.1,job,false)).toBe(true);await Promise.resolve();
 expect(world.parcel.parent).toBe(wrist);expect(world.marker.position.toArray()).toEqual([10,7,0]);
 expect(raw.collision.addCircle).toHaveBeenCalledWith('practice-garden-host',10,0,.35);
 world.update(.1,job,false);expect(createCharacter).toHaveBeenCalledTimes(1);
 expect(world.update(.1,job,true)).toBe(false);expect(world.parcel.parent).toBeNull();
 raw.riding={id:'v',kind:'motorbike',color:'#fff'};expect(world.update(.1,job,false)).toBe(false);
 raw.riding=null;world.update(.1,job,false);expect(world.parcel.parent).toBe(wrist);
 world.dispose();expect(npc.dispose).toHaveBeenCalled();expect(world.parcel.parent).toBeNull();expect(raw.scene.children).toHaveLength(0);
});
it('reattaches a parcel when the existing avatar rig is rebuilt',()=>{
 vi.mocked(createCharacter).mockResolvedValue(character());const {raw,world,wrist}=setup();world.update(.1,job,false);
 wrist.removeFromParent();const next=new THREE.Object3D();next.name='RightWrist';raw.avatar.add(next);
 world.update(.1,job,false);expect(world.parcel.parent).toBe(next);world.dispose();
});
it('thanks on completion, removes the host after the gesture, and clears cancelled markers',async()=>{
 const npc=character();vi.mocked(createCharacter).mockResolvedValue(npc);const {world}=setup();world.update(.1,job,false);await Promise.resolve();
 world.finish();world.update(.1,null,false);expect(npc.emotes.play).toHaveBeenCalledWith('sampeah');expect(world.marker.visible).toBe(false);
 world.update(5,null,false);expect(npc.dispose).toHaveBeenCalled();expect(world.diagnostics().host).toBe(false);world.dispose();
});
it('disposes a character that finishes loading after the activity was cancelled or unmounted',async()=>{
 let done!: (npc: GameCharacter)=>void;vi.mocked(createCharacter).mockImplementation(()=>new Promise(r=>done=r));
 const {world,raw}=setup();world.update(.1,job,false);world.dispose();const npc=character();done(npc);await Promise.resolve();
 expect(npc.dispose).toHaveBeenCalled();expect(raw.scene.children).toHaveLength(0);
});

import { npcFaceFor } from '$lib/game/avatar/npcIdentity';
/** Local practice-delivery presentation. Reuses real target points and the existing rig.
 * No new lights, geographic features, player avatar or multiplayer entities. */
import * as THREE from 'three';
import type { CityController } from '$lib/game/city/CityEngine';
import { createCharacter, type GameCharacter } from '$lib/game/avatar/character';
import { roundedLabel, disposeSprite } from '$lib/game/avatar/labels';
import { keeperFor, turnTowards } from '$lib/game/shop/Shopkeepers';
import { distance, type PracticeDelivery, type Point } from './passport';

export function createDrinksParcel(): THREE.Group {
 const group=new THREE.Group();group.name='practice-drinks-parcel';
 const card=new THREE.MeshStandardMaterial({color:0xb58a53,roughness:.95});
 const cup=new THREE.MeshStandardMaterial({color:0xf4eee3,roughness:.7});
 const lid=new THREE.MeshStandardMaterial({color:0x244d46,roughness:.65});
 const base=new THREE.Mesh(new THREE.BoxGeometry(.23,.055,.13),card);base.position.y=-.21;group.add(base);
 const handle=new THREE.Mesh(new THREE.TorusGeometry(.065,.006,4,12,Math.PI),card);handle.position.y=-.065;group.add(handle);
 // Origin is the top of the carrying handle, matching the shop's RightWrist socket.
 for(const x of [-.059,.059]) {
  const body=new THREE.Mesh(new THREE.CylinderGeometry(.039,.028,.12,8),cup);body.position.set(x,-.135,0);group.add(body);
  const top=new THREE.Mesh(new THREE.CylinderGeometry(.042,.042,.012,8),lid);top.position.set(x,-.07,0);group.add(top);
 }
 return group;
}
function disposeMeshes(root: THREE.Object3D): void {
 const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>();
 root.traverse(o=>{if(o instanceof THREE.Mesh){geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material])materials.add(m);}});
 geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());root.removeFromParent();
}
export class DeliveryWorld {
 readonly marker=new THREE.Group();
 readonly parcel=createDrinksParcel();
 private label: THREE.Sprite|null=null;
 private markerKey='';
 private character: GameCharacter|null=null;
 private host=new THREE.Group();
 private hostLabel: THREE.Sprite|null=null;
 private hostKey='';
 private loading=false;
 private generation=0;
 private disposed=false;
 private thanks=0;
 private previous: PracticeDelivery|null=null;
 private inverse=new THREE.Quaternion();
 private facing=new THREE.Quaternion();
 private retryAt=0;
 constructor(private city: CityController) {
  this.marker.name='practice-delivery-marker';this.host.name='practice-garden-host';
  const mat=new THREE.MeshBasicMaterial({color:0xf4bb54,transparent:true,opacity:.85,depthWrite:false});
  const ring=new THREE.Mesh(new THREE.RingGeometry(.8,1.05,24),mat);ring.rotation.x=-Math.PI/2;ring.position.y=.05;
  const arrow=new THREE.Mesh(new THREE.ConeGeometry(.16,.28,4),mat);arrow.rotation.z=Math.PI;arrow.position.y=2.65;
  this.marker.add(ring,arrow);this.marker.visible=false;city.scene.add(this.marker);
 }
 private setMarker(target: Point, carrying: boolean): void {
  const key=`${target.x}:${target.z}:${carrying}`;
  if(key===this.markerKey)return;
  this.markerKey=key;
  this.marker.position.set(target.x,this.city.terrain.height(target.x,target.z),target.z);
  if(this.label){disposeSprite(this.label);this.label=null;}
  this.label=roundedLabel([{text:carrying?'Garden host · handoff':'Café · collect drinks',font:'600 22px sans-serif',color:'#fff4d7'}],'#123b3a');
  this.label.position.y=2.25;this.label.scale.multiplyScalar(.6);this.marker.add(this.label);
 }
 private removeHost(): void {
  this.generation++;this.loading=false;this.hostKey='';
  this.city.collision.removeOwner('practice-garden-host');
  this.character?.root.removeFromParent();this.character?.dispose();this.character=null;
  if(this.hostLabel)disposeSprite(this.hostLabel);this.hostLabel=null;this.host.removeFromParent();
 }
 private loadHost(point: Point): void {
  const key=`${point.x}:${point.z}`;
  if(this.hostKey===key || performance.now()<this.retryAt)return;
  this.removeHost();this.hostKey=key;this.loading=true;
  const generation=this.generation;
  const avatar=keeperFor({id:'practice-garden-host',accent_color:'#e8a33d'}).avatar;
  void createCharacter(avatar, {npcFace:npcFaceFor('practice-garden-host')}).then(character=>{
   if(this.disposed||generation!==this.generation){character.dispose();return;}
   this.loading=false;this.character=character;this.host.add(character.root);
   this.host.position.set(point.x,this.city.terrain.height(point.x,point.z),point.z);
   this.hostLabel=roundedLabel([{text:'Garden host · practice',font:'600 20px sans-serif',color:'#fff4d7'}],'#123b3a');
   this.hostLabel.scale.multiplyScalar(.55);this.hostLabel.position.y=2;this.host.add(this.hostLabel);
   this.city.scene.add(this.host);this.city.collision.addCircle('practice-garden-host',point.x,point.z,.35);
  }).catch(()=>{if(generation===this.generation){this.loading=false;this.hostKey='';this.retryAt=performance.now()+10000;}});
 }
 update(dt: number, job: PracticeDelivery|null, handOccupied: boolean): boolean {
  if(this.disposed)return false;
  const me=this.city.localState();
  // Completing or cancelling is distinguished explicitly by finish(), so cancellation never thanks.
  if(!job && this.previous && this.thanks<=0)this.removeHost();
  this.previous=job;
  const target=job?(job.stage==='pickup'?job.pickup:job.dropoff):null;
  this.marker.visible=!!target&&distance(me,target)<180;
  if(target)this.setMarker(target,job?.stage==='carrying');
  if(job?.stage==='carrying'&&distance(me,job.dropoff)<35)this.loadHost(job.dropoff);
  else if(this.thanks<=0&&this.hostKey)this.removeHost();
  if(this.label)this.label.visible=job?.stage!=='carrying'||!this.character;
  this.thanks=Math.max(0,this.thanks-dt);
  if(this.character){
   this.host.rotation.y=turnTowards(this.host.rotation.y,Math.atan2(me.x-this.host.position.x,me.z-this.host.position.z),dt*2);
   this.character.animations.update(dt,0);this.character.emotes.update(dt,false);
   if(!job&&this.thanks===0)this.removeHost();
  }
  const carrying=job?.stage==='carrying'&&!this.city.riding&&!handOccupied;
  const wrist=this.city.avatar.getObjectByName('RightWrist');
  if(carrying&&wrist){
   if(this.parcel.parent!==wrist){this.parcel.removeFromParent();this.parcel.position.set(0,-.045,0);wrist.add(this.parcel);}
   wrist.getWorldQuaternion(this.inverse);this.city.avatar.getWorldQuaternion(this.facing);
   this.parcel.quaternion.copy(this.inverse.invert().multiply(this.facing));
  }else this.parcel.removeFromParent();
  return !!carrying&&!!wrist;
 }
 finish(): void {
  this.thanks=4;this.character?.emotes.play('sampeah');
  if(this.character){
   if(this.hostLabel)disposeSprite(this.hostLabel);
   this.hostLabel=roundedLabel([{text:'អរគុណ! Thank you.',font:'600 22px sans-serif',color:'#fff4d7'}],'#123b3a');
   this.hostLabel.scale.multiplyScalar(.6);this.hostLabel.position.y=2;this.host.add(this.hostLabel);
  }
 }
 diagnostics(){return {marker:this.marker.visible,parcel:!!this.parcel.parent,host:!!this.character,loading:this.loading};}
 dispose(): void {
  this.disposed=true;this.removeHost();disposeMeshes(this.parcel);
  if(this.label)disposeSprite(this.label);this.label=null;disposeMeshes(this.marker);
 }
}

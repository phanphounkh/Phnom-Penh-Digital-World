<script lang="ts">
 import { Compass, MapPin, Check, Award, Coffee, Navigation, PackageCheck } from 'lucide-svelte';
 import type { SpawnPoint } from '$lib/api/types';
 import type { Passport, Point, Position, PracticeDelivery } from '$lib/game/activities/passport';
 import { stops, publicPoint, canInteract, distance, deliveryTarget, explorer, STOPS, DELIVERY_REACH } from '$lib/game/activities/passport';
 let { progress, places, position, offer, routing, storageWarning, syncStatus, onSync, onStamp, onGuide, onStart, onDelivery, onCancel }: {
  progress: Passport; places: SpawnPoint[]; position: Position|null; offer: PracticeDelivery|null;
  routing: boolean; storageWarning: string; syncStatus: 'syncing'|'saved'|'offline'; onSync: ()=>void;
  onStamp: (p: SpawnPoint)=>void; onGuide: (p: Point)=>void; onStart: ()=>void; onDelivery: ()=>void; onCancel: ()=>void;
 } = $props();
 const target=$derived(deliveryTarget(progress));
</script>
<div class="space-y-4" data-testid="passport-panel">
 <div>
  <p class="label flex items-center gap-2"><Compass size={15}/> Your first city adventure</p>
  <h2 class="display mt-1 text-xl font-bold">Daun Penh passport</h2>
  <p class="mt-2 text-sm text-ink-soft">Explore three public places, collect a memory, and try a café delivery. Take your time — there is no deadline.</p>
 </div>
 <div class="rounded-xl bg-saffron-100 p-3" role="status" data-testid="passport-progress">
  <p class="flex items-center gap-2 font-semibold"><Award size={18}/>{progress.stamps.length} / {STOPS.length} discoveries</p>
  <p class="mt-1 text-xs">{explorer(progress)?'Daun Penh Explorer badge earned!':'Collect all three stamps to earn your Daun Penh Explorer badge.'}</p>
  {#if progress.delivered}<p class="mt-2 flex items-center gap-1 text-xs font-semibold"><PackageCheck size={14}/> City Helper badge earned</p>{/if}
 </div>
 <div class="text-xs text-ink-soft" role="status" data-testid="passport-sync">
  {syncStatus === 'saved' ? 'Discoveries and badges saved to your account.' : syncStatus === 'syncing' ? 'Syncing your passport…' : 'Account sync unavailable. Keep playing; your progress will retry syncing.'}
  {#if syncStatus === 'offline'}<button class="ml-2 underline" onclick={onSync}>Retry sync</button>{/if}
 </div>
 {#if storageWarning}<p class="text-xs text-brick-600" role="alert">{storageWarning}</p>{/if}
 {#if progress.delivery && target}
  <button class="btn-primary w-full" disabled={routing} onclick={()=>onGuide(target)} data-testid="delivery-quick-start"><Coffee size={16}/> Continue café delivery</button>
 {:else if offer}
  <button class="btn-primary w-full" onclick={onStart} data-testid="delivery-quick-start"><Coffee size={16}/> {progress.delivered?'Take another café delivery':'Try a café delivery'}</button>
 {/if}
 <div class="space-y-2">
  {#each stops(places) as place (place.slug)}
   {@const collected=progress.stamps.includes(place.slug)}
   {@const point=publicPoint(place)}
   <article class="rounded-xl border border-river-900/15 bg-white p-3" data-testid={`passport-stop-${place.slug}`}>
    <h3 class="flex items-center gap-2 text-sm font-semibold">{#if collected}<Check size={15}/>{:else}<MapPin size={15}/>{/if}{place.name}</h3>
    {#if place.name_km}<p class="khmer mt-1 text-xs" lang="km">{place.name_km}</p>{/if}
    <p class="mt-2 text-xs leading-relaxed text-ink-soft">{place.description}</p>
    <div class="mt-3 flex items-center justify-between gap-2">
     <span class="text-xs text-ink-soft">{position?`${Math.round(distance(position,point))} m away`:'Finding your position…'}</span>
     <button class="btn-ghost px-2 py-1 text-xs" disabled={routing||!position} onclick={()=>onGuide(point)} aria-label={`Passport directions to ${place.name}`}><Navigation size={13}/> Route</button>
     <button class="btn-primary px-2 py-1 text-xs" disabled={collected||!canInteract(position,point)} onclick={()=>onStamp(place)} data-testid={`stamp-${place.slug}`}>{collected?'Stamped':'Collect stamp'}</button>
    </div>
   </article>
  {:else}<p class="text-sm">Public arrival points are loading. Reopen Places if your connection is unavailable.</p>{/each}
 </div>
 <p class="text-xs text-ink-soft">Stop on foot within 25 m of the public arrival point to collect a stamp. Routes follow the existing street network.</p>
 <section class="rounded-xl border border-river-900/15 bg-white p-3" data-testid="practice-delivery">
  <h3 class="flex items-center gap-2 font-semibold"><Coffee size={17}/> Coffee for the garden</h3>
  <p class="mt-2 text-xs leading-relaxed text-ink-soft">A fictional practice delivery: collect drinks outside an existing virtual café, then hand them to the garden host at the Canadia Garden meetup point. No purchase, work role, real order, or payment is involved.</p>
  {#if progress.delivery && target}
   <p class="mt-3 text-sm font-semibold">{progress.delivery.stage==='pickup'?'1. Collect the drinks':'2. Bring the drinks to the garden'}</p>
   <p class="mt-1 text-xs">{target.label} · {position?`${Math.round(distance(position,target))} m`:'Locating…'}</p>
   <div class="mt-3 flex flex-wrap gap-2">
    <button class="btn-ghost px-2 py-1 text-xs" disabled={routing} onclick={()=>onGuide(target)}><Navigation size={13}/> Show route</button>
    <button class="btn-primary px-2 py-1 text-xs" disabled={!canInteract(position,target,DELIVERY_REACH)} onclick={onDelivery} data-testid="delivery-interact">{progress.delivery.stage==='pickup'?'Collect drinks':'Hand over drinks'}</button>
    <button class="btn-quiet px-2 py-1 text-xs" onclick={onCancel}>Cancel</button>
   </div>
   <p class="mt-2 text-xs text-ink-soft">Walk, cycle, or ride. Dismount and stop within 3 m to collect or hand over drinks. Fast travel cancels this practice run.</p>
  {:else if offer}
   <p class="mt-2 text-xs">From {offer.pickup.label} to {offer.dropoff.label}.</p>
   <button class="btn-primary mt-3 w-full" onclick={onStart} data-testid="delivery-start">{progress.delivered?'Take another practice delivery':'Try a delivery'}</button>
  {:else}<p class="mt-3 text-xs">No open virtual café is available in this district. You can still collect passport stamps.</p>{/if}
  <p class="mt-2 text-xs text-ink-soft">Reward: City Helper passport badge. Friends can come along; progress is individual.</p>
 </section>
 <p class="text-xs text-ink-soft">Completed discoveries and badges follow your account across browsers. An unfinished practice delivery stays on this browser. Badges are keepsakes, with no currency value or clothing unlock. Public arrival points use the game’s imported geography; delivery and rewards are fictional.</p>
</div>

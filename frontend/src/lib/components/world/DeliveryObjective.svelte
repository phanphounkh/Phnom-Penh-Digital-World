<script lang="ts">
 import { Coffee, Navigation, PackageCheck, X } from 'lucide-svelte';
 import { distance, type PracticeDelivery, type Position } from '$lib/game/activities/passport';
 let { job, position, routing, onRoute, onCancel }: {job: PracticeDelivery; position: Position; routing: boolean; onRoute: ()=>void; onCancel: ()=>void}=$props();
 const target=$derived(job.stage==='pickup'?job.pickup:job.dropoff);
</script>
<div class="space-y-1" role="region" aria-label="Delivery objective" data-testid="delivery-objective">
 <p class="flex items-center gap-2 font-semibold text-saffron-300">{#if job.stage==='pickup'}<Coffee size={14}/>{:else}<PackageCheck size={14}/>{/if}{job.stage==='pickup'?'1/2 · Collect café drinks':'2/2 · Meet the garden host'}</p>
 <p class="truncate text-xs" title={target.label}>{target.label} · {Math.round(distance(position,target))} m</p>
 <div class="flex items-center gap-2 pt-1">
  <button class="flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-xs hover:bg-white/20" disabled={routing} onclick={onRoute} data-testid="delivery-route"><Navigation size={12}/> Route</button>
  <button class="ml-auto rounded-lg p-1 hover:bg-white/20" onclick={onCancel} aria-label="Cancel practice delivery"><X size={14}/></button>
 </div>
</div>

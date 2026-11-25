<script lang="ts">
 import { Download,Camera } from 'lucide-svelte';
 let {url,place,filename,onRetake}:{url:string;place:string;filename:string;onRetake:()=>void}=$props();
</script>
<h2 class="display text-xl font-bold">Your Phnom Penh postcard</h2>
<p class="mt-2 text-sm text-ink-soft">{place}</p>
<img class="mt-4 max-h-[55dvh] w-full rounded-xl object-contain" src={url} alt={`Game postcard from ${place}`} data-testid="postcard-image" />
<div class="mt-4 flex gap-2">
 <a class="btn-primary flex-1" href={url} download={filename} data-testid="postcard-download"><Download size={16}/> Save picture</a>
 <button class="btn-ghost" onclick={onRetake}><Camera size={16}/> Retake</button>
</div>
<p class="mt-3 text-xs text-ink-soft">A memory from the digital world. Orbit the camera or use an emote, then press K to capture another view.</p>

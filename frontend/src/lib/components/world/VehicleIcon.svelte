<script lang="ts">
	/** Bicycle (lucide) or a step-through motorbike (lucide has none), same stroke style. */
	import { Bike } from 'lucide-svelte';
	let { kind, size = 18 }: { kind: string; size?: number } = $props();
</script>

{#if kind === 'bicycle'}
	<Bike {size} />
{:else}
	<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<circle cx="5" cy="17" r="3" />
		<circle cx="19" cy="17" r="3" />
		<path d="M8 17h6l2-6h3" />
		<path d="M16 11 14 5h-2" />
		<path d="M5 14l3-4h5" />
	</svg>
{/if}

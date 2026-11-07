<script lang="ts">
	import { onMount } from 'svelte';
	import { world } from '$lib/api/endpoints';
	import type { ChunkPayload } from '$lib/api/types';

	/** Decorative render of the real streets around the world origin (from the chunk API). */
	let { radius = 1 }: { radius?: number } = $props();
	let canvas: HTMLCanvasElement;
	let status = $state<'loading' | 'ready' | 'offline'>('loading');

	const ROAD_STYLE: Record<string, [string, number]> = {
		trunk: ['#e8a33d', 4.2],
		primary: ['#e8a33d', 3.6],
		secondary: ['#f4cf8e', 3],
		tertiary: ['#f6f1e6', 2.4],
		residential: ['#f6f1e6', 1.6],
		unclassified: ['#f6f1e6', 1.6],
		service: ['#bfe0d8', 1],
		pedestrian: ['#bfe0d8', 1.2]
	};

	onMount(() => {
		const ctrl = new AbortController();
		(async () => {
			try {
				const keys: string[] = [];
				for (let ix = -radius; ix <= radius; ix++)
					for (let iz = -radius; iz <= radius; iz++) keys.push(`${ix}_${iz}`);
				const chunks = (
					await Promise.allSettled(keys.map((k) => world.chunk(k, ctrl.signal)))
				).flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
				if (!chunks.length) throw new Error('no data');
				draw(chunks);
				status = 'ready';
			} catch {
				status = 'offline';
			}
		})();
		return () => ctrl.abort();
	});

	function draw(chunks: ChunkPayload[]) {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		canvas.width = w * dpr;
		canvas.height = h * dpr;
		const ctx = canvas.getContext('2d')!;
		ctx.scale(dpr, dpr);
		const span = (radius * 2 + 1) * 200;
		const scale = Math.max(w, h) / (span * 0.82);
		const tx = (x: number) => w / 2 + (x - 100) * scale;
		const ty = (z: number) => h / 2 + (z - 100) * scale;
		ctx.fillStyle = '#123b3a';
		ctx.fillRect(0, 0, w, h);
		const areaColor: Record<string, string> = {
			water: '#1f6661',
			park: '#18504d',
			grass: '#18504d',
			temple_grounds: '#3c4a33'
		};
		for (const c of chunks)
			for (const a of c.areas) {
				const fill = areaColor[a.kind];
				if (!fill) continue;
				ctx.fillStyle = fill;
				for (const poly of a.polys) {
					ctx.beginPath();
					poly[0].forEach(([x, z], i) => (i ? ctx.lineTo(tx(x), ty(z)) : ctx.moveTo(tx(x), ty(z))));
					ctx.fill();
				}
			}
		ctx.fillStyle = 'rgba(246,241,230,0.13)';
		for (const c of chunks)
			for (const b of c.buildings)
				for (const poly of b.polys) {
					ctx.beginPath();
					poly[0].forEach(([x, z], i) => (i ? ctx.lineTo(tx(x), ty(z)) : ctx.moveTo(tx(x), ty(z))));
					ctx.fill();
				}
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		const order = Object.keys(ROAD_STYLE).reverse();
		for (const cls of order)
			for (const c of chunks)
				for (const r of c.roads) {
					if (r.cls.replace('_link', '') !== cls) continue;
					const [color, width] = ROAD_STYLE[cls];
					ctx.strokeStyle = color;
					ctx.globalAlpha = cls === 'service' ? 0.35 : 0.85;
					ctx.lineWidth = width;
					ctx.beginPath();
					r.pts.forEach(([x, z], i) => (i ? ctx.lineTo(tx(x), ty(z)) : ctx.moveTo(tx(x), ty(z))));
					ctx.stroke();
				}
		ctx.globalAlpha = 1;
		// The world origin: Phsar Thmei.
		ctx.fillStyle = '#e8a33d';
		ctx.beginPath();
		ctx.arc(tx(0), ty(0), 6, 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = '#fbf0d9';
		ctx.lineWidth = 2;
		ctx.stroke();
	}
</script>

<div class="relative h-full w-full overflow-hidden rounded-[2rem] bg-river-900">
	<canvas bind:this={canvas} class="h-full w-full" aria-hidden="true"></canvas>
	{#if status !== 'ready'}
		<div
			class="absolute inset-0 grid place-items-center text-sm text-river-200"
			style="background-image: linear-gradient(rgba(191,224,216,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(191,224,216,.08) 1px, transparent 1px); background-size: 36px 36px;"
		>
			{status === 'loading' ? 'Loading Daun Penh…' : 'Map preview unavailable'}
		</div>
	{/if}
	<div
		class="absolute right-4 bottom-4 left-4 flex items-end justify-between gap-3 text-[11px] text-river-200"
	>
		<span class="rounded-full bg-river-950/70 px-3 py-1 backdrop-blur">
			<span class="mr-1 inline-block h-2 w-2 rounded-full bg-saffron-500"></span>
			Phsar Thmei · world origin
		</span>
		<span class="rounded-full bg-river-950/70 px-3 py-1 backdrop-blur"
			>© OpenStreetMap contributors</span
		>
	</div>
</div>

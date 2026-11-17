<script lang="ts">
	import { onMount } from 'svelte';
	import { delivery, type DeliveryJob } from '$lib/api/commerce';
	import { transport } from '$lib/api/transport';
	import { formatDistance } from '$lib/game/vehicles/route';
	let { orderId }: { orderId: string } = $props();
	let job = $state<DeliveryJob | null>(null);
	let points = $state<number[][]>([]);
	let error = $state('');
	const bounds = $derived.by(() => {
		const all = [
			...points,
			...(job
				? [
						[job.pickup.x, job.pickup.z],
						[job.dropoff.x, job.dropoff.z]
					]
				: []),
			...(job?.position ? [[job.position.x, job.position.z]] : [])
		];
		if (!all.length) return '0 0 100 100';
		const xs = all.map((p) => p[0]),
			zs = all.map((p) => p[1]);
		const minX = Math.min(...xs),
			minZ = Math.min(...zs);
		return `${minX - 50} ${minZ - 50} ${Math.max(100, Math.max(...xs) - minX) + 100} ${Math.max(100, Math.max(...zs) - minZ) + 100}`;
	});
	const markerRadius = $derived(Number(bounds.split(' ')[3]) / 24);
	onMount(() => {
		let disposed = false;
		async function load() {
			try {
				const value = await delivery.tracking(orderId);
				if (disposed) return;
				job = value;
				error = '';
				if (!points.length) {
					const route = await transport.route(
						[value.pickup.x, value.pickup.z],
						[value.dropoff.x, value.dropoff.z],
						'motorbike'
					);
					if (!disposed) points = route.points;
				}
			} catch {
				if (!disposed) error = 'Tracking is temporarily unavailable. Your order is still saved.';
			}
		}
		void load();
		const timer = setInterval(() => {
			if (!document.hidden) void load();
		}, 5000);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
	});
</script>

<section
	class="rounded-2xl border border-river-900/10 bg-paper p-3"
	data-testid="delivery-tracking"
>
	{#if job}
		<div class="flex flex-wrap items-center justify-between gap-2">
			<h3 class="text-sm font-semibold">Delivery to {job.dropoff.label}</h3>
			<span class="text-xs text-ink-soft"
				>{job.status === 'waiting'
					? 'Waiting for a driver'
					: job.status === 'delivered'
						? 'Delivered'
						: job.status === 'cancelled'
							? 'Cancelled'
							: job.driver_online
								? 'Driver connected · updates every 5 s'
								: 'Driver reconnecting · job saved'}</span
			>
		</div>
		<svg
			viewBox={bounds}
			class="mt-2 h-40 w-full rounded-xl bg-white"
			role="img"
			aria-label="Delivery route on real streets, from shop to public drop-off"
		>
			<polyline
				points={points.map((p) => p.join(',')).join(' ')}
				fill="none"
				stroke="#1f6661"
				stroke-width="4"
				vector-effect="non-scaling-stroke"
			/>
			<circle
				cx={job.pickup.x}
				cy={job.pickup.z}
				r={markerRadius}
				fill="#123b3a"
				vector-effect="non-scaling-stroke"
				stroke="white"
				stroke-width="2"
			/>
			<circle
				cx={job.dropoff.x}
				cy={job.dropoff.z}
				r={markerRadius}
				fill="#e8a33d"
				stroke="#123b3a"
				stroke-width="2"
				vector-effect="non-scaling-stroke"
			/>
			{#if job.position}<circle
					cx={job.position.x}
					cy={job.position.z}
					r={markerRadius * 1.15}
					fill="#3d6fb6"
					stroke="white"
					stroke-width="3"
					vector-effect="non-scaling-stroke"
				/>{/if}
		</svg>
		<p class="mt-2 text-xs text-ink-soft">
			Teal: shop · Gold: drop-off · Blue: assigned driver{job.position
				? ` · ${formatDistance(Math.hypot(job.position.x - job.dropoff.x, job.position.z - job.dropoff.z))} straight-line distance remaining`
				: ''}. Your private address is never shown.
		</p>
	{:else}<p class="text-xs text-ink-soft">Loading delivery tracking…</p>{/if}
	{#if error}<p class="mt-2 text-xs text-brick-600" role="status">
			{error}
		</p>{/if}
</section>

<script lang="ts">
	import { onMount } from 'svelte';
	import { Bike, Navigation, PackageCheck, RefreshCw } from 'lucide-svelte';
	import { delivery, type DriverDashboard } from '$lib/api/commerce';
	import { money } from '$lib/api/market';
	let { onGuide }: { onGuide?: (point: { x: number; z: number; label: string }) => void } =
		$props();
	let data = $state<DriverDashboard | null>(null);
	let error = $state('');
	let busy = $state(false);
	let vehicle = $state<'bicycle' | 'motorbike'>('motorbike');
	const current = $derived(
		data?.jobs.find((j) => ['assigned', 'picked_up', 'in_transit'].includes(j.status))
	);
	async function load() {
		try {
			data = await delivery.dashboard();
			vehicle = data.vehicle_kind;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load delivery jobs.';
		}
	}
	onMount(() => {
		void load();
		const timer = setInterval(() => {
			if (!document.hidden && !busy) void load();
		}, 5000);
		return () => clearInterval(timer);
	});
	async function act(fn: () => Promise<unknown>) {
		if (busy) return;
		busy = true;
		error = '';
		try {
			await fn();
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Please try again.';
		} finally {
			busy = false;
		}
	}
</script>

<div class="space-y-4" data-testid="driver-panel">
	<p class="rounded-xl bg-saffron-100 p-3 text-xs leading-relaxed">
		Deliver inside the virtual city. Earnings are demo credits; no real delivery or payment takes
		place. Accepting a job shares your virtual position with its buyer until delivery or
		cancellation.
	</p>
	{#if error}<p class="alert-error" role="alert">{error}</p>{/if}
	{#if data}
		<div
			class="flex items-center justify-between gap-3 rounded-xl border border-river-900/10 bg-white p-3"
		>
			<div>
				<p class="font-semibold">
					{data.online ? 'You’re online' : 'You’re offline'}
				</p>
				<p class="text-xs text-ink-soft">
					{data.online ? 'Ready to receive job offers' : 'Go online when you’re ready'}
				</p>
			</div>
			<button
				class={data.online ? 'btn-ghost px-3 py-2' : 'btn-primary px-3 py-2'}
				disabled={busy}
				onclick={() => act(() => delivery.availability(!data!.online, vehicle))}
				>{data.online ? 'Go offline' : 'Go online'}</button
			>
		</div>
		<label class="label" for="delivery-vehicle">Your vehicle</label>
		<select
			id="delivery-vehicle"
			class="input"
			bind:value={vehicle}
			disabled={busy || !!current}
			onchange={() => act(() => delivery.availability(data!.online, vehicle))}
		>
			<option value="motorbike">Motorbike</option><option value="bicycle">Bicycle</option>
		</select>
		{#if current}
			<article
				class="rounded-2xl border border-river-500/30 bg-white p-4"
				data-testid="active-delivery"
			>
				<p class="eyebrow">Current delivery</p>
				<h3 class="mt-1 font-semibold">{current.number}</h3>
				<p class="mt-2 text-sm">
					{current.shop_name} → {current.dropoff.label}
				</p>
				<p class="mt-1 text-xs text-ink-soft">
					{money(current.fee_minor)} demo earnings · {current.status.replaceAll('_', ' ')}
				</p>
				<div class="mt-4 grid gap-2">
					{#if onGuide}<button
							class="btn-ghost"
							onclick={() =>
								onGuide?.(
									current.status === 'assigned'
										? { ...current.pickup, label: current.shop_name }
										: { ...current.dropoff }
								)}
							><Navigation size={16} /> Directions to {current.status === 'assigned'
								? 'pickup'
								: 'drop-off'}</button
						>
					{:else}<a class="btn-ghost" href="/world">Enter the city to deliver</a>{/if}
					{#if current.status === 'assigned'}
						<button
							class="btn-primary"
							disabled={busy}
							onclick={() => act(() => delivery.advance(current.id, 'pickup'))}
							data-testid="delivery-pickup"><Bike size={16} /> Collect at shop</button
						>
						<button
							class="btn-quiet"
							disabled={busy}
							onclick={() => act(() => delivery.advance(current.id, 'release'))}>Release job</button
						>
					{:else if current.status === 'picked_up'}
						<button
							class="btn-primary"
							disabled={busy}
							onclick={() => act(() => delivery.advance(current.id, 'start'))}
							>Start delivery</button
						>
					{:else}
						<button
							class="btn-primary"
							disabled={busy}
							onclick={() => act(() => delivery.advance(current.id, 'deliver'))}
							data-testid="delivery-complete"><PackageCheck size={16} /> Deliver at drop-off</button
						>
					{/if}
				</div>
				<p class="hint">
					Collection and delivery require you to be within 15 m of the marked point. Your job is
					kept if you disconnect.
				</p>
			</article>
		{:else}
			<div class="flex items-center justify-between">
				<h3 class="font-semibold">Available jobs</h3>
				<button class="btn-quiet" aria-label="Refresh jobs" disabled={busy} onclick={load}
					><RefreshCw size={16} /></button
				>
			</div>
			{#each data.offers as job (job.id)}
				<article class="rounded-xl border border-river-900/10 bg-white p-3">
					<p class="font-semibold">{job.shop_name}</p>
					<p class="mt-1 text-sm text-ink-soft">To {job.dropoff.label}</p>
					<div class="mt-3 flex items-center justify-between gap-2">
						<span class="text-sm">{money(job.fee_minor)} demo</span><button
							class="btn-primary px-3 py-2"
							disabled={busy}
							onclick={() => act(() => delivery.accept(job.id))}>Accept job</button
						>
					</div>
				</article>
			{:else}<p class="rounded-xl bg-paper-2 p-4 text-sm text-ink-soft">
					{data.online
						? 'No jobs ready yet. Offers appear when a seller finishes preparing a delivery order.'
						: 'Go online to see available jobs.'}
				</p>{/each}
		{/if}
		{#if data.jobs.some((j) => j.status === 'delivered')}<p class="text-xs text-ink-soft">
				{data.jobs.filter((j) => j.status === 'delivered').length} recent deliveries completed.
				<a class="underline" href="/wallet">View demo earnings</a>
			</p>{/if}
	{:else}<p class="text-sm text-ink-soft">Loading your delivery dashboard…</p>{/if}
</div>

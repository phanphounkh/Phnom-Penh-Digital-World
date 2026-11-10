<script lang="ts">
	/** My vehicles (V): get a free starter bicycle or motorbike, find them, bring them, repaint. */
	import { MapPin, Navigation, Palette, Trash2 } from 'lucide-svelte';
	import VehicleIcon from './VehicleIcon.svelte';
	import { ApiError } from '$lib/api/client';
	import { transport, VEHICLE_COLORS, type Vehicle } from '$lib/api/transport';
	import { formatDistance } from '$lib/game/vehicles/route';
	import { MODES, VEHICLE_KINDS, type VehicleKind } from '$lib/game/vehicles/specs';

	let {
		version,
		here,
		riding,
		online,
		onGuide,
		onRide
	}: {
		/** Bumped by the world session when my vehicles change. */
		version: number;
		here: { x: number; z: number } | null;
		riding: string | null;
		online: boolean;
		/** Show the walking route to a vehicle. */
		onGuide: (v: Vehicle) => void;
		/** Get on a vehicle that is within reach. */
		onRide: (v: Vehicle) => void;
	} = $props();

	let vehicles = $state<Vehicle[] | null>(null);
	let error = $state('');
	let busy = $state('');
	let painting = $state('');

	async function load() {
		try {
			vehicles = await transport.vehicles();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not load your vehicles.';
		}
	}

	$effect(() => {
		void version;
		void load();
	});

	async function run(key: string, action: () => Promise<unknown>) {
		busy = key;
		error = '';
		try {
			await action();
			await load();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Something went wrong.';
		} finally {
			busy = '';
		}
	}

	const distance = (v: Vehicle) => (here ? Math.hypot(v.x - here.x, v.z - here.z) : null);
	const missing = $derived(VEHICLE_KINDS.filter((k) => vehicles && !vehicles.some((v) => v.kind === k)));
	const label = (k: VehicleKind) => MODES[k].label;
</script>

<div class="flex h-full flex-col" data-testid="garage-panel">
	<p class="text-xs text-ink-soft">
		Your vehicles stay where you park them. Ride on the streets (keep right; one-way streets are marked) and park at the
		kerb, in a car park or an alley.
	</p>
	{#if error}<p class="alert-error mt-2 text-sm" data-testid="garage-error">{error}</p>{/if}
	<div class="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
		{#if !vehicles && !error}<p class="text-sm text-ink-soft">Loading…</p>{/if}
		{#each vehicles ?? [] as v (v.id)}
			{@const d = distance(v)}
			<div class="rounded-xl border border-river-900/10 bg-white p-3" data-testid={`vehicle-${v.kind}`} data-status={riding === v.id ? 'riding' : v.status}>
				<div class="flex items-center gap-3">
					<span class="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white" style="background: {v.color}">
						<VehicleIcon kind={v.kind} size={20} />
					</span>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-semibold">{v.name} <span class="font-mono text-[11px] text-ink-soft">{v.plate}</span></p>
						<p class="truncate text-xs text-ink-soft" data-testid="vehicle-where">
							{#if riding === v.id}Riding now{:else}<MapPin size={11} class="inline" /> {v.street ?? 'Off-street'}{#if d !== null} · {formatDistance(d)} away{/if}{/if}
						</p>
						{#if v.street_km && riding !== v.id}<p class="khmer truncate text-[11px] text-ink-soft" lang="km">{v.street_km}</p>{/if}
					</div>
					<span class="shrink-0 text-[11px] text-ink-soft">{(v.odometer_m / 1000).toFixed(1)} km</span>
				</div>
				{#if riding !== v.id}
					<div class="mt-2 flex flex-wrap gap-1.5">
						{#if d !== null && d < 2.8}
							<button class="btn-primary px-3 py-1 text-xs" onclick={() => onRide(v)} data-testid="vehicle-ride">Ride (F)</button>
						{:else}
							<button class="btn-ghost px-2.5 py-1 text-xs" onclick={() => onGuide(v)} disabled={d === null}><Navigation size={12} class="inline" /> Walk there</button>
							<button class="btn-ghost px-2.5 py-1 text-xs" disabled={!online || !!riding || busy === v.id} onclick={() => run(v.id, () => transport.summon(v.id))} data-testid="vehicle-summon">Bring it here</button>
						{/if}
						<button class="btn-ghost px-2.5 py-1 text-xs" aria-label="Repaint" onclick={() => (painting = painting === v.id ? '' : v.id)}><Palette size={12} /></button>
						<button class="btn-ghost px-2.5 py-1 text-xs text-brick-600" aria-label="Give it back" title="Give it back" disabled={busy === v.id} onclick={() => run(v.id, () => transport.remove(v.id))}><Trash2 size={12} /></button>
					</div>
					{#if painting === v.id}
						<div class="mt-2 flex gap-1.5" role="group" aria-label="Colour">
							{#each VEHICLE_COLORS as c (c)}
								<button class="h-6 w-6 rounded-full border-2 {v.color === c ? 'border-ink' : 'border-white'} shadow" style="background: {c}" aria-label={c} onclick={() => run(v.id, () => transport.update(v.id, { color: c }))}></button>
							{/each}
						</div>
					{/if}
				{/if}
			</div>
		{/each}
		{#each missing as kind (kind)}
			<div class="flex items-center gap-3 rounded-xl border border-dashed border-river-900/25 p-3">
				<span class="grid h-10 w-10 place-items-center rounded-full bg-paper-2 text-ink-soft">
					<VehicleIcon {kind} size={20} />
				</span>
				<div class="min-w-0 flex-1">
					<p class="text-sm font-semibold">{label(kind)} <span class="khmer text-xs text-ink-soft" lang="km">{MODES[kind].labelKm}</span></p>
					<p class="text-xs text-ink-soft">Up to {Math.round(MODES[kind].topSpeed * 3.6)} km/h · free starter vehicle</p>
				</div>
				<button class="btn-primary px-3 py-1.5 text-xs" disabled={busy === kind || !online} onclick={() => run(kind, () => transport.create(kind))} data-testid={`get-${kind}`}>Get one</button>
			</div>
		{/each}
	</div>
	<p class="mt-2 text-[11px] text-ink-soft">Vehicles are free in this phase and have no monetary value. A vehicle is parked next to you on the nearest street.</p>
</div>

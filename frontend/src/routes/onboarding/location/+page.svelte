<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Search, Lock, Users, EyeOff, MapPin, Trash2, CircleCheck, CircleAlert } from 'lucide-svelte';
	import LocationMap from '$lib/components/LocationMap.svelte';
	import { geo, me, world } from '$lib/api/endpoints';
	import { ApiError } from '$lib/api/client';
	import type { Address, ReverseResult, SearchResult, SpawnPoint } from '$lib/api/types';
	import { session } from '$lib/stores/session.svelte';

	const user = $derived(session.user);
	const needsAddress = $derived(!!user?.onboarding.needs_address);

	let spawnPoints = $state<SpawnPoint[]>([]);
	let playableBbox = $state<[number, number, number, number] | null>(null);
	let addresses = $state<Address[]>([]);
	let spawnId = $state<string | null>(null);
	let visible = $state<boolean | null>(null);

	let query = $state('');
	let results = $state<SearchResult[]>([]);
	let searching = $state(false);
	let focus = $state<{ lat: number; lon: number; zoom?: number } | null>(null);

	let pin = $state<{ lat: number; lon: number } | null>(null);
	let place = $state<ReverseResult | null>(null);
	let label = $state('Home');
	let addressLine = $state('');
	let details = $state('');

	let busy = $state(false);
	let error = $state('');

	onMount(async () => {
		const [spawns, config, saved] = await Promise.all([
			geo.spawnPoints(),
			world.config(),
			me.addresses().catch(() => [] as Address[])
		]);
		spawnPoints = spawns;
		playableBbox = config.regions[0]?.bbox ?? null;
		addresses = saved;
		visible = user?.world_visible ?? null;
	});

	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let searchCtrl: AbortController | undefined;
	function onSearchInput() {
		clearTimeout(searchTimer);
		searchCtrl?.abort();
		if (query.trim().length < 2) {
			results = [];
			return;
		}
		searchTimer = setTimeout(async () => {
			searchCtrl = new AbortController();
			searching = true;
			try {
				results = await geo.search(query.trim(), searchCtrl.signal);
			} catch {
				/* aborted or offline */
			} finally {
				searching = false;
			}
		}, 250);
	}

	function chooseResult(r: SearchResult) {
		focus = { lat: r.lat, lon: r.lon, zoom: r.kind === 'khan' ? 14 : 17 };
		results = [];
		query = r.name_en ?? r.name;
	}

	async function pick(lat: number, lon: number) {
		pin = { lat, lon };
		place = null;
		try {
			place = await geo.reverse(lat, lon);
			if (!addressLine || addressLine.startsWith('Near ')) {
				addressLine = place.street
					? `Near ${place.street}${place.area ? ', ' + place.area : ''}`
					: place.area
						? `Near ${place.area}`
						: '';
			}
		} catch (e) {
			if (e instanceof ApiError && e.status === 422) {
				place = {
					lat, lon, street: null, street_km: null, area: null, area_kind: null,
					in_playable_area: false, in_service_area: false, world: null
				};
			}
		}
	}

	function chooseSpawn(id: string) {
		spawnId = id;
		const sp = spawnPoints.find((s) => s.id === id);
		if (sp) focus = { lat: sp.lat, lon: sp.lon, zoom: 16.5 };
	}

	async function removeAddress(id: string) {
		await me.deleteAddress(id);
		addresses = addresses.filter((a) => a.id !== id);
	}

	const pinValid = $derived(!!pin && !!place?.in_service_area && addressLine.trim().length >= 3);
	const hasAddress = $derived(addresses.length > 0 || pinValid);
	const canFinish = $derived(!!spawnId && visible !== null && (!needsAddress || hasAddress));

	async function finish() {
		busy = true;
		error = '';
		try {
			if (pin && pinValid) {
				const saved = await me.addAddress({
					label: label.trim() || 'Home',
					lat: pin.lat,
					lon: pin.lon,
					address_line: addressLine.trim(),
					details: details.trim() || null,
					is_default: true
				});
				addresses = [...addresses.map((a) => ({ ...a, is_default: false })), saved];
				pin = null;
			}
			await me.chooseSpawn(spawnId!, visible!);
			await me.completeOnboarding();
			await session.refresh();
			await goto('/world', { invalidateAll: true });
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not save your location.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Location · Phnom Penh Digital World</title></svelte:head>

<div class="grid gap-6 lg:grid-cols-[1.25fr_1fr]">
	<section class="relative h-[460px] lg:sticky lg:top-6 lg:h-[calc(100dvh-7rem)]">
		<LocationMap
			{spawnPoints}
			selectedSpawn={spawnId}
			{pin}
			{focus}
			{playableBbox}
			onpick={pick}
			onspawn={chooseSpawn}
		/>
		<div class="absolute top-3 right-14 left-3">
			<div class="relative">
				<Search size={16} class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-soft" />
				<input
					class="input py-2.5 pl-10 shadow-lg"
					placeholder="Search a khan, market, street or landmark…"
					aria-label="Search places in Phnom Penh"
					bind:value={query}
					oninput={onSearchInput}
				/>
				{#if results.length || searching}
					<ul class="absolute top-full right-0 left-0 z-10 mt-2 max-h-72 overflow-auto rounded-2xl bg-white p-1 shadow-xl">
						{#if searching && !results.length}<li class="px-3 py-2 text-sm text-ink-soft">Searching…</li>{/if}
						{#each results as r (r.kind + r.name + r.lat)}
							<li>
								<button class="flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left hover:bg-paper" onclick={() => chooseResult(r)}>
									<MapPin size={16} class="mt-0.5 shrink-0 text-saffron-600" />
									<span class="min-w-0 flex-1">
										<span class="block truncate text-sm font-semibold">{r.name_en ?? r.name}</span>
										<span class="block truncate text-xs text-ink-soft">
											{r.kind}{#if r.name_km}<span class="khmer" lang="km"> · {r.name_km}</span>{/if}
											{#if r.in_playable_area}<span class="ml-1 font-semibold text-saffron-600">· 3D</span>{/if}
										</span>
									</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</section>

	<section class="space-y-5">
		<div>
			<p class="eyebrow">Step 4 of 4</p>
			<h1 class="display mt-1 text-3xl font-bold">Choose your location</h1>
		</div>

		<div class="card space-y-4">
			<div class="flex items-start gap-3">
				<span class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brick-500/10 text-brick-600"><Lock size={18} /></span>
				<div>
					<h2 class="font-semibold">
						Private delivery address {#if needsAddress}<span class="text-brick-600">*</span>{:else}<span class="text-xs font-normal text-ink-soft">(optional)</span>{/if}
					</h2>
					<p class="text-xs text-ink-soft">
						Only you can see it. It is never shown in the 3D world and never sets your avatar's
						position.{needsAddress ? ' Buyers need one for deliveries.' : ''}
					</p>
				</div>
			</div>

			{#each addresses as a (a.id)}
				<div class="flex items-center gap-3 rounded-xl bg-paper px-3 py-2 text-sm">
					<CircleCheck size={16} class="text-river-700" />
					<span class="flex-1"><strong>{a.label}</strong> · {a.address_line}</span>
					<button class="btn-quiet p-1" aria-label="Delete address" onclick={() => removeAddress(a.id)}><Trash2 size={15} /></button>
				</div>
			{/each}

			{#if !pin}
				<p class="rounded-xl border border-dashed border-river-900/20 px-3 py-3 text-sm text-ink-soft">
					Tap the map to drop a pin{addresses.length ? ' for another address' : ''}. Drag it to adjust.
				</p>
			{:else}
				<div class="space-y-3">
					{#if place && !place.in_service_area}
						<p class="alert-error flex items-center gap-2"><CircleAlert size={16} /> That point is outside Phnom Penh. Deliveries are Phnom Penh only.</p>
					{:else if place}
						<p class="flex items-center gap-2 text-sm text-river-700">
							<CircleCheck size={16} /> Inside Phnom Penh{place.area ? ` · ${place.area}` : ''}
						</p>
					{/if}
					<div class="grid grid-cols-[7rem_1fr] gap-2">
						<input class="input" aria-label="Address label" maxlength="40" bind:value={label} />
						<input class="input" aria-label="Address line" placeholder="House no., street" maxlength="200" bind:value={addressLine} />
					</div>
					<input class="input" aria-label="Address details" placeholder="Floor, apartment, landmark (optional)" maxlength="500" bind:value={details} />
					<button class="btn-quiet text-xs" onclick={() => { pin = null; place = null; }}>Remove pin</button>
				</div>
			{/if}
		</div>

		<div class="card space-y-3">
			<div class="flex items-start gap-3">
				<span class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-saffron-100 text-saffron-600"><MapPin size={18} /></span>
				<div>
					<h2 class="font-semibold">Public spawn area <span class="text-brick-600">*</span></h2>
					<p class="text-xs text-ink-soft">Where your avatar appears in the 3D city. Always a public place.</p>
				</div>
			</div>
			<div class="grid gap-2" role="radiogroup" aria-label="Spawn area">
				{#each spawnPoints as sp (sp.id)}
					<button
						role="radio"
						aria-checked={spawnId === sp.id}
						data-testid={`spawn-${sp.slug}`}
						class="rounded-xl border-2 px-3 py-2.5 text-left transition {spawnId === sp.id ? 'border-river-800 bg-river-200/40' : 'border-river-900/10 hover:border-river-900/30'}"
						onclick={() => chooseSpawn(sp.id)}
					>
						<span class="block text-sm font-semibold">{sp.name}
							{#if sp.name_km}<span class="khmer ml-1 font-normal text-ink-soft" lang="km">{sp.name_km}</span>{/if}</span>
						<span class="block text-xs text-ink-soft">{sp.description}</span>
					</button>
				{/each}
			</div>
		</div>

		<div class="card space-y-3">
			<h2 class="font-semibold">Visibility <span class="text-brick-600">*</span></h2>
			<p class="text-xs text-ink-soft">Choose whether other online players can see your avatar. You can change this any time.</p>
			<div class="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Visibility">
				<button role="radio" aria-checked={visible === true} data-testid="visible-yes"
					class="flex items-center gap-3 rounded-xl border-2 p-3 text-left text-sm {visible === true ? 'border-river-800 bg-river-200/40' : 'border-river-900/10'}"
					onclick={() => (visible = true)}><Users size={18} /> <span><strong>Visible</strong><br /><span class="text-xs text-ink-soft">Others can see and greet you</span></span></button>
				<button role="radio" aria-checked={visible === false} data-testid="visible-no"
					class="flex items-center gap-3 rounded-xl border-2 p-3 text-left text-sm {visible === false ? 'border-river-800 bg-river-200/40' : 'border-river-900/10'}"
					onclick={() => (visible = false)}><EyeOff size={18} /> <span><strong>Hidden</strong><br /><span class="text-xs text-ink-soft">Explore privately</span></span></button>
			</div>
		</div>

		{#if error}<p class="alert-error" role="alert">{error}</p>{/if}
		<button class="btn-accent w-full py-4 text-base" disabled={!canFinish || busy} onclick={finish} data-testid="enter-city">
			{busy ? 'Preparing the city…' : 'Enter the city'}
		</button>
		{#if !canFinish}
			<p class="text-center text-xs text-ink-soft">
				{!spawnId ? 'Choose a spawn area. ' : ''}{visible === null ? 'Choose your visibility. ' : ''}{needsAddress && !hasAddress ? 'Add a delivery address inside Phnom Penh.' : ''}
			</p>
		{/if}
	</section>
</div>

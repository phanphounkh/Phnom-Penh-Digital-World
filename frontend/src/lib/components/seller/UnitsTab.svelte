<script lang="ts">
	import { onMount } from 'svelte';
	import { ApiError } from '$lib/api/client';
	import { seller, market, type Claim, type Merchant, type Transfer, type Unit } from '$lib/api/market';
	import UnitMap from './UnitMap.svelte';

	let { merchant, onchange }: { merchant: Merchant; onchange: () => void } = $props();

	let claims = $state<Claim[]>([]);
	let transfers = $state<Transfer[]>([]);
	let visible = $state<Unit[]>([]);
	let selected = $state<Unit | null>(null);
	let code = $state('');
	let evidence = $state('');
	let documentId = $state('');
	let transferTo = $state<Record<string, string>>({});
	let error = $state('');
	let notice = $state('');
	let busy = $state(false);
	let mapRef = $state<UnitMap>();
	const canClaim = $derived(merchant.status === 'approved' && merchant.seller_role === 'active');

	async function load() {
		[claims, transfers] = await Promise.all([seller.claims(), seller.transfers()]);
	}
	onMount(() => void load().catch(() => {}));

	async function lookup() {
		error = '';
		try {
			selected = await market.unit(code.trim().toUpperCase());
			mapRef?.focus(selected.lat, selected.lon);
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Unit not found.';
		}
	}

	async function claim() {
		if (!selected) return;
		busy = true;
		error = notice = '';
		try {
			const c = await seller.claim(selected.code, evidence || undefined, documentId || undefined);
			notice =
				c.status === 'approved'
					? `Unit ${c.unit.code} is yours until ${new Date(c.expires_at!).toLocaleDateString()}. Your shop is open in the 3D city.`
					: `Claim for ${c.unit.code} sent for review.`;
			selected = await market.unit(selected.code);
			await load();
			onchange();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Claim failed.';
		} finally {
			busy = false;
		}
	}

	async function act(fn: () => Promise<unknown>, message: string) {
		error = notice = '';
		try {
			await fn();
			notice = message;
			await load();
			onchange();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Action failed.';
		}
	}

	const LIVE = new Set(['pending', 'approved']);
</script>

<div class="space-y-5">
	{#if !canClaim}
		<p class="alert border-saffron-500/40 bg-saffron-300/30 text-sm">You can claim a unit once an administrator approves your merchant application.</p>
	{/if}
	{#if error}<p class="alert-error">{error}</p>{/if}
	{#if notice}<p class="alert border-river-500/30 bg-river-200/40" data-testid="units-notice">{notice}</p>{/if}

	<div class="grid gap-4 lg:grid-cols-[1fr_20rem]">
		<div class="h-[26rem]"><UnitMap bind:this={mapRef} selected={selected?.code ?? null} onselect={(u) => (selected = u)} onunits={(u) => (visible = u)} /></div>
		<div class="flex flex-col gap-3">
			<div class="flex gap-2">
				<input class="input py-2" placeholder="Unit code, e.g. DP-0412" bind:value={code} onkeydown={(e) => e.key === 'Enter' && lookup()} data-testid="unit-code" />
				<button class="btn-ghost py-2" onclick={lookup}>Find</button>
			</div>
			{#if selected}
				<div class="card space-y-2 p-4" data-testid="unit-detail">
					<p class="display text-lg font-bold">{selected.code}</p>
					<p class="text-sm">{selected.street_name ?? 'Unnamed street'}{#if selected.street_name_km}<span class="khmer block text-xs text-ink-soft" lang="km">{selected.street_name_km}</span>{/if}</p>
					<p class="text-xs text-ink-soft">{selected.width_m} m frontage × {selected.depth_m} m · status <strong>{selected.status}</strong>{selected.shop_name ? ` · ${selected.shop_name}` : ''}</p>
					{#if selected.requires_verification}
						<p class="rounded-lg bg-saffron-300/30 p-2 text-xs">
							<strong>{selected.real_business_name}</strong> is a real business here. Only its owner (or someone it authorises) may claim this unit: attach a document and explain. An administrator reviews it, and the business can dispute any claim.
						</p>
						<textarea class="input min-h-16 text-sm" placeholder="Your connection to this business" bind:value={evidence} maxlength="600"></textarea>
						<select class="input py-2 text-sm" bind:value={documentId}>
							<option value="">Choose an uploaded document…</option>
							{#each merchant.documents as d (d.id)}<option value={d.id}>{d.original_name}</option>{/each}
						</select>
					{/if}
					<button class="btn-primary w-full" disabled={!canClaim || busy || selected.status !== 'available'} onclick={claim} data-testid="claim-unit">
						{selected.status === 'available' ? (selected.requires_verification ? 'Request this unit' : 'Claim this unit') : 'Not available'}
					</button>
					<p class="text-[11px] text-ink-soft">A virtual storefront only: it gives no right to the real building. Claims last 30 days and can be renewed.</p>
				</div>
			{:else}
				<p class="text-sm text-ink-soft">Pick a unit on the map or from the list.</p>
			{/if}
			<div class="min-h-0 flex-1 overflow-y-auto rounded-xl border border-river-900/10 bg-white" data-testid="unit-list">
				{#each visible.filter((u) => u.status === 'available').slice(0, 40) as u (u.code)}
					<button class="flex w-full items-center justify-between gap-2 border-b border-river-900/5 px-3 py-1.5 text-left text-xs hover:bg-paper-2" onclick={() => { selected = u; mapRef?.focus(u.lat, u.lon); }}>
						<span class="font-mono font-semibold">{u.code}</span>
						<span class="min-w-0 flex-1 truncate">{u.street_name ?? '—'}</span>
						{#if u.requires_verification}<span class="chip">verify</span>{/if}
					</button>
				{/each}
			</div>
		</div>
	</div>

	<div>
		<h3 class="font-semibold">My units</h3>
		<div class="mt-2 space-y-2">
			{#each claims as c (c.id)}
				<div class="card flex flex-wrap items-center gap-3 p-3 text-sm" data-testid="claim">
					<span class="font-mono font-semibold">{c.unit.code}</span>
					<span class="min-w-0 flex-1 truncate">{c.unit.street_name ?? ''}</span>
					<span class="chip">{c.status}</span>
					{#if c.expires_at && LIVE.has(c.status)}<span class="text-xs text-ink-soft">{c.status === 'approved' ? 'until' : 'review by'} {new Date(c.expires_at).toLocaleDateString()}</span>{/if}
					{#if c.decision_reason}<span class="w-full text-xs text-ink-soft">{c.decision_reason}</span>{/if}
					{#if c.status === 'approved'}
						<button class="btn-ghost py-1 text-xs" onclick={() => act(() => seller.renew(c.id), 'Renewed for 30 days.')}>Renew</button>
						<input class="input w-36 py-1 text-xs" placeholder="Transfer to username" bind:value={transferTo[c.id]} />
						<button class="btn-ghost py-1 text-xs" disabled={!transferTo[c.id]} onclick={() => act(() => seller.transfer(c.id, transferTo[c.id]), 'Transfer offered.')}>Transfer</button>
					{/if}
					{#if LIVE.has(c.status)}
						<button class="btn-ghost py-1 text-xs text-brick-600" onclick={() => confirm(`Release ${c.unit.code}? Your shop there closes.`) && act(() => seller.release(c.id), 'Unit released.')}>Release</button>
					{/if}
				</div>
			{:else}
				<p class="text-sm text-ink-soft">No units yet.</p>
			{/each}
		</div>
		{#if transfers.length}
			<h3 class="mt-4 font-semibold">Transfers</h3>
			{#each transfers as t (t.id)}
				<div class="card mt-2 flex flex-wrap items-center gap-3 p-3 text-sm">
					<span class="font-mono">{t.unit_code}</span>
					<span class="flex-1">{t.direction === 'incoming' ? `from ${t.from_merchant}` : `to ${t.to_merchant}`}</span>
					<span class="chip">{t.status}</span>
					{#if t.status === 'pending' && t.direction === 'incoming'}
						<button class="btn-primary py-1 text-xs" onclick={() => act(() => seller.respondTransfer(t.id, 'accept'), 'Transfer accepted: the unit is yours.')}>Accept</button>
						<button class="btn-ghost py-1 text-xs" onclick={() => act(() => seller.respondTransfer(t.id, 'decline'), 'Declined.')}>Decline</button>
					{:else if t.status === 'pending'}
						<button class="btn-ghost py-1 text-xs" onclick={() => act(() => seller.respondTransfer(t.id, 'cancel'), 'Cancelled.')}>Cancel</button>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>

<script lang="ts">
	/**
	 * Your spot on the street (renew, hand over to another seller, give it up) and the free spots
	 * near where you stand in the city. A spot is claimed in person: walk to it (Go there draws the
	 * route), and Claim becomes available when you stand in front of it.
	 */
	import { onDestroy, onMount } from 'svelte';
	import { MapPin, Route as RouteIcon } from 'lucide-svelte';
	import { ApiError } from '$lib/api/client';
	import { market, seller, type Claim, type MerchantDocument, type Transfer, type Unit } from '$lib/api/market';
	import { compassLabel } from '$lib/geo/projection';
	import { offset, type Here } from './types';

	let {
		claims,
		documents = [],
		here,
		onRoute,
		onchange
	}: {
		claims: Claim[];
		documents?: MerchantDocument[];
		here: () => Here | null;
		onRoute: (target: { x: number; z: number; label: string }) => void;
		onchange: () => void | Promise<void>;
	} = $props();

	/** How close (metres from the middle of the spot) you must stand to claim it. */
	const REACH = 25;
	/** How far around you to look for free spots (degrees; about 450 m). */
	const AROUND = 0.004;

	let me = $state<Here | null>(null);
	let nearby = $state<Unit[]>([]);
	let looked = $state(false);
	let transfers = $state<Transfer[]>([]);
	let picked = $state<string | null>(null);
	let evidence = $state('');
	let documentId = $state('');
	let handing = $state<string | null>(null);
	let handTo = $state('');
	let releasing = $state<string | null>(null);
	let busy = $state(false);
	let notice = $state('');
	let error = $state('');

	const LIVE = new Set<Claim['status']>(['pending', 'approved']);
	const live = $derived(claims.filter((c) => LIVE.has(c.status)));
	const past = $derived(claims.filter((c) => !LIVE.has(c.status)).slice(0, 5));

	const place = (u: Unit) => (me ? offset(me, u.lat, u.lon) : null);
	const free = $derived(
		nearby
			.map((u) => ({ unit: u, at: place(u) }))
			.filter((r): r is { unit: Unit; at: NonNullable<ReturnType<typeof place>> } => !!r.at)
			.sort((a, b) => a.at.distance - b.at.distance)
			.slice(0, 12)
	);

	async function look() {
		me = here();
		if (!me) return;
		error = '';
		try {
			nearby = await market.units([me.lon - AROUND, me.lat - AROUND, me.lon + AROUND, me.lat + AROUND], true);
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not look for spots.';
		}
		looked = true;
	}
	async function loadTransfers() {
		transfers = await seller.transfers().catch(() => []);
	}

	let timer: ReturnType<typeof setInterval> | undefined;
	onMount(() => {
		void look();
		void loadTransfers();
		// Follow the player while the panel is open: distances and "Claim" stay current.
		timer = setInterval(() => (me = here()), 1000);
	});
	onDestroy(() => clearInterval(timer));

	function route(x: number, z: number, label: string) {
		onRoute({ x, z, label });
	}
	function routeToClaim(c: Claim) {
		const at = place(c.unit);
		if (at) route(at.x, at.z, `Spot ${c.unit.code}`);
	}

	async function act(fn: () => Promise<unknown>, message: string) {
		error = notice = '';
		busy = true;
		try {
			await fn();
			notice = message;
			await Promise.all([onchange(), loadTransfers()]);
			handing = releasing = null;
			handTo = '';
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'That did not work.';
		} finally {
			busy = false;
		}
	}

	async function claim(u: Unit) {
		error = notice = '';
		busy = true;
		try {
			const c = await seller.claim(u.code, u.requires_verification ? evidence.trim() || undefined : undefined, u.requires_verification ? documentId || undefined : undefined);
			notice = c.status === 'approved' ? `Spot ${c.unit.code} is yours until ${new Date(c.expires_at!).toLocaleDateString()}. Your shop is open here.` : `Your request for ${c.unit.code} is waiting for an administrator's check.`;
			picked = null;
			evidence = documentId = '';
			await Promise.all([onchange(), look()]);
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not claim the spot.';
		} finally {
			busy = false;
		}
	}

	const until = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
	const PAST: Partial<Record<Claim['status'], string>> = { rejected: 'Not approved', released: 'Given up', expired: 'Ran out', revoked: 'Taken back', transferred: 'Handed over' };
</script>

<div class="spots">
	{#if notice}<p class="ok" data-testid="units-notice">{notice}</p>{/if}
	{#if error}<p class="alert-error">{error}</p>{/if}

	<section aria-labelledby="your-spot">
		<h3 id="your-spot">Your spot</h3>
		{#each live as c (c.id)}
			{@const at = place(c.unit)}
			<article class="mine" data-testid="claim">
				<div class="top">
					<MapPin size={18} class="text-river-700" />
					<div class="grow">
						<p class="strong">{c.unit.street_name ?? 'Unnamed street'} <span class="code">{c.unit.code}</span></p>
						<p class="muted">{c.status === 'approved' ? `Yours until ${until(c.expires_at)}` : `Waiting for an administrator's check${c.expires_at ? ` (by ${until(c.expires_at)})` : ''}`}{at ? ` · ${Math.round(at.distance)} m from you` : ''}</p>
					</div>
					<button type="button" class="btn-ghost px-3 py-1.5 text-xs" onclick={() => routeToClaim(c)} disabled={!at}><RouteIcon size={13} class="inline" /> Go there</button>
				</div>
				<div class="actions">
					{#if c.status === 'approved'}
						<button type="button" class="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onclick={() => act(() => seller.renew(c.id), 'Renewed for 30 more days.')}>Renew 30 days</button>
						<button type="button" class="btn-quiet px-3 py-1.5 text-xs" onclick={() => ((handing = handing === c.id ? null : c.id), (releasing = null))}>Hand over…</button>
					{/if}
					<button type="button" class="btn-quiet px-3 py-1.5 text-xs text-brick-600" onclick={() => ((releasing = releasing === c.id ? null : c.id), (handing = null))}>Give up…</button>
				</div>
				{#if handing === c.id}
					<form class="inline" onsubmit={(e) => (e.preventDefault(), act(() => seller.transfer(c.id, handTo.trim().replace(/^@/, '')), `Offered to @${handTo.trim().replace(/^@/, '')}. The spot moves when they accept.`))}>
						<input class="input py-1.5 text-sm" placeholder="Another seller's username" bind:value={handTo} required minlength="3" maxlength="40" />
						<button class="btn-primary px-3 py-1.5 text-xs" disabled={busy}>Offer the spot</button>
					</form>
				{/if}
				{#if releasing === c.id}
					<div class="inline warn-box">
						<p class="warn">Give up {c.unit.code}? {c.status === 'approved' ? 'Your shop there closes and anyone can claim the spot.' : 'Your request is withdrawn.'}</p>
						<button type="button" class="release" disabled={busy} onclick={() => act(() => seller.release(c.id), `${c.unit.code} given up.`)}>Give it up</button>
						<button type="button" class="btn-quiet px-3 py-1.5 text-xs" onclick={() => (releasing = null)}>Keep it</button>
					</div>
				{/if}
			</article>
		{:else}
			<p class="muted">No spot yet. Pick a free one below and walk there to claim it.</p>
		{/each}
		{#if past.length}
			<details class="past">
				<summary>Earlier spots</summary>
				{#each past as c (c.id)}<p class="muted">{c.unit.code} · {c.unit.street_name ?? ''} · {PAST[c.status] ?? c.status}{c.decision_reason ? `: ${c.decision_reason}` : ''}</p>{/each}
			</details>
		{/if}
	</section>

	{#if transfers.some((t) => t.status === 'pending')}
		<section aria-labelledby="handovers">
			<h3 id="handovers">Handovers</h3>
			{#each transfers.filter((t) => t.status === 'pending') as t (t.id)}
				<div class="row-card">
					<p class="grow">{t.direction === 'incoming' ? `@${t.from_merchant} offers you spot ${t.unit_code}` : `You offered ${t.unit_code} to @${t.to_merchant}`}</p>
					{#if t.direction === 'incoming'}
						<button type="button" class="btn-primary px-3 py-1.5 text-xs" disabled={busy} onclick={() => act(() => seller.respondTransfer(t.id, 'accept'), `Spot ${t.unit_code} is yours.`)}>Accept</button>
						<button type="button" class="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onclick={() => act(() => seller.respondTransfer(t.id, 'decline'), 'Declined.')}>Decline</button>
					{:else}
						<button type="button" class="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onclick={() => act(() => seller.respondTransfer(t.id, 'cancel'), 'Offer withdrawn.')}>Withdraw</button>
					{/if}
				</div>
			{/each}
		</section>
	{/if}

	<section aria-labelledby="free-spots">
		<div class="head">
			<h3 id="free-spots">Free spots near you</h3>
			<button type="button" class="btn-quiet px-2 py-1 text-xs" onclick={look}>Look again</button>
		</div>
		<p class="muted">Claim a spot in person: press Go there, walk to it, then Claim. A spot is a place in the game city only, not the real building. It lasts 30 days and you can renew it.</p>
		{#if !me}
			<p class="muted">Enter the city to see spots near you.</p>
		{:else if looked && !free.length}
			<p class="muted">No free spots within about 450 m. Walk to another street, then Look again.</p>
		{/if}
		<ul class="free" data-testid="unit-list">
			{#each free as { unit: u, at }, i (u.code)}
				{@const close = at.distance <= REACH}
				<li class:close data-testid="free-spot" data-code={u.code}>
					<div class="line">
						<div class="grow">
							<p class="strong">{u.street_name ?? 'Unnamed street'} <span class="code">{u.code}</span></p>
							<p class="muted">{close ? (i === 0 ? 'You are here' : `${Math.round(at.distance)} m · close enough to claim`) : `${Math.round(at.distance)} m ${compassLabel(at.heading)}`} · {u.width_m} m wide{u.requires_verification ? ` · ${u.real_business_name ?? 'a real business'}` : ''}</p>
						</div>
						{#if close}
							{#if u.requires_verification}
								<button type="button" class="btn-ghost px-3 py-1.5 text-xs" onclick={() => (picked = picked === u.code ? null : u.code)}>Request…</button>
							{:else}
								<button type="button" class="btn-primary px-3 py-1.5 text-xs" disabled={busy} onclick={() => claim(u)} data-testid="claim-unit">Claim</button>
							{/if}
						{:else}
							<button type="button" class="btn-ghost px-3 py-1.5 text-xs" onclick={() => route(at.x, at.z, `Spot ${u.code}`)} data-testid="spot-route"><RouteIcon size={13} class="inline" /> Go there</button>
						{/if}
					</div>
					{#if picked === u.code}
						<div class="verify">
							<p class="muted"><strong>{u.real_business_name}</strong> is a real business here. Only its owner, or someone it allows, may take this spot. Explain your connection and attach a document from your business details; an administrator checks it and the business can object.</p>
							<textarea class="input min-h-16 text-sm" placeholder="Your connection to this business" bind:value={evidence} maxlength="600"></textarea>
							<select class="input py-2 text-sm" bind:value={documentId}>
								<option value="">Choose a document…</option>
								{#each documents as d (d.id)}<option value={d.id}>{d.original_name}</option>{/each}
							</select>
							<button type="button" class="btn-primary py-2 text-sm" disabled={busy || !evidence.trim() || !documentId} onclick={() => claim(u)}>Send the request</button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
</div>

<style>
	.spots { display: grid; gap: 18px; }
	section { display: grid; gap: 8px; }
	h3 { margin: 0; font-family: var(--font-display); font-size: 17px; font-weight: 700; color: var(--color-ink); }
	.head { display: flex; justify-content: space-between; align-items: center; }
	.mine { display: grid; gap: 8px; padding: 12px; border-radius: 16px; background: rgba(255, 255, 255, 0.09); border: 1px solid rgba(255, 255, 255, 0.14); }
	.top, .line, .row-card { display: flex; align-items: center; gap: 10px; }
	.row-card { padding: 10px 12px; border-radius: 14px; background: rgba(255, 255, 255, 0.09); border: 1px solid rgba(255, 255, 255, 0.14); font-size: 14px; }
	.grow { flex: 1; min-width: 0; }
	.strong { font-weight: 600; font-size: 14px; }
	.code { font-size: 11px; font-weight: 700; color: var(--color-ink-soft); margin-left: 4px; }
	.muted { font-size: 13px; color: var(--color-ink-soft); }
	.actions, .inline { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
	.inline input { flex: 1; min-width: 10rem; }
	.warn-box { padding: 8px 10px; border-radius: 12px; background: rgba(255, 120, 90, 0.14); }
	.warn { flex-basis: 100%; font-size: 13px; font-weight: 600; color: #ffb59c; }
	.release { padding: 6px 12px; border-radius: 10px; font-size: 12px; font-weight: 700; background: var(--color-brick-600); color: #fff; }
	.past summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--color-ink-soft); }
	.free { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
	.free li { padding: 10px 12px; border-radius: 14px; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.1); }
	.free li.close { background: rgba(255, 255, 255, 0.14); border-color: var(--color-saffron-300); box-shadow: 0 0 0 2px rgba(244, 207, 142, 0.25); }
	.verify { display: grid; gap: 8px; margin-top: 8px; }
	.ok { font-size: 13px; padding: 8px 12px; border-radius: 12px; background: rgba(191, 224, 216, 0.16); }
</style>

<script lang="ts">
	/** What to do next (a checklist until the shop is open), today's figures and new orders. */
	import { Check } from 'lucide-svelte';
	import { ApiError } from '$lib/api/client';
	import { money, seller, type Claim, type Merchant, type Order, type Product, type Revenue, type Shop } from '$lib/api/market';
	import { ago, type Tab } from './types';

	let {
		merchant,
		shop,
		claims,
		ordersVersion = 0,
		go
	}: { merchant: Merchant; shop: Shop | null; claims: Claim[]; ordersVersion?: number; go: (tab: Tab) => void } = $props();

	let products = $state<Product[]>([]);
	let revenue = $state<Revenue | null>(null);
	let fresh = $state<Order[]>([]);
	let error = $state('');
	let busy = $state('');

	const approved = $derived(merchant.status === 'approved');
	async function load() {
		if (!approved) return;
		try {
			const [p, r, o] = await Promise.all([seller.products(), seller.revenue(30), seller.orders('open')]);
			products = p;
			revenue = r;
			fresh = o.filter((x) => x.status === 'paid');
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not load today.';
		}
	}
	$effect(() => {
		void ordersVersion;
		void approved;
		void load();
	});

	const withPhoto = $derived(products.filter((p) => p.status === 'active' && p.image_url).length);
	const steps = $derived<{ done: boolean; text: string; tab: Tab; action: string; detail?: string }[]>([
		{ done: approved, text: 'Business approved', tab: 'business', action: 'Details' },
		{ done: claims.some((c) => c.status === 'approved'), text: 'A spot on a street', tab: 'spot', action: 'Find a spot' },
		{ done: !!shop?.tagline, text: "Your shop's name, colours and tagline", tab: 'look', action: 'Set it up' },
		{ done: withPhoto >= 3, text: 'Three products with photos', tab: 'products', action: 'Add products', detail: `${Math.min(withPhoto, 3)} of 3` },
		{ done: !!shop?.is_open, text: 'Open for customers', tab: 'look', action: 'Open it' }
	]);
	const left = $derived(steps.filter((s) => !s.done).length);
	const today = new Date().toISOString().slice(0, 10);
	const todays = $derived(revenue?.days.find((d) => d.day === today));

	async function accept(o: Order) {
		busy = o.id;
		try {
			await seller.transition(o.id, 'merchant_accepted');
			await load();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not accept the order.';
		} finally {
			busy = '';
		}
	}
</script>

<div class="today">
	{#if left}
		<section class="card-ish" aria-labelledby="getting-open">
			<div class="row"><h3 id="getting-open">Get your shop open</h3><span class="muted">{steps.length - left} of {steps.length}</span></div>
			<ol class="steps">
				{#each steps as s (s.text)}
					<li class:done={s.done}>
						<span class="check" aria-hidden="true">{#if s.done}<Check size={13} strokeWidth={3} />{/if}</span>
						<span class="grow">{s.text}{#if s.detail && !s.done}<span class="muted">{` · ${s.detail}`}</span>{/if}</span>
						{#if !s.done && (approved || s.tab === 'business')}<button type="button" class="btn-ghost px-3 py-1 text-xs" onclick={() => go(s.tab)}>{s.action}</button>{/if}
					</li>
				{/each}
			</ol>
		</section>
	{/if}

	{#if approved}
		<section class="figures" aria-label="Sales">
			<div><p class="muted">Sales today</p><p class="figure">{money(todays?.revenue_minor ?? 0)}</p></div>
			<div><p class="muted">Orders to do</p><p class="figure">{revenue?.open_orders ?? 0}</p></div>
			<div><p class="muted">Last 30 days</p><p class="figure" data-testid="revenue">{money(revenue?.total_revenue_minor ?? 0)}</p></div>
		</section>
		<p class="demo">Demo money only: these figures have no value and nothing is paid out.</p>

		<section aria-labelledby="new-orders">
			<div class="row"><h3 id="new-orders">New orders</h3>{#if fresh.length}<span class="count">{fresh.length}</span>{/if}</div>
			{#each fresh as o (o.id)}
				<div class="order">
					<div class="grow">
						<p class="strong">{o.number} · {o.items.reduce((n, i) => n + i.quantity, 0)} item{o.items.reduce((n, i) => n + i.quantity, 0) === 1 ? '' : 's'} · {o.fulfillment === 'delivery' ? 'delivery' : 'pickup'}</p>
						<p class="muted">@{o.buyer_username} · {ago(o.paid_at ?? o.created_at)} · {money(o.total_minor)}</p>
					</div>
					<button type="button" class="btn-primary px-4 py-2 text-sm" disabled={busy === o.id} onclick={() => accept(o)}>Accept</button>
				</div>
			{:else}
				<p class="muted">No new orders. They appear here (and on the Orders tab) as they come in.</p>
			{/each}
		</section>
	{/if}
	{#if error}<p class="alert-error">{error}</p>{/if}
</div>

<style>
	.today { display: grid; gap: 16px; }
	h3 { margin: 0; font-family: var(--font-display); font-size: 17px; font-weight: 700; color: var(--color-river-950); }
	.row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
	.card-ish { padding: 14px; border-radius: 16px; background: rgba(255, 255, 255, 0.7); border: 1px solid rgba(18, 59, 58, 0.1); }
	.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
	.steps li { display: flex; align-items: center; gap: 10px; font-size: 14px; }
	.steps li.done { color: var(--color-ink-soft); }
	.check { width: 22px; height: 22px; border-radius: 999px; display: grid; place-items: center; flex: none; border: 2px solid rgba(18, 59, 58, 0.2); }
	.done .check { background: var(--color-river-700); border-color: var(--color-river-700); color: #fff; }
	.grow { flex: 1; min-width: 0; }
	.muted { font-size: 13px; color: var(--color-ink-soft); }
	.figures { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
	.figures > div { padding: 10px 12px; border-radius: 14px; background: rgba(255, 255, 255, 0.7); border: 1px solid rgba(18, 59, 58, 0.1); }
	.figure { font-family: var(--font-display); font-size: 22px; font-weight: 700; color: var(--color-river-950); font-variant-numeric: tabular-nums; }
	.demo { font-size: 11px; color: var(--color-ink-soft); margin-top: -8px; }
	.count { font-size: 12px; font-weight: 700; padding: 1px 8px; border-radius: 999px; background: var(--color-saffron-500); color: #0b2524; }
	.order { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 14px; background: #fff; border: 1px solid rgba(18, 59, 58, 0.1); margin-bottom: 6px; }
	.strong { font-weight: 600; font-size: 14px; }
	@media (max-width: 480px) { .figure { font-size: 18px; } }
</style>

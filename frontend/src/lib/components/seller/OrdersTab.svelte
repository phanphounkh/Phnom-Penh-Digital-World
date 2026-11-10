<script lang="ts">
	import { ApiError } from '$lib/api/client';
	import { money, ORDER_LABEL, seller, type Order, type OrderStatus, type Revenue } from '$lib/api/market';

	let { version = 0 }: { version?: number } = $props();
	let orders = $state<Order[]>([]);
	let revenue = $state<Revenue | null>(null);
	let filter = $state<'open' | ''>('open');
	let error = $state('');
	let reasons = $state<Record<string, string>>({});

	const ACTION: Partial<Record<OrderStatus, string>> = {
		merchant_accepted: 'Accept',
		preparing: 'Start preparing',
		ready_for_pickup: 'Ready for pickup',
		completed: 'Collected',
		refunded: 'Cancel & refund'
	};

	async function load() {
		try {
			[orders, revenue] = await Promise.all([seller.orders(filter || undefined), seller.revenue(30)]);
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not load orders.';
		}
	}
	$effect(() => {
		void version;
		void filter;
		void load();
	});

	async function move(o: Order, to: OrderStatus) {
		error = '';
		if (to === 'refunded' && !confirm(`Cancel ${o.number} and refund the buyer (demo)?`)) return;
		try {
			await seller.transition(o.id, to, reasons[o.id] || undefined);
			await load();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not update the order.';
		}
	}
</script>

<div class="space-y-4">
	{#if revenue}
		<div class="grid gap-3 sm:grid-cols-4" data-testid="revenue">
			<div class="card p-3"><p class="text-xs text-ink-soft">Demo revenue (30 days)</p><p class="display text-2xl font-bold">{money(revenue.total_revenue_minor)}</p></div>
			<div class="card p-3"><p class="text-xs text-ink-soft">Paid orders</p><p class="display text-2xl font-bold">{revenue.total_orders}</p></div>
			<div class="card p-3"><p class="text-xs text-ink-soft">Open orders</p><p class="display text-2xl font-bold">{revenue.open_orders}</p></div>
			<div class="card p-3"><p class="text-xs text-ink-soft">Refunded (demo)</p><p class="display text-2xl font-bold">{money(revenue.refunded_minor)}</p></div>
		</div>
		{#if revenue.days.length}
			<div class="flex h-24 items-end gap-1 rounded-xl bg-white p-2" aria-label="Revenue per day">
				{#each revenue.days as d (d.day)}
					{@const max = Math.max(...revenue.days.map((x) => x.revenue_minor), 1)}
					<div class="flex-1 rounded-t bg-river-700" style="height: {Math.max(4, (d.revenue_minor / max) * 100)}%" title={`${d.day}: ${money(d.revenue_minor)} · ${d.orders} orders`}></div>
				{/each}
			</div>
		{/if}
		<p class="text-[11px] text-ink-soft">Demo payments only: these figures have no monetary value and nothing is paid out.</p>
	{/if}
	<div class="flex gap-2">
		<button class="chip py-2 {filter === 'open' ? 'bg-river-900 text-paper' : ''}" onclick={() => (filter = 'open')}>Open</button>
		<button class="chip py-2 {filter === '' ? 'bg-river-900 text-paper' : ''}" onclick={() => (filter = '')}>All</button>
	</div>
	{#if error}<p class="alert-error">{error}</p>{/if}
	{#each orders as o (o.id)}
		<article class="card space-y-2 p-4" data-testid="merchant-order" data-status={o.status}>
			<div class="flex flex-wrap items-baseline justify-between gap-2">
				<p class="font-semibold">{o.number} <span class="chip ml-1">{ORDER_LABEL[o.status]}</span></p>
				<p class="text-xs text-ink-soft">@{o.buyer_username} · pickup at {o.pickup_unit ?? '—'} · {new Date(o.created_at).toLocaleString()}</p>
			</div>
			<ul class="text-sm">
				{#each o.items as i (i.name)}<li>{i.quantity} × {i.name} <span class="text-ink-soft">{money(i.line_total_minor)}</span></li>{/each}
			</ul>
			{#if o.note}<p class="text-xs">Note: “{o.note}”</p>{/if}
			<p class="text-sm font-semibold">{money(o.total_minor)}{o.refunded_minor ? ` · refunded ${money(o.refunded_minor)}` : ''}</p>
			{#if o.allowed.length}
				<div class="flex flex-wrap items-center gap-2">
					{#each o.allowed.filter((s) => s !== 'refunded') as to (to)}
						<button class="btn-primary py-1.5 text-xs" onclick={() => move(o, to)} data-testid={`order-${to}`}>{ACTION[to] ?? to}</button>
					{/each}
					{#if o.allowed.includes('refunded')}
						<input class="input w-48 py-1 text-xs" placeholder="Reason (optional)" bind:value={reasons[o.id]} />
						<button class="btn-ghost py-1.5 text-xs text-brick-600" onclick={() => move(o, 'refunded')}>Cancel & refund</button>
					{/if}
				</div>
			{/if}
		</article>
	{:else}
		<p class="text-sm text-ink-soft">No {filter === 'open' ? 'open ' : ''}orders.</p>
	{/each}
</div>

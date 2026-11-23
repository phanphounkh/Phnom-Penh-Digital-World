<script lang="ts">
	/**
	 * Orders as a board: New, Preparing, Ready (and Done when showing all). Each order shows its
	 * next step as one button; cancelling and refunding sits behind "More" with a confirmation.
	 * New orders arrive live (`version` is bumped by the world's order messages).
	 */
	import { ApiError } from '$lib/api/client';
	import { money, seller, type Order, type OrderStatus } from '$lib/api/market';
	import { ago } from './types';

	let { version = 0 }: { version?: number } = $props();

	let orders = $state<Order[]>([]);
	let all = $state(false);
	let error = $state('');
	let busy = $state('');
	let more = $state<string | null>(null);
	let reason = $state('');
	let confirming = $state<string | null>(null);

	async function load() {
		try {
			orders = await seller.orders(all ? undefined : 'open');
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not load orders.';
		}
	}
	$effect(() => {
		void version;
		void all;
		void load();
	});

	const NEXT: Partial<Record<OrderStatus, string>> = {
		merchant_accepted: 'Accept',
		preparing: 'Start preparing',
		ready_for_pickup: 'Mark ready',
		completed: 'Handed over'
	};
	const COLUMNS: { title: string; has: OrderStatus[] }[] = [
		{ title: 'New', has: ['paid'] },
		{ title: 'Preparing', has: ['merchant_accepted', 'preparing'] },
		{ title: 'Ready', has: ['ready_for_pickup', 'assigned_to_driver', 'picked_up', 'in_transit', 'delivered'] },
		{ title: 'Done', has: ['completed', 'refunded', 'cancelled'] }
	];
	const columns = $derived(COLUMNS.filter((c) => all || c.title !== 'Done').map((c) => ({ ...c, orders: orders.filter((o) => c.has.includes(o.status)) })));
	const WAITING: Partial<Record<OrderStatus, string>> = {
		ready_for_pickup: 'Waiting for the buyer at your counter',
		assigned_to_driver: 'A driver is on the way to collect it',
		picked_up: 'With the driver',
		in_transit: 'With the driver',
		delivered: 'Delivered',
		completed: 'Done',
		refunded: 'Refunded (demo)',
		cancelled: 'Cancelled'
	};

	async function move(o: Order, to: OrderStatus) {
		busy = o.id;
		error = '';
		try {
			await seller.transition(o.id, to, to === 'refunded' ? reason.trim() || undefined : undefined);
			more = confirming = null;
			reason = '';
			await load();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not update the order.';
		} finally {
			busy = '';
		}
	}
</script>

<div class="board-wrap">
	<div class="filters" role="radiogroup" aria-label="Which orders">
		<button type="button" role="radio" aria-checked={!all} class="chip py-1.5 {!all ? 'bg-river-900 text-paper' : ''}" onclick={() => (all = false)}>To do</button>
		<button type="button" role="radio" aria-checked={all} class="chip py-1.5 {all ? 'bg-river-900 text-paper' : ''}" onclick={() => (all = true)}>All</button>
	</div>
	{#if error}<p class="alert-error">{error}</p>{/if}
	<div class="board" class:four={all}>
		{#each columns as col (col.title)}
			<section class="col" aria-label={col.title}>
				<h3>{col.title} <span>{col.orders.length}</span></h3>
				{#each col.orders as o (o.id)}
					{@const next = o.allowed.find((s) => s !== 'refunded' && s !== 'cancelled' && NEXT[s])}
					<article class="order" data-testid="merchant-order" data-status={o.status}>
						<div class="top"><strong>{o.number}</strong><span class="muted">{ago(o.paid_at ?? o.created_at)}</span></div>
						<ul>{#each o.items as i (i.name)}<li>{i.quantity} × {i.name}</li>{/each}</ul>
						{#if o.note}<p class="note">“{o.note}”</p>{/if}
						<div class="top"><span class="chip">{o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}</span><span class="muted">@{o.buyer_username}</span><strong class="total">{money(o.total_minor)}</strong></div>
						{#if next}
							<button type="button" class="btn-primary w-full py-2 text-sm" disabled={busy === o.id} onclick={() => move(o, next)} data-testid={`order-${next}`}>{NEXT[next]}</button>
						{:else}
							<p class="muted">{WAITING[o.status] ?? ''}</p>
						{/if}
						{#if o.allowed.includes('refunded')}
							{#if more === o.id}
								<div class="more">
									<input class="input py-1.5 text-sm" placeholder="Reason for the buyer (optional)" maxlength="300" bind:value={reason} />
									{#if confirming === o.id}
										<p class="warn">Cancel {o.number} and refund {money(o.total_minor)} (demo)?</p>
										<div class="row"><button type="button" class="btn-ghost py-1.5 text-xs" onclick={() => (confirming = more = null)}>Keep the order</button><button type="button" class="refund" disabled={busy === o.id} onclick={() => move(o, 'refunded')}>Cancel and refund</button></div>
									{:else}
										<button type="button" class="btn-ghost py-1.5 text-xs text-brick-600" onclick={() => (confirming = o.id)}>Cancel and refund…</button>
									{/if}
								</div>
							{:else}
								<button type="button" class="more-link" onclick={() => ((more = o.id), (confirming = null), (reason = ''))}>More ▾</button>
							{/if}
						{/if}
					</article>
				{:else}
					<p class="empty">Nothing here.</p>
				{/each}
			</section>
		{/each}
	</div>
</div>

<style>
	.board-wrap { display: grid; gap: 10px; }
	.filters { display: flex; gap: 6px; }
	.board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; align-items: start; }
	.board.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
	.col { display: grid; gap: 8px; padding: 8px; border-radius: 14px; background: rgba(236, 228, 211, 0.7); }
	h3 { margin: 0; display: flex; justify-content: space-between; font-size: 13px; font-weight: 700; color: var(--color-ink-soft); }
	.order { display: grid; gap: 6px; padding: 10px; border-radius: 12px; background: #fff; border: 1px solid rgba(18, 59, 58, 0.1); font-size: 13px; }
	.top { display: flex; align-items: center; gap: 6px; justify-content: space-between; flex-wrap: wrap; }
	ul { margin: 0; padding: 0; list-style: none; color: var(--color-ink-soft); }
	.total { font-variant-numeric: tabular-nums; }
	.muted { font-size: 12px; color: var(--color-ink-soft); }
	.note { font-size: 12px; font-style: italic; }
	.empty { font-size: 12px; color: var(--color-ink-soft); padding: 4px; }
	.more { display: grid; gap: 6px; }
	.more-link { justify-self: center; font-size: 12px; font-weight: 600; color: var(--color-ink-soft); }
	.warn { font-size: 12px; font-weight: 600; color: var(--color-brick-600); }
	.row { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
	.refund { padding: 6px 10px; border-radius: 10px; font-size: 12px; font-weight: 700; background: var(--color-brick-600); color: #fff; }
	@media (max-width: 760px) { .board, .board.four { grid-template-columns: 1fr; } }
</style>

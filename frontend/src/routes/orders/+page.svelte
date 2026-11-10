<script lang="ts">
	import { onMount } from 'svelte';
	import { ApiError } from '$lib/api/client';
	import { money, ORDER_LABEL, shopping, type Order } from '$lib/api/market';

	let orders = $state<Order[]>([]);
	let loaded = $state(false);
	let error = $state('');

	async function load() {
		try {
			orders = await shopping.orders();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not load your orders.';
		}
		loaded = true;
	}
	onMount(load);

	async function act(fn: () => Promise<unknown>) {
		error = '';
		try {
			await fn();
			await load();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Action failed.';
		}
	}

	const STEPS = ['paid', 'merchant_accepted', 'preparing', 'ready_for_pickup', 'completed'];
</script>

<svelte:head><title>My orders · Phnom Penh Digital World</title></svelte:head>

<main class="street-grid min-h-dvh px-4 py-8 sm:px-6">
	<div class="mx-auto max-w-3xl space-y-5">
		<header class="flex items-end justify-between gap-3">
			<div>
				<p class="eyebrow">Shopping</p>
				<h1 class="display text-3xl font-bold">My orders</h1>
			</div>
			<a class="btn-primary" href="/world">Back to the city</a>
		</header>
		<p class="rounded-xl bg-paper-2 px-4 py-2 text-xs text-ink-soft">Demo payments only: no real money was charged, and refunds are simulated.</p>
		{#if error}<p class="alert-error">{error}</p>{/if}
		{#if loaded && !orders.length}<p class="card p-5 text-sm text-ink-soft">No orders yet. Walk into a shop in the city to buy something.</p>{/if}
		{#each orders as o (o.id)}
			<article class="card space-y-3 p-5" data-testid="buyer-order" data-status={o.status}>
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<p class="font-semibold">{o.number} · {o.merchant_name}</p>
					<span class="chip">{ORDER_LABEL[o.status]}</span>
				</div>
				{#if STEPS.includes(o.status)}
					<ol class="flex gap-1" aria-label="Progress">
						{#each STEPS as s, i (s)}
							<li class="h-1.5 flex-1 rounded-full {i <= STEPS.indexOf(o.status) ? 'bg-river-700' : 'bg-paper-2'}" title={ORDER_LABEL[s as keyof typeof ORDER_LABEL]}></li>
						{/each}
					</ol>
				{/if}
				<ul class="text-sm">
					{#each o.items as i (i.name)}<li>{i.quantity} × {i.name} <span class="text-ink-soft">{money(i.line_total_minor)}</span></li>{/each}
				</ul>
				<p class="text-sm">
					<strong>{money(o.total_minor)}</strong>
					{#if o.pickup_shop} · pick up at {o.pickup_shop} ({o.pickup_unit}){/if}
					{#if o.refunded_minor} · refunded {money(o.refunded_minor)} (demo){/if}
				</p>
				{#if o.cancel_reason}<p class="text-xs text-ink-soft">{o.cancel_reason}</p>{/if}
				<div class="flex flex-wrap gap-2">
					{#if o.status === 'pending_payment'}
						<button class="btn-primary py-1.5 text-xs" onclick={() => act(() => shopping.confirm(o.payment_intent_id))}>Pay with demo funds</button>
					{/if}
					{#if o.allowed.includes('completed')}
						<button class="btn-primary py-1.5 text-xs" onclick={() => act(() => shopping.received(o.id))} data-testid="order-received">I collected it</button>
					{/if}
					{#if o.allowed.includes('refunded') || o.allowed.includes('cancelled')}
						<button class="btn-ghost py-1.5 text-xs text-brick-600" onclick={() => confirm(`Cancel ${o.number}?`) && act(() => shopping.cancel(o.id))}>Cancel order</button>
					{/if}
				</div>
				<details class="text-xs text-ink-soft">
					<summary>History</summary>
					<ul class="mt-1 space-y-0.5">
						{#each o.events as e, i (i)}<li>{new Date(e.at).toLocaleString()} · {ORDER_LABEL[e.to_status as keyof typeof ORDER_LABEL] ?? e.to_status} ({e.actor_role}){e.note ? ` · ${e.note}` : ''}</li>{/each}
					</ul>
				</details>
			</article>
		{/each}
	</div>
</main>

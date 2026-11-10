<script lang="ts">
	/**
	 * The combined cart (lines grouped by merchant) and the demo checkout:
	 * review → place order (one payment, one order per merchant) → pay with demo funds.
	 * The Idempotency-Key is created once per attempt, so retries never double-order.
	 */
	import { Minus, Plus, Trash2, BadgeCheck, TriangleAlert } from 'lucide-svelte';
	import { ApiError } from '$lib/api/client';
	import { money, shopping, ORDER_LABEL, type Cart, type Payment } from '$lib/api/market';

	let { cart, onCart }: { cart: Cart | null; onCart: (cart: Cart) => void } = $props();

	let step = $state<'cart' | 'pay' | 'done'>('cart');
	let payment = $state<Payment | null>(null);
	let error = $state('');
	let busy = $state(false);
	let note = $state('');
	let adult = $state(false);
	let attemptKey = '';

	function fail(e: unknown, fallback: string) {
		error = e instanceof ApiError ? e.message : fallback;
		if (e instanceof ApiError && ['PRICE_CHANGED', 'ITEMS_UNAVAILABLE'].includes(e.code)) {
			attemptKey = ''; // the request changes after a refresh: a new attempt
			shopping.cart().then(onCart).catch(() => {});
		}
	}

	async function quantity(productId: string, q: number) {
		error = '';
		try {
			onCart(q > 0 ? await shopping.setQuantity(productId, q) : await shopping.remove(productId));
		} catch (e) {
			fail(e, 'Could not update the cart.');
		}
	}

	async function placeOrder() {
		if (!cart) return;
		busy = true;
		error = '';
		attemptKey ||= crypto.randomUUID();
		try {
			payment = await shopping.checkout(attemptKey, {
				expected_total_minor: cart.total_minor,
				note: note || undefined,
				age_confirmed: adult
			});
			step = 'pay';
			onCart(await shopping.cart());
		} catch (e) {
			fail(e, 'Checkout failed.');
		} finally {
			busy = false;
		}
	}

	async function pay() {
		if (!payment) return;
		busy = true;
		error = '';
		try {
			payment = await shopping.confirm(payment.id);
			step = 'done';
			attemptKey = '';
		} catch (e) {
			fail(e, 'Payment failed.');
		} finally {
			busy = false;
		}
	}

	async function cancelPayment() {
		if (!payment) return;
		try {
			payment = await shopping.cancelPayment(payment.id);
		} catch {
			/* already closed */
		}
		step = 'cart';
		payment = null;
		attemptKey = '';
	}
</script>

<div class="flex h-full flex-col" data-testid="cart-panel" data-step={step}>
	<p class="flex items-center gap-2 rounded-lg bg-saffron-300/30 px-3 py-1.5 text-[11px]">
		<TriangleAlert size={13} /> Demo checkout: no real money is charged and demo payments have no value.
	</p>
	{#if error}<p class="alert-error mt-2 text-sm" data-testid="cart-error">{error}</p>{/if}

	{#if step === 'cart'}
		<div class="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
			{#if !cart || !cart.item_count}
				<p class="text-sm text-ink-soft">Your cart is empty. Walk into a shop, pick up a product (E) and put it in the shop's cart (E).</p>
			{/if}
			{#each cart?.groups ?? [] as g (g.merchant_id)}
				<div class="rounded-xl border border-river-900/10 bg-white p-3">
					<p class="flex justify-between text-sm font-semibold"><span>{g.merchant_name}</span><span>{money(g.subtotal_minor)}</span></p>
					{#each g.lines as l (l.product_id)}
						<div class="mt-2 flex items-center gap-2 text-sm" data-testid="cart-line">
							<div class="min-w-0 flex-1">
								<p class="truncate">{l.name}</p>
								<p class="text-xs text-ink-soft">
									{money(l.unit_price_minor)}
									{#if l.price_changed}<span class="text-brick-600">(was {money(l.quoted_price_minor)})</span>{/if}
									{#if l.problem}<span class="text-brick-600"> · {l.problem.replaceAll('_', ' ')}</span>{/if}
								</p>
							</div>
							<button class="rounded p-1 hover:bg-paper-2" aria-label="One less" onclick={() => quantity(l.product_id, l.quantity - 1)}><Minus size={14} /></button>
							<span class="w-5 text-center font-mono">{l.quantity}</span>
							<button class="rounded p-1 hover:bg-paper-2" aria-label="One more" onclick={() => quantity(l.product_id, l.quantity + 1)}><Plus size={14} /></button>
							<button class="rounded p-1 text-ink-soft hover:bg-paper-2" aria-label="Remove" onclick={() => quantity(l.product_id, 0)}><Trash2 size={14} /></button>
						</div>
					{/each}
				</div>
			{/each}
		</div>
		{#if cart?.item_count}
			<div class="mt-3 space-y-2 border-t border-river-900/10 pt-3">
				<p class="flex justify-between font-semibold"><span>Total ({cart.item_count} items)</span><span data-testid="cart-total">{money(cart.total_minor)}</span></p>
				<p class="text-xs text-ink-soft">Pickup at the shop. {cart.groups.length > 1 ? `${cart.groups.length} shops: one order each.` : ''} Delivery arrives with Phase 6.</p>
				<input class="input py-2 text-sm" placeholder="Note for the shop (optional)" maxlength="300" bind:value={note} />
				{#if cart.needs_age_confirmation}
					<label class="flex items-center gap-2 text-xs"><input type="checkbox" bind:checked={adult} /> I am 18 or older (age-restricted items)</label>
				{/if}
				<button class="btn-primary w-full" disabled={busy || !cart.can_checkout || (cart.needs_age_confirmation && !adult)} onclick={placeOrder} data-testid="place-order">
					Place order · {money(cart.total_minor)}
				</button>
			</div>
		{/if}
	{:else if step === 'pay' && payment}
		<div class="mt-3 flex-1 space-y-3">
			<p class="text-sm">Orders reserved. Pay within 15 minutes or they are released.</p>
			{#each payment.orders as o (o.id)}
				<p class="flex justify-between rounded-lg bg-white px-3 py-2 text-sm"><span>{o.number} · {o.merchant_name}</span><span>{money(o.total_minor)}</span></p>
			{/each}
			<button class="btn-primary w-full" disabled={busy} onclick={pay} data-testid="pay-demo">Pay {money(payment.amount_minor)} with demo funds</button>
			<button class="btn-ghost w-full" disabled={busy} onclick={cancelPayment}>Cancel</button>
		</div>
	{:else if payment}
		<div class="mt-4 flex-1 space-y-3 text-center" data-testid="checkout-done">
			<BadgeCheck class="mx-auto text-river-700" size={40} />
			<p class="display text-lg font-bold">Paid (demo)</p>
			<p class="font-mono text-xs text-ink-soft">{payment.reference}</p>
			{#each payment.orders as o (o.id)}
				<p class="flex justify-between rounded-lg bg-white px-3 py-2 text-left text-sm"><span>{o.number} · {o.merchant_name}</span><span>{ORDER_LABEL[o.status]}</span></p>
			{/each}
			<a class="btn-ghost w-full" href="/orders" data-sveltekit-reload>Track my orders</a>
			<button class="btn-ghost w-full" onclick={() => { step = 'cart'; payment = null; }}>Keep shopping</button>
		</div>
	{/if}
</div>

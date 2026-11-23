<script lang="ts">
	/**
	 * A shop's counter, in the game: the basket (what the player picked from this shop's shelves),
	 * one Pay button, and the receipt: paid in person, the goods are handed over at once. Orders
	 * placed ahead for pickup here are collected at the same counter. The shopkeeper (when one
	 * stands there) does the talking. A glass panel like the System Office's; walking away from
	 * the shop closes it.
	 */
	import { onMount, untrack } from 'svelte';
	import { BadgeCheck, Minus, Package, Plus, X } from 'lucide-svelte';
	import { ApiError } from '$lib/api/client';
	import { wallet, type Wallet } from '$lib/api/commerce';
	import { money, shopping, type Cart, type Order, type Payment, type Shop } from '$lib/api/market';

	let {
		shop,
		cart,
		keeper = null,
		solid = false,
		onSay,
		onCart,
		onPaid,
		onClose
	}: {
		shop: Shop;
		cart: Cart | null;
		/** The shopkeeper's name (null: nobody at the counter yet). */
		keeper?: string | null;
		solid?: boolean;
		/** The shopkeeper says this in the city (a bubble); thanks comes with a sampeah. */
		onSay?: (text: string, gesture?: 'talk' | 'thanks') => void;
		onCart: (cart: Cart) => void;
		/** Paid: the basket became a bag in the player's hand. */
		onPaid: (payment: Payment) => void;
		onClose: () => void;
	} = $props();

	let receipt = $state<Payment | null>(null);
	let purse = $state<Wallet | null>(null);
	let ready = $state<Order[]>([]);
	let adult = $state(false);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	/** What the shopkeeper said last (also shown here). */
	let line = $state('');
	function say(text: string, gesture: 'talk' | 'thanks' = 'talk') {
		if (!keeper) return;
		line = text;
		onSay?.(text, gesture);
	}

	const group = $derived(cart?.groups.find((g) => g.merchant_id === shop.merchant_id) ?? null);
	const lines = $derived(group?.lines ?? []);
	const total = $derived(group?.subtotal_minor ?? 0);
	const count = $derived(lines.reduce((n, l) => n + l.quantity, 0));
	const elsewhere = $derived((cart?.item_count ?? 0) - count);
	const needsAge = $derived(lines.some((l) => l.min_age));
	const blocked = $derived(lines.some((l) => l.problem));

	// One Idempotency-Key per attempt: a retry of the same basket never pays twice; a changed
	// basket is a new attempt.
	let attempt = '';
	let seen = '';
	$effect(() => {
		const now = JSON.stringify([lines.map((l) => [l.product_id, l.quantity, l.unit_price_minor]), adult]);
		if (now !== untrack(() => seen)) {
			seen = now;
			attempt = '';
		}
	});

	async function loadOrders() {
		const mine = await shopping.orders().catch(() => [] as Order[]);
		ready = mine.filter((o) => o.pickup_unit === shop.unit.code && o.fulfillment === 'pickup' && !o.in_person && ['paid', 'merchant_accepted', 'preparing', 'ready_for_pickup'].includes(o.status));
	}
	onMount(() => {
		void loadOrders().then(() => {
			const due = ready.find((o) => o.status === 'ready_for_pickup');
			if (count) say(`That's ${money(total)}, please.`);
			else if (due) say(`Your order ${due.number} is ready. Here you are!`);
			else say('Hello! Pick what you like from the shelves and bring it here.');
		});
		wallet.get().then((w) => (purse = w)).catch(() => {});
	});

	async function quantity(productId: string, q: number) {
		error = '';
		try {
			onCart(q > 0 ? await shopping.setQuantity(productId, q) : await shopping.remove(productId));
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not change the basket.';
		}
	}

	async function pay() {
		busy = true;
		error = notice = '';
		attempt ||= crypto.randomUUID();
		try {
			const paid = await shopping.counter(shop.id, attempt, { expected_total_minor: total, age_confirmed: adult });
			receipt = paid;
			attempt = '';
			say('Orkun! Thank you. Here you are.', 'thanks');
			onPaid(paid);
			onCart(await shopping.cart());
			wallet.get().then((w) => (purse = w)).catch(() => {});
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'The payment did not go through.';
			if (e instanceof ApiError && ['PRICE_CHANGED', 'ITEMS_UNAVAILABLE'].includes(e.code)) {
				attempt = '';
				shopping.cart().then(onCart).catch(() => {});
			}
		} finally {
			busy = false;
		}
	}

	async function collect(o: Order) {
		busy = true;
		error = notice = '';
		try {
			await shopping.received(o.id);
			notice = `${o.number} is yours. Thank you!`;
			say(`Here is ${o.number}. Orkun!`, 'thanks');
			await loadOrders();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not collect the order.';
		} finally {
			busy = false;
		}
	}

	function keydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		e.preventDefault();
		onClose();
	}
	const WAIT: Record<string, string> = { paid: 'Waiting for the shop to accept', merchant_accepted: 'Accepted', preparing: 'Being prepared' };
</script>

<svelte:window onkeydown={keydown} />

<div class="counter" class:solid role="dialog" aria-label={`${shop.name} counter`} data-testid="counter" data-step={receipt ? 'done' : 'basket'}>
	<header>
		<div class="title">
			<p>{keeper ? `${keeper}, at the counter` : 'Counter'}</p>
			<h2>{shop.name}</h2>
		</div>
		<button type="button" class="icon" aria-label="Close" onclick={onClose}><X size={18} /></button>
	</header>

	{#if line}<p class="line" data-testid="counter-line-said">“{line}”</p>{/if}

	{#if receipt}
		<section class="receipt" data-testid="counter-receipt">
			<BadgeCheck size={36} class="mx-auto text-saffron-300" />
			<p class="paid">Paid. It's yours.</p>
			{#each receipt.orders as o (o.id)}
				<ul>
					{#each o.items as i (i.name)}<li><span>{i.quantity} × {i.name}</span><span>{money(i.line_total_minor)}</span></li>{/each}
				</ul>
				<p class="row total"><span>Total</span><span>{money(o.total_minor)}</span></p>
				<p class="small">{o.number} · {receipt.reference} · demo money</p>
			{/each}
			{#if purse}<p class="small">Wallet: {money(purse.balance_minor)} left</p>{/if}
			<button type="button" class="go" onclick={onClose} data-testid="counter-done">Done</button>
		</section>
	{:else}
		{#if lines.length}
			<section aria-label="Your basket">
				<ul class="lines">
					{#each lines as l (l.product_id)}
						<li data-testid="counter-line">
							<span class="pic">{#if l.image_url}<img src={l.image_url} alt="" />{:else}<Package size={18} />{/if}</span>
							<span class="name">
								<span>{l.name}</span>
								<span class="small">{money(l.unit_price_minor)}{l.price_changed ? ` (was ${money(l.quoted_price_minor)})` : ''}{l.problem ? ` · ${l.problem === 'insufficient_stock' ? `only ${l.stock} left` : 'no longer sold'}` : ''}</span>
							</span>
							<span class="qty">
								<button type="button" aria-label={`One less ${l.name}`} onclick={() => quantity(l.product_id, l.quantity - 1)}><Minus size={14} /></button>
								<span>{l.quantity}</span>
								<button type="button" aria-label={`One more ${l.name}`} onclick={() => quantity(l.product_id, l.quantity + 1)}><Plus size={14} /></button>
							</span>
						</li>
					{/each}
				</ul>
				<p class="row total"><span>{count} item{count === 1 ? '' : 's'}</span><span data-testid="counter-total">{money(total)}</span></p>
				{#if needsAge}<label class="age"><input type="checkbox" bind:checked={adult} /> I am 18 or older</label>{/if}
				{#if error}<p class="error" role="alert">{error}</p>{/if}
				<button type="button" class="go" disabled={busy || blocked || (needsAge && !adult)} onclick={pay} data-testid="counter-pay">{busy ? 'Paying…' : `Pay ${money(total)}`}</button>
				<p class="small">Demo money from your wallet{purse ? ` (${money(purse.balance_minor)})` : ''}. You take it with you at once.</p>
			</section>
		{:else}
			<p class="intro">Your basket is empty. Pick things from the shelves (E): they go into your basket, and you pay here.</p>
		{/if}
		{#if elsewhere > 0}<p class="small">{elsewhere} item{elsewhere === 1 ? '' : 's'} from other shops stay in your cart (C).</p>{/if}

		{#if ready.length}
			<section class="collect" aria-labelledby="to-collect">
				<h3 id="to-collect">Your orders here</h3>
				{#each ready as o (o.id)}
					<div class="row order">
						<span><strong>{o.number}</strong> · {o.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</span>
						{#if o.status === 'ready_for_pickup'}
							<button type="button" class="take" disabled={busy} onclick={() => collect(o)} data-testid="counter-collect">Collect</button>
						{:else}
							<span class="small">{WAIT[o.status]}</span>
						{/if}
					</div>
				{/each}
			</section>
		{/if}
		{#if notice}<p class="notice" data-testid="counter-notice">{notice}</p>{/if}
		{#if error && !lines.length}<p class="error" role="alert">{error}</p>{/if}
	{/if}
</div>

<style>
	.counter {
		position: absolute;
		z-index: 30;
		top: max(16px, env(safe-area-inset-top, 0px));
		right: max(16px, env(safe-area-inset-right, 0px));
		width: min(380px, calc(100vw - 32px));
		max-height: calc(100dvh - 32px);
		overflow-y: auto;
		border-radius: 26px;
		padding: 18px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		color: #f6f1e6;
		background: rgba(11, 37, 36, 0.42);
		-webkit-backdrop-filter: blur(18px) saturate(150%);
		backdrop-filter: blur(18px) saturate(150%);
		border: 1px solid rgba(255, 255, 255, 0.24);
		box-shadow: 0 24px 60px -24px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.2);
	}
	.counter.solid { background: rgba(11, 37, 36, 0.88); -webkit-backdrop-filter: none; backdrop-filter: none; }
	.counter > * { flex-shrink: 0; }
	header { display: flex; align-items: flex-start; gap: 10px; }
	.title { flex: 1; display: grid; gap: 2px; }
	.title p { font-size: 12px; font-weight: 700; color: var(--color-saffron-300); }
	h2 { margin: 0; font-family: var(--font-display); font-size: 22px; font-weight: 700; color: #fffaf0; }
	h3 { margin: 0 0 6px; font-size: 13px; font-weight: 700; color: var(--color-saffron-300); }
	section { display: grid; gap: 10px; }
	.icon { padding: 6px; border-radius: 10px; }
	.icon:hover { background: rgba(255, 255, 255, 0.14); }
	.intro { font-size: 13px; line-height: 1.45; opacity: 0.9; }
	.line { font-family: var(--font-display); font-size: 16px; font-style: italic; line-height: 1.35; color: #fffaf0; }
	.lines { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
	.lines li { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 14px; background: rgba(255, 255, 255, 0.08); }
	.pic { width: 40px; height: 40px; flex: none; border-radius: 10px; overflow: hidden; display: grid; place-items: center; background: rgba(255, 255, 255, 0.12); }
	.pic img { width: 100%; height: 100%; object-fit: cover; }
	.name { flex: 1; min-width: 0; display: grid; font-size: 14px; font-weight: 600; }
	.small { font-size: 12px; font-weight: 400; opacity: 0.75; }
	.qty { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
	.qty button { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; background: rgba(255, 255, 255, 0.14); color: inherit; }
	.qty button:hover { background: rgba(255, 255, 255, 0.24); }
	.row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
	.total { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
	.age { display: flex; align-items: center; gap: 8px; font-size: 13px; }
	.go { padding: 12px 18px; border-radius: 14px; font-size: 15px; font-weight: 800; background: var(--color-saffron-500); color: #0b2524; box-shadow: 0 5px 0 -2px var(--color-saffron-600); }
	.go:disabled { opacity: 0.5; cursor: not-allowed; }
	.error { font-size: 13px; font-weight: 600; color: #ffd4c4; }
	.notice { font-size: 13px; padding: 8px 12px; border-radius: 12px; background: rgba(155, 227, 178, 0.18); }
	.collect { padding-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.16); }
	.order { font-size: 13px; }
	.take { padding: 6px 12px; border-radius: 10px; font-size: 13px; font-weight: 700; background: #fffaf0; color: #123b3a; }
	.receipt { text-align: center; }
	.receipt ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; text-align: left; font-size: 14px; }
	.receipt li { display: flex; justify-content: space-between; }
	.paid { font-family: var(--font-display); font-size: 22px; font-weight: 700; color: #fffaf0; }
	button:focus-visible { outline: 3px solid var(--color-saffron-500); outline-offset: 2px; }
	@media (max-width: 640px) {
		.counter { top: auto; bottom: max(10px, env(safe-area-inset-bottom, 0px)); left: max(10px, env(safe-area-inset-left, 0px)); right: max(10px, env(safe-area-inset-right, 0px)); width: auto; max-height: 70dvh; padding: 14px; }
	}
</style>

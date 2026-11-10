<script lang="ts">
	/** Browse a storefront's products (also reachable at the door with E). */
	import { onMount } from 'svelte';
	import { Clock, MessageCircle, ShoppingBag } from 'lucide-svelte';
	import { ApiError } from '$lib/api/client';
	import { market, money, type ShopDetail, type Shop, type Cart } from '$lib/api/market';
	import { shopping } from '$lib/api/market';

	let {
		shop,
		canBuy,
		onCart,
		onMessage
	}: {
		shop: Shop;
		canBuy: boolean;
		onCart: (cart: Cart) => void;
		onMessage?: (username: string) => void;
	} = $props();

	let detail = $state<ShopDetail | null>(null);
	let error = $state('');
	let busy = $state('');
	let added = $state('');

	onMount(async () => {
		try {
			detail = await market.shop(shop.id);
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not load the shop.';
		}
	});

	async function add(productId: string, name: string) {
		busy = productId;
		error = '';
		try {
			onCart(await shopping.add(productId, 1, shop.id));
			added = name;
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not add to the cart.';
		} finally {
			busy = '';
		}
	}

	const today = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Asia/Phnom_Penh' }).slice(0, 3).toLowerCase();
	const hours = $derived((shop.operating_hours as Record<string, [string, string][]>)[today] ?? []);
</script>

<div class="flex h-full flex-col" data-testid="shop-panel">
	<div class="rounded-xl p-3 text-white" style="background: {shop.primary_color}">
		<p class="text-[11px] font-bold tracking-widest uppercase opacity-80">{shop.unit.code} · {shop.unit.street_name ?? 'Daun Penh'}</p>
		<p class="display text-xl font-bold leading-tight">{shop.name}</p>
		{#if shop.name_km}<p class="khmer text-sm" lang="km">{shop.name_km}</p>{/if}
		{#if shop.tagline}<p class="mt-1 text-xs opacity-90">{shop.tagline}</p>{/if}
		<p class="mt-2 flex items-center gap-1.5 text-xs">
			<Clock size={12} />
			{#if !shop.is_open}Closed now{:else if hours.length}Today {hours.map((h) => h.join('–')).join(', ')}{:else}Open{/if}
			{#if onMessage}
				<button class="ml-auto flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 hover:bg-white/30" onclick={() => onMessage(shop.owner_username)}>
					<MessageCircle size={12} /> Message the shop
				</button>
			{/if}
		</p>
	</div>
	{#if error}<p class="alert-error mt-2 text-sm">{error}</p>{/if}
	{#if added}<p class="mt-2 rounded-lg bg-river-200/40 px-3 py-1.5 text-xs">Added {added} to your cart.</p>{/if}
	{#if !canBuy}<p class="mt-2 rounded-lg bg-saffron-300/30 px-3 py-1.5 text-xs">Browsing only: choose the buyer role to shop.</p>{/if}
	<div class="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" data-testid="shop-products">
		{#if !detail && !error}<p class="text-sm text-ink-soft">Loading products…</p>{/if}
		{#if detail && !detail.products.length}<p class="text-sm text-ink-soft">No products listed yet.</p>{/if}
		{#each detail?.products ?? [] as p (p.id)}
			<div class="flex items-center gap-3 rounded-xl border border-river-900/10 bg-white p-2">
				{#if p.image_url}
					<img src={p.image_url} alt="" class="h-14 w-14 shrink-0 rounded-lg object-cover" loading="lazy" />
				{:else}
					<div class="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-paper-2 text-ink-soft"><ShoppingBag size={20} /></div>
				{/if}
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-semibold">{p.name}</p>
					{#if p.name_km}<p class="khmer truncate text-xs text-ink-soft" lang="km">{p.name_km}</p>{/if}
					<p class="text-xs text-ink-soft">
						<strong class="text-brick-600">{money(p.price_minor)}</strong> · {p.in_stock ? `${p.stock} in stock` : 'Sold out'}{p.min_age ? ` · ${p.min_age}+` : ''}
					</p>
				</div>
				<button
					class="btn-primary shrink-0 px-3 py-1.5 text-xs"
					disabled={!canBuy || !p.in_stock || !shop.is_open || busy === p.id}
					onclick={() => add(p.id, p.name)}
					data-testid={`add-${p.name}`}
				>
					Add
				</button>
			</div>
		{/each}
	</div>
	<p class="mt-2 text-[11px] text-ink-soft">Prices are set by the shop and checked again by the server at checkout. Payments are a demo: no real money.</p>
</div>

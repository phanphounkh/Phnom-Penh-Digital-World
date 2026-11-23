<script lang="ts">
	/**
	 * "My shop", in the game: everything a seller does, without leaving the city. Today (what to
	 * do next, sales, new orders), Orders, Products, the shop's look, its spot on the street, and
	 * the business details. A frosted panel over the city, like the wardrobe; on a phone, a sheet.
	 */
	import { onMount } from 'svelte';
	import { X } from 'lucide-svelte';
	import { ApiError } from '$lib/api/client';
	import { seller, type Claim, type Merchant, type Shop } from '$lib/api/market';
	import BusinessForm from '$lib/components/seller/BusinessForm.svelte';
	import TodayTab from './TodayTab.svelte';
	import OrdersBoard from './OrdersBoard.svelte';
	import ProductsGrid from './ProductsGrid.svelte';
	import ShopLook from './ShopLook.svelte';
	import SpotsTab from './SpotsTab.svelte';
	import type { Here, Tab } from './types';

	let {
		here,
		ordersVersion = 0,
		solid = false,
		onRoute,
		onClose
	}: {
		/** Where the player stands (world metres and map position), to find spots near them. */
		here: () => Here | null;
		/** Bumped when an order changed (a live message): the orders reload. */
		ordersVersion?: number;
		solid?: boolean;
		onRoute: (target: { x: number; z: number; label: string }) => void;
		onClose: () => void;
	} = $props();

	let tab = $state<Tab>('today');
	let merchant = $state<Merchant | null>(null);
	let shops = $state<Shop[]>([]);
	let claims = $state<Claim[]>([]);
	let loaded = $state(false);
	let error = $state('');

	const approved = $derived(merchant?.status === 'approved');
	/** The shop being looked after (a seller can hold more than one spot). */
	let shopId = $state<string | null>(null);
	const shop = $derived(shops.find((s) => s.id === shopId) ?? shops[0] ?? null);

	async function load() {
		try {
			merchant = await seller.merchant();
			[shops, claims] = merchant.status === 'approved' ? await Promise.all([seller.shops(), seller.claims()]) : [[], []];
			error = '';
		} catch (e) {
			if (!(e instanceof ApiError && e.code === 'NO_MERCHANT')) error = e instanceof ApiError ? e.message : 'Your shop could not be loaded.';
			merchant = null;
		}
		loaded = true;
	}
	onMount(load);

	async function setOpen(open: boolean) {
		if (!shop) return;
		try {
			const s = await seller.updateShop(shop.id, { is_open: open });
			shops = shops.map((x) => (x.id === s.id ? s : x));
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not change that.';
		}
	}

	function keydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		e.preventDefault();
		e.stopPropagation();
		onClose();
	}

	const TABS: [Tab, string][] = [
		['today', 'Today'],
		['orders', 'Orders'],
		['products', 'Products'],
		['look', 'Shop'],
		['spot', 'Spot'],
		['business', 'Business']
	];
</script>

<svelte:window onkeydown={keydown} />

<div class="myshop glass-sheet" class:solid role="dialog" aria-label="My shop" data-testid="my-shop">
	<header class="head">
		{#if shop}
			<div class="sign" style:background={shop.primary_color} style:border-color={shop.accent_color}>
				<p class="sign-name">{shop.name}</p>
				{#if shop.name_km}<p class="khmer sign-km" lang="km">{shop.name_km}</p>{/if}
			</div>
		{:else}
			<div class="title">
				<p class="kicker">My shop</p>
				<h2>{merchant?.business_name ?? 'Your shop'}</h2>
			</div>
		{/if}
		<div class="grow"></div>
		{#if shops.length > 1}
			<select class="pick" aria-label="Which shop" value={shop?.id} onchange={(e) => (shopId = e.currentTarget.value)} data-testid="shop-pick">
				{#each shops as s (s.id)}<option value={s.id}>{s.unit.code} · {s.unit.street_name ?? s.name}</option>{/each}
			</select>
		{/if}
		{#if shop}
			<label class="open" data-testid="shop-open">
				<span>{shop.is_open ? 'Open' : 'Closed'}</span>
				<input type="checkbox" role="switch" checked={shop.is_open} onchange={(e) => setOpen(e.currentTarget.checked)} aria-label="Shop open for customers" />
			</label>
		{/if}
		<button type="button" class="icon" aria-label="Close" onclick={onClose}><X size={18} /></button>
	</header>

	{#if !loaded}
		<p class="muted">Loading your shop…</p>
	{:else if !merchant}
		<p class="muted">You are not registered as a seller. Register at the System Office in the city (Places → System Office).</p>
	{:else}
		{#if !approved}
			<p class="status-note" data-testid="merchant-status" data-status={merchant.status}>
				{merchant.status === 'pending' ? 'An administrator is checking your business. Meanwhile you can update its details.' : merchant.status === 'rejected' ? `Not approved${merchant.decision_reason ? `: ${merchant.decision_reason}` : '.'} Register again at the System Office.` : 'Your shop is suspended.'}
			</p>
		{:else}
			<span hidden data-testid="merchant-status" data-status={merchant.status}></span>
		{/if}
		<nav class="tabs" aria-label="My shop">
			{#each TABS as [id, label] (id)}
				{@const locked = !approved && id !== 'business' && id !== 'today'}
				<button type="button" class:on={tab === id} disabled={locked} aria-current={tab === id ? 'page' : undefined} onclick={() => (tab = id)} data-testid={`myshop-tab-${id}`}>{label}</button>
			{/each}
		</nav>
		{#if error}<p class="alert-error">{error}</p>{/if}
		<div class="body">
			{#if tab === 'today'}
				<TodayTab {merchant} {shop} {claims} {ordersVersion} go={(t) => (tab = t)} />
			{:else if tab === 'orders'}
				<OrdersBoard version={ordersVersion} />
			{:else if tab === 'products'}
				<ProductsGrid />
			{:else if tab === 'look' && shop}
				{#key shop.id}<ShopLook {shop} onsaved={(s) => (shops = shops.map((x) => (x.id === s.id ? s : x)))} />{/key}
			{:else if tab === 'look'}
				<p class="muted">Claim a spot on a street first: your shop opens there. <button type="button" class="link" onclick={() => (tab = 'spot')}>Find a spot</button></p>
			{:else if tab === 'spot'}
				<SpotsTab {claims} documents={merchant.documents} {here} {onRoute} onchange={load} />
			{:else}
				<BusinessForm {merchant} onsaved={(m) => (merchant = m)} />
			{/if}
		</div>
	{/if}
</div>

<style>
	.myshop {
		position: absolute;
		z-index: 30;
		top: max(16px, env(safe-area-inset-top, 0px));
		bottom: 16px;
		right: max(16px, env(safe-area-inset-right, 0px));
		width: min(46rem, calc(100vw - 32px));
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 18px;
		border-radius: 24px;
		/* Dark glass over the city, like the other pop-ups (`.glass-sheet` in app.css). */
	}
	.myshop > * { flex-shrink: 0; }
	.head { display: flex; align-items: center; gap: 10px; }
	.sign { border-radius: 12px; padding: 6px 14px; border-bottom: 5px solid; color: #fff; max-width: 60%; }
	.sign-name { font-family: var(--font-display); font-size: 20px; font-weight: 700; line-height: 1.15; }
	.sign-km { font-size: 13px; opacity: 0.9; }
	.title { display: grid; gap: 2px; }
	.kicker { font-size: 12px; font-weight: 700; color: var(--color-saffron-300); }
	h2 { margin: 0; font-family: var(--font-display); font-size: 22px; font-weight: 700; color: var(--color-ink); }
	.grow { flex: 1; }
	.open { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: var(--color-ink); cursor: pointer; }
	.open input { appearance: none; width: 42px; height: 24px; border-radius: 999px; background: rgba(255, 255, 255, 0.25); position: relative; transition: background 150ms; cursor: pointer; }
	.open input::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform 150ms; }
	.open input:checked { background: #4c9a63; }
	.open input:checked::after { transform: translateX(18px); }
	.open input:focus-visible { outline: 3px solid var(--color-saffron-500); outline-offset: 2px; }
	.pick { max-width: 11rem; padding: 6px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; color: inherit; background: rgba(255, 255, 255, 0.09); border: 1px solid rgba(255, 255, 255, 0.26); }
	.icon { padding: 6px; border-radius: 10px; color: var(--color-ink-soft); }
	.icon:hover { background: rgba(255, 255, 255, 0.14); }
	.tabs { display: flex; gap: 4px; padding: 4px; border-radius: 14px; background: rgba(255, 255, 255, 0.1); overflow-x: auto; scrollbar-width: none; }
	.tabs button { flex: 1 0 auto; padding: 7px 12px; border-radius: 10px; font-size: 13px; font-weight: 600; color: var(--color-ink-soft); }
	.tabs button.on { background: rgba(255, 255, 255, 0.92); color: var(--color-river-900); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2); }
	.tabs button:disabled { opacity: 0.4; cursor: not-allowed; }
	.body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 2px; }
	.muted { font-size: 14px; color: var(--color-ink-soft); }
	.status-note { font-size: 13px; padding: 10px 12px; border-radius: 12px; background: rgba(232, 163, 61, 0.16); }
	.link { font-weight: 700; color: var(--color-saffron-300); text-decoration: underline; }
	@media (max-width: 640px) {
		.myshop { top: auto; left: max(8px, env(safe-area-inset-left, 0px)); right: max(8px, env(safe-area-inset-right, 0px)); bottom: max(8px, env(safe-area-inset-bottom, 0px)); width: auto; height: 86dvh; padding: 14px; border-radius: 20px; }
		.sign { max-width: 55%; }
		.sign-name { font-size: 17px; }
		.tabs { display: grid; grid-template-columns: repeat(3, 1fr); overflow: visible; }
	}
</style>

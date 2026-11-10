<script lang="ts">
	import { onMount } from 'svelte';
	import { Store, MapPinned, Palette, Package, ReceiptText, MessageCircle } from 'lucide-svelte';
	import { ApiError } from '$lib/api/client';
	import { social } from '$lib/api/endpoints';
	import type { Conversation, DirectMessage } from '$lib/api/types';
	import { seller, type Merchant, type Shop, type ShopTheme } from '$lib/api/market';
	import BusinessForm from '$lib/components/seller/BusinessForm.svelte';
	import UnitsTab from '$lib/components/seller/UnitsTab.svelte';
	import ProductsTab from '$lib/components/seller/ProductsTab.svelte';
	import OrdersTab from '$lib/components/seller/OrdersTab.svelte';

	type Tab = 'business' | 'units' | 'shop' | 'products' | 'orders' | 'messages';
	let tab = $state<Tab>('business');
	let merchant = $state<Merchant | null>(null);
	let loaded = $state(false);
	let shops = $state<Shop[]>([]);
	let error = $state('');
	let notice = $state('');
	let conversations = $state<Conversation[]>([]);
	let thread = $state<{ user: string; messages: DirectMessage[] } | null>(null);
	let reply = $state('');

	async function refresh() {
		try {
			merchant = await seller.merchant();
			shops = await seller.shops();
		} catch (e) {
			if (!(e instanceof ApiError && e.code === 'NO_MERCHANT')) error = e instanceof ApiError ? e.message : 'Could not load.';
			merchant = null;
		}
		loaded = true;
	}
	onMount(async () => {
		await refresh();
		if (merchant?.status === 'approved') tab = shops.length ? 'orders' : 'units';
	});

	async function saveShop(s: Shop) {
		error = notice = '';
		try {
			await seller.updateShop(s.id, {
				name: s.name,
				name_km: s.name_km || null,
				tagline: s.tagline || null,
				theme: s.theme,
				primary_color: s.primary_color,
				accent_color: s.accent_color,
				is_open: s.is_open
			});
			notice = `${s.name} updated in the 3D city.`;
			shops = await seller.shops();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not save.';
		}
	}

	async function openMessages() {
		tab = 'messages';
		conversations = await social.conversations().catch(() => []);
	}
	async function openThread(u: string) {
		thread = { user: u, messages: await social.thread(u) };
	}
	async function send() {
		if (!thread || !reply.trim()) return;
		await social.sendMessage(thread.user, reply.trim());
		reply = '';
		await openThread(thread.user);
	}

	const STATUS: Record<string, string> = {
		pending: 'Application under review',
		approved: 'Approved merchant',
		rejected: 'Application not approved',
		suspended: 'Suspended'
	};
	const THEMES: ShopTheme[] = ['market', 'cafe', 'boutique', 'tech', 'books'];
	const TABS: [Tab, string, typeof Store][] = [
		['business', 'Business', Store],
		['units', 'Units', MapPinned],
		['shop', 'Storefront', Palette],
		['products', 'Products', Package],
		['orders', 'Orders & revenue', ReceiptText],
		['messages', 'Messages', MessageCircle]
	];
</script>

<svelte:head><title>Seller · Phnom Penh Digital World</title></svelte:head>

<main class="street-grid min-h-dvh px-4 py-8 sm:px-6">
	<div class="mx-auto max-w-5xl space-y-5">
		<header class="flex flex-wrap items-end justify-between gap-3">
			<div>
				<p class="eyebrow">Seller dashboard</p>
				<h1 class="display text-3xl font-bold">{merchant?.business_name ?? 'Sell in Phnom Penh Digital World'}</h1>
				{#if merchant}
					<p class="mt-1 text-sm" data-testid="merchant-status" data-status={merchant.status}>
						<span class="chip">{STATUS[merchant.status]}</span>
						{#if merchant.decision_reason}<span class="ml-2 text-ink-soft">{merchant.decision_reason}</span>{/if}
					</p>
				{/if}
			</div>
			<div class="flex gap-2"><a class="btn-ghost" href="/orders">My purchases</a><a class="btn-primary" href="/world">Enter the city</a></div>
		</header>

		<p class="rounded-xl bg-paper-2 px-4 py-2 text-xs text-ink-soft">
			Virtual storefronts on real Daun Penh streets. A unit is a place in the 3D city, not real property, and payments are demo-only (no real money).
		</p>

		{#if !loaded}
			<p class="text-sm text-ink-soft">Loading…</p>
		{:else if !merchant}
			<section class="card space-y-3 p-5">
				<h2 class="display text-xl font-bold">Apply to sell</h2>
				<p class="text-sm text-ink-soft">Tell us about your business. An administrator reviews every application; then you can claim a shop unit, list products and receive (demo) orders.</p>
				<BusinessForm merchant={null} onsaved={(m) => { merchant = m; notice = 'Application sent.'; }} />
			</section>
		{:else}
			<nav class="flex flex-wrap gap-1 rounded-xl bg-paper-2 p-1 text-sm font-semibold" aria-label="Seller sections">
				{#each TABS as [id, label, Icon] (id)}
					<button class="flex items-center gap-1.5 rounded-lg px-3 py-2 {tab === id ? 'bg-white shadow' : 'text-ink-soft'}" onclick={() => (id === 'messages' ? openMessages() : (tab = id))} data-testid={`tab-${id}`}>
						<Icon size={15} /> {label}
					</button>
				{/each}
			</nav>
			{#if error}<p class="alert-error">{error}</p>{/if}
			{#if notice}<p class="alert border-river-500/30 bg-river-200/40">{notice}</p>{/if}

			<section class="card p-5">
				{#if tab === 'business'}
					<BusinessForm {merchant} onsaved={(m) => { merchant = m; notice = 'Saved.'; }} />
				{:else if tab === 'units'}
					<UnitsTab {merchant} onchange={refresh} />
				{:else if tab === 'shop'}
					{#each shops as s (s.id)}
						<div class="mb-5 grid gap-4 sm:grid-cols-[1fr_16rem]" data-testid="shop-editor">
							<div class="space-y-3">
								<p class="text-xs text-ink-soft">Unit {s.unit.code} · {s.unit.street_name}</p>
								<label class="block"><span class="label">Shop name</span><input class="input" bind:value={s.name} maxlength="60" /></label>
								<label class="block"><span class="label">Name in Khmer</span><input class="input khmer" lang="km" bind:value={s.name_km} maxlength="60" /></label>
								<label class="block"><span class="label">Tagline</span><input class="input" bind:value={s.tagline} maxlength="80" /></label>
								<div class="flex flex-wrap gap-3">
									<label class="block"><span class="label">Theme</span>
										<select class="input" bind:value={s.theme}>{#each THEMES as t (t)}<option value={t}>{t}</option>{/each}</select>
									</label>
									<label class="block"><span class="label">Colour</span><input type="color" class="h-11 w-16 rounded-lg" bind:value={s.primary_color} /></label>
									<label class="block"><span class="label">Accent</span><input type="color" class="h-11 w-16 rounded-lg" bind:value={s.accent_color} /></label>
								</div>
								<label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={s.is_open} /> Open for customers</label>
								<button class="btn-primary" onclick={() => saveShop(s)}>Save storefront</button>
							</div>
							<div class="overflow-hidden rounded-2xl border border-river-900/10" aria-label="Sign preview">
								<div class="p-3 text-center text-white" style="background: {s.primary_color}; border-bottom: 6px solid {s.accent_color}">
									<p class="display text-lg font-bold">{s.name}</p>
									{#if s.name_km}<p class="khmer text-sm" lang="km">{s.name_km}</p>{/if}
								</div>
								<div class="h-24 bg-[repeating-linear-gradient(90deg,var(--stripe-a)_0_14px,var(--stripe-b)_14px_28px)]" style="--stripe-a: {s.primary_color}; --stripe-b: {s.accent_color}"></div>
								<p class="p-2 text-center text-xs text-ink-soft">{s.tagline ?? ''}</p>
							</div>
						</div>
					{:else}
						<p class="text-sm text-ink-soft">Claim a unit first: your storefront appears there in the 3D city.</p>
					{/each}
				{:else if tab === 'products'}
					<ProductsTab />
				{:else if tab === 'orders'}
					<OrdersTab />
				{:else}
					<div class="grid gap-4 sm:grid-cols-[16rem_1fr]">
						<div class="space-y-1">
							{#each conversations as c (c.username)}
								<button class="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-paper-2 {thread?.user === c.username ? 'bg-paper-2' : ''}" onclick={() => openThread(c.username)}>
									<span class="font-semibold">{c.display_name}</span> {#if c.unread}<span class="chip">{c.unread}</span>{/if}
									<span class="block truncate text-xs text-ink-soft">{c.last}</span>
								</button>
							{:else}
								<p class="text-sm text-ink-soft">No customer messages yet. Buyers can message your shop from its page in the city.</p>
							{/each}
						</div>
						{#if thread}
							<div class="flex flex-col gap-2">
								<div class="max-h-80 space-y-1 overflow-y-auto rounded-xl bg-paper-2 p-3">
									{#each thread.messages as m, i (i)}
										<p class="text-sm {m.from_me ? 'text-right' : ''}"><span class="inline-block rounded-xl px-3 py-1.5 {m.from_me ? 'bg-river-900 text-paper' : 'bg-white'}">{m.text}</span></p>
									{/each}
								</div>
								<div class="flex gap-2"><input class="input py-2" bind:value={reply} maxlength="1000" placeholder={`Reply to @${thread.user}`} onkeydown={(e) => e.key === 'Enter' && send()} /><button class="btn-primary" onclick={send}>Send</button></div>
							</div>
						{/if}
					</div>
				{/if}
			</section>
		{/if}
	</div>
</main>

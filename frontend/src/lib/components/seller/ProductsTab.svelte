<script lang="ts">
	import { onMount } from 'svelte';
	import { ImagePlus, Trash2 } from 'lucide-svelte';
	import { ApiError } from '$lib/api/client';
	import { DISPLAY_MODELS, market, money, seller, toMinor, type Category, type DisplayModel, type Product } from '$lib/api/market';

	let products = $state<Product[]>([]);
	let categories = $state<Category[]>([]);
	let error = $state('');
	let notice = $state('');
	let busy = $state(false);
	let draft = $state({ name: '', name_km: '', description: '', category: 'food', price: '', model: 'box' as DisplayModel, stock: 10 });
	let edits = $state<Record<string, { price: string; stock: number }>>({});

	async function load() {
		products = await seller.products();
		edits = Object.fromEntries(products.map((p) => [p.id, { price: (p.price_minor / 100).toFixed(2), stock: p.stock }]));
	}
	onMount(async () => {
		try {
			[categories] = await Promise.all([market.categories(), load()]);
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not load products.';
		}
	});

	const selectedCategory = $derived(categories.find((c) => c.slug === draft.category));

	async function create(e: SubmitEvent) {
		e.preventDefault();
		error = notice = '';
		const price_minor = toMinor(draft.price);
		if (!Number.isFinite(price_minor) || price_minor < 1) return (error = 'Enter a price such as 2.50');
		busy = true;
		try {
			const p = await seller.createProduct({
				name: draft.name,
				name_km: draft.name_km || null,
				description: draft.description || null,
				category: draft.category,
				price_minor,
				model: draft.model,
				stock: draft.stock
			});
			notice = p.status === 'pending_review' ? `${p.name} is waiting for an administrator's review.` : `${p.name} is on your shelves.`;
			draft = { ...draft, name: '', name_km: '', description: '', price: '' };
			await load();
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Could not add the product.';
		} finally {
			busy = false;
		}
	}

	async function run(fn: () => Promise<unknown>, message = '') {
		error = notice = '';
		try {
			await fn();
			notice = message;
			await load();
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Action failed.';
		}
	}

	function savePrice(p: Product) {
		const minor = toMinor(edits[p.id].price);
		if (!Number.isFinite(minor) || minor < 1) return (error = 'Enter a price such as 2.50');
		if (minor !== p.price_minor) void run(() => seller.updateProduct(p.id, { price_minor: minor }), `${p.name}: ${money(minor)}`);
	}

	function saveStock(p: Product) {
		const n = Math.max(0, Math.floor(Number(edits[p.id].stock)));
		if (n !== p.stock) void run(() => seller.setStock(p.id, n), `${p.name}: ${n} in stock`);
	}

	function upload(p: Product, files: FileList | null) {
		const file = files?.[0];
		if (file) void run(() => seller.uploadImage(p.id, file), 'Photo updated (location data removed).');
	}
</script>

<div class="space-y-5">
	{#if error}<p class="alert-error">{error}</p>{/if}
	{#if notice}<p class="alert border-river-500/30 bg-river-200/40" data-testid="products-notice">{notice}</p>{/if}

	<form class="card space-y-3 p-4" onsubmit={create} data-testid="product-form">
		<p class="font-semibold">Add a product</p>
		<div class="grid gap-3 sm:grid-cols-3">
			<input class="input" placeholder="Name" bind:value={draft.name} required minlength="2" maxlength="80" name="product_name" />
			<input class="input khmer" lang="km" placeholder="Khmer name (optional)" bind:value={draft.name_km} maxlength="80" />
			<input class="input" placeholder="Price (USD), e.g. 2.50" bind:value={draft.price} inputmode="decimal" required name="product_price" />
			<select class="input" bind:value={draft.category} name="product_category">
				{#each categories as c (c.slug)}
					<option value={c.slug} disabled={c.policy === 'prohibited'}>{c.name}{c.policy === 'prohibited' ? ' (not allowed)' : c.policy === 'restricted' ? ' (reviewed)' : ''}</option>
				{/each}
			</select>
			<select class="input" bind:value={draft.model} aria-label="3D display model">
				{#each DISPLAY_MODELS as m (m)}<option value={m}>{m} (3D model)</option>{/each}
			</select>
			<label class="flex items-center gap-2 text-sm">Stock <input class="input py-2" type="number" min="0" max="100000" bind:value={draft.stock} /></label>
		</div>
		<textarea class="input min-h-16" placeholder="Description (optional)" bind:value={draft.description} maxlength="1000"></textarea>
		{#if selectedCategory?.policy_note}<p class="text-xs text-ink-soft">{selectedCategory.policy_note}</p>{/if}
		<button class="btn-primary" disabled={busy} data-testid="product-submit">Add product</button>
		<p class="hint">No Blender needed: pick a display model; your photo goes on its label. Prices are integer cents on the server and re-checked at every checkout.</p>
	</form>

	<div class="space-y-2" data-testid="product-list">
		{#each products as p (p.id)}
			<div class="card flex flex-wrap items-center gap-3 p-3 text-sm">
				<label class="grid h-14 w-14 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-lg bg-paper-2" title="Upload a photo">
					{#if p.image_url}<img src={p.image_url} alt="" class="h-full w-full object-cover" />{:else}<ImagePlus size={20} class="text-ink-soft" />{/if}
					<input type="file" accept="image/jpeg,image/png,image/webp" class="hidden" onchange={(e) => upload(p, e.currentTarget.files)} />
				</label>
				<div class="min-w-40 flex-1">
					<p class="font-semibold">{p.name} <span class="chip ml-1">{p.status.replace('_', ' ')}</span></p>
					<p class="text-xs text-ink-soft">{p.category_name} · {p.model}{p.review_note ? ` · ${p.review_note}` : ''}</p>
				</div>
				<label class="flex items-center gap-1 text-xs">$<input class="input w-20 py-1 text-sm" bind:value={edits[p.id].price} onchange={() => savePrice(p)} aria-label={`Price of ${p.name}`} /></label>
				<label class="flex items-center gap-1 text-xs">Stock <input class="input w-20 py-1 text-sm" type="number" min="0" bind:value={edits[p.id].stock} onchange={() => saveStock(p)} aria-label={`Stock of ${p.name}`} /></label>
				{#if p.status === 'active' || p.status === 'hidden'}
					<button class="btn-ghost py-1 text-xs" onclick={() => run(() => seller.updateProduct(p.id, { visible: p.status !== 'active' }))}>{p.status === 'active' ? 'Hide' : 'Show'}</button>
				{/if}
				<button class="rounded p-1 text-ink-soft hover:text-brick-600" aria-label={`Remove ${p.name}`} onclick={() => confirm(`Remove ${p.name}?`) && run(() => seller.archiveProduct(p.id), 'Removed.')}><Trash2 size={15} /></button>
			</div>
		{:else}
			<p class="text-sm text-ink-soft">No products yet.</p>
		{/each}
	</div>
</div>

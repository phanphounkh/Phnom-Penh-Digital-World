<script lang="ts">
	/**
	 * The shop's products as cards (photo, price tag, stock), and one editor to add or change a
	 * product: its name, price, stock, category, how it looks on the shelf (a picture tile per 3D
	 * model) and its photo. Every save says so.
	 */
	import { onMount } from 'svelte';
	import { ImagePlus } from 'lucide-svelte';
	import { ApiError } from '$lib/api/client';
	import { DISPLAY_MODELS, market, money, seller, toMinor, type Category, type DisplayModel, type Product } from '$lib/api/market';

	let products = $state<Product[]>([]);
	let categories = $state<Category[]>([]);
	let filter = $state<'all' | 'active' | 'low' | 'other'>('all');
	let editing = $state<Product | 'new' | null>(null);
	let draft = $state({ name: '', name_km: '', description: '', category: 'food', price: '', model: 'box' as DisplayModel, stock: 10 });
	let notice = $state('');
	let error = $state('');
	let busy = $state(false);
	let confirmRemove = $state(false);

	async function load() {
		products = await seller.products();
	}
	onMount(async () => {
		try {
			[categories] = await Promise.all([market.categories(), load()]);
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not load your products.';
		}
	});

	const LOW = 3;
	const shown = $derived(
		products.filter((p) => (filter === 'all' ? true : filter === 'active' ? p.status === 'active' : filter === 'low' ? p.status === 'active' && p.stock <= LOW : p.status !== 'active'))
	);
	const counts = $derived({ active: products.filter((p) => p.status === 'active').length, low: products.filter((p) => p.status === 'active' && p.stock <= LOW).length, other: products.filter((p) => p.status !== 'active').length });
	const STATUS: Record<Product['status'], string> = { active: 'On the shelf', hidden: 'Hidden', pending_review: 'Being checked', rejected: 'Not allowed', archived: 'Removed' };
	const selected = $derived(categories.find((c) => c.slug === draft.category));

	function open(p: Product | 'new') {
		notice = error = '';
		confirmRemove = false;
		editing = p;
		draft =
			p === 'new'
				? { name: '', name_km: '', description: '', category: draft.category || 'food', price: '', model: 'box', stock: 10 }
				: { name: p.name, name_km: p.name_km ?? '', description: p.description ?? '', category: p.category, price: (p.price_minor / 100).toFixed(2), model: p.model, stock: p.stock };
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		error = notice = '';
		const price_minor = toMinor(draft.price);
		if (!Number.isFinite(price_minor) || price_minor < 1) return (error = 'Enter a price such as 2.50');
		const stock = Math.max(0, Math.floor(Number(draft.stock)));
		busy = true;
		try {
			const fields = { name: draft.name.trim(), name_km: draft.name_km.trim() || null, description: draft.description.trim() || null, category: draft.category, price_minor, model: draft.model };
			if (editing === 'new') {
				const p = await seller.createProduct({ ...fields, stock });
				notice = p.status === 'pending_review' ? `${p.name} is waiting for an administrator's check.` : `${p.name} is on your shelves.`;
				await load();
				editing = products.find((x) => x.id === p.id) ?? null;
			} else if (editing) {
				const p = editing;
				await seller.updateProduct(p.id, fields);
				if (stock !== p.stock) await seller.setStock(p.id, stock);
				notice = 'Saved.';
				await load();
				editing = products.find((x) => x.id === p.id) ?? null;
			}
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Could not save the product.';
		} finally {
			busy = false;
		}
	}

	async function act(fn: () => Promise<unknown>, message: string, close = false) {
		error = notice = '';
		busy = true;
		try {
			await fn();
			notice = message;
			await load();
			if (close) editing = null;
			else if (editing && editing !== 'new') editing = products.find((x) => x.id === (editing as Product).id) ?? null;
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'That did not work.';
		} finally {
			busy = false;
			confirmRemove = false;
		}
	}
	function upload(p: Product, files: FileList | null) {
		const file = files?.[0];
		if (file) void act(() => seller.uploadImage(p.id, file), 'Photo updated (location data removed).');
	}
</script>

{#if editing}
	{@const current = editing === 'new' ? null : editing}
	<form class="editor" onsubmit={save} data-testid="product-form">
		<div class="row">
			<button type="button" class="btn-quiet px-2 py-1 text-sm" onclick={() => (editing = null)}>← All products</button>
			<h3>{current ? current.name : 'Add a product'}</h3>
		</div>
		{#if current}
			<div class="photo-row">
				<label class="photo" title="Upload a photo">
					{#if current.image_url}<img src={current.image_url} alt="" />{:else}<ImagePlus size={22} /><span>Add a photo</span>{/if}
					<input type="file" accept="image/jpeg,image/png,image/webp" class="hidden" onchange={(e) => upload(current, e.currentTarget.files)} data-testid="product-photo" />
				</label>
				<p class="muted">Your photo goes on the product's label on the shelf. Location data in it is removed.</p>
			</div>
		{/if}
		<div class="grid2">
			<label><span class="lbl">Name</span><input class="input" name="product_name" bind:value={draft.name} required minlength="2" maxlength="80" /></label>
			<label><span class="lbl">Name in Khmer (optional)</span><input class="input khmer" lang="km" bind:value={draft.name_km} maxlength="80" /></label>
			<label><span class="lbl">Price (USD)</span><input class="input" name="product_price" bind:value={draft.price} inputmode="decimal" placeholder="2.50" required /></label>
			<label><span class="lbl">In stock</span><input class="input" type="number" min="0" max="100000" bind:value={draft.stock} /></label>
		</div>
		<label><span class="lbl">Category</span>
			<select class="input" name="product_category" bind:value={draft.category}>
				{#each categories as c (c.slug)}<option value={c.slug} disabled={c.policy === 'prohibited'}>{c.name}{c.policy === 'prohibited' ? ' (not allowed)' : c.policy === 'restricted' ? ' (checked first)' : ''}</option>{/each}
			</select>
		</label>
		{#if selected?.policy_note}<p class="muted">{selected.policy_note}</p>{/if}
		<fieldset>
			<legend class="lbl">How it looks on the shelf</legend>
			<div class="models" role="radiogroup" aria-label="Shelf look">
				{#each DISPLAY_MODELS as m (m)}
					<button type="button" role="radio" aria-checked={draft.model === m} class="model" class:on={draft.model === m} onclick={() => (draft.model = m)}>{m[0].toUpperCase() + m.slice(1)}</button>
				{/each}
			</div>
		</fieldset>
		<label><span class="lbl">Description (optional)</span><textarea class="input min-h-16" bind:value={draft.description} maxlength="1000"></textarea></label>
		<div class="foot">
		{#if notice}<p class="ok" data-testid="products-notice">{notice}</p>{/if}
		{#if error}<p class="alert-error">{error}</p>{/if}
		<div class="actions">
			{#if current}
				{#if current.status === 'active' || current.status === 'hidden'}
					<button type="button" class="btn-ghost py-2 text-sm" disabled={busy} onclick={() => act(() => seller.updateProduct(current.id, { visible: current.status !== 'active' }), current.status === 'active' ? 'Hidden from your shop.' : 'Back on your shelves.')}>{current.status === 'active' ? 'Hide from the shop' : 'Show in the shop'}</button>
				{/if}
				{#if confirmRemove}
					<button type="button" class="remove" disabled={busy} onclick={() => act(() => seller.archiveProduct(current.id), `${current.name} removed.`, true)}>Remove {current.name}</button>
					<button type="button" class="btn-quiet py-2 text-sm" onclick={() => (confirmRemove = false)}>Keep it</button>
				{:else}
					<button type="button" class="btn-quiet py-2 text-sm text-brick-600" onclick={() => (confirmRemove = true)}>Remove…</button>
				{/if}
			{/if}
			<span class="grow"></span>
			<button class="btn-primary py-2" disabled={busy} data-testid="product-submit">{busy ? 'Saving…' : current ? 'Save' : 'Put it on the shelf'}</button>
		</div>
		</div>
	</form>
{:else}
	<div class="list">
		<div class="row">
			<div class="filters" role="radiogroup" aria-label="Show">
				{#each [['all', `All ${products.length}`], ['active', `On the shelf ${counts.active}`], ['low', `Low stock ${counts.low}`], ['other', `Hidden or checked ${counts.other}`]] as [id, text] (id)}
					<button type="button" role="radio" aria-checked={filter === id} class="chip py-1.5 {filter === id ? 'bg-river-900 text-paper' : ''}" onclick={() => (filter = id as typeof filter)}>{text}</button>
				{/each}
			</div>
			<button type="button" class="btn-primary py-2 text-sm" onclick={() => open('new')} data-testid="add-product">Add product</button>
		</div>
		{#if notice}<p class="ok" data-testid="products-notice">{notice}</p>{/if}
		{#if error}<p class="alert-error">{error}</p>{/if}
		<div class="cards" data-testid="product-list">
			{#each shown as p (p.id)}
				<button type="button" class="card" onclick={() => open(p)} data-testid={`product-${p.name}`}>
					<span class="pic">{#if p.image_url}<img src={p.image_url} alt="" loading="lazy" />{:else}<ImagePlus size={20} /><span>No photo yet</span>{/if}</span>
					<span class="name">{p.name}</span>
					<span class="meta">
						<span class="price">{money(p.price_minor)}</span>
						<span class:low={p.stock <= LOW}>{p.stock} left</span>
					</span>
					{#if p.status !== 'active'}<span class="state">{STATUS[p.status]}{p.review_note ? `: ${p.review_note}` : ''}</span>{/if}
				</button>
			{:else}
				<p class="muted">{products.length ? 'Nothing here.' : 'No products yet. Add your first: it goes on a shelf in your shop for buyers to pick up.'}</p>
			{/each}
		</div>
	</div>
{/if}

<style>
	.list, .editor { display: grid; gap: 12px; }
	.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: space-between; }
	h3 { margin: 0; flex: 1; font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--color-ink); }
	.filters { display: flex; gap: 6px; flex-wrap: wrap; }
	.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
	.card { display: grid; gap: 6px; padding: 8px; border-radius: 14px; background: rgba(255, 255, 255, 0.09); border: 1px solid rgba(255, 255, 255, 0.14); text-align: left; }
	.card:hover { border-color: rgba(255, 255, 255, 0.4); }
	.pic { aspect-ratio: 4 / 3; border-radius: 10px; background: var(--color-paper-2); display: grid; place-items: center; align-content: center; gap: 4px; overflow: hidden; font-size: 11px; color: var(--color-ink-soft); }
	.pic img, .photo img { width: 100%; height: 100%; object-fit: cover; }
	.name { font-weight: 600; font-size: 14px; }
	.meta { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--color-ink-soft); }
	.price { display: inline-block; background: var(--color-saffron-500); color: #0b2524; font-weight: 700; font-variant-numeric: tabular-nums; padding: 1px 8px 1px 12px; clip-path: polygon(7px 0, 100% 0, 100% 100%, 7px 100%, 0 50%); border-radius: 0 6px 6px 0; }
	.low { color: #ffb59c; font-weight: 700; }
	.state { font-size: 11px; font-weight: 600; color: var(--color-saffron-300); }
	.photo-row { display: flex; gap: 12px; align-items: center; }
	.photo { width: 110px; aspect-ratio: 4 / 3; flex: none; border-radius: 12px; background: var(--color-paper-2); display: grid; place-items: center; align-content: center; gap: 2px; overflow: hidden; cursor: pointer; font-size: 11px; color: var(--color-ink-soft); border: 2px dashed rgba(255, 255, 255, 0.3); }
	.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
	label, fieldset { display: grid; gap: 4px; min-width: 0; border: 0; margin: 0; padding: 0; }
	.lbl { font-size: 13px; font-weight: 600; color: var(--color-ink); }
	.models { display: grid; grid-template-columns: repeat(8, 1fr); gap: 6px; }
	.model { padding: 8px 2px; border-radius: 10px; font-size: 12px; font-weight: 600; background: rgba(255, 255, 255, 0.09); border: 2px solid rgba(255, 255, 255, 0.16); color: var(--color-ink-soft); }
	.model.on { border-color: #fff; color: var(--color-river-900); background: rgba(255, 255, 255, 0.92); }
	/* Save and its message stay in view at the bottom of the panel. */
	.foot { position: sticky; bottom: 0; display: grid; gap: 8px; padding: 10px 0 2px; background: linear-gradient(to bottom, rgba(11, 37, 36, 0), rgba(11, 37, 36, 0.85) 14px); }
	.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
	.grow { flex: 1; }
	.remove { padding: 8px 12px; border-radius: 10px; font-size: 13px; font-weight: 700; background: var(--color-brick-600); color: #fff; }
	.ok { font-size: 13px; padding: 8px 12px; border-radius: 12px; background: rgba(191, 224, 216, 0.16); }
	.muted { font-size: 13px; color: var(--color-ink-soft); }
	@media (max-width: 640px) { .grid2 { grid-template-columns: 1fr; } .models { grid-template-columns: repeat(4, 1fr); } }
</style>

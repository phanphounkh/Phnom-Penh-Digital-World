<script lang="ts">
	/**
	 * How the shop looks in the city: its name (and Khmer name), tagline, theme and colours, with a
	 * live preview of the shopfront sign and awning. Saving updates the shop in the 3D city.
	 */
	import { untrack } from 'svelte';
	import { ApiError } from '$lib/api/client';
	import { seller, type Shop, type ShopTheme } from '$lib/api/market';

	let { shop, onsaved }: { shop: Shop; onsaved: (s: Shop) => void } = $props();

	const initial = untrack(() => shop);
	let name = $state(initial.name);
	let name_km = $state(initial.name_km ?? '');
	let tagline = $state(initial.tagline ?? '');
	let theme = $state<ShopTheme>(initial.theme);
	let primary = $state(initial.primary_color);
	let accent = $state(initial.accent_color);
	let open = $state(initial.is_open);
	let busy = $state(false);
	let notice = $state('');
	let error = $state('');

	const THEMES: [ShopTheme, string][] = [
		['market', 'Market'],
		['cafe', 'Café'],
		['boutique', 'Boutique'],
		['tech', 'Tech'],
		['books', 'Books']
	];
	/** Colour pairs that read well on a street: sign colour, then awning stripe. */
	const PAIRS: [string, string][] = [
		['#123b3a', '#f2b53a'],
		['#8c2f1c', '#f4e3c1'],
		['#1f4e79', '#e8eef5'],
		['#3d7a4f', '#f7d774'],
		['#5b2a6e', '#f0c6d8'],
		['#222222', '#d94f30']
	];
	// The header's Open/Closed switch changes the shop too: follow it.
	$effect(() => {
		open = shop.is_open;
	});
	const changed = $derived(
		name.trim() !== shop.name || (name_km.trim() || null) !== shop.name_km || (tagline.trim() || null) !== shop.tagline || theme !== shop.theme || primary !== shop.primary_color || accent !== shop.accent_color || open !== shop.is_open
	);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		error = notice = '';
		busy = true;
		try {
			const s = await seller.updateShop(shop.id, { name: name.trim(), name_km: name_km.trim() || null, tagline: tagline.trim() || null, theme, primary_color: primary, accent_color: accent, is_open: open });
			onsaved(s);
			notice = 'Saved. Your shopfront in the city has changed.';
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Could not save your shop.';
		} finally {
			busy = false;
		}
	}
</script>

<form class="look" onsubmit={save} data-testid="shop-editor">
	<div class="preview" aria-label="Shopfront preview">
		<div class="board" style:background={primary} style:border-color={accent}>
			<p class="board-name">{name || 'Your shop'}</p>
			{#if name_km}<p class="khmer board-km" lang="km">{name_km}</p>{/if}
		</div>
		<div class="awning" style:--a={primary} style:--b={accent}></div>
		<div class="front">
			<span class="window"></span><span class="door" class:shut={!open}>{open ? 'Open' : 'Closed'}</span><span class="window"></span>
		</div>
		<p class="tag">{tagline || 'Add a tagline: what you sell, in a few words.'}</p>
		<p class="where">{shop.unit.code}{shop.unit.street_name ? ` · ${shop.unit.street_name}` : ''}</p>
	</div>

	<div class="fields">
		<label><span class="lbl">Shop name</span><input class="input" name="shop_name" bind:value={name} required minlength="2" maxlength="60" /></label>
		<label><span class="lbl">Name in Khmer (optional)</span><input class="input khmer" lang="km" bind:value={name_km} maxlength="60" /></label>
		<label><span class="lbl">Tagline</span><input class="input" name="shop_tagline" bind:value={tagline} maxlength="80" placeholder="Fresh fruit from Kandal" /></label>
		<fieldset>
			<legend class="lbl">Theme</legend>
			<div class="chips" role="radiogroup" aria-label="Theme">
				{#each THEMES as [id, text] (id)}
					<button type="button" role="radio" aria-checked={theme === id} class="chip py-1.5 {theme === id ? 'bg-river-900 text-paper' : ''}" onclick={() => (theme = id)}>{text}</button>
				{/each}
			</div>
		</fieldset>
		<fieldset>
			<legend class="lbl">Colours</legend>
			<div class="pairs">
				{#each PAIRS as [a, b] (a + b)}
					<button type="button" class="pair" class:on={primary === a && accent === b} aria-label={`Sign ${a}, stripe ${b}`} onclick={() => ((primary = a), (accent = b))}><span style:background={a}></span><span style:background={b}></span></button>
				{/each}
				<label class="own" title="Sign colour"><input type="color" bind:value={primary} aria-label="Sign colour" /></label>
				<label class="own" title="Stripe colour"><input type="color" bind:value={accent} aria-label="Stripe colour" /></label>
			</div>
		</fieldset>
		<label class="switch"><input type="checkbox" role="switch" bind:checked={open} /> <span>Open for customers</span></label>
		{#if notice}<p class="ok" data-testid="shop-notice">{notice}</p>{/if}
		{#if error}<p class="alert-error">{error}</p>{/if}
		<button class="btn-primary py-2" disabled={busy || !changed} data-testid="shop-save">{busy ? 'Saving…' : changed ? 'Save' : 'Saved'}</button>
	</div>
</form>

<style>
	.look { display: grid; grid-template-columns: 15rem 1fr; gap: 16px; align-items: start; }
	.preview { display: grid; border-radius: 16px; overflow: hidden; background: rgba(255, 255, 255, 0.09); border: 1px solid rgba(255, 255, 255, 0.14); position: sticky; top: 0; }
	.board { padding: 10px; text-align: center; color: #fff; border-bottom: 6px solid; }
	.board-name { font-family: var(--font-display); font-size: 19px; font-weight: 700; line-height: 1.15; overflow-wrap: anywhere; }
	.board-km { font-size: 13px; opacity: 0.9; }
	.awning { height: 22px; background: repeating-linear-gradient(90deg, var(--a) 0 16px, var(--b) 16px 32px); clip-path: polygon(0 0, 100% 0, 100% 60%, 96% 100%, 92% 60%, 88% 100%, 84% 60%, 80% 100%, 76% 60%, 72% 100%, 68% 60%, 64% 100%, 60% 60%, 56% 100%, 52% 60%, 48% 100%, 44% 60%, 40% 100%, 36% 60%, 32% 100%, 28% 60%, 24% 100%, 20% 60%, 16% 100%, 12% 60%, 8% 100%, 4% 60%, 0 100%); }
	.front { display: grid; grid-template-columns: 1fr 1.1fr 1fr; gap: 8px; padding: 6px 10px 0; height: 76px; background: linear-gradient(#ece4d3, #e2d8c3); }
	.window { border-radius: 4px 4px 0 0; background: linear-gradient(160deg, #cfe3e6, #9cc8d2); }
	.door { display: grid; place-items: center; border-radius: 4px 4px 0 0; background: #4a3b2a; color: #f7d774; font-size: 11px; font-weight: 700; }
	.door.shut { background: #6d6a63; color: #ddd; }
	.tag { padding: 8px 10px 0; font-size: 12px; text-align: center; color: var(--color-ink-soft); }
	.where { padding: 2px 10px 10px; font-size: 11px; text-align: center; color: var(--color-ink-soft); }
	.fields { display: grid; gap: 10px; }
	label, fieldset { display: grid; gap: 4px; border: 0; margin: 0; padding: 0; min-width: 0; }
	.lbl { font-size: 13px; font-weight: 600; color: var(--color-ink); }
	.chips, .pairs { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
	.pair { display: flex; width: 44px; height: 30px; border-radius: 10px; overflow: hidden; border: 2px solid transparent; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25); }
	.pair span { flex: 1; }
	.pair.on { border-color: #fff; box-shadow: 0 0 0 2px rgba(11, 37, 36, 0.9), 0 0 0 4px var(--color-saffron-300); }
	.own input { width: 44px; height: 30px; border-radius: 10px; padding: 0; border: 1px solid rgba(255, 255, 255, 0.3); background: none; cursor: pointer; }
	.switch { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
	.switch input { width: 18px; height: 18px; accent-color: #4c9a63; }
	.ok { font-size: 13px; padding: 8px 12px; border-radius: 12px; background: rgba(191, 224, 216, 0.16); }
	@media (max-width: 640px) { .look { grid-template-columns: 1fr; } .preview { position: static; } }
</style>

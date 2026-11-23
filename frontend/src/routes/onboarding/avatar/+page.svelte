<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Check, Shuffle } from 'lucide-svelte';
	import AvatarPreview from '$lib/components/AvatarPreview.svelte';
	import { me } from '$lib/api/endpoints';
	import { ApiError } from '$lib/api/client';
	import type { Avatar } from '$lib/api/types';
	import {
		CLOTH_COLORS,
		DEFAULT_AVATAR,
		HAIR_COLORS,
		SHOE_COLORS,
		SKIN_TONES,
		colorName,
		randomAvatar
	} from '$lib/game/avatar/avatar';
	import { describe, summary as outfit } from '$lib/game/avatar/wardrobe';
	import { session, nextPath } from '$lib/stores/session.svelte';

	let avatar = $state<Avatar>({
		...DEFAULT_AVATAR,
		avatar_name: session.user?.display_name.slice(0, 32) ?? 'Explorer'
	});
	let busy = $state(false);
	let error = $state('');

	onMount(async () => {
		try {
			const saved = await me.avatar();
			const { model: _model, ...rest } = saved;
			avatar = { ...DEFAULT_AVATAR, ...rest };
		} catch {
			/* no avatar yet */
		}
	});

	/** The whole look in one sentence, under the preview (the same words as the wardrobe). */
	const summary = $derived(outfit(avatar));

	/** Light swatches get a dark tick, dark ones a white one. */
	function light(hex: string): boolean {
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
		return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
	}

	/** Arrow keys move the choice within a group (one tab stop per group, like radio buttons). */
	function rove<T>(event: KeyboardEvent, values: readonly T[], value: T, set: (v: T) => void) {
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		if (!step) return;
		event.preventDefault();
		const next = (values.indexOf(value) + step + values.length) % values.length;
		set(values[next]);
		const group = (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]');
		group[next]?.focus();
	}

	async function save() {
		busy = true;
		error = '';
		try {
			await me.saveAvatar($state.snapshot(avatar) as Avatar);
			const user = await session.refresh();
			await goto(nextPath(user), { invalidateAll: true });
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not save your avatar.';
		} finally {
			busy = false;
		}
	}
</script>

<!-- Swatches on one grid (twelve across, six on a phone), so every row lines up; `half` for a
     palette in a half-width column. -->
{#snippet swatches(colors: string[], value: string, set: (c: string) => void, label: string, palette: 'skin' | 'hair' | 'cloth' | 'shoe', half = false)}
	<div
		class="grid gap-2 {half ? 'grid-cols-6' : 'grid-cols-6 sm:grid-cols-12'}"
		role="radiogroup"
		aria-label={label}
		tabindex="-1"
		onkeydown={(e) => rove(e, colors, value, set)}
	>
		{#each colors as color (color)}
			{@const on = value === color}
			<button
				type="button"
				role="radio"
				aria-checked={on}
				aria-label={colorName(palette, color)}
				title={colorName(palette, color)}
				tabindex={on || (!colors.includes(value) && color === colors[0]) ? 0 : -1}
				class="grid aspect-square w-full max-w-10 place-items-center rounded-full ring-1 ring-river-950/10 ring-inset transition
					{on ? 'outline-2 outline-offset-2 outline-river-900' : 'hover:scale-105'}"
				style="background: {color}"
				onclick={() => set(color)}
			>
				{#if on}<Check size={16} strokeWidth={3} class={light(color) ? 'text-river-950' : 'text-white drop-shadow'} />{/if}
			</button>
		{/each}
	</div>
{/snippet}

{#snippet choice(options: [string, string][], value: string, set: (v: any) => void, label: string)}
	<div
		class="grid grid-flow-col gap-1 rounded-xl bg-paper-2 p-1 text-sm font-semibold"
		role="radiogroup"
		aria-label={label}
		tabindex="-1"
		onkeydown={(e) => rove(e, options.map(([id]) => id), value, set)}
	>
		{#each options as [id, text] (id)}
			<button
				type="button"
				role="radio"
				aria-checked={value === id}
				tabindex={value === id ? 0 : -1}
				class="rounded-lg px-3 py-2 transition {value === id ? 'bg-white text-river-900 shadow' : 'text-ink-soft hover:text-river-900'}"
				onclick={() => set(id)}>{text}</button
			>
		{/each}
	</div>
{/snippet}

<!-- A row's name and what is chosen. -->
{#snippet row(name: string, value = '')}
	<div class="mb-2 flex items-baseline justify-between gap-3">
		<p class="text-sm font-semibold text-ink">{name}</p>
		{#if value}<p class="truncate text-sm text-ink-soft">{value}</p>{/if}
	</div>
{/snippet}

<svelte:head><title>Avatar · Phnom Penh Digital World</title></svelte:head>

<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start">
	<section class="h-[50svh] max-h-[500px] min-h-[320px] lg:sticky lg:top-6 lg:h-[calc(100dvh-7rem)] lg:max-h-[760px]" aria-label="Preview">
		<AvatarPreview {avatar} caption={summary} />
	</section>

	<section class="card flex flex-col gap-7 pb-0">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0 flex-1 basis-60">
				<p class="eyebrow">Step 2 of 4</p>
				<h1 class="display mt-1 text-3xl font-bold">Create your avatar</h1>
				<p class="mt-1 text-sm text-ink-soft">This is how other players will see you.</p>
			</div>
			<button type="button" class="btn-ghost shrink-0" onclick={() => (avatar = randomAvatar(avatar.avatar_name))}
				><Shuffle size={16} /> Surprise me</button
			>
		</header>

		<div>
			<label class="mb-2 block text-sm font-semibold text-ink" for="avatar_name">Avatar name</label>
			<input id="avatar_name" class="input" maxlength="32" bind:value={avatar.avatar_name} />
		</div>

		<section class="space-y-5 border-t border-river-900/10 pt-5" aria-labelledby="body-heading">
			<h2 id="body-heading" class="display text-xl font-semibold">Body</h2>
			<div class="grid gap-5 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)]">
				<div>
					{@render row('Build')}
					{@render choice([['a', 'Build A'], ['b', 'Build B']], avatar.body, (v) => (avatar.body = v), 'Build')}
				</div>
				<div>
					{@render row('Skin tone', colorName('skin', avatar.skin_tone))}
					{@render swatches(SKIN_TONES, avatar.skin_tone, (c) => (avatar.skin_tone = c), 'Skin tone', 'skin', true)}
				</div>
			</div>
		</section>

		<section class="space-y-5 border-t border-river-900/10 pt-5" aria-labelledby="hair-heading">
			<h2 id="hair-heading" class="display text-xl font-semibold">Hair</h2>
			<div>
				{@render row('Colour', colorName('hair', avatar.hair_color))}
				{@render swatches(HAIR_COLORS, avatar.hair_color, (c) => (avatar.hair_color = c), 'Hair colour', 'hair')}
			</div>
		</section>

		<section class="space-y-5 border-t border-river-900/10 pt-5" aria-labelledby="clothes-heading">
			<h2 id="clothes-heading" class="display text-xl font-semibold">Clothes</h2>
			<div>
				{@render row('Top', describe('top', avatar))}
				{@render swatches(CLOTH_COLORS, avatar.top_color, (c) => (avatar.top_color = c), 'Top colour', 'cloth')}
			</div>
			<div>
				{@render row('Trousers', describe('bottom', avatar))}
				{@render swatches(CLOTH_COLORS, avatar.bottom_color, (c) => (avatar.bottom_color = c), 'Trousers colour', 'cloth')}
			</div>
			<div>
				{@render row('Shoes', describe('shoes', avatar))}
				{@render swatches(SHOE_COLORS, avatar.shoe_color, (c) => (avatar.shoe_color = c), 'Shoe colour', 'shoe')}
			</div>
			<div>
				{@render row('Backpack', describe('bag', avatar))}
				{@render swatches(CLOTH_COLORS, avatar.accent_color, (c) => (avatar.accent_color = c), 'Backpack colour', 'cloth')}
				<p class="hint">This colour also trims the top's panels and the shoes.</p>
			</div>
		</section>

		<!-- Always in reach: the card's foot sticks to the bottom of the window. -->
		<div class="sticky bottom-0 -mx-6 mt-1 rounded-b-3xl border-t border-river-900/10 bg-white/95 px-6 pt-4 pb-6 backdrop-blur">
			{#if error}<p class="alert-error mb-3" role="alert">{error}</p>{/if}
			<button class="btn-primary w-full" onclick={save} disabled={busy || avatar.avatar_name.trim().length < 2}>
				{busy ? 'Saving…' : 'Save avatar & continue'}
			</button>
			{#if avatar.avatar_name.trim().length < 2}<p class="hint text-center">Give your avatar a name of at least 2 characters.</p>{/if}
		</div>
	</section>
</div>

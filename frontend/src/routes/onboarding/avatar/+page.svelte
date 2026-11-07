<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Shuffle } from 'lucide-svelte';
	import AvatarPreview from '$lib/components/AvatarPreview.svelte';
	import { me } from '$lib/api/endpoints';
	import { ApiError } from '$lib/api/client';
	import type { Accessory, Avatar } from '$lib/api/types';
	import {
		CLOTH_COLORS,
		DEFAULT_AVATAR,
		HAIR_COLORS,
		SHOE_COLORS,
		SKIN_TONES,
		randomAvatar
	} from '$lib/game/avatar/avatar';
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

	const ACCESSORIES: { id: Accessory; label: string }[] = [
		{ id: 'cap', label: 'Cap' },
		{ id: 'glasses', label: 'Glasses' },
		{ id: 'backpack', label: 'Backpack' },
		{ id: 'krama', label: 'Krama scarf' }
	];

	function toggle(id: Accessory) {
		avatar.accessories = avatar.accessories.includes(id)
			? avatar.accessories.filter((a) => a !== id)
			: avatar.accessories.length < 3
				? [...avatar.accessories, id]
				: avatar.accessories;
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

{#snippet swatches(colors: string[], value: string, set: (c: string) => void, label: string)}
	<div class="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
		{#each colors as color (color)}
			<button
				type="button"
				role="radio"
				aria-checked={value === color}
				aria-label={`${label} ${color}`}
				class="h-8 w-8 rounded-full border-2 transition {value === color
					? 'scale-110 border-river-900 ring-2 ring-saffron-500 ring-offset-2'
					: 'border-white shadow'}"
				style="background: {color}"
				onclick={() => set(color)}
			></button>
		{/each}
	</div>
{/snippet}

{#snippet choice(
	options: [string, string][],
	value: string,
	set: (v: any) => void,
	label: string
)}
	<div class="grid grid-flow-col gap-1 rounded-xl bg-paper-2 p-1 text-sm font-semibold" role="radiogroup" aria-label={label}>
		{#each options as [id, text] (id)}
			<button
				type="button"
				role="radio"
				aria-checked={value === id}
				class="rounded-lg px-3 py-2 transition {value === id ? 'bg-white text-river-900 shadow' : 'text-ink-soft'}"
				onclick={() => set(id)}>{text}</button
			>
		{/each}
	</div>
{/snippet}

<svelte:head><title>Avatar · Phnom Penh Digital World</title></svelte:head>

<div class="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
	<section class="h-[420px] lg:sticky lg:top-6 lg:h-[640px]">
		<AvatarPreview {avatar} />
	</section>

	<section class="card space-y-6">
		<div class="flex items-start justify-between gap-4">
			<div>
				<p class="eyebrow">Step 2 of 4</p>
				<h1 class="display mt-1 text-3xl font-bold">Create your avatar</h1>
				<p class="mt-1 text-sm text-ink-soft">This is how other players will see you.</p>
			</div>
			<button
				type="button"
				class="btn-ghost shrink-0"
				onclick={() => (avatar = randomAvatar(avatar.avatar_name))}><Shuffle size={16} /> Surprise me</button
			>
		</div>

		<div>
			<label class="label" for="avatar_name">Avatar name</label>
			<input id="avatar_name" class="input" maxlength="32" bind:value={avatar.avatar_name} />
		</div>

		<div class="grid gap-5 sm:grid-cols-2">
			<div>
				<p class="label">Build</p>
				{@render choice([['a', 'Build A'], ['b', 'Build B']], avatar.body, (v) => (avatar.body = v), 'Build')}
			</div>
			<div>
				<p class="label">Skin tone</p>
				{@render swatches(SKIN_TONES, avatar.skin_tone, (c) => (avatar.skin_tone = c), 'Skin tone')}
			</div>
		</div>

		<div class="space-y-3">
			<p class="label">Hair</p>
			{@render choice(
				[['short', 'Short'], ['long', 'Long'], ['bun', 'Bun'], ['buzz', 'Buzz']],
				avatar.hair_style,
				(v) => (avatar.hair_style = v),
				'Hairstyle'
			)}
			{@render swatches(HAIR_COLORS, avatar.hair_color, (c) => (avatar.hair_color = c), 'Hair colour')}
		</div>

		<div class="space-y-3">
			<p class="label">Top</p>
			{@render choice([['tee', 'T-shirt'], ['hoodie', 'Hoodie']], avatar.top_style, (v) => (avatar.top_style = v), 'Top style')}
			{@render swatches(CLOTH_COLORS, avatar.top_color, (c) => (avatar.top_color = c), 'Top colour')}
		</div>

		<div class="space-y-3">
			<p class="label">Bottom</p>
			{@render choice(
				[['trousers', 'Trousers'], ['shorts', 'Shorts']],
				avatar.bottom_style,
				(v) => (avatar.bottom_style = v),
				'Bottom style'
			)}
			{@render swatches(CLOTH_COLORS, avatar.bottom_color, (c) => (avatar.bottom_color = c), 'Bottom colour')}
		</div>

		<div class="grid gap-5 sm:grid-cols-2">
			<div>
				<p class="label">Shoes</p>
				{@render swatches(SHOE_COLORS, avatar.shoe_color, (c) => (avatar.shoe_color = c), 'Shoe colour')}
			</div>
			<div>
				<p class="label">Accessory colour</p>
				{@render swatches(CLOTH_COLORS.slice(0, 6), avatar.accent_color, (c) => (avatar.accent_color = c), 'Accessory colour')}
			</div>
		</div>

		<div>
			<p class="label">Accessories <span class="normal-case">(up to 3)</span></p>
			<div class="flex flex-wrap gap-2">
				{#each ACCESSORIES as acc (acc.id)}
					{@const on = avatar.accessories.includes(acc.id)}
					<button
						type="button"
						aria-pressed={on}
						class="chip py-2 {on ? 'border-river-900 bg-river-900 text-paper' : ''}"
						onclick={() => toggle(acc.id)}>{acc.label}</button
					>
				{/each}
			</div>
		</div>

		{#if error}<p class="alert-error" role="alert">{error}</p>{/if}
		<button class="btn-primary w-full" onclick={save} disabled={busy || avatar.avatar_name.trim().length < 2}>
			{busy ? 'Saving…' : 'Save avatar & continue'}
		</button>
	</section>
</div>

<script lang="ts">
	/**
	 * The wardrobe, in the game: a glass panel over the city while the camera faces the player.
	 * Pick a category, turn its wheels; the avatar in the world changes as you go (`onPreview`).
	 * Save keeps the outfit (others see it at once); Cancel or Escape puts the old one back.
	 */
	import { Backpack, Eye, Footprints, Glasses, PersonStanding, Scissors, Shirt, Shuffle, X } from 'lucide-svelte';
	import type { Avatar } from '$lib/api/types';
	import type { AvatarStyle } from '$lib/game/avatar/character';
	import { randomAvatar } from '$lib/game/avatar/avatar';
	import { CATEGORIES, describe, wheels, type CategoryId } from '$lib/game/avatar/wardrobe';
	import { untrack } from 'svelte';
	import Drum from './Drum.svelte';

	let {
		outfit,
		look,
		solid = false,
		onLook,
		onPreview,
		onSave,
		onClose
	}: {
		outfit: Avatar;
		look: AvatarStyle;
		/** No frosted glass (slow graphics): a more opaque panel instead. */
		solid?: boolean;
		onLook: (style: AvatarStyle) => void;
		onPreview: (avatar: Avatar) => void;
		onSave: (avatar: Avatar) => Promise<void>;
		onClose: () => void;
	} = $props();

	// What was worn when the wardrobe opened (Cancel goes back to it).
	const saved = untrack(() => $state.snapshot(outfit) as Avatar);
	let draft = $state<Avatar>(untrack(() => $state.snapshot(outfit) as Avatar));
	let category = $state<CategoryId>('top');
	let busy = $state(false);
	let error = $state('');
	/** A phone or a narrow window: the panel is a sheet under the avatar, with shorter wheels. */
	let narrow = $state(typeof window !== 'undefined' && window.innerWidth < 900);

	const current = $derived(CATEGORIES.find((c) => c.id === category)!);
	const turning = $derived(wheels(category, draft));
	const changed = $derived(JSON.stringify(draft) !== JSON.stringify(saved));

	// Show every change on the avatar in the world (a short pause first: wheels turn fast, and a
	// classic avatar is rebuilt for other parts).
	let timer: ReturnType<typeof setTimeout> | undefined;
	function wear(next: Avatar) {
		draft = next;
		clearTimeout(timer);
		timer = setTimeout(() => onPreview($state.snapshot(draft) as Avatar), 90);
	}

	function cancel() {
		clearTimeout(timer);
		if (changed) onPreview(saved);
		onClose();
	}

	async function save() {
		if (busy) return;
		if (draft.avatar_name.trim().length < 2) return (error = 'Give your avatar a name of at least 2 characters.');
		clearTimeout(timer);
		busy = true;
		error = '';
		try {
			await onSave($state.snapshot(draft) as Avatar);
			onClose();
		} catch (e) {
			error = e instanceof Error && e.message ? e.message : 'Your outfit could not be saved. Try again.';
		} finally {
			busy = false;
		}
	}

	function keydown(e: KeyboardEvent) {
		const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT';
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			cancel();
		} else if (!typing && (e.key === '[' || e.key === ']')) {
			const i = CATEGORIES.findIndex((c) => c.id === category);
			category = CATEGORIES[(i + (e.key === ']' ? 1 : CATEGORIES.length - 1)) % CATEGORIES.length].id;
		}
	}
</script>

<svelte:window onkeydown={keydown} onresize={() => (narrow = window.innerWidth < 900)} />

<div class="wardrobe" data-testid="wardrobe" data-category={category}>
	<div class="glass panel" class:solid aria-label="Wardrobe" role="dialog" aria-modal="false">
		<header class="head">
			<h2>Wardrobe</h2>
			<div class="look" role="radiogroup" aria-label="Look">
				{#each [['realistic', 'Realistic'], ['classic', 'Classic']] as const as [s, text] (s)}
					<button type="button" role="radio" aria-checked={look === s} class:on={look === s} onclick={() => onLook(s)}>{text}</button>
				{/each}
			</div>
			<button type="button" class="icon" aria-label="Close without saving" onclick={cancel}><X size={18} /></button>
		</header>

		<div class="cats" role="tablist" aria-label="What to change">
			{#each CATEGORIES as c (c.id)}
				<button type="button" role="tab" aria-selected={category === c.id} class:on={category === c.id} onclick={() => (category = c.id)} data-testid={`cat-${c.id}`}>
					<span class="cat-icon" aria-hidden="true">
						{#if c.id === 'top'}<Shirt size={18} />
						{:else if c.id === 'bottom'}<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M7 3h10l1 18h-4l-2-11-2 11H6z" /></svg>
						{:else if c.id === 'shoes'}<Footprints size={18} />
						{:else if c.id === 'hat'}<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 15a8 8 0 0 1 16 0z" /><path d="M12 15h9" /></svg>
						{:else if c.id === 'glasses'}<Glasses size={18} />
						{:else if c.id === 'bag'}<Backpack size={18} />
						{:else if c.id === 'scarf'}<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 6c4 3 10 3 14 0" /><path d="M9 8l-2 13h4l1-10" /></svg>
						{:else if c.id === 'hair'}<Scissors size={18} />
						{:else}<PersonStanding size={18} />{/if}
					</span>
					<span>{c.label}</span>
				</button>
			{/each}
		</div>

		<div class="now">
			<p class="now-cat">{current.label}</p>
			<p class="now-what" data-testid="wardrobe-now">{describe(category, draft)}</p>
		</div>

		{#if current.classicOnly && look === 'realistic'}
			<button type="button" class="tag" onclick={() => onLook('classic')} title="The realistic look wears one outfit in your colours. Show the Classic look.">
				<Eye size={13} /> The item shows in the Classic look
			</button>
		{/if}

		<div class="wheels" class:single={turning.length === 1}>
			{#each turning as wheel (`${category}-${wheel.kind}`)}
				<Drum id={`${category}-${wheel.kind}`} rows={narrow ? 3 : 5} label={wheel.label} choices={wheel.choices} value={wheel.value} onchange={(id) => wear(wheel.pick(draft, id))} />
			{/each}
		</div>
		{#if current.note}<p class="note">{current.note}</p>{/if}

		{#if category === 'body'}
			<label class="name">
				<span>Avatar name</span>
				<input class="glass-input" maxlength="32" value={draft.avatar_name} oninput={(e) => (draft = { ...draft, avatar_name: e.currentTarget.value })} />
			</label>
		{/if}

		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<footer class="foot">
			<button type="button" class="ghost" onclick={() => wear(randomAvatar(draft.avatar_name))}><Shuffle size={15} /> Surprise me</button>
			<span class="grow"></span>
			<button type="button" class="ghost" onclick={cancel}>Cancel</button>
			<button type="button" class="save" disabled={busy} onclick={save} data-testid="wardrobe-save">{busy ? 'Saving…' : changed ? 'Save outfit' : 'Done'}</button>
		</footer>
	</div>
	<p class="glass hint" class:solid>Scroll a wheel to choose · drag the city to turn around · <kbd>[</kbd> <kbd>]</kbd> change what to wear · <kbd>Esc</kbd> cancel</p>
</div>

<style>
	.wardrobe { position: absolute; inset: 0; pointer-events: none; z-index: 30; color: #f6f1e6; }
	.glass {
		pointer-events: auto;
		background: rgba(11, 37, 36, 0.38);
		-webkit-backdrop-filter: blur(18px) saturate(150%);
		backdrop-filter: blur(18px) saturate(150%);
		border: 1px solid rgba(255, 255, 255, 0.24);
		box-shadow: 0 24px 60px -24px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.2);
	}
	.glass.solid { background: rgba(11, 37, 36, 0.86); -webkit-backdrop-filter: none; backdrop-filter: none; }
	.panel {
		position: absolute;
		top: max(16px, env(safe-area-inset-top, 0px));
		bottom: 16px;
		right: max(16px, env(safe-area-inset-right, 0px));
		width: min(400px, calc(100vw - 32px));
		border-radius: 26px;
		padding: 18px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		overflow-y: auto;
	}
	.panel > * { flex-shrink: 0; } /* the panel scrolls; its rows keep their height */
	.head { display: flex; align-items: center; gap: 10px; }
	h2 { margin: 0; flex: 1; font-family: var(--font-display); font-size: 24px; font-weight: 700; color: #fffaf0; }
	.look { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 3px; border-radius: 12px; background: rgba(255, 255, 255, 0.12); font-size: 12px; font-weight: 600; }
	.look button { padding: 4px 10px; border-radius: 9px; color: inherit; opacity: 0.8; }
	.look button.on { background: rgba(255, 255, 255, 0.92); color: #123b3a; opacity: 1; }
	.icon { padding: 6px; border-radius: 10px; }
	.icon:hover, .ghost:hover { background: rgba(255, 255, 255, 0.14); }
	.cats { display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr)); gap: 6px; }
	.cats button { display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-radius: 12px; font-size: 12px; font-weight: 600; background: rgba(255, 255, 255, 0.08); border: 1px solid transparent; color: inherit; }
	.cats button:hover { background: rgba(255, 255, 255, 0.16); }
	.cats button.on { background: rgba(255, 255, 255, 0.92); color: #123b3a; }
	.cat-icon { display: grid; place-items: center; }
	.now { display: grid; gap: 2px; }
	.now-cat { font-size: 12px; font-weight: 600; opacity: 0.75; }
	.now-what { font-family: var(--font-display); font-size: 22px; font-weight: 600; color: #fffaf0; }
	.tag { justify-self: start; align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: rgba(232, 163, 61, 0.9); color: #0b2524; }
	.wheels { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.wheels.single { grid-template-columns: 1fr; }
	.note { font-size: 12px; opacity: 0.8; }
	.name { display: grid; gap: 6px; font-size: 12px; font-weight: 600; }
	.glass-input { border-radius: 12px; padding: 9px 12px; font-size: 15px; color: #fffaf0; background: rgba(255, 255, 255, 0.12); border: 1px solid rgba(255, 255, 255, 0.3); }
	.glass-input:focus { outline: 2px solid var(--color-saffron-500); }
	.error { font-size: 13px; font-weight: 600; color: #ffd4c4; }
	.foot { margin-top: auto; display: flex; align-items: center; gap: 8px; padding-top: 6px; position: sticky; bottom: -18px; margin-bottom: -4px; padding-bottom: 4px; background: linear-gradient(to bottom, transparent, rgba(11, 37, 36, 0.55) 35%); }
	.grow { flex: 1; }
	.ghost { display: inline-flex; align-items: center; gap: 6px; padding: 9px 12px; border-radius: 12px; font-size: 13px; font-weight: 600; color: inherit; }
	.save { padding: 10px 18px; border-radius: 12px; font-size: 14px; font-weight: 700; background: var(--color-saffron-500); color: #0b2524; box-shadow: 0 5px 0 -2px var(--color-saffron-600); }
	.save:disabled { opacity: 0.6; }
	.hint { position: absolute; left: max(16px, env(safe-area-inset-left, 0px)); bottom: 16px; max-width: calc(100vw - 448px); border-radius: 999px; padding: 8px 14px; font-size: 12px; }
	kbd { font-family: inherit; font-size: 11px; font-weight: 700; padding: 0 5px; border-radius: 4px; background: rgba(255, 255, 255, 0.85); color: #123b3a; }
	button:focus-visible { outline: 3px solid var(--color-saffron-500); outline-offset: 2px; }

	/* Phones and narrow windows: the panel is a sheet over the lower part of the screen, the
	   camera keeps the avatar in the upper part (see the world page). */
	@media (max-width: 899px) {
		.panel { top: auto; left: max(10px, env(safe-area-inset-left, 0px)); right: max(10px, env(safe-area-inset-right, 0px)); bottom: max(10px, env(safe-area-inset-bottom, 0px)); width: auto; max-height: 52dvh; padding: 14px; gap: 10px; border-radius: 22px; }
		.cats { display: flex; overflow-x: auto; scrollbar-width: none; }
		.cats button { flex: none; }
		.now-what { font-size: 18px; }
		.foot { bottom: -14px; }
		.hint { display: none; }
	}
</style>

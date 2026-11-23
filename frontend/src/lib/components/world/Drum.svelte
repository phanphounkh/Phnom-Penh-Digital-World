<script lang="ts">
	/**
	 * A wheel to choose from: the choices sit on a drum, the one in the lens is chosen. Turn it
	 * with the mouse wheel or a touchpad, the arrow keys, a drag, or a click on a choice.
	 * Blocked choices are passed over.
	 */
	import type { Choice } from '$lib/game/avatar/wardrobe';

	let {
		label,
		choices,
		value,
		onchange,
		id,
		rows = 5
	}: { label: string; choices: Choice[]; value: string; onchange: (id: string) => void; id: string; rows?: number } = $props();

	const ROW = 42;
	/** Rows on show (odd: the lens sits in the middle one). */
	const VISIBLE = $derived(rows);
	let host: HTMLDivElement;
	const index = $derived(Math.max(0, choices.findIndex((c) => c.id === value)));
	const blockedNote = $derived(choices.find((c) => c.blocked)?.blocked ?? '');

	/** Move `by` choices (skipping blocked ones); stays put at either end. */
	function turn(by: number) {
		let i = index;
		for (let n = 0; n < Math.abs(by); n++) {
			let j = i + Math.sign(by);
			while (choices[j]?.blocked) j += Math.sign(by);
			if (!choices[j]) break;
			i = j;
		}
		if (i !== index) onchange(choices[i].id);
	}

	// The wheel (and touchpads): one choice per notch; small touchpad steps add up.
	let pending = 0;
	$effect(() => {
		const wheel = (e: WheelEvent) => {
			e.preventDefault();
			pending += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
			if (Math.abs(pending) < 36) return;
			turn(Math.sign(pending));
			pending = 0;
		};
		host.addEventListener('wheel', wheel, { passive: false });
		return () => host.removeEventListener('wheel', wheel);
	});

	function keydown(e: KeyboardEvent) {
		const by = { ArrowDown: 1, ArrowUp: -1, PageDown: 3, PageUp: -3 }[e.key];
		if (by) {
			e.preventDefault();
			e.stopPropagation();
			turn(by);
		} else if (e.key === 'Home' || e.key === 'End') {
			e.preventDefault();
			turn(e.key === 'Home' ? -choices.length : choices.length);
		}
	}

	// A drag: one choice per row height.
	let dragY: number | null = null;
	function down(e: PointerEvent) {
		dragY = e.clientY;
		host.setPointerCapture(e.pointerId);
	}
	function move(e: PointerEvent) {
		if (dragY === null) return;
		const rows = Math.trunc((dragY - e.clientY) / ROW);
		if (rows) {
			turn(rows);
			dragY -= rows * ROW;
		}
	}
	const up = () => (dragY = null);
</script>

<div class="drum-wrap">
	<p class="drum-label" id={`${id}-label`}>{label}</p>
	<div
		bind:this={host}
		class="drum"
		role="listbox"
		tabindex="0"
		aria-labelledby={`${id}-label`}
		aria-activedescendant={`${id}-${index}`}
		data-testid={`drum-${id}`}
		data-value={value}
		style:height={`${ROW * VISIBLE}px`}
		onkeydown={keydown}
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
	>
		<div class="lens" style:top={`${ROW * Math.floor(VISIBLE / 2)}px`} style:height={`${ROW}px`}></div>
		<ul style:transform={`translateY(${(Math.floor(VISIBLE / 2) - index) * ROW}px)`}>
			{#each choices as choice, i (choice.id)}
				{@const d = i - index}
				{@const far = Math.min(Math.abs(d), 3)}
				<!-- svelte-ignore a11y_click_events_have_key_events (the listbox takes the keys) -->
				<li
					id={`${id}-${i}`}
					role="option"
					aria-selected={i === index}
					aria-disabled={!!choice.blocked}
					title={choice.blocked}
					class:chosen={i === index}
					class:blocked={!!choice.blocked}
					style:height={`${ROW}px`}
					style:transform={`rotateX(${d * -16}deg) scale(${1 - far * 0.06})`}
					style:opacity={choice.blocked ? 0.35 : 1 - far * 0.28}
					onclick={() => !choice.blocked && onchange(choice.id)}
				>
					{#if choice.swatch}<span class="swatch" style:background={choice.swatch}></span>{/if}
					<span class="name">{choice.label}</span>
				</li>
			{/each}
		</ul>
	</div>
	{#if blockedNote}<p class="drum-note">{blockedNote}</p>{/if}
</div>

<style>
	.drum-wrap { display: grid; gap: 6px; min-width: 0; }
	.drum-label { font-size: 12px; font-weight: 600; opacity: 0.8; }
	.drum {
		position: relative;
		overflow: hidden;
		border-radius: 16px;
		cursor: ns-resize;
		touch-action: none;
		perspective: 420px;
		outline: none;
		-webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 28%, #000 72%, transparent 100%);
		mask-image: linear-gradient(to bottom, transparent 0, #000 28%, #000 72%, transparent 100%);
	}
	.drum:focus-visible .lens { box-shadow: 0 0 0 3px var(--color-saffron-500); }
	.lens {
		position: absolute;
		left: 0;
		right: 0;
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.18);
		border: 1px solid rgba(255, 255, 255, 0.4);
		pointer-events: none;
	}
	ul { list-style: none; margin: 0; padding: 0; transition: transform 160ms ease-out; }
	li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 14px;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		transition: transform 160ms ease-out, opacity 160ms ease-out;
	}
	li.chosen { font-size: 16px; }
	li.blocked { text-decoration: line-through; cursor: not-allowed; }
	.name { overflow: hidden; text-overflow: ellipsis; }
	.swatch { width: 22px; height: 22px; flex: none; border-radius: 999px; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25), 0 0 0 2px rgba(255, 255, 255, 0.5); }
	.drum-note { font-size: 12px; opacity: 0.85; }
	@media (prefers-reduced-motion: reduce) { ul, li { transition: none; } }
</style>

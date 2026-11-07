<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		title,
		subtitle,
		children,
		footer
	}: { title: string; subtitle?: string; children: Snippet; footer?: Snippet } = $props();
</script>

<main class="street-grid grid min-h-dvh place-items-center px-4 py-10">
	<div class="w-full max-w-md">
		<a href="/" class="mb-6 flex items-center gap-3 text-river-900">
			<span
				class="grid h-10 w-10 place-items-center rounded-xl bg-river-900 font-display text-lg font-bold text-saffron-500"
				>ភ</span
			>
			<span class="leading-tight">
				<span class="block font-display text-lg font-bold">Phnom Penh Digital World</span>
				<span class="khmer block text-xs text-ink-soft" lang="km">ពិភពឌីជីថលភ្នំពេញ</span>
			</span>
		</a>
		<div class="card">
			<h1 class="display text-3xl font-bold">{title}</h1>
			{#if subtitle}<p class="mt-2 text-sm text-ink-soft">{subtitle}</p>{/if}
			<div class="mt-6">{@render children()}</div>
		</div>
		{#if footer}<div class="mt-5 text-center text-sm text-ink-soft">{@render footer()}</div>{/if}
	</div>
</main>

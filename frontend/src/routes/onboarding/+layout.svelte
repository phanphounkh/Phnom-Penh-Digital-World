<script lang="ts">
	import { Check } from 'lucide-svelte';
	import { STEPS, stepIndex, session } from '$lib/stores/session.svelte';
	let { data, children } = $props();
	const current = $derived(stepIndex(data.step));
	const reached = $derived(session.user ? stepIndex(session.user.onboarding.next_step) : 0);
</script>

<main class="street-grid min-h-dvh pb-16">
	<header class="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-5">
		<a href="/" class="flex items-center gap-2 font-display text-lg font-bold text-river-900">
			<span class="grid h-8 w-8 place-items-center rounded-lg bg-river-900 text-saffron-500">ភ</span>
			<span class="hidden sm:inline">Phnom Penh Digital World</span>
		</a>
		<nav aria-label="Onboarding progress">
			<ol class="flex items-center gap-1 sm:gap-2">
				{#each STEPS as s, i (s.id)}
					{@const done = i < reached}
					<li class="flex items-center gap-1 sm:gap-2">
						{#if i > 0}<span class="h-px w-3 bg-river-900/20 sm:w-6"></span>{/if}
						<svelte:element
							this={i <= reached ? 'a' : 'span'}
							href={i <= reached ? `/onboarding/${s.id}` : undefined}
							class="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold
								{i === current
								? 'bg-river-900 text-paper'
								: done
									? 'bg-river-200 text-river-900'
									: 'text-ink-soft'}"
							aria-current={i === current ? 'step' : undefined}
						>
							<span
								class="grid h-5 w-5 place-items-center rounded-full text-[10px]
									{i === current ? 'bg-saffron-500 text-river-950' : 'bg-white/70'}"
							>
								{#if done && i !== current}<Check size={12} />{:else}{i + 1}{/if}
							</span>
							<span class="hidden md:inline">{s.label}</span>
						</svelte:element>
					</li>
				{/each}
			</ol>
		</nav>
	</header>
	<div class="mx-auto max-w-5xl px-5">{@render children()}</div>
</main>

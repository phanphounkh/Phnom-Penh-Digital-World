<script lang="ts">
	import WalletPanel from '$lib/components/world/WalletPanel.svelte';
</script>

<svelte:head><title>Demo wallet · Phnom Penh Digital World</title></svelte:head>
<main class="street-grid min-h-dvh px-4 py-8">
	<div class="mx-auto max-w-xl space-y-6">
		<header class="flex items-center justify-between gap-3">
			<div>
				<p class="eyebrow">Your account</p>
				<h1 class="display text-3xl font-bold">Demo wallet</h1>
			</div>
			<a class="btn-ghost" href="/world">Back to city</a>
		</header>
		<section class="card"><WalletPanel /></section>
	</div>
</main>

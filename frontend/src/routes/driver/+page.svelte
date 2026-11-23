<script lang="ts">
	import DriverPanel from '$lib/components/world/DriverPanel.svelte';
	let { data } = $props();
</script>

<svelte:head><title>Delivery jobs · Phnom Penh Digital World</title></svelte:head>
<main class="street-grid min-h-dvh px-4 py-8">
	<div class="mx-auto max-w-xl space-y-6">
		<header class="flex items-center justify-between gap-3">
			<div>
				<p class="eyebrow">Driver dashboard</p>
				<h1 class="display text-3xl font-bold">Delivery jobs</h1>
			</div>
			<a class="btn-ghost" href="/world">Back to city</a>
		</header>
		<section class="card">
			{#if data.approved}<DriverPanel />{:else}<p class="text-sm">
					Register as a driver at the System Office in the city (by Phsar Thmei: Places → System
					Office → Route), then wait for an administrator's approval before taking delivery jobs.
				</p>
				<a class="btn-primary mt-4" href="/world">Go to the city</a>{/if}
		</section>
	</div>
</main>

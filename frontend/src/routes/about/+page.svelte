<script lang="ts">
	import { ArrowLeft } from 'lucide-svelte';
	const ROADMAP = [
		['1', 'Foundation', 'Accounts, verification, roles, avatars, real map, one playable neighbourhood', 'now'],
		['2', '3D city', 'Richer Blender assets, street furniture, day/night, collisions polish', 'next'],
		['3', 'Multiplayer', 'See and chat with other online players in real time', ''],
		['4', 'Marketplace', 'Claim virtual shop units, storefronts, carts and demo checkout', ''],
		['5', 'Transport', 'Bicycle, motorbike, car and tuk-tuk on the real road network', ''],
		['6', 'Delivery', 'Driver registration, simulated delivery jobs and tracking', ''],
		['7', 'Payments', 'Ledger-based demo wallet with clearly labelled simulated credits', ''],
		['8', 'Production', 'Streaming, caching, monitoring and deployment hardening', '']
	];
</script>

<svelte:head><title>About · Phnom Penh Digital World</title></svelte:head>

<main class="street-grid min-h-dvh px-5 py-10">
	<article class="mx-auto max-w-3xl space-y-8">
		<a href="/" class="btn-quiet -ml-3"><ArrowLeft size={16} /> Home</a>
		<header>
			<p class="eyebrow">About the platform</p>
			<h1 class="display mt-2 text-4xl font-bold">A city you can walk into</h1>
			<p class="mt-4 text-lg text-ink-soft">
				Phnom Penh Digital World is a persistent, multiplayer 3D version of Phnom Penh, built on
				open map data and connected — in later phases — to real shops, orders and deliveries.
			</p>
		</header>

		<section class="card space-y-3">
			<h2 class="display text-2xl font-bold">What is real, and what is not</h2>
			<ul class="list-disc space-y-2 pl-5 text-sm leading-relaxed">
				<li><strong>Streets and building footprints are real</strong>, imported from an OpenStreetMap snapshot of Daun Penh (Central Market, Wat Phnom, the riverside). They can be out of date or incomplete.</li>
				<li><strong>Building heights, facade colours, windows and park trees are partly estimated.</strong> Where OSM has no height or storey count, a typical height for the building type is used and labelled as an estimate in the data.</li>
				<li><strong>It is not a live replica</strong> of Phnom Penh. Nothing you see reflects real-time conditions.</li>
				<li><strong>Players are real people.</strong> There are no fake accounts; you only see registered players who are online and chose to be visible.</li>
				<li><strong>Virtual property is not real property.</strong> Claiming a virtual shop unit never grants rights to a real building or business.</li>
				<li><strong>Money is simulated.</strong> Demo credits have no monetary value. Real payments will only be added through a licensed payment provider, after legal review.</li>
			</ul>
		</section>

		<section class="card space-y-3">
			<h2 class="display text-2xl font-bold">Your privacy</h2>
			<p class="text-sm leading-relaxed text-ink-soft">
				Your delivery address is private: it is never shown in the 3D world and never decides where
				your avatar appears. Avatars start at public places you choose. Your real-world GPS location
				is not used.
			</p>
		</section>

		<section class="card">
			<h2 class="display text-2xl font-bold">Roadmap</h2>
			<ol class="mt-4 space-y-3">
				{#each ROADMAP as [n, title, body, tag] (n)}
					<li class="flex gap-4">
						<span class="grid h-8 w-8 shrink-0 place-items-center rounded-full {tag === 'now' ? 'bg-saffron-500 text-river-950' : 'bg-paper-2 text-river-900'} text-sm font-bold">{n}</span>
						<div>
							<p class="font-semibold">{title} {#if tag === 'now'}<span class="chip ml-1">In this build</span>{/if}</p>
							<p class="text-sm text-ink-soft">{body}</p>
						</div>
					</li>
				{/each}
			</ol>
		</section>

		<section class="text-xs leading-relaxed text-ink-soft">
			<p>Map data © <a class="underline" href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, available under the Open Database Licence. Base map tiles in the location picker by OpenFreeMap / OpenMapTiles. 3D characters are original Blender models (CC0).</p>
			<p class="mt-2">The original CampusEats food court is still playable at <a class="underline" href="/mall" data-sveltekit-reload>/mall</a>; it will become the template for shop interiors.</p>
		</section>
	</article>
</main>

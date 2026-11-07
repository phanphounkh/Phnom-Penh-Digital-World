<script lang="ts">
	import { MapPin, LogIn, UserPlus, BookOpen, ArrowRight } from 'lucide-svelte';
	import StreetMapArt from '$lib/components/StreetMapArt.svelte';
	import { invalidateAll } from '$app/navigation';
	import { session, nextPath } from '$lib/stores/session.svelte';

	async function signOut() {
		await session.logout();
		await invalidateAll();
	}

	const enterHref = $derived(session.user ? nextPath(session.user) : '/register');
</script>

<svelte:head><title>Phnom Penh Digital World</title></svelte:head>

<main class="street-grid min-h-dvh">
	<div class="mx-auto grid max-w-6xl gap-10 px-5 py-10 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:py-16">
		<section>
			<p class="eyebrow flex items-center gap-2">
				<MapPin size={14} /> Daun Penh · Phnom Penh · Cambodia
			</p>
			<h1 class="display mt-4 text-5xl leading-[1.02] font-bold sm:text-6xl">
				Phnom Penh<br />Digital World
			</h1>
			<p class="khmer mt-3 text-xl text-river-700" lang="km">ពិភពឌីជីថលភ្នំពេញ</p>
			<p class="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft">
				Walk real streets mapped from OpenStreetMap, meet other players who are online right
				now, and — in upcoming phases — visit shops, ride a tuk-tuk and follow deliveries across
				the city.
			</p>

			<div class="mt-8 flex flex-col gap-3 sm:max-w-md">
				<a class="btn-accent py-4 text-base" href={enterHref} data-testid="enter-world">
					Enter Phnom Penh Digital World <ArrowRight size={18} />
				</a>
				{#if session.user}
					<p class="text-sm text-ink-soft">
						Signed in as <strong class="text-river-900">{session.user.display_name}</strong>
						(@{session.user.username}).
						<button class="font-semibold text-river-800 underline" onclick={signOut}
							>Sign out</button
						>
					</p>
				{:else}
					<div class="grid grid-cols-2 gap-3">
						<a class="btn-ghost" href="/login"><LogIn size={16} /> Sign in</a>
						<a class="btn-primary" href="/register"><UserPlus size={16} /> Create account</a>
					</div>
				{/if}
				<a class="btn-quiet self-start" href="/about"
					><BookOpen size={16} /> Learn about the platform</a
				>
			</div>
		</section>

		<section class="aspect-square w-full lg:aspect-[4/5]">
			<StreetMapArt />
		</section>
	</div>

	<section class="mx-auto max-w-6xl px-5 pb-14">
		<div class="grid gap-4 sm:grid-cols-3">
			<div class="card">
				<p class="eyebrow">Real</p>
				<p class="mt-2 font-semibold">Map-accurate streets</p>
				<p class="mt-1 text-sm text-ink-soft">
					2,300+ building footprints and every mapped road around Central Market, Wat Phnom and
					the riverside.
				</p>
			</div>
			<div class="card">
				<p class="eyebrow">Real</p>
				<p class="mt-2 font-semibold">Real players only</p>
				<p class="mt-1 text-sm text-ink-soft">
					No fake crowds. You only see registered players who are online and chose to be
					visible.
				</p>
			</div>
			<div class="card">
				<p class="eyebrow text-brick-500!">Simulated</p>
				<p class="mt-2 font-semibold">Demo money only</p>
				<p class="mt-1 text-sm text-ink-soft">
					No real payments or deposits. Virtual shops never grant ownership of real property.
				</p>
			</div>
		</div>
	</section>
</main>

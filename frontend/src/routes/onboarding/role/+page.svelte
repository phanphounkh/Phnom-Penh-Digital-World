<script lang="ts">
	import { goto } from '$app/navigation';
	import { Eye, ShoppingBag, Store, Bike, Clock, Check } from 'lucide-svelte';
	import { untrack, type Component } from 'svelte';
	import { me } from '$lib/api/endpoints';
	import { ApiError } from '$lib/api/client';
	import { session, nextPath } from '$lib/stores/session.svelte';

	type Choice = 'buyer' | 'seller' | 'driver';
	const user = $derived(session.user);
	const statusOf = (role: string) => user?.roles.find((r) => r.role === role)?.status;
	// Start from the saved choice (or suggest Buyer on first visit).
	const initial = untrack(() =>
		(['buyer', 'seller', 'driver'] as Choice[]).filter((r) =>
			['active', 'pending'].includes(statusOf(r) ?? '')
		)
	);
	let selected = $state<Choice[]>(
		initial.length || untrack(() => user?.onboarding.roles) ? initial : ['buyer']
	);
	let sellerNote = $state('');
	let driverNote = $state('');
	let busy = $state(false);
	let error = $state('');

	const ROLES: {
		id: Choice;
		title: string;
		icon: Component;
		body: string;
		review: boolean;
	}[] = [
		{
			id: 'buyer',
			title: 'Buyer',
			icon: ShoppingBag as unknown as Component,
			body: 'Shop in virtual stores, place orders and track deliveries.',
			review: false
		},
		{
			id: 'seller',
			title: 'Seller',
			icon: Store as unknown as Component,
			body: 'Run a business and claim a virtual shop unit. Requires approval.',
			review: true
		},
		{
			id: 'driver',
			title: 'Delivery driver',
			icon: Bike as unknown as Component,
			body: 'Accept delivery jobs and earn. Requires approval and verification.',
			review: true
		}
	];

	function toggle(id: Choice) {
		selected = selected.includes(id) ? selected.filter((r) => r !== id) : [...selected, id];
	}

	async function save() {
		busy = true;
		error = '';
		try {
			const updated = await me.chooseRoles({
				roles: selected,
				seller_note: selected.includes('seller') ? sellerNote || undefined : undefined,
				driver_note: selected.includes('driver') ? driverNote || undefined : undefined
			});
			session.set(updated);
			await goto(nextPath(updated), { invalidateAll: true });
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not save your roles.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Role · Phnom Penh Digital World</title></svelte:head>

<section class="mx-auto max-w-3xl">
	<div class="card">
		<p class="eyebrow">Step 3 of 4</p>
		<h1 class="display mt-1 text-3xl font-bold">How will you use the city?</h1>
		<p class="mt-2 text-sm text-ink-soft">
			Choose any combination. You can change this later. Everyone can explore as a visitor.
		</p>

		<div class="mt-6 grid gap-3">
			<div class="flex items-center gap-4 rounded-2xl border border-river-900/10 bg-paper-2/60 p-4">
				<span class="grid h-11 w-11 place-items-center rounded-xl bg-white text-river-800"><Eye size={20} /></span>
				<div class="flex-1">
					<p class="font-semibold">Visitor <span class="chip ml-1">Always included</span></p>
					<p class="text-sm text-ink-soft">Explore public areas, view shops and meet players.</p>
				</div>
			</div>
			{#each ROLES as role (role.id)}
				{@const on = selected.includes(role.id)}
				{@const status = statusOf(role.id)}
				<button
					type="button"
					aria-pressed={on}
					data-testid={`role-${role.id}`}
					class="flex items-center gap-4 rounded-2xl border-2 p-4 text-left transition {on
						? 'border-river-800 bg-river-200/40'
						: 'border-river-900/10 bg-white hover:border-river-900/30'}"
					onclick={() => toggle(role.id)}
				>
					<span
						class="grid h-11 w-11 place-items-center rounded-xl {on
							? 'bg-river-900 text-saffron-500'
							: 'bg-paper-2 text-river-800'}"><role.icon size={20} /></span
					>
					<span class="flex-1">
						<span class="flex flex-wrap items-center gap-2 font-semibold">
							{role.title}
							{#if role.review}<span class="chip"><Clock size={12} /> Needs approval</span>{/if}
							{#if status === 'pending'}<span class="chip border-saffron-500 bg-saffron-100">Pending review</span>{/if}
							{#if status === 'active'}<span class="chip border-river-500 bg-river-200">Active</span>{/if}
							{#if status === 'rejected'}<span class="chip border-brick-500 text-brick-600">Not approved</span>{/if}
						</span>
						<span class="block text-sm text-ink-soft">{role.body}</span>
					</span>
					<span
						class="grid h-6 w-6 place-items-center rounded-md border-2 {on
							? 'border-river-900 bg-river-900 text-paper'
							: 'border-river-900/30'}">{#if on}<Check size={14} />{/if}</span
					>
				</button>
			{/each}
		</div>

		{#if selected.includes('seller')}
			<div class="mt-4">
				<label class="label" for="seller_note">Tell us about your business (optional)</label>
				<textarea id="seller_note" class="input" rows="2" maxlength="500" placeholder="e.g. Fresh noodle stall near Phsar Thmei" bind:value={sellerNote}></textarea>
				<p class="hint">Full merchant verification (documents, opening hours) comes with the marketplace.</p>
			</div>
		{/if}
		{#if selected.includes('driver')}
			<div class="mt-4">
				<label class="label" for="driver_note">Vehicle and availability (optional)</label>
				<textarea id="driver_note" class="input" rows="2" maxlength="500" placeholder="e.g. Motorbike, weekday evenings" bind:value={driverNote}></textarea>
			</div>
		{/if}

		{#if error}<p class="alert-error mt-4" role="alert">{error}</p>{/if}
		<button class="btn-primary mt-6 w-full" onclick={save} disabled={busy}>
			{busy ? 'Saving…' : selected.length ? 'Save roles & continue' : 'Continue as a visitor'}
		</button>
	</div>
</section>

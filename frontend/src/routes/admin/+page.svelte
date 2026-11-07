<script lang="ts">
	import { onMount } from 'svelte';
	import { admin } from '$lib/api/endpoints';
	import { ApiError } from '$lib/api/client';
	import type { RoleRequest } from '$lib/api/types';

	let { data } = $props();
	let status = $state<'pending' | 'active' | 'rejected'>('pending');
	let requests = $state<RoleRequest[]>([]);
	let error = $state('');
	let reasons = $state<Record<string, string>>({});

	async function load() {
		error = '';
		try {
			requests = await admin.roleRequests(status);
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not load requests.';
		}
	}
	onMount(() => {
		if (data.isAdmin) load();
	});

	async function decide(r: RoleRequest, approve: boolean) {
		try {
			await (approve ? admin.approve : admin.reject)(r.id, reasons[r.id] || undefined);
			await load();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Action failed.';
		}
	}
</script>

<svelte:head><title>Admin · Phnom Penh Digital World</title></svelte:head>

<main class="street-grid min-h-dvh px-5 py-10">
	<div class="mx-auto max-w-4xl space-y-6">
		<header class="flex items-end justify-between gap-4">
			<div>
				<p class="eyebrow">Administration</p>
				<h1 class="display text-3xl font-bold">Seller &amp; driver requests</h1>
			</div>
			<a class="btn-ghost" href="/">Home</a>
		</header>
		{#if !data.isAdmin}
			<p class="alert-error">Administrator access is required.</p>
		{:else}
			<div class="flex gap-2">
				{#each ['pending', 'active', 'rejected'] as const as s (s)}
					<button class="chip py-2 {status === s ? 'bg-river-900 text-paper' : ''}" onclick={() => { status = s; load(); }}>{s}</button>
				{/each}
			</div>
			{#if error}<p class="alert-error">{error}</p>{/if}
			{#if !requests.length}<p class="card text-sm text-ink-soft">No {status} requests.</p>{/if}
			{#each requests as r (r.id)}
				<div class="card flex flex-col gap-3 sm:flex-row sm:items-center">
					<div class="flex-1">
						<p class="font-semibold">{r.display_name} <span class="font-normal text-ink-soft">@{r.username}</span> <span class="chip ml-1">{r.role}</span></p>
						{#if r.note}<p class="mt-1 text-sm text-ink-soft">“{r.note}”</p>{/if}
						<p class="mt-1 text-xs text-ink-soft">Requested {new Date(r.requested_at).toLocaleString()}</p>
						{#if r.decision_reason}<p class="mt-1 text-xs">Reason: {r.decision_reason}</p>{/if}
					</div>
					{#if r.status === 'pending'}
						<input class="input sm:w-48" placeholder="Reason (optional)" bind:value={reasons[r.id]} />
						<div class="flex gap-2">
							<button class="btn-primary" onclick={() => decide(r, true)}>Approve</button>
							<button class="btn-ghost" onclick={() => decide(r, false)}>Reject</button>
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</main>

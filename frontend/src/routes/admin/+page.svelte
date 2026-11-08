<script lang="ts">
	import { onMount } from 'svelte';
	import { admin } from '$lib/api/endpoints';
	import { ApiError } from '$lib/api/client';
	import type { PlayerReport, RoleRequest } from '$lib/api/types';

	let { data } = $props();
	let section = $state<'roles' | 'reports'>('roles');
	let status = $state<'pending' | 'active' | 'rejected'>('pending');
	let reportStatus = $state<'open' | 'resolved' | 'dismissed'>('open');
	let requests = $state<RoleRequest[]>([]);
	let reports = $state<PlayerReport[]>([]);
	let error = $state('');
	let notice = $state('');
	let reasons = $state<Record<string, string>>({});
	let hours = $state<Record<string, number>>({});

	async function load() {
		error = '';
		try {
			if (section === 'roles') requests = await admin.roleRequests(status);
			else reports = await admin.reports(reportStatus);
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not load.';
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

	async function resolve(r: PlayerReport, action: 'dismiss' | 'warn' | 'chat_mute' | 'suspend') {
		if (action === 'suspend' && !confirm(`Suspend @${r.reported}? They are disconnected and signed out everywhere.`)) return;
		try {
			const res = await admin.resolve(r.id, action, hours[r.id] ?? 24, reasons[r.id] || undefined);
			notice = `${res.message}: @${r.reported}`;
			await load();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Action failed.';
		}
	}

	const REASON_LABEL: Record<string, string> = {
		harassment: 'Harassment', hate: 'Hate speech', spam: 'Spam / scams', cheating: 'Cheating',
		inappropriate_name: 'Inappropriate name/avatar', other: 'Other'
	};
</script>

<svelte:head><title>Admin · Phnom Penh Digital World</title></svelte:head>

<main class="street-grid min-h-dvh px-5 py-10">
	<div class="mx-auto max-w-4xl space-y-6">
		<header class="flex items-end justify-between gap-4">
			<div>
				<p class="eyebrow">Administration</p>
				<h1 class="display text-3xl font-bold">{section === 'roles' ? 'Seller & driver requests' : 'Player reports'}</h1>
			</div>
			<a class="btn-ghost" href="/">Home</a>
		</header>
		{#if !data.isAdmin}
			<p class="alert-error">Administrator access is required.</p>
		{:else}
			<div class="grid max-w-sm grid-cols-2 gap-1 rounded-xl bg-paper-2 p-1 text-sm font-semibold">
				<button class="rounded-lg py-2 {section === 'roles' ? 'bg-white shadow' : 'text-ink-soft'}" onclick={() => { section = 'roles'; load(); }}>Role requests</button>
				<button class="rounded-lg py-2 {section === 'reports' ? 'bg-white shadow' : 'text-ink-soft'}" onclick={() => { section = 'reports'; load(); }}>Reports</button>
			</div>
			{#if error}<p class="alert-error">{error}</p>{/if}
			{#if notice}<p class="alert border-river-500/30 bg-river-200/40">{notice}</p>{/if}

			{#if section === 'roles'}
				<div class="flex gap-2">
					{#each ['pending', 'active', 'rejected'] as const as s (s)}
						<button class="chip py-2 {status === s ? 'bg-river-900 text-paper' : ''}" onclick={() => { status = s; load(); }}>{s}</button>
					{/each}
				</div>
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
			{:else}
				<div class="flex gap-2">
					{#each ['open', 'resolved', 'dismissed'] as const as s (s)}
						<button class="chip py-2 {reportStatus === s ? 'bg-river-900 text-paper' : ''}" onclick={() => { reportStatus = s; load(); }}>{s}</button>
					{/each}
				</div>
				{#if !reports.length}<p class="card text-sm text-ink-soft">No {reportStatus} reports.</p>{/if}
				{#each reports as r (r.id)}
					<article class="card space-y-3" data-testid="report">
						<div class="flex flex-wrap items-baseline justify-between gap-2">
							<p class="font-semibold">@{r.reported} <span class="font-normal text-ink-soft">({r.reported_display_name})</span> <span class="chip ml-1">{REASON_LABEL[r.reason] ?? r.reason}</span></p>
							<p class="text-xs text-ink-soft">by @{r.reporter} · {new Date(r.created_at).toLocaleString()}</p>
						</div>
						{#if r.details}<p class="text-sm">“{r.details}”</p>{/if}
						<div class="rounded-xl bg-paper-2 p-3">
							<p class="label">Recent messages from @{r.reported} (24 h)</p>
							{#if !r.context.messages?.length}<p class="text-xs text-ink-soft">None captured.</p>{/if}
							{#each r.context.messages ?? [] as m (m.id)}
								<p class="khmer text-sm {m.flagged ? 'text-brick-600' : ''}"><span class="text-[10px] text-ink-soft uppercase">{m.channel} · {new Date(m.at).toLocaleString()}</span><br />{m.text}</p>
							{/each}
						</div>
						{#if r.status === 'open'}
							<div class="flex flex-wrap items-center gap-2">
								<input class="input max-w-xs py-2 text-sm" placeholder="Note (optional)" bind:value={reasons[r.id]} />
								<label class="flex items-center gap-1 text-xs">Mute
									<select class="input w-24 py-1.5 text-sm" bind:value={hours[r.id]}>
										{#each [1, 24, 72, 168] as h (h)}<option value={h}>{h} h</option>{/each}
									</select>
								</label>
								<button class="btn-ghost py-2" onclick={() => resolve(r, 'dismiss')}>Dismiss</button>
								<button class="btn-ghost py-2" onclick={() => resolve(r, 'warn')}>Warn</button>
								<button class="btn-primary py-2" onclick={() => resolve(r, 'chat_mute')}>Mute chat</button>
								<button class="btn py-2 bg-brick-600 text-white hover:bg-brick-500" onclick={() => resolve(r, 'suspend')}>Suspend</button>
							</div>
						{:else}
							<p class="text-xs text-ink-soft">Outcome: <strong>{r.action}</strong>{r.resolution_note ? ` · ${r.resolution_note}` : ''}</p>
						{/if}
					</article>
				{/each}
			{/if}
		{/if}
	</div>
</main>

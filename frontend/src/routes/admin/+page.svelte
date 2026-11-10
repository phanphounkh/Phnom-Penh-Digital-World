<script lang="ts">
	import { onMount } from 'svelte';
	import { admin } from '$lib/api/endpoints';
	import { ApiError } from '$lib/api/client';
	import type { PlayerReport, RoleRequest } from '$lib/api/types';
	import { marketAdmin, money, type AdminMerchant, type AdminProduct, type Claim, type Dispute } from '$lib/api/market';

	let { data } = $props();
	let section = $state<'roles' | 'reports' | 'merchants' | 'claims' | 'products'>('merchants');
	let merchantStatus = $state<'pending' | 'approved' | 'rejected' | 'suspended'>('pending');
	let merchants = $state<AdminMerchant[]>([]);
	let claims = $state<Claim[]>([]);
	let disputes = $state<Dispute[]>([]);
	let products = $state<AdminProduct[]>([]);
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
			else if (section === 'reports') reports = await admin.reports(reportStatus);
			else if (section === 'merchants') merchants = await marketAdmin.merchants(merchantStatus);
			else if (section === 'claims') [claims, disputes] = await Promise.all([marketAdmin.claims('pending'), marketAdmin.disputes('open')]);
			else products = await marketAdmin.products('pending_review');
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

	async function market(fn: () => Promise<{ message: string }>) {
		error = '';
		try {
			notice = (await fn()).message;
			await load();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Action failed.';
		}
	}

	const TITLES = {
		roles: 'Seller & driver requests',
		reports: 'Player reports',
		merchants: 'Merchant applications',
		claims: 'Unit claims & disputes',
		products: 'Restricted products'
	} as const;

	const REASON_LABEL: Record<string, string> = {
		harassment: 'Harassment', hate: 'Hate speech', spam: 'Spam / scams', cheating: 'Cheating',
		inappropriate_name: 'Inappropriate name/avatar', other: 'Other'
	};
</script>

<svelte:head><title>Admin · Phnom Penh Digital World</title></svelte:head>

<main class="street-grid min-h-dvh px-5 py-10">
	<div class="mx-auto max-w-5xl space-y-6">
		<header class="flex items-end justify-between gap-4">
			<div>
				<p class="eyebrow">Administration</p>
				<h1 class="display text-3xl font-bold">{TITLES[section]}</h1>
			</div>
			<a class="btn-ghost" href="/">Home</a>
		</header>
		{#if !data.isAdmin}
			<p class="alert-error">Administrator access is required.</p>
		{:else}
			<div class="flex flex-wrap gap-1 rounded-xl bg-paper-2 p-1 text-sm font-semibold">
				{#each [['merchants', 'Merchants'], ['claims', 'Claims & disputes'], ['products', 'Products'], ['roles', 'Role requests'], ['reports', 'Reports']] as const as [id, label] (id)}
					<button class="rounded-lg px-3 py-2 {section === id ? 'bg-white shadow' : 'text-ink-soft'}" onclick={() => { section = id; notice = ''; load(); }} data-testid={`admin-${id}`}>{label}</button>
				{/each}
			</div>
			{#if error}<p class="alert-error">{error}</p>{/if}
			{#if notice}<p class="alert border-river-500/30 bg-river-200/40">{notice}</p>{/if}

			{#if section === 'merchants'}
				<div class="flex gap-2">
					{#each ['pending', 'approved', 'rejected', 'suspended'] as const as s (s)}
						<button class="chip py-2 {merchantStatus === s ? 'bg-river-900 text-paper' : ''}" onclick={() => { merchantStatus = s; load(); }}>{s}</button>
					{/each}
				</div>
				{#if !merchants.length}<p class="card text-sm text-ink-soft">No {merchantStatus} merchants.</p>{/if}
				{#each merchants as m (m.id)}
					<article class="card space-y-2" data-testid="admin-merchant">
						<p class="font-semibold">{m.business_name}{#if m.business_name_km} <span class="khmer font-normal" lang="km">{m.business_name_km}</span>{/if} <span class="font-normal text-ink-soft">@{m.owner_username}</span> <span class="chip ml-1">{m.category}</span></p>
						{#if m.description}<p class="text-sm">{m.description}</p>{/if}
						<p class="text-xs text-ink-soft">{m.contact_phone ?? ''} {m.contact_email ?? ''} · address (private): {m.business_address ?? '—'} · seller role: {m.seller_role ?? 'none'}</p>
						<p class="text-xs">Documents:
							{#each m.documents as d (d.id)}<a class="ml-2 underline" href={marketAdmin.documentUrl(d.id)} target="_blank" rel="noopener">{d.original_name}</a>{:else}<span class="text-ink-soft"> none</span>{/each}
						</p>
						<div class="flex flex-wrap items-center gap-2">
							<input class="input max-w-xs py-2 text-sm" placeholder="Reason (optional)" bind:value={reasons[m.id]} />
							{#if m.status !== 'approved'}<button class="btn-primary py-2" onclick={() => market(() => marketAdmin.decideMerchant(m.id, 'approve', reasons[m.id]))} data-testid="approve-merchant">Approve</button>{/if}
							{#if m.status === 'pending'}<button class="btn-ghost py-2" onclick={() => market(() => marketAdmin.decideMerchant(m.id, 'reject', reasons[m.id]))}>Reject</button>{/if}
							{#if m.status === 'approved'}<button class="btn py-2 bg-brick-600 text-white" onclick={() => confirm('Suspend this merchant? Their shops close.') && market(() => marketAdmin.decideMerchant(m.id, 'suspend', reasons[m.id]))}>Suspend</button>{/if}
						</div>
					</article>
				{/each}
			{:else if section === 'claims'}
				<h2 class="font-semibold">Claims waiting for review (units at real businesses)</h2>
				{#if !claims.length}<p class="card text-sm text-ink-soft">No pending claims.</p>{/if}
				{#each claims as c (c.id)}
					<article class="card space-y-2">
						<p class="font-semibold">{c.unit.code} · {c.unit.street_name} <span class="font-normal text-ink-soft">by {c.merchant_name} (@{c.merchant_username})</span></p>
						<p class="text-sm">Real business here: <strong>{c.unit.real_business_name}</strong></p>
						{#if c.evidence_note}<p class="text-sm">“{c.evidence_note}”</p>{/if}
						{#if c.document}<a class="text-xs underline" href={marketAdmin.documentUrl(c.document.id)} target="_blank" rel="noopener">{c.document.original_name}</a>{/if}
						<div class="flex gap-2">
							<input class="input max-w-xs py-2 text-sm" placeholder="Reason (optional)" bind:value={reasons[c.id]} />
							<button class="btn-primary py-2" onclick={() => market(() => marketAdmin.decideClaim(c.id, 'approve', reasons[c.id]))}>Approve</button>
							<button class="btn-ghost py-2" onclick={() => market(() => marketAdmin.decideClaim(c.id, 'reject', reasons[c.id]))}>Reject</button>
						</div>
					</article>
				{/each}
				<h2 class="font-semibold">Open disputes</h2>
				{#if !disputes.length}<p class="card text-sm text-ink-soft">No open disputes.</p>{/if}
				{#each disputes as d (d.id)}
					<article class="card space-y-2">
						<p class="font-semibold">{d.unit_code}{d.real_business_name ? ` · ${d.real_business_name}` : ''} <span class="font-normal text-ink-soft">held by {d.claimed_by ?? '—'}, disputed by @{d.disputer}</span></p>
						<p class="text-sm">“{d.reason}”</p>
						{#if d.contact}<p class="text-xs text-ink-soft">Contact: {d.contact}</p>{/if}
						<div class="flex gap-2">
							<input class="input max-w-xs py-2 text-sm" placeholder="Note" bind:value={reasons[d.id]} />
							<button class="btn-primary py-2" onclick={() => market(() => marketAdmin.resolveDispute(d.id, true, reasons[d.id]))}>Uphold (revoke claim)</button>
							<button class="btn-ghost py-2" onclick={() => market(() => marketAdmin.resolveDispute(d.id, false, reasons[d.id]))}>Reject</button>
						</div>
					</article>
				{/each}
			{:else if section === 'products'}
				{#if !products.length}<p class="card text-sm text-ink-soft">No products waiting for review.</p>{/if}
				{#each products as p (p.id)}
					<article class="card flex flex-wrap items-center gap-3">
						{#if p.image_url}<img src={p.image_url} alt="" class="h-14 w-14 rounded-lg object-cover" />{/if}
						<div class="flex-1">
							<p class="font-semibold">{p.name} <span class="font-normal text-ink-soft">· {p.merchant_name} · {p.category_name} · {money(p.price_minor)}</span></p>
							{#if p.description}<p class="text-sm">{p.description}</p>{/if}
						</div>
						<input class="input max-w-48 py-2 text-sm" placeholder="Note" bind:value={reasons[p.id]} />
						<button class="btn-primary py-2" onclick={() => market(() => marketAdmin.reviewProduct(p.id, 'approve', reasons[p.id]))}>Approve</button>
						<button class="btn-ghost py-2" onclick={() => market(() => marketAdmin.reviewProduct(p.id, 'reject', reasons[p.id]))}>Reject</button>
					</article>
				{/each}
			{:else if section === 'roles'}
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

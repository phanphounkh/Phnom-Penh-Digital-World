<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowDownLeft, ArrowUpRight, WalletCards } from 'lucide-svelte';
	import { wallet, type Wallet } from '$lib/api/commerce';
	import { money } from '$lib/api/market';
	let data = $state<Wallet | null>(null);
	let error = $state('');
	let busy = $state(false);
	let creditKey = '';
	const labels: Record<string, string> = {
		starter_credit: 'Welcome credits',
		demo_credit: 'Added demo credits',
		payment: 'Order payment',
		refund: 'Order refunded',
		merchant_payout: 'Shop earnings',
		driver_payout: 'Delivery earnings'
	};
	onMount(() => {
		wallet
			.get()
			.then((value) => (data = value))
			.catch((e) => (error = e.message));
	});
	async function add() {
		if (busy) return;
		busy = true;
		error = '';
		creditKey ||= crypto.randomUUID();
		try {
			data = await wallet.credit(5000, creditKey);
			creditKey = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not add credits.';
		} finally {
			busy = false;
		}
	}
</script>

<div class="space-y-4" data-testid="wallet-panel">
	<div class="rounded-2xl bg-river-900 p-5 text-paper">
		<p class="flex items-center gap-2 text-sm text-river-200">
			<WalletCards size={18} /> Demo balance
		</p>
		<p class="mt-3 font-display text-4xl" data-testid="wallet-balance">
			{data ? money(data.balance_minor) : '…'}
		</p>
		<p class="mt-2 text-xs leading-relaxed text-river-200">
			Virtual credits only. They have no cash value and cannot be withdrawn.
		</p>
	</div>
	{#if error}<p class="alert-error" role="alert">{error}</p>{/if}
	<button class="btn-accent w-full" disabled={busy || !data} onclick={add}
		>{busy ? 'Adding credits…' : 'Add $50 in free demo credits'}</button
	>
	<p class="hint">
		New wallets start with $100 demo credits. Order payments are held until collection or delivery;
		eligible cancellations return the credits.
	</p>
	<h3 class="pt-2 font-semibold">Recent activity</h3>
	<div class="divide-y divide-river-900/10">
		{#each data?.transactions ?? [] as entry (entry.id)}
			<div class="flex items-center gap-3 py-3">
				<span class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-paper-2"
					>{#if entry.amount_minor > 0}<ArrowDownLeft size={16} />{:else}<ArrowUpRight
							size={16}
						/>{/if}</span
				>
				<div class="min-w-0 flex-1">
					<p class="text-sm font-medium">
						{labels[entry.kind] ?? entry.kind.replaceAll('_', ' ')}
					</p>
					<p class="text-xs text-ink-soft">
						{new Date(entry.created_at).toLocaleString()}
					</p>
				</div>
				<p
					class="text-sm font-semibold tabular-nums {entry.amount_minor > 0
						? 'text-river-700'
						: ''}"
				>
					{entry.amount_minor > 0 ? '+' : '−'}{money(Math.abs(entry.amount_minor))}
				</p>
			</div>
		{/each}
	</div>
</div>

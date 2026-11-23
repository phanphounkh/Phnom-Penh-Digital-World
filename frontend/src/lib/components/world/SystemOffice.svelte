<script lang="ts">
	/**
	 * The System Office's counter, in the game: register one work role (seller or driver), see
	 * how it stands, or leave it. A glass panel over the city, like the wardrobe; the server only
	 * accepts it while the player stands at the office (from their position in the city).
	 */
	import { Bike, Store, X } from 'lucide-svelte';
	import { ApiError } from '$lib/api/client';
	import { me as meApi } from '$lib/api/endpoints';
	import { BUSINESS_CATEGORIES, type BusinessCategory } from '$lib/api/market';
	import type { Role } from '$lib/api/types';
	import { session } from '$lib/stores/session.svelte';

	let { solid = false, onClose, onMyShop }: { solid?: boolean; onClose: () => void; /** Opens My shop (for a registered seller). */ onMyShop?: () => void } = $props();

	type Work = 'seller' | 'driver';
	const WORK: Record<Work, { label: string; what: string }> = {
		seller: { label: 'Seller', what: 'Open a shop on a real street of Daun Penh and sell to other players. An administrator checks your business first.' },
		driver: { label: 'Driver', what: 'Deliver orders across the city by bicycle or motorbike. An administrator approves you first.' }
	};

	const roles = $derived<Role[]>(session.user?.roles ?? []);
	/** The work role held now (active or waiting for approval): at most one. */
	const current = $derived(roles.find((r) => (r.role === 'seller' || r.role === 'driver') && (r.status === 'active' || r.status === 'pending')) ?? null);
	/** The last one not approved, to say why. */
	const rejected = $derived(roles.find((r) => (r.role === 'seller' || r.role === 'driver') && r.status === 'rejected') ?? null);

	let picked = $state<Work | null>(null);
	let busy = $state(false);
	let error = $state('');
	let confirmLeave = $state(false);
	let business = $state({ business_name: '', business_name_km: '', category: 'food_drink' as BusinessCategory, contact_phone: '', description: '' });
	let note = $state('');

	async function register() {
		if (!picked || busy) return;
		error = '';
		if (picked === 'seller' && business.business_name.trim().length < 2) return (error = "Give your business's name.");
		if (picked === 'seller' && !business.contact_phone.trim()) return (error = 'Give a phone number customers can call.');
		busy = true;
		try {
			const body =
				picked === 'seller'
					? { role: picked, business: { business_name: business.business_name.trim(), business_name_km: business.business_name_km.trim() || null, category: business.category, contact_phone: business.contact_phone.trim(), description: business.description.trim() || null, contact_email: null, business_address: null, operating_hours: {} } }
					: { role: picked, note: note.trim() || null };
			session.set(await meApi.registerWorkRole(body));
			picked = null;
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'The registration could not be sent. Try again.';
		} finally {
			busy = false;
		}
	}

	async function leave() {
		busy = true;
		error = '';
		try {
			session.set(await meApi.leaveWorkRole());
			confirmLeave = false;
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not leave the role. Try again.';
		} finally {
			busy = false;
		}
	}

	function keydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		e.preventDefault();
		e.stopPropagation();
		onClose();
	}
</script>

<svelte:window onkeydown={keydown} />

<div class="glass office" class:solid role="dialog" aria-label="System Office" data-testid="system-office">
	<header>
		<div class="title">
			<p>System Office</p>
			<h2>Work roles</h2>
		</div>
		<button type="button" class="icon" aria-label="Close" onclick={onClose}><X size={18} /></button>
	</header>
	<p class="intro">Everyone can explore and buy. To sell or deliver, register one work role at this counter.</p>

	{#if current}
		{@const work = current.role as Work}
		<section class="status" data-testid="work-role" data-role={current.role} data-status={current.status}>
			<div class="role-head">
				<span class="badge">{#if work === 'seller'}<Store size={18} />{:else}<Bike size={18} />{/if}</span>
				<div>
					<p class="role">{WORK[work].label}</p>
					<p class="state {current.status}">{current.status === 'pending' ? 'Waiting for approval' : 'Approved'}</p>
				</div>
			</div>
			<p class="explain">
				{#if current.status === 'pending'}
					An administrator is checking your registration. Keep exploring, and come back to this counter to see how it stands.{#if work === 'seller'} Meanwhile, your business details are in My shop (B).{/if}
				{:else if work === 'seller'}
					You can claim a spot on a street and open your shop: it is all in My shop (B).
				{:else}
					Delivery jobs are in the menu (☰ → Delivery jobs).
				{/if}
			</p>
			{#if work === 'seller' && onMyShop}
				<button type="button" class="go" onclick={onMyShop} data-testid="office-my-shop">Open My shop</button>
			{/if}
			{#if confirmLeave}
				<div class="confirm">
					<p>Leave the {WORK[work].label.toLowerCase()} role?{current.status === 'pending' ? ' Your registration is withdrawn.' : ''}</p>
					<div class="row">
						<button type="button" class="ghost" onclick={() => (confirmLeave = false)}>Keep it</button>
						<button type="button" class="danger" disabled={busy} onclick={leave} data-testid="leave-confirm">{busy ? 'Leaving…' : 'Leave the role'}</button>
					</div>
				</div>
			{:else}
				<button type="button" class="ghost" onclick={() => (confirmLeave = true)} data-testid="leave-role">Leave this role</button>
			{/if}
		</section>
		<p class="note">One work role at a time: leave this one to register the other.</p>
	{:else}
		{#if rejected}
			<p class="rejected">Your {rejected.role} registration was not approved{rejected.decision_reason ? `: ${rejected.decision_reason}` : '.'} You can register again.</p>
		{/if}
		<div class="choices" role="radiogroup" aria-label="Work role">
			{#each ['seller', 'driver'] as const as work (work)}
				<button type="button" role="radio" aria-checked={picked === work} class="choice" class:on={picked === work} onclick={() => ((picked = work), (error = ''))} data-testid={`pick-${work}`}>
					<span class="badge">{#if work === 'seller'}<Store size={18} />{:else}<Bike size={18} />{/if}</span>
					<span class="choice-text"><strong>{WORK[work].label}</strong><span>{WORK[work].what}</span></span>
				</button>
			{/each}
		</div>
		{#if picked === 'seller'}
			<form class="form" onsubmit={(e) => (e.preventDefault(), register())}>
				<label><span>Business name</span><input class="field" maxlength="120" bind:value={business.business_name} required data-testid="business-name" /></label>
				<label><span>Name in Khmer (optional)</span><input class="field khmer" lang="km" maxlength="120" bind:value={business.business_name_km} /></label>
				<div class="two">
					<label><span>What you sell</span>
						<select class="field" bind:value={business.category}>{#each Object.entries(BUSINESS_CATEGORIES) as [value, label] (value)}<option {value}>{label}</option>{/each}</select>
					</label>
					<label><span>Phone for customers</span><input class="field" inputmode="tel" maxlength="20" placeholder="012 345 678" bind:value={business.contact_phone} required data-testid="business-phone" /></label>
				</div>
				<label><span>About your business (optional)</span><textarea class="field" rows="2" maxlength="600" bind:value={business.description}></textarea></label>
				<button type="submit" class="go" disabled={busy} data-testid="register-role">{busy ? 'Sending…' : 'Register as a seller'}</button>
			</form>
		{:else if picked === 'driver'}
			<form class="form" onsubmit={(e) => (e.preventDefault(), register())}>
				<label><span>About you and your vehicle (optional)</span><textarea class="field" rows="2" maxlength="500" placeholder="I ride a motorbike around Daun Penh every day." bind:value={note}></textarea></label>
				<button type="submit" class="go" disabled={busy} data-testid="register-role">{busy ? 'Sending…' : 'Register as a driver'}</button>
			</form>
		{/if}
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
	.office {
		position: absolute;
		z-index: 30;
		top: max(16px, env(safe-area-inset-top, 0px));
		right: max(16px, env(safe-area-inset-right, 0px));
		width: min(400px, calc(100vw - 32px));
		max-height: calc(100dvh - 32px);
		overflow-y: auto;
		border-radius: 26px;
		padding: 18px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		color: #f6f1e6;
		background: rgba(11, 37, 36, 0.42);
		-webkit-backdrop-filter: blur(18px) saturate(150%);
		backdrop-filter: blur(18px) saturate(150%);
		border: 1px solid rgba(255, 255, 255, 0.24);
		box-shadow: 0 24px 60px -24px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.2);
	}
	.office.solid { background: rgba(11, 37, 36, 0.88); -webkit-backdrop-filter: none; backdrop-filter: none; }
	.office > * { flex-shrink: 0; }
	header { display: flex; align-items: flex-start; gap: 10px; }
	.title { flex: 1; display: grid; gap: 2px; }
	.title p { font-size: 12px; font-weight: 700; color: var(--color-saffron-300); }
	h2 { margin: 0; font-family: var(--font-display); font-size: 24px; font-weight: 700; color: #fffaf0; }
	.icon { padding: 6px; border-radius: 10px; }
	.icon:hover, .ghost:hover { background: rgba(255, 255, 255, 0.14); }
	.intro, .note, .explain { font-size: 13px; line-height: 1.45; opacity: 0.9; }
	.note { font-size: 12px; opacity: 0.75; }
	.choices { display: grid; gap: 8px; }
	.choice { display: flex; gap: 12px; align-items: flex-start; text-align: left; padding: 12px; border-radius: 16px; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.16); color: inherit; }
	.choice:hover { background: rgba(255, 255, 255, 0.14); }
	.choice.on { background: rgba(255, 255, 255, 0.92); color: #123b3a; }
	.choice-text { display: grid; gap: 2px; font-size: 12px; line-height: 1.4; }
	.choice-text strong { font-size: 15px; }
	.badge { display: grid; place-items: center; flex: none; width: 34px; height: 34px; border-radius: 10px; background: rgba(232, 163, 61, 0.9); color: #0b2524; }
	.form { display: grid; gap: 10px; }
	.form label { display: grid; gap: 4px; font-size: 12px; font-weight: 600; }
	.two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
	.field { border-radius: 12px; padding: 9px 12px; font-size: 14px; color: #fffaf0; background: rgba(255, 255, 255, 0.12); border: 1px solid rgba(255, 255, 255, 0.3); }
	.field::placeholder { color: rgba(255, 255, 255, 0.5); }
	select.field option { color: #1d2422; }
	.field:focus { outline: 2px solid var(--color-saffron-500); }
	.go { justify-self: stretch; padding: 11px 18px; border-radius: 12px; font-size: 14px; font-weight: 700; background: var(--color-saffron-500); color: #0b2524; box-shadow: 0 5px 0 -2px var(--color-saffron-600); }
	.go:disabled, .danger:disabled { opacity: 0.6; }
	.status { display: grid; gap: 10px; padding: 14px; border-radius: 16px; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.18); }
	.role-head { display: flex; gap: 12px; align-items: center; }
	.role { font-family: var(--font-display); font-size: 20px; font-weight: 700; color: #fffaf0; }
	.state { font-size: 12px; font-weight: 700; }
	.state.pending { color: var(--color-saffron-300); }
	.state.active { color: #9be3b2; }
	.ghost { justify-self: start; padding: 8px 12px; border-radius: 12px; font-size: 13px; font-weight: 600; color: inherit; }
	.confirm { display: grid; gap: 8px; font-size: 13px; }
	.row { display: flex; gap: 8px; justify-content: flex-end; }
	.danger { padding: 8px 14px; border-radius: 12px; font-size: 13px; font-weight: 700; background: #c4552f; color: #fff; }
	.rejected { font-size: 13px; padding: 10px 12px; border-radius: 12px; background: rgba(196, 85, 47, 0.3); }
	.error { font-size: 13px; font-weight: 600; color: #ffd4c4; }
	button:focus-visible { outline: 3px solid var(--color-saffron-500); outline-offset: 2px; }
	@media (max-width: 640px) {
		.office { top: auto; bottom: max(10px, env(safe-area-inset-bottom, 0px)); left: max(10px, env(safe-area-inset-left, 0px)); right: max(10px, env(safe-area-inset-right, 0px)); width: auto; max-height: 70dvh; padding: 14px; }
		.two { grid-template-columns: 1fr; }
	}
</style>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { MailCheck, Smartphone, Wrench } from 'lucide-svelte';
	import { auth } from '$lib/api/endpoints';
	import { ApiError } from '$lib/api/client';
	import { session, nextPath } from '$lib/stores/session.svelte';

	let code = $state('');
	let busy = $state(false);
	let error = $state('');
	let info = $state('');
	let cooldown = $state(0);
	const user = $derived(session.user);
	const verification = $derived(session.verification);
	const verified = $derived(!!user?.onboarding.verified);
	const channel = $derived(verification?.channel ?? (user?.email ? 'email' : 'phone'));

	$effect(() => {
		if (cooldown <= 0) return;
		const t = setTimeout(() => (cooldown -= 1), 1000);
		return () => clearTimeout(t);
	});

	async function confirm(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = '';
		try {
			const me = await auth.confirmCode(code.trim());
			session.set(me);
			await goto(nextPath(me), { invalidateAll: true });
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not verify the code.';
			if (e instanceof ApiError && e.details && typeof e.details === 'object') {
				const left = (e.details as { attempts_remaining?: number }).attempts_remaining;
				if (left !== undefined) error += ` ${left} attempt${left === 1 ? '' : 's'} left.`;
			}
		} finally {
			busy = false;
		}
	}

	async function resend() {
		error = '';
		info = '';
		try {
			session.verification = await auth.sendCode();
			info = `A new code was sent to ${session.verification.destination}.`;
			cooldown = session.verification.resend_after_seconds;
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not send a new code.';
		}
	}
</script>

<svelte:head><title>Verify · Phnom Penh Digital World</title></svelte:head>

<section class="mx-auto max-w-md">
	<div class="card">
		<div class="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-saffron-100 text-saffron-600">
			{#if channel === 'email'}<MailCheck />{:else}<Smartphone />{/if}
		</div>
		<p class="eyebrow">Step 1 of 4</p>
		<h1 class="display mt-1 text-3xl font-bold">Verify your {channel === 'email' ? 'email' : 'phone'}</h1>

		{#if verified}
			<p class="mt-3 text-ink-soft">Your contact is verified.</p>
			<a class="btn-primary mt-6 w-full" href={nextPath(user)}>Continue</a>
		{:else}
			<p class="mt-3 text-sm text-ink-soft">
				Enter the 6-digit code sent to
				<strong class="text-river-900"
					>{verification?.destination ?? user?.email ?? user?.phone}</strong
				>. It expires after 15 minutes.
			</p>

			{#if verification?.dev_code}
				<div class="alert-dev mt-5" data-testid="dev-code">
					<p class="flex items-center gap-2 font-semibold"><Wrench size={15} /> Developer mode</p>
					<p class="mt-1 text-xs">
						No email/SMS provider is connected, so the code is shown here instead of being
						delivered. This never happens in production.
					</p>
					<p class="mt-2 font-mono text-2xl tracking-[0.4em]">{verification.dev_code}</p>
				</div>
			{/if}

			<form class="mt-5 space-y-4" onsubmit={confirm}>
				<div>
					<label class="label" for="code">Verification code</label>
					<input
						id="code"
						class="input text-center font-mono text-2xl tracking-[0.5em]"
						inputmode="numeric"
						autocomplete="one-time-code"
						maxlength="6"
						pattern={'[0-9]{6}'}
						required
						bind:value={code}
					/>
				</div>
				{#if error}<p class="alert-error" role="alert">{error}</p>{/if}
				{#if info}<p class="text-sm text-river-700">{info}</p>{/if}
				<button class="btn-primary w-full" disabled={busy || code.trim().length !== 6}>
					{busy ? 'Checking…' : 'Verify'}
				</button>
			</form>
			<button class="btn-quiet mt-3 w-full" onclick={resend} disabled={cooldown > 0}>
				{cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}
			</button>
		{/if}
	</div>
</section>

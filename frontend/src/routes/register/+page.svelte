<script lang="ts">
	import { goto } from '$app/navigation';
	import AuthShell from '$lib/components/AuthShell.svelte';
	import { auth } from '$lib/api/endpoints';
	import { ApiError } from '$lib/api/client';
	import type { Language } from '$lib/api/types';
	import { session } from '$lib/stores/session.svelte';

	let contactMode = $state<'email' | 'phone'>('email');
	let form = $state({
		username: '',
		email: '',
		phone: '',
		password: '',
		display_name: '',
		preferred_language: 'en' as Language,
		accept_terms: false,
		accept_privacy: false
	});
	let busy = $state(false);
	let error = $state('');
	let fieldErrors = $state<Record<string, string>>({});

	const usernameOk = $derived(/^[a-z0-9_.]{3,24}$/i.test(form.username));

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = '';
		fieldErrors = {};
		try {
			const result = await auth.register({
				username: form.username,
				email: contactMode === 'email' ? form.email : null,
				phone: contactMode === 'phone' ? form.phone : null,
				password: form.password,
				display_name: form.display_name || form.username,
				preferred_language: form.preferred_language,
				accept_terms: form.accept_terms,
				accept_privacy: form.accept_privacy
			});
			session.set(result.user);
			session.verification = result.verification;
			await goto('/onboarding/verify', { invalidateAll: true });
		} catch (e) {
			if (e instanceof ApiError) {
				fieldErrors = e.fieldErrors;
				error = e.code === 'VALIDATION_ERROR' && Object.keys(fieldErrors).length ? '' : e.message;
				if (fieldErrors['_']) error = fieldErrors['_'];
			} else error = 'Could not create your account. Please try again.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Create account · Phnom Penh Digital World</title></svelte:head>

<AuthShell title="Create your account" subtitle="It takes about two minutes to enter the city.">
	<form class="space-y-4" onsubmit={submit} novalidate>
		<div class="grid gap-4 sm:grid-cols-2">
			<div>
				<label class="label" for="username">Username</label>
				<input
					id="username"
					class="input"
					autocomplete="username"
					placeholder="sokha_k"
					bind:value={form.username}
					aria-invalid={!!fieldErrors.username}
				/>
				{#if fieldErrors.username}<p class="error-text">{fieldErrors.username}</p>
				{:else if form.username && !usernameOk}<p class="error-text">
						3–24 letters, numbers, dots or underscores
					</p>{/if}
			</div>
			<div>
				<label class="label" for="display_name">Display name</label>
				<input
					id="display_name"
					class="input"
					autocomplete="nickname"
					placeholder="Sokha"
					bind:value={form.display_name}
				/>
				{#if fieldErrors.display_name}<p class="error-text">{fieldErrors.display_name}</p>{/if}
			</div>
		</div>

		<fieldset>
			<legend class="label">Verify with</legend>
			<div class="mb-2 grid grid-cols-2 gap-2 rounded-xl bg-paper-2 p-1 text-sm font-semibold">
				{#each ['email', 'phone'] as const as mode (mode)}
					<button
						type="button"
						class="rounded-lg py-2 transition {contactMode === mode
							? 'bg-white text-river-900 shadow'
							: 'text-ink-soft'}"
						aria-pressed={contactMode === mode}
						onclick={() => (contactMode = mode)}>{mode === 'email' ? 'Email' : 'Phone'}</button
					>
				{/each}
			</div>
			{#if contactMode === 'email'}
				<input
					class="input"
					type="email"
					autocomplete="email"
					placeholder="you@example.com"
					aria-label="Email"
					bind:value={form.email}
				/>
				{#if fieldErrors.email}<p class="error-text">{fieldErrors.email}</p>{/if}
			{:else}
				<input
					class="input"
					type="tel"
					autocomplete="tel"
					placeholder="012 345 678"
					aria-label="Phone number"
					bind:value={form.phone}
				/>
				<p class="hint">Cambodian numbers starting with 0 are saved as +855.</p>
				{#if fieldErrors.phone}<p class="error-text">{fieldErrors.phone}</p>{/if}
			{/if}
		</fieldset>

		<div>
			<label class="label" for="password">Password</label>
			<input
				id="password"
				class="input"
				type="password"
				autocomplete="new-password"
				minlength="10"
				bind:value={form.password}
			/>
			<p class="hint">At least 10 characters.</p>
			{#if fieldErrors.password}<p class="error-text">{fieldErrors.password}</p>{/if}
		</div>

		<div>
			<label class="label" for="language">Preferred language</label>
			<select id="language" class="input" bind:value={form.preferred_language}>
				<option value="en">English</option>
				<option value="km">ភាសាខ្មែរ (Khmer)</option>
			</select>
			{#if form.preferred_language === 'km'}
				<p class="hint">Khmer place names are shown in the world; full Khmer UI is coming.</p>
			{/if}
		</div>

		<div class="space-y-2 rounded-2xl bg-paper-2/70 p-4 text-sm">
			<label class="flex items-start gap-3">
				<input type="checkbox" class="mt-1 accent-river-800" bind:checked={form.accept_terms} />
				<span>I agree to the <a class="underline" href="/legal/terms" target="_blank">Terms of Use</a>.</span>
			</label>
			<label class="flex items-start gap-3">
				<input type="checkbox" class="mt-1 accent-river-800" bind:checked={form.accept_privacy} />
				<span
					>I have read the <a class="underline" href="/legal/privacy" target="_blank">Privacy Policy</a
					>.</span
				>
			</label>
			{#if fieldErrors.accept_terms || fieldErrors.accept_privacy}
				<p class="error-text">Please accept the terms and privacy policy.</p>
			{/if}
		</div>

		{#if error}<p class="alert-error" role="alert">{error}</p>{/if}
		<button class="btn-primary w-full" disabled={busy || !form.accept_terms || !form.accept_privacy}>
			{busy ? 'Creating account…' : 'Create account'}
		</button>
	</form>
	{#snippet footer()}
		Already registered? <a class="font-semibold text-river-800 underline" href="/login">Sign in</a>
	{/snippet}
</AuthShell>

<script lang="ts">
	import { goto } from '$app/navigation';
	import AuthShell from '$lib/components/AuthShell.svelte';
	import { auth } from '$lib/api/endpoints';
	import { ApiError } from '$lib/api/client';
	import { session, nextPath } from '$lib/stores/session.svelte';

	let identifier = $state('');
	let password = $state('');
	let busy = $state(false);
	let error = $state('');

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = '';
		try {
			const result = await auth.login(identifier, password);
			session.set(result.user);
			await goto(nextPath(result.user), { invalidateAll: true });
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'Could not sign in. Please try again.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Sign in · Phnom Penh Digital World</title></svelte:head>

<AuthShell title="Welcome back" subtitle="Sign in with your username, email or phone number.">
	<form class="space-y-4" onsubmit={submit}>
		<div>
			<label class="label" for="identifier">Username, email or phone</label>
			<input
				id="identifier"
				class="input"
				autocomplete="username"
				required
				bind:value={identifier}
			/>
		</div>
		<div>
			<label class="label" for="password">Password</label>
			<input
				id="password"
				class="input"
				type="password"
				autocomplete="current-password"
				required
				bind:value={password}
			/>
		</div>
		{#if error}<p class="alert-error" role="alert">{error}</p>{/if}
		<button class="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
	</form>
	{#snippet footer()}
		New here? <a class="font-semibold text-river-800 underline" href="/register">Create an account</a>
	{/snippet}
</AuthShell>

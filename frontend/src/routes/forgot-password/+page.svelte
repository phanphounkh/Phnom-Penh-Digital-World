<script lang="ts">
	import AuthShell from '$lib/components/AuthShell.svelte';
	import { api } from '$lib/api/client';
	import { session } from '$lib/stores/session.svelte';
	let identifier = $state(''),
		token = $state(''),
		password = $state('');
	let sent = $state(false),
		done = $state(false),
		busy = $state(false);
	let error = $state(''),
		message = $state(''),
		devToken = $state('');
	async function request(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = '';
		try {
			const result = await api<{ message: string; dev_token?: string }>('/auth/password/request', {
				method: 'POST',
				body: { identifier }
			});
			message = result.message;
			devToken = result.dev_token ?? '';
			sent = true;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Please try again.';
		} finally {
			busy = false;
		}
	}
	async function reset(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = '';
		try {
			const result = await api<{ message: string }>('/auth/password/reset', {
				method: 'POST',
				body: { token: token.trim(), password }
			});
			message = result.message;
			done = true;
			devToken = '';
			token = '';
			password = '';
			session.set(null);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Please try again.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Reset password · Phnom Penh Digital World</title></svelte:head>
<AuthShell
	title={done ? 'Password updated' : 'Reset your password'}
	subtitle="Get back to your city safely."
>
	{#if error}<p class="alert-error mb-4" role="alert">{error}</p>{/if}
	{#if message}<p class="mb-4 text-sm text-ink-soft" role="status">
			{message}
		</p>{/if}
	{#if done}<a class="btn-primary w-full" href="/login" data-sveltekit-reload>Sign in</a>
	{:else if sent}
		{#if devToken}<div class="alert-dev mb-4 break-all">
				<strong>Developer mode</strong>
				<p class="mt-2 font-mono text-xs" data-testid="reset-dev-token">
					{devToken}
				</p>
			</div>{/if}
		<form class="space-y-4" onsubmit={reset}>
			<div>
				<label class="label" for="reset-token">Token from your message</label><input
					id="reset-token"
					class="input"
					autocomplete="one-time-code"
					bind:value={token}
					required
					maxlength="128"
				/>
			</div>
			<div>
				<label class="label" for="new-password">New password</label><input
					id="new-password"
					type="password"
					class="input"
					autocomplete="new-password"
					bind:value={password}
					required
					minlength="10"
					maxlength="128"
				/>
				<p class="hint">At least 10 characters. Changing it signs out every device.</p>
			</div>
			<button class="btn-primary w-full" disabled={busy}
				>{busy ? 'Updating…' : 'Update password'}</button
			>
			<button
				type="button"
				class="btn-quiet w-full"
				onclick={() => {
					sent = false;
					message = '';
					devToken = '';
				}}>Request a new token</button
			>
		</form>
	{:else}<form class="space-y-4" onsubmit={request}>
			<div>
				<label class="label" for="reset-identifier">Username, email or phone</label><input
					id="reset-identifier"
					class="input"
					autocomplete="username"
					required
					bind:value={identifier}
				/>
			</div>
			<button class="btn-primary w-full" disabled={busy}
				>{busy ? 'Sending…' : 'Send reset instructions'}</button
			>
		</form>{/if}
	{#snippet footer()}<a class="font-semibold text-river-800 underline" href="/login"
			>Back to sign in</a
		>{/snippet}
</AuthShell>

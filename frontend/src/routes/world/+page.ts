import { redirect, error } from '@sveltejs/kit';
import { world } from '$lib/api/endpoints';
import { ApiError } from '$lib/api/client';
import { nextPath } from '$lib/stores/session.svelte';

// WebGL-only page: render on the client.
export const ssr = false;

export const load = async ({ parent, fetch }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login?next=/world');
	if (!user.onboarding.completed) redirect(303, nextPath(user));
	try {
		return { boot: await world.bootstrap({ fetch }) };
	} catch (e) {
		if (e instanceof ApiError && e.status === 409) redirect(303, nextPath(user));
		if (e instanceof ApiError && e.status === 401) redirect(303, '/login?next=/world');
		error(503, e instanceof Error ? e.message : 'The world could not be loaded.');
	}
};

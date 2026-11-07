import { redirect } from '@sveltejs/kit';
import { nextPath } from '$lib/stores/session.svelte';

/** Signed-in users go straight to their next step (or the world). */
export const load = async ({ parent }) => {
	const { user } = await parent();
	if (user) redirect(303, nextPath(user));
};

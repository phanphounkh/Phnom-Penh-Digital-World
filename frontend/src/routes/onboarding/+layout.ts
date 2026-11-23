import { redirect } from '@sveltejs/kit';
import { STEPS, nextPath, stepIndex } from '$lib/stores/session.svelte';
import type { OnboardingStep } from '$lib/api/types';

/** Users may revisit earlier steps to edit them, but never skip ahead of the server state. */
export const load = async ({ parent, url }) => {
	const { user } = await parent();
	if (!user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	const requested = url.pathname.split('/')[2] as OnboardingStep | undefined;
	if (!requested) redirect(303, nextPath(user));
	// Not a step any more: the avatar is made in the city. Work roles stay reachable once in.
	const done = user.onboarding.completed;
	if (!STEPS.some((s) => s.id === requested) && !(requested === 'role' && done)) redirect(303, nextPath(user));
	if (requested !== 'role' && stepIndex(requested) > stepIndex(user.onboarding.next_step)) redirect(303, nextPath(user));
	return { step: requested };
};

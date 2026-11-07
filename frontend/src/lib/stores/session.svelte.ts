import { browser } from '$app/environment';
import { page } from '$app/state';
import { auth } from '$lib/api/endpoints';
import type { Me, OnboardingStep, Verification } from '$lib/api/types';

/**
 * The signed-in user. Server truth always comes from /auth/me (the root layout load).
 *
 * During SSR this reads the request-scoped `page.data.user` and never stores anything in the
 * module-level singleton (which would leak between users on the server). In the browser,
 * `set()` overrides it immediately after sign-in, verification and other mutations.
 */
class Session {
	#override = $state<{ user: Me | null } | null>(null);
	/** Latest verification response (holds the clearly-labelled dev code in development). */
	verification = $state<Verification | null>(null);

	get user(): Me | null {
		if (this.#override) return this.#override.user;
		return (page.data?.user as Me | null | undefined) ?? null;
	}

	set(user: Me | null) {
		if (browser) this.#override = { user };
	}

	async refresh(fetchFn?: typeof fetch): Promise<Me | null> {
		try {
			this.set(await auth.me({ fetch: fetchFn }));
		} catch {
			this.set(null);
		}
		return this.user;
	}

	async logout() {
		try {
			await auth.logout();
		} finally {
			this.set(null);
			this.verification = null;
		}
	}
}

export const session = new Session();

export const STEPS: { id: Exclude<OnboardingStep, 'complete' | 'world'>; label: string }[] = [
	{ id: 'verify', label: 'Verify' },
	{ id: 'avatar', label: 'Avatar' },
	{ id: 'role', label: 'Role' },
	{ id: 'location', label: 'Location' }
];

/** Where a user should go next: an onboarding step, or the world. */
export function nextPath(user: Me | null): string {
	if (!user) return '/login';
	const step = user.onboarding.next_step;
	if (step === 'world') return '/world';
	if (step === 'complete') return '/onboarding/location';
	return `/onboarding/${step}`;
}

/** Index of a step in the flow; 'complete'/'world' are past the last step. */
export function stepIndex(step: OnboardingStep): number {
	const i = STEPS.findIndex((s) => s.id === step);
	return i === -1 ? STEPS.length : i;
}

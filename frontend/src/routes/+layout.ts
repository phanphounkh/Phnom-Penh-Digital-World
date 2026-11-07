import { auth } from '$lib/api/endpoints';
import type { Me } from '$lib/api/types';

export const load = async ({ fetch }) => {
	let user: Me | null = null;
	try {
		user = await auth.me({ fetch });
	} catch {
		user = null; // 401 when signed out, or the API is unreachable
	}
	return { user };
};

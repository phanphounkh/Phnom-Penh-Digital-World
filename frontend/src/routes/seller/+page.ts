import { redirect } from '@sveltejs/kit';

/** Selling happens in the city now: the old dashboard's address opens My shop there. */
export const load = async ({ parent }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login?next=/seller');
	redirect(307, '/world?panel=shop');
};

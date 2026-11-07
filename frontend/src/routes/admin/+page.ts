import { redirect } from '@sveltejs/kit';

export const load = async ({ parent }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login?next=/admin');
	return { isAdmin: user.active_roles.includes('admin') };
};

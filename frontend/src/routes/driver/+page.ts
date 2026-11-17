import { redirect } from '@sveltejs/kit';
export const load = async ({ parent }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login');
	return { approved: user.active_roles.includes('driver') };
};

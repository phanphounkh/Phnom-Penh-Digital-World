import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';

export const ssr = false;

/** Development-only gallery of the Blender assets (404 in production builds). */
export const load = () => {
	if (!dev) error(404, 'Not found');
};

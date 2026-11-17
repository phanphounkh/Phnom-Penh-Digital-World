import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		// No remote functions are used. Keep their experimental request parser disabled.
		experimental: { remoteFunctions: false },
		// One repo-level .env for the API and the web app.
		env: { dir: '..' }
	}
};

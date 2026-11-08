import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
	// One repo-level .env (see svelte.config.js → kit.env.dir).
	const env = loadEnv(mode, '..', '');
	const api = (env.API_INTERNAL_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
	// SvelteKit's /api proxy (hooks.server.ts) uses fetch and cannot carry WebSocket upgrades,
	// so the world socket is proxied here (dev + preview) and by server.js in production.
	const proxy = {
		'/api/v1/world/ws': { target: api.replace(/^http/, 'ws'), ws: true, xfwd: true }
	};
	return {
		plugins: [tailwindcss(), sveltekit()],
		server: { host: '0.0.0.0', proxy },
		preview: { proxy },
		test: {
			include: ['src/**/*.test.ts'],
			environment: 'node'
		}
	};
});

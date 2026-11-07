import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: { host: '0.0.0.0' },
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});

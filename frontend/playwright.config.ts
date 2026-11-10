import { defineConfig } from '@playwright/test';

/**
 * Browser end-to-end tests run against an ISOLATED stack by default: their own API on :8001
 * with its own database (`ppw_e2e`), and their own web server (:5174 dev, :4174 production
 * build). Test bots therefore never appear in the development world on :8000/:5173.
 * Set E2E_SHARED_DEV=1 to run against already-running dev servers instead.
 */
const production = process.env.CAMPUS_PRODUCTION_TEST === '1';
const shared = process.env.E2E_SHARED_DEV === '1';
const port = shared ? (production ? 4173 : 5173) : production ? 4174 : 5174;
const baseURL = `http://127.0.0.1:${port}`;
const api = 'http://127.0.0.1:8001';

export default defineConfig({
	testDir: './tests',
	testMatch: '**/*.spec.{js,ts}',
	timeout: 360000,
	workers: 1,
	use: {
		baseURL,
		viewport: { width: 1000, height: 700 },
		launchOptions: {
			executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
			args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
		},
		screenshot: 'only-on-failure'
	},
	webServer: shared
		? {
				command: production ? 'npm run preview -- --port 4173' : 'npm run dev',
				url: baseURL,
				reuseExistingServer: true,
				timeout: 30000
			}
		: [
				{
					command: 'cd ../backend && uv run python scripts/e2e_stack.py',
					url: `${api}/api/v1/health`,
					reuseExistingServer: true,
					timeout: 240000,
					stdout: 'ignore'
				},
				{
					command: production
						? `npm run preview -- --port ${port} --strictPort`
						: `npx vite dev --port ${port} --strictPort`,
					url: baseURL,
					env: { API_INTERNAL_URL: api, BODY_SIZE_LIMIT: '6M' },
					reuseExistingServer: true,
					timeout: 60000
				}
			]
});

# Dependency review (2026-11-17)

The map renderer was upgraded from MapLibre 5.24.0 to 6.18.0, and the transitive cookie parser
was overridden to 0.7.2. The production dependency audit now reports no critical findings.
Both maps share an explicit Vite `?worker&url` worker configuration; browser checks verify
that the address-picker and shop-claim maps load in the production build.
The MapLibre attribution sanitizer issue is described in the
[maintainer advisory](https://github.com/maplibre/maplibre-gl-js/security/advisories/GHSA-jrc7-96c5-q579).

One production dependency still appears in `npm audit`: SvelteKit 2.70.4. Its high/moderate
advisories concern experimental remote functions. This application uses ordinary FastAPI
requests, has no remote function modules, and explicitly sets
`kit.experimental.remoteFunctions = false` in `frontend/svelte.config.js`. The
[maintainer's high-severity advisory](https://github.com/sveltejs/kit/security/advisories/GHSA-3r8g-jcqq-3p5j)
states that the affected remote-functions feature must be enabled and used. The low-severity
findings concern enhanced SvelteKit forms and prerendered pages; neither is used here.

This is a scoped mitigation, not a clean audit. Revisit it before enabling those framework
features. Full package-level remediation requires a SvelteKit 3 migration, including its
adapter, Vite 8, TypeScript 6 and Node 22.17+ requirements; see the
[official migration guide](https://svelte.dev/docs/kit/migrating-to-sveltekit-3). The local shell
currently uses Node 20; supported app builds run in the Node 22 Docker image. Development-tool
advisories also need a coordinated toolchain upgrade. Do not run the Vite development server
as the public production service.

import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

/** MapLibre 6 needs a self-contained worker asset when bundled by Vite. */
export async function loadMapLibre() {
	const library = await import('maplibre-gl');
	library.setWorkerUrl(workerUrl);
	return library;
}

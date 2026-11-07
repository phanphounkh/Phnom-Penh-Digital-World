<script lang="ts">
	import { onMount } from 'svelte';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import type { Map as MapLibreMap, Marker, StyleSpecification } from 'maplibre-gl';
	import { env } from '$env/dynamic/public';
	import { geo } from '$lib/api/endpoints';
	import type { SpawnPoint } from '$lib/api/types';

	let {
		spawnPoints,
		selectedSpawn = null,
		pin = null,
		focus = null,
		playableBbox = null,
		pickEnabled = true,
		onpick,
		onspawn
	}: {
		spawnPoints: SpawnPoint[];
		selectedSpawn?: string | null;
		pin?: { lat: number; lon: number } | null;
		focus?: { lat: number; lon: number; zoom?: number } | null;
		playableBbox?: [number, number, number, number] | null; // s, w, n, e
		pickEnabled?: boolean;
		onpick?: (lat: number, lon: number) => void;
		onspawn?: (id: string) => void;
	} = $props();

	let host: HTMLDivElement;
	let map: MapLibreMap | null = null;
	let maplibre: typeof import('maplibre-gl') | null = null;
	let pinMarker: Marker | null = null;
	const spawnMarkers = new Map<string, { marker: Marker; el: HTMLElement }>();
	let baseMapOffline = $state(false);
	let ready = $state(false);

	const FALLBACK_STYLE: StyleSpecification = {
		version: 8,
		sources: {},
		layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#ece4d3' } }]
	};

	async function loadStyle(): Promise<StyleSpecification | string> {
		const url = env.PUBLIC_MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/liberty';
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), 6000);
			const res = await fetch(url, { signal: ctrl.signal });
			clearTimeout(timer);
			if (!res.ok) throw new Error(String(res.status));
			return (await res.json()) as StyleSpecification;
		} catch {
			baseMapOffline = true;
			return FALLBACK_STYLE;
		}
	}

	onMount(() => {
		let disposed = false;
		(async () => {
			maplibre = await import('maplibre-gl');
			const style = await loadStyle();
			if (disposed) return;
			map = new maplibre.Map({
				container: host,
				style,
				center: [104.9211, 11.5696],
				zoom: 14.2,
				minZoom: 10,
				maxZoom: 19,
				attributionControl: { compact: true, customAttribution: '© OpenStreetMap contributors' },
				cooperativeGestures: false
			});
			map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
			map.on('load', async () => {
				if (!map) return;
				try {
					const area = await geo.serviceArea();
					map.addSource('city', { type: 'geojson', data: area });
					map.addLayer({
						id: 'city-line',
						type: 'line',
						source: 'city',
						paint: { 'line-color': '#123b3a', 'line-width': 2, 'line-dasharray': [2, 2] }
					});
				} catch {
					/* boundary is decorative */
				}
				if (playableBbox) {
					const [s, w, n, e] = playableBbox;
					map.addSource('playable', {
						type: 'geojson',
						data: {
							type: 'Feature',
							properties: {},
							geometry: {
								type: 'Polygon',
								coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]]
							}
						}
					});
					map.addLayer({
						id: 'playable-fill',
						type: 'fill',
						source: 'playable',
						paint: { 'fill-color': '#e8a33d', 'fill-opacity': 0.12 }
					});
					map.addLayer({
						id: 'playable-line',
						type: 'line',
						source: 'playable',
						paint: { 'line-color': '#c9831f', 'line-width': 2.5 }
					});
				}
				ready = true;
			});
			map.on('click', (e) => {
				if (pickEnabled) onpick?.(e.lngLat.lat, e.lngLat.lng);
			});
		})();
		return () => {
			disposed = true;
			map?.remove();
			map = null;
		};
	});

	// Spawn markers (HTML markers work even with the fallback style, which has no glyphs).
	$effect(() => {
		const lib = maplibre;
		const m = map;
		if (!lib || !m || !ready) return;
		for (const sp of spawnPoints) {
			if (spawnMarkers.has(sp.id)) continue;
			const el = document.createElement('button');
			el.type = 'button';
			el.className = 'ppw-spawn';
			el.title = sp.name;
			el.setAttribute('aria-label', `Spawn area: ${sp.name}`);
			el.innerHTML = `<span></span><b>${sp.name.replace(/</g, '&lt;')}</b>`;
			el.addEventListener('click', (ev) => {
				ev.stopPropagation();
				onspawn?.(sp.id);
			});
			const marker = new lib.Marker({ element: el, anchor: 'bottom' })
				.setLngLat([sp.lon, sp.lat])
				.addTo(m);
			spawnMarkers.set(sp.id, { marker, el });
		}
	});

	$effect(() => {
		const id = selectedSpawn;
		for (const [key, { el }] of spawnMarkers) el.classList.toggle('active', key === id);
		void ready;
	});

	$effect(() => {
		const lib = maplibre;
		const m = map;
		const p = pin;
		if (!lib || !m) return;
		if (!p) {
			pinMarker?.remove();
			pinMarker = null;
			return;
		}
		if (!pinMarker) {
			const el = document.createElement('div');
			el.className = 'ppw-pin';
			el.setAttribute('aria-label', 'Your private delivery address');
			pinMarker = new lib.Marker({ element: el, anchor: 'bottom', draggable: true })
				.setLngLat([p.lon, p.lat])
				.addTo(m);
			pinMarker.on('dragend', () => {
				const ll = pinMarker!.getLngLat();
				onpick?.(ll.lat, ll.lng);
			});
		} else pinMarker.setLngLat([p.lon, p.lat]);
	});

	$effect(() => {
		const f = focus;
		if (f && map) map.flyTo({ center: [f.lon, f.lat], zoom: f.zoom ?? 16, speed: 1.4 });
	});
</script>

<div class="relative h-full w-full overflow-hidden rounded-3xl border border-river-900/10 bg-paper-2">
	<div bind:this={host} class="h-full w-full" data-testid="location-map" data-ready={ready}></div>
	{#if baseMapOffline}
		<p class="absolute top-3 left-3 max-w-[70%] rounded-xl bg-white/90 px-3 py-2 text-xs text-ink-soft shadow">
			Base map unavailable — showing the city outline and spawn areas only.
		</p>
	{/if}
	<div class="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1 text-[11px] font-semibold">
		<span class="rounded-full bg-white/90 px-3 py-1 shadow"
			><span class="mr-1 inline-block h-2 w-3 border-2 border-saffron-600 bg-saffron-500/20"></span>3D world available</span
		>
		<span class="rounded-full bg-white/90 px-3 py-1 shadow"
			><span class="mr-1 inline-block h-0.5 w-3 border-t-2 border-dashed border-river-900 align-middle"></span>Phnom Penh delivery area</span
		>
	</div>
</div>

<style>
	:global(.ppw-spawn) {
		display: flex;
		flex-direction: column;
		align-items: center;
		background: none;
		border: 0;
		cursor: pointer;
		padding: 0;
	}
	:global(.ppw-spawn span) {
		width: 18px;
		height: 18px;
		border-radius: 999px;
		background: #e8a33d;
		border: 3px solid #fff;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
		order: 2;
	}
	:global(.ppw-spawn b) {
		font: 600 11px/1.2 Inter, sans-serif;
		background: #123b3a;
		color: #f6f1e6;
		padding: 3px 8px;
		border-radius: 999px;
		margin-bottom: 4px;
		white-space: nowrap;
		opacity: 0.9;
	}
	:global(.ppw-spawn.active span) {
		background: #123b3a;
		transform: scale(1.3);
	}
	:global(.ppw-spawn.active b) {
		background: #e8a33d;
		color: #0b2524;
		opacity: 1;
	}
	:global(.ppw-pin) {
		width: 26px;
		height: 34px;
		background: #c4552f;
		clip-path: path('M13 0C5.8 0 0 5.8 0 13c0 9.4 13 21 13 21s13-11.6 13-21C26 5.8 20.2 0 13 0z');
		cursor: grab;
	}
</style>

<script lang="ts">
	/**
	 * The claim map: real streets (MapLibre base map) with the virtual shop units of the visible
	 * area drawn from the server, coloured by status. Click a unit to select it.
	 */
	import { onMount } from 'svelte';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import type { GeoJSONSource, Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
	import { env } from '$env/dynamic/public';
	import { market, type Unit } from '$lib/api/market';

	let {
		selected = null,
		onselect,
		onunits
	}: {
		selected?: string | null;
		onselect: (unit: Unit) => void;
		onunits?: (units: Unit[]) => void;
	} = $props();

	let host: HTMLDivElement;
	let map: MapLibreMap | null = null;
	let units: Unit[] = [];
	let note = $state('');
	let offline = $state(false);
	const MIN_ZOOM = 16;

	const FALLBACK: StyleSpecification = {
		version: 8,
		sources: {},
		layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#ece4d3' } }]
	};

	async function style(): Promise<StyleSpecification | string> {
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), 6000);
			const res = await fetch(env.PUBLIC_MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/liberty', { signal: ctrl.signal });
			clearTimeout(timer);
			if (!res.ok) throw new Error(String(res.status));
			return (await res.json()) as StyleSpecification;
		} catch {
			offline = true;
			return FALLBACK;
		}
	}

	function geojson(list: Unit[]): GeoJSON.FeatureCollection {
		return {
			type: 'FeatureCollection',
			features: list.map((u) => ({
				type: 'Feature',
				properties: {
					code: u.code,
					state: u.status === 'available' ? (u.requires_verification ? 'verify' : 'available') : u.status,
					selected: u.code === selected ? 1 : 0
				},
				geometry: {
					type: 'Polygon',
					coordinates: [[...u.corners_ll, u.corners_ll[0]].map(([lat, lon]) => [lon, lat])]
				}
			}))
		};
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	function refresh() {
		clearTimeout(timer);
		timer = setTimeout(async () => {
			if (!map) return;
			if (map.getZoom() < MIN_ZOOM) {
				note = 'Zoom in to see shop units.';
				units = [];
			} else {
				const b = map.getBounds();
				try {
					units = await market.units([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
					note = units.length ? '' : 'No shop units here. Units line real shopping streets in Daun Penh.';
				} catch {
					note = 'Could not load units.';
				}
			}
			(map.getSource('units') as GeoJSONSource | undefined)?.setData(geojson(units));
			onunits?.(units);
		}, 250);
	}

	$effect(() => {
		void selected;
		(map?.getSource('units') as GeoJSONSource | undefined)?.setData(geojson(units));
	});

	onMount(() => {
		let disposed = false;
		(async () => {
			const maplibre = await import('maplibre-gl');
			const s = await style();
			if (disposed) return;
			map = new maplibre.Map({
				container: host,
				style: s,
				center: [104.9211, 11.5696],
				zoom: 17,
				minZoom: 13,
				maxZoom: 19.5,
				attributionControl: { compact: true, customAttribution: '© OpenStreetMap contributors' }
			});
			map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
			map.on('load', () => {
				if (!map) return;
				map.addSource('units', { type: 'geojson', data: geojson([]) });
				map.addLayer({
					id: 'units-fill',
					type: 'fill',
					source: 'units',
					paint: {
						'fill-color': ['match', ['get', 'state'], 'available', '#3d7a4f', 'verify', '#e8a33d', 'pending', '#2f6f8f', '#8a8378'],
						'fill-opacity': ['case', ['==', ['get', 'selected'], 1], 0.85, 0.5]
					}
				});
				map.addLayer({
					id: 'units-line',
					type: 'line',
					source: 'units',
					paint: { 'line-color': ['case', ['==', ['get', 'selected'], 1], '#c4552f', '#1f2a2c'], 'line-width': ['case', ['==', ['get', 'selected'], 1], 3, 0.8] }
				});
				map.on('click', 'units-fill', (e) => {
					const code = e.features?.[0]?.properties?.code as string | undefined;
					const unit = units.find((u) => u.code === code);
					if (unit) onselect(unit);
				});
				map.on('mouseenter', 'units-fill', () => map && (map.getCanvas().style.cursor = 'pointer'));
				map.on('mouseleave', 'units-fill', () => map && (map.getCanvas().style.cursor = ''));
				map.on('moveend', refresh);
				refresh();
			});
		})();
		return () => {
			disposed = true;
			clearTimeout(timer);
			map?.remove();
			map = null;
		};
	});

	/** Centre the map on a unit (e.g. picked from the list). */
	export function focus(lat: number, lon: number) {
		map?.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 18) });
	}
</script>

<div class="relative h-full min-h-72 overflow-hidden rounded-2xl border border-river-900/10">
	<div bind:this={host} class="absolute inset-0"></div>
	<div class="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-1.5 text-[10px] font-semibold">
		<span class="rounded bg-[#3d7a4f] px-1.5 py-0.5 text-white">Available</span>
		<span class="rounded bg-[#e8a33d] px-1.5 py-0.5 text-river-950">Real business: verification</span>
		<span class="rounded bg-[#2f6f8f] px-1.5 py-0.5 text-white">Under review</span>
		<span class="rounded bg-[#8a8378] px-1.5 py-0.5 text-white">Claimed</span>
	</div>
	{#if note}<p class="absolute top-2 left-2 rounded bg-white/90 px-2 py-1 text-xs">{note}</p>{/if}
	{#if offline}<p class="absolute top-9 left-2 rounded bg-white/90 px-2 py-1 text-[10px] text-ink-soft">Base map offline: unit outlines only.</p>{/if}
</div>

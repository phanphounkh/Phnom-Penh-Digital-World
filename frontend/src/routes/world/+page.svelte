<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		Compass, MapPin, Navigation, Settings2, CircleHelp, LogOut, X, Gauge, Users, Landmark,
		ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Footprints, Wifi, WifiOff, Hand, Sparkles, PartyPopper
	} from 'lucide-svelte';
	import ChatBox from '$lib/components/world/ChatBox.svelte';
	import PeoplePanel from '$lib/components/world/PeoplePanel.svelte';
	import type { WorldSession } from '$lib/game/net/WorldSession.svelte';
	import type { EmoteName } from '$lib/game/net/protocol';
	import { geo } from '$lib/api/endpoints';
	import type { SpawnPoint } from '$lib/api/types';
	import { compassLabel } from '$lib/geo/projection';
	import type { CityController, CityState, Quality, TimeMode } from '$lib/game/city/CityEngine';
	import { session } from '$lib/stores/session.svelte';

	let { data } = $props();
	const boot = untrack(() => data.boot); // the page is rebuilt on navigation
	const preferKhmer = session.user?.preferred_language === 'km';

	let host: HTMLDivElement;
	let minimap = $state<HTMLCanvasElement>();
	let city: CityController | null = null;
	let hud = $state<CityState | null>(null);
	let progress = $state({ loaded: 0, total: 1 });
	let ready = $state(false);
	let failure = $state('');
	let panel = $state<'' | 'places' | 'settings' | 'help' | 'people'>('');
	let net = $state<WorldSession | null>(null);
	let chatInput = $state<HTMLInputElement>();
	const EMOTE_BUTTONS: [EmoteName, string][] = [['wave', 'Wave'], ['sampeah', 'Sampeah'], ['cheer', 'Cheer'], ['dance', 'Dance']];
	let places = $state<SpawnPoint[]>([]);
	let quality = $state<Quality>('high');
	let timeMode = $state<TimeMode>('live');
	const TIME_MODES: [TimeMode, string][] = [
		['live', 'Live'],
		['morning', 'Morning'],
		['noon', 'Midday'],
		['sunset', 'Sunset'],
		['night', 'Night']
	];
	let touch = $state(false);

	// Menus pause your movement (not the world): other players keep moving and chatting.
	$effect(() => city?.setPaused(panel !== '' && panel !== 'people'));

	onMount(() => {
		touch = matchMedia('(pointer: coarse)').matches;
		let disposed = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		(async () => {
			try {
				const { createCity } = await import('$lib/game/city/CityEngine');
				const created = await createCity(host, boot, {
					preferKhmer,
					quality: touch ? 'low' : 'high',
					onState: (s) => (hud = s),
					onProgress: (loaded, total) => (progress = { loaded, total })
				});
				if (disposed) return created.dispose();
				city = created;
				quality = touch ? 'low' : 'high';
				ready = true;
				const { WorldSession } = await import('$lib/game/net/WorldSession.svelte');
				net = new WorldSession(created);
				net.start();
				(globalThis as { __ppwNet?: unknown }).__ppwNet = net; // e2e/perf inspection
				timer = setInterval(() => {
					if ((globalThis as { __ppwNoMinimap?: boolean }).__ppwNoMinimap) return; // perf probes
					const ctx = minimap?.getContext('2d');
					if (ctx && city) city.drawMinimap(ctx, minimap!.width, 1.6);
				}, 200);
			} catch (e) {
				console.error(e);
				failure = 'The 3D city could not start. A browser with WebGL 2 is required.';
			}
		})();
		geo.spawnPoints().then((p) => (places = p)).catch(() => {});
		const onKey = (e: KeyboardEvent) => {
			const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
			if (e.key === 'Escape' && !typing) panel = panel ? '' : 'help';
			if (typing) return;
			if (e.key.toLowerCase() === 'm') panel = panel === 'places' ? '' : 'places';
			if (e.key.toLowerCase() === 'p') panel = panel === 'people' ? '' : 'people';
			if (e.key === 'Enter' && chatInput) {
				e.preventDefault();
				chatInput.focus();
			}
			const emote = EMOTE_BUTTONS[Number(e.key) - 1];
			if (emote && net) net.emote(emote[0]);
		};
		window.addEventListener('keydown', onKey);
		return () => {
			disposed = true;
			clearInterval(timer);
			window.removeEventListener('keydown', onKey);
			net?.stop();
			net = null;
			city?.dispose();
			city = null;
		};
	});

	async function travel(p: SpawnPoint) {
		panel = '';
		// Online, the server moves you (it is authoritative); offline, travel locally.
		if (net?.travel(p.slug)) return;
		await city?.teleport(p.x, p.z, p.heading_deg);
	}

	function setQuality(q: Quality) {
		quality = q;
		city?.setQuality(q);
	}

	function setTime(mode: TimeMode) {
		timeMode = mode;
		city?.setTimeMode(mode);
	}

	async function signOut() {
		net?.stop();
		city?.dispose();
		city = null;
		await session.logout();
		await goto('/', { invalidateAll: true });
	}

	const pad = (key: string) => ({
		onpointerdown: (e: PointerEvent) => {
			e.preventDefault();
			city?.setKey(key, true);
		},
		onpointerup: () => city?.setKey(key, false),
		onpointerleave: () => city?.setKey(key, false),
		onpointercancel: () => city?.setKey(key, false)
	});
</script>

<svelte:head><title>Daun Penh · Phnom Penh Digital World</title></svelte:head>

<div class="fixed inset-0 overflow-hidden bg-river-950 text-paper select-none">
	<div bind:this={host} class="absolute inset-0" data-testid="world-canvas" data-ready={ready} data-ground={hud?.ground.toFixed(1)} data-night={hud?.night.toFixed(2)}></div>

	{#if !ready}
		<div class="absolute inset-0 grid place-items-center bg-river-950">
			<div class="w-72 text-center">
				{#if failure}
					<p class="text-sm text-saffron-300">{failure}</p>
					<a href="/" class="btn-ghost mt-4">Back home</a>
				{:else}
					<p class="font-display text-2xl">Daun Penh</p>
					<p class="khmer mt-1 text-sm text-river-200" lang="km">ដូនពេញ</p>
					<div class="mt-5 h-1.5 overflow-hidden rounded-full bg-river-800">
						<div class="h-full rounded-full bg-saffron-500 transition-all" style="width: {Math.round((progress.loaded / Math.max(1, progress.total)) * 100)}%"></div>
					</div>
					<p class="mt-2 text-xs text-river-200">Streaming streets and buildings… {progress.loaded}/{progress.total}</p>
				{/if}
			</div>
		</div>
	{/if}

	{#if ready && hud}
		<!-- Location card -->
		<div class="pointer-events-none absolute top-3 left-3 max-w-[min(22rem,calc(100vw-7rem))] rounded-2xl bg-river-950/75 px-4 py-3 shadow-xl backdrop-blur" data-testid="hud-location">
			<p class="flex items-center gap-2 text-[11px] font-bold tracking-widest text-saffron-300 uppercase">
				<Navigation size={12} style="transform: rotate({hud.heading}deg)" /> {compassLabel(hud.heading)} · Daun Penh
				<span class="ml-auto font-mono normal-case tracking-normal text-river-200" data-testid="hud-clock" title={hud.timeMode === 'live' ? 'Phnom Penh time (live sun)' : 'Fixed time of day'}>{hud.clock}{hud.timeMode === 'live' ? '' : ' ·'}</span>
			</p>
			<p class="mt-1 truncate font-display text-lg leading-tight" data-testid="hud-street">
				{hud.street ?? 'Off-street'}
			</p>
			{#if hud.streetAlt}<p class="khmer truncate text-xs text-river-200" lang={preferKhmer ? 'en' : 'km'}>{hud.streetAlt}</p>{/if}
			{#if hud.landmark}
				<p class="mt-1 flex items-center gap-1.5 truncate text-xs text-river-200"><Landmark size={12} /> Near {hud.landmark}</p>
			{/if}
			<p class="mt-1 font-mono text-[10px] text-river-200/80" data-testid="hud-coords">
				{hud.lat.toFixed(5)}, {hud.lon.toFixed(5)} · x {hud.x.toFixed(0)} z {hud.z.toFixed(0)}
			</p>
		</div>

		<!-- Toolbar -->
		<div class="absolute top-3 right-3 flex flex-col gap-2">
			{#each [['people', Users, 'People (P)'], ['places', MapPin, 'Places (M)'], ['settings', Settings2, 'Settings'], ['help', CircleHelp, 'Controls (Esc)']] as const as [id, Icon, label] (id)}
				<button class="grid h-11 w-11 place-items-center rounded-xl bg-river-950/75 text-paper shadow-lg backdrop-blur hover:bg-river-800 {panel === id ? 'ring-2 ring-saffron-500' : ''}" aria-label={label} title={label} onclick={() => (panel = panel === id ? '' : id)}>
					<Icon size={19} />
				</button>
			{/each}
			<button class="grid h-11 w-11 place-items-center rounded-xl bg-river-950/75 text-paper shadow-lg backdrop-blur hover:bg-brick-600" aria-label="Sign out" title="Sign out" onclick={signOut}><LogOut size={18} /></button>
		</div>

		<!-- Minimap -->
		<div class="absolute bottom-10 left-3 overflow-hidden rounded-2xl border-2 border-white/80 shadow-xl">
			<canvas bind:this={minimap} width="170" height="170" class="block h-[150px] w-[150px] sm:h-[170px] sm:w-[170px]" aria-label="Minimap"></canvas>
			<span class="absolute top-1.5 left-1/2 -translate-x-1/2 rounded bg-river-950/70 px-1.5 text-[10px] font-bold">N</span>
			<span class="absolute right-2 bottom-1.5 rounded bg-river-950/70 px-1.5 text-[9px]">100 m ▬</span>
		</div>

		<!-- Status -->
		<div class="pointer-events-none absolute right-3 bottom-10 flex flex-col items-end gap-1.5 text-[11px]">
			{#if net}
				<span class="flex items-center gap-1.5 rounded-full px-3 py-1 backdrop-blur {net.status === 'open' ? 'bg-river-950/70' : 'bg-brick-600/85'}" data-testid="hud-net" data-status={net.status}>
					{#if net.status === 'open'}
						<Wifi size={12} /> <span data-testid="hud-online">{net.online}</span>&nbsp;online · {net.nearby.length} nearby{#if net.rtt} · {net.rtt} ms{/if}
					{:else}
						<WifiOff size={12} /> {net.detail || (net.status === 'connecting' ? 'Connecting…' : 'Offline')}
					{/if}
				</span>
			{/if}
			<span class="flex items-center gap-1.5 rounded-full bg-river-950/70 px-3 py-1 backdrop-blur" data-testid="hud-perf"><Gauge size={12} /> {hud.fps} fps · {hud.chunks} chunks{hud.pending ? ` (+${hud.pending})` : ''}</span>
		</div>

		{#if net}
			<div class="pointer-events-none absolute bottom-10 left-[calc(170px+1.5rem)] flex flex-col gap-2 max-sm:bottom-52 max-sm:left-3">
				<div class="pointer-events-auto flex gap-1.5" role="group" aria-label="Emotes (keys 1–4)">
					{#each EMOTE_BUTTONS as [id, label], i (id)}
						<button class="flex items-center gap-1 rounded-full bg-river-950/70 px-2.5 py-1 text-[11px] font-semibold backdrop-blur hover:bg-river-800" title={`${label} (${i + 1})`} onclick={() => net?.emote(id)} data-testid={`emote-${id}`}>
							{#if id === 'wave'}<Hand size={12} />{:else if id === 'sampeah'}<span aria-hidden="true">🙏</span>{:else if id === 'cheer'}<PartyPopper size={12} />{:else}<Sparkles size={12} />{/if}
							{label}
						</button>
					{/each}
				</div>
				<ChatBox session={net} bind:input={chatInput} />
			</div>
			<div class="absolute top-3 left-1/2 flex w-[min(26rem,calc(100vw-8rem))] -translate-x-1/2 flex-col gap-2" aria-live="polite">
				{#each net.toasts as t (t.key)}
					<div class="flex items-center gap-3 rounded-2xl px-4 py-2.5 text-sm shadow-xl {t.kind === 'warning' ? 'bg-brick-600 text-white' : 'bg-paper text-ink'}" data-testid="toast">
						<span class="flex-1">{t.text}</span>
						{#if t.kind === 'invite' && t.from}
							<button class="btn-primary px-3 py-1.5 text-xs" onclick={() => net?.join(t.from!)} data-testid="join-invite">Join</button>
						{/if}
						<button class="text-ink-soft" aria-label="Dismiss" onclick={() => net?.dismiss(t.key)}><X size={15} /></button>
					</div>
				{/each}
			</div>
		{/if}

		{#if hud.nearEdge}
			<div class="pointer-events-none absolute top-24 left-1/2 -translate-x-1/2 rounded-full bg-saffron-500 px-4 py-2 text-sm font-semibold text-river-950 shadow-lg">
				Edge of the mapped neighbourhood — more of Phnom Penh is coming
			</div>
		{/if}

		<p class="absolute right-0 bottom-0 left-0 bg-gradient-to-t from-river-950/80 to-transparent px-3 pt-4 pb-1.5 text-center text-[10px] text-river-200">
			Map data © OpenStreetMap contributors (ODbL) · Geometry from OSM; heights, colours and trees are partly estimated · Not a live replica of Phnom Penh
		</p>

		{#if touch}
			<div class="absolute right-4 bottom-44 grid grid-cols-3 gap-1.5">
				<span></span><button class="pad" aria-label="Forward" {...pad('w')}><ChevronUp /></button><span></span>
				<button class="pad" aria-label="Left" {...pad('a')}><ChevronLeft /></button>
				<button class="pad" aria-label="Run" {...pad('shift')}><Footprints size={18} /></button>
				<button class="pad" aria-label="Right" {...pad('d')}><ChevronRight /></button>
				<span></span><button class="pad" aria-label="Back" {...pad('s')}><ChevronDown /></button><span></span>
			</div>
		{/if}
	{/if}

	{#if panel}
		<div class="absolute top-3 right-17 {panel === 'people' ? 'w-[min(27rem,calc(100vw-5.5rem))]' : 'w-[min(22rem,calc(100vw-5.5rem))]'} rounded-2xl bg-paper p-5 text-ink shadow-2xl" role="dialog" aria-label={panel}>
			<button class="absolute top-3 right-3 rounded-lg p-1 text-ink-soft hover:bg-paper-2" aria-label="Close" onclick={() => (panel = '')}><X size={18} /></button>
			{#if panel === 'people' && net}
				<h2 class="display mb-3 text-xl font-bold">People</h2>
				<div class="h-[min(32rem,calc(100dvh-10rem))]"><PeoplePanel session={net} /></div>
			{:else if panel === 'places'}
				<h2 class="display text-xl font-bold">Places</h2>
				<p class="mt-1 text-xs text-ink-soft">Fast-travel between public spawn areas. Vehicles arrive in Phase 5.</p>
				<div class="mt-3 grid gap-2">
					{#each places as p (p.id)}
						<button class="rounded-xl border border-river-900/10 bg-white px-3 py-2 text-left hover:border-river-700" onclick={() => travel(p)}>
							<span class="block text-sm font-semibold">{p.name}</span>
							{#if p.name_km}<span class="khmer block text-xs text-ink-soft" lang="km">{p.name_km}</span>{/if}
						</button>
					{/each}
				</div>
			{:else if panel === 'settings'}
				<h2 class="display text-xl font-bold">Settings</h2>
				<p class="label mt-4">Graphics</p>
				<div class="grid grid-cols-2 gap-1 rounded-xl bg-paper-2 p-1 text-sm font-semibold">
					{#each [['high', 'Quality'], ['low', 'Performance']] as const as [q, text] (q)}
						<button class="rounded-lg py-2 {quality === q ? 'bg-white shadow' : 'text-ink-soft'}" onclick={() => setQuality(q)}>{text}</button>
					{/each}
				</div>
				<p class="hint">Performance mode turns off shadows and streams fewer chunks. It switches on automatically if the frame rate stays low.</p>
				<p class="label mt-4">Time of day</p>
				<div class="grid grid-cols-5 gap-1 rounded-xl bg-paper-2 p-1 text-xs font-semibold" role="radiogroup" aria-label="Time of day">
					{#each TIME_MODES as [mode, text] (mode)}
						<button role="radio" aria-checked={timeMode === mode} class="rounded-lg py-2 {timeMode === mode ? 'bg-white shadow' : 'text-ink-soft'}" onclick={() => setTime(mode)}>{text}</button>
					{/each}
				</div>
				<p class="hint">Live follows the real sun over Phnom Penh (UTC+7). Street lamps are generated; OSM maps none here.</p>
				<p class="label mt-4">Avatar</p>
				<a class="btn-ghost w-full" href="/onboarding/avatar" data-sveltekit-reload>Edit avatar</a>
				<p class="label mt-4">Visibility</p>
				<p class="text-sm">{boot.player.world_visible ? 'Visible to other players' : 'Hidden from other players'}</p>
			{:else}
				<h2 class="display text-xl font-bold">Controls</h2>
				<dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
					<dt class="font-mono font-semibold">W A S D</dt><dd>Walk (arrow keys work too)</dd>
					<dt class="font-mono font-semibold">Shift</dt><dd>Run</dd>
					<dt class="font-mono font-semibold">Drag</dt><dd>Orbit the camera</dd>
					<dt class="font-mono font-semibold">Wheel</dt><dd>Zoom</dd>
					<dt class="font-mono font-semibold">M</dt><dd>Places / fast travel</dd>
					<dt class="font-mono font-semibold">P</dt><dd>People: friends, messages, blocking</dd>
					<dt class="font-mono font-semibold">Enter</dt><dd>Chat (Tab: nearby ↔ world)</dd>
					<dt class="font-mono font-semibold">1 – 4</dt><dd>Wave · Sampeah · Cheer · Dance</dd>
					<dt class="font-mono font-semibold">Esc</dt><dd>This panel</dd>
				</dl>
				<p class="mt-4 rounded-xl bg-paper-2 p-3 text-xs text-ink-soft">
					<Compass size={12} class="mr-1 inline" /> Streets and building footprints come from OpenStreetMap ({String(boot.config.regions[0]?.dataset?.osm_base_timestamp ?? 'snapshot').slice(0, 10)}). Building heights are estimated where OSM has none.
				</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.pad {
		display: grid;
		place-items: center;
		width: 3.25rem;
		height: 3.25rem;
		border-radius: 1rem;
		background: rgb(11 37 36 / 0.7);
		color: #f6f1e6;
		touch-action: none;
	}
	.pad:active {
		background: #e8a33d;
		color: #0b2524;
	}
</style>

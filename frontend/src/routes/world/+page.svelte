<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		Compass, MapPin, Navigation, Settings2, CircleHelp, LogOut, X, Gauge, Users, Landmark,
		ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Footprints, Wifi, WifiOff, Hand, Sparkles, PartyPopper,
		ShoppingCart, Store, Package, Bike, Route as RouteIcon, CircleParking, TriangleAlert, Play, Square
	} from 'lucide-svelte';
	import ChatBox from '$lib/components/world/ChatBox.svelte';
	import PeoplePanel from '$lib/components/world/PeoplePanel.svelte';
	import ShopPanel from '$lib/components/world/ShopPanel.svelte';
	import CartPanel from '$lib/components/world/CartPanel.svelte';
	import GaragePanel from '$lib/components/world/GaragePanel.svelte';
	import VehicleIcon from '$lib/components/world/VehicleIcon.svelte';
	import { transport, type Vehicle } from '$lib/api/transport';
	import { formatDistance, formatDuration } from '$lib/game/vehicles/route';
	import { MODES, type TravelMode } from '$lib/game/vehicles/specs';
	import { market, money, shopping, type Cart, type Product, type Shop } from '$lib/api/market';
	import type { Interaction, Storefronts } from '$lib/game/shop/Storefronts';
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
	let panel = $state<'' | 'places' | 'settings' | 'help' | 'people' | 'cart' | 'shop' | 'garage'>('');
	// Transport (Phase 5)
	let navTarget = $state<{ x: number; z: number; label: string; mode: TravelMode } | null>(null);
	let navMode = $state<TravelMode>('foot');
	let routing = $state(false);
	let canPark = $state(false);
	let offRouteSince = 0;
	let lastReroute = 0;
	// Shopping (Phase 4)
	let shops: Storefronts | null = null;
	let shopList = $state<Shop[]>([]);
	let prompt = $state<Interaction | null>(null);
	let held = $state<Product | null>(null);
	let cart = $state<Cart | null>(null);
	let browsing = $state<Shop | null>(null);
	let insideShop = $state<Shop | null>(null);
	const canBuy = $derived(!!session.user?.active_roles.includes('buyer'));
	const isSeller = $derived(!!session.user?.roles.some((r) => r.role === 'seller'));
	const region = boot.spawn.region;
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
	$effect(() => city?.setPaused(panel !== '' && panel !== 'people' && panel !== 'garage'));

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
				const { Storefronts } = await import('$lib/game/shop/Storefronts');
				shops = new Storefronts({
					scene: created.scene,
					collision: created.collision,
					materials: created.materials,
					terrain: created.terrain,
					avatar: created.avatar,
					setHolding: (h) => created.setHolding(h),
					onInteraction: (i) => (prompt = i)
				});
				(globalThis as { __ppwShops?: unknown }).__ppwShops = shops;
				let parkCheck = 0;
				created.onFrame((dt) => {
					const me = created.localState();
					parkCheck += dt;
					if (parkCheck > 0.4) {
						parkCheck = 0;
						const ok = !!created.riding && !!net?.parkingSpot();
						if (ok !== canPark) canPark = ok;
					}
					if (created.riding) {
						if (prompt) prompt = null;
						return; // no shopping from the saddle
					}
					shops?.update(me.x, me.z, me.yaw);
					const here = shops?.shopAt(me.x, me.z) ?? null;
					if (here?.id !== insideShop?.id) insideShop = here;
				});
				await loadShops();
				if (canBuy) shopping.cart().then(setCart).catch(() => {});
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
			if (e.key.toLowerCase() === 'v') panel = panel === 'garage' ? '' : 'garage';
			if (e.key.toLowerCase() === 'f' && !panel) rideOrPark();
			if (e.key.toLowerCase() === 'e' && !panel) void interact();
			if (e.key.toLowerCase() === 'c') panel = panel === 'cart' ? '' : 'cart';
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
			shops?.dispose();
			shops = null;
			city?.dispose();
			city = null;
		};
	});

	async function loadShops() {
		try {
			shopList = await market.shops(region);
			shops?.setShops(shopList);
		} catch {
			/* the city works without shops */
		}
	}

	// A storefront opened, closed, changed or was restocked somewhere: reload the list.
	$effect(() => {
		if (net && net.shopsVersion > 0) void loadShops();
	});
	$effect(() => {
		if (net && net.ordersVersion > 0 && canBuy) shopping.cart().then(setCart).catch(() => {});
	});

	function setCart(c: Cart) {
		cart = c;
		shops?.setCart(c);
	}

	/** E: the action the prompt shows (pick up, put in the cart, put back, pay, browse). */
	async function interact() {
		const i = shops?.interaction;
		if (!i || !shops) return;
		if (i.kind === 'browse') {
			browsing = i.shop;
			panel = 'shop';
		} else if (i.kind === 'pickup') {
			if (!i.product.in_stock) return net?.say(`${i.product.name} is sold out.`);
			if (!i.shop.is_open) return net?.say(`${i.shop.name} is closed.`);
			await shops.hold(i.shop, i.product);
			held = i.product;
		} else if (i.kind === 'putback') {
			shops.drop();
			held = null;
		} else if (i.kind === 'cart') {
			if (!canBuy) return net?.say('Choose the buyer role to shop.', 'warning');
			try {
				setCart(await shopping.add(i.product.id, 1, i.shop.id));
				net?.say(`${i.product.name} is in your cart.`);
				shops.drop();
				held = null;
			} catch (e) {
				net?.say(e instanceof Error ? e.message : 'Could not add to the cart.', 'warning');
			}
		} else if (i.kind === 'counter') {
			panel = 'cart';
		}
	}

	/** F: get on my vehicle within reach, or park the one I am riding. */
	function rideOrPark() {
		if (!net || !city) return;
		if (city.riding) {
			if (!net.dismount()) return;
			return;
		}
		const v = net.reachable;
		if (!v) return net.say('Walk up to one of your vehicles to ride it (V lists them).');
		if (held) return net.say('Put the product back or in the cart first.', 'warning');
		net.mount(v.id);
	}

	/** A route from here, drawn in the world and on the minimap, with turn-by-turn guidance. */
	async function showRoute(target: { x: number; z: number; label: string }, mode: TravelMode, follow = false) {
		if (!city) return;
		panel = '';
		routing = true;
		try {
			const me = city.localState();
			const route = await transport.route([me.x, me.z], [target.x, target.z], mode);
			city.setRoute(route, [target.x, target.z]);
			navTarget = { ...target, mode };
			offRouteSince = 0;
			if (follow) followRoute();
		} catch (e) {
			net?.say(e instanceof Error ? e.message : 'No route found.', 'warning');
		} finally {
			routing = false;
		}
	}

	function followRoute() {
		if (!city || !navTarget) return;
		const mode = city.mode;
		if (mode !== navTarget.mode) {
			// Re-plan for how you are travelling now (walking vs riding use different streets).
			return void showRoute(navTarget, mode, true);
		}
		city.followRoute((arrived) => {
			if (arrived) net?.say(`You have arrived: ${navTarget?.label ?? 'destination'}.`);
		});
	}

	function ridingId(): string | null {
		return city?.riding?.id ?? null;
	}

	/** Stop the autopilot but keep the route on screen. */
	function stopFollowing() {
		if (city?.route) city.setRoute(city.route);
	}

	function clearRoute() {
		city?.setRoute(null);
		navTarget = null;
	}

	// Guidance: re-plan when far off the route; tidy up on arrival.
	$effect(() => {
		const nav = hud?.nav;
		if (!nav || !navTarget || routing) return;
		const now = performance.now();
		if (nav.arrived) {
			if (!city?.following) setTimeout(() => navTarget && hud?.nav?.arrived && clearRoute(), 2500);
			return;
		}
		if (nav.off > 30) {
			offRouteSince ||= now;
			if (now - offRouteSince > 3000 && now - lastReroute > 6000) {
				lastReroute = now;
				void showRoute(navTarget, hud?.mode ?? navTarget.mode, city?.following);
			}
		} else offRouteSince = 0;
	});

	function shopEntrance(s: Shop) {
		const out = 2.5;
		return { x: s.unit.door_x + Math.sin(s.unit.heading) * out, z: s.unit.door_z + Math.cos(s.unit.heading) * out, label: s.name };
	}

	function guideToVehicle(v: Vehicle) {
		panel = '';
		void showRoute({ x: v.x, z: v.z, label: v.name }, 'foot', true);
	}

	function walkToShop(s: Shop) {
		panel = '';
		// To the pavement in front of the door, then two steps inside.
		const out = 2.5, inside = 1.6;
		const sin = Math.sin(s.unit.heading), cos = Math.cos(s.unit.heading);
		city?.walkTo([
			[s.unit.door_x + sin * out, s.unit.door_z + cos * out],
			[s.unit.door_x - sin * inside, s.unit.door_z - cos * inside]
		]);
	}

	function shopDistance(s: Shop) {
		return hud ? Math.hypot(s.unit.door_x - hud.x, s.unit.door_z - hud.z) : 0;
	}

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
				{insideShop ? insideShop.name : (hud.street ?? 'Off-street')}
			</p>
			{#if insideShop}<p class="truncate text-xs text-saffron-300" data-testid="hud-shop">Shop {insideShop.unit.code} · {insideShop.unit.street_name ?? ''}{insideShop.is_open ? '' : ' · closed'}</p>{/if}
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
			{#each [['people', Users, 'People (P)'], ['places', MapPin, 'Places & shops (M)'], ['garage', Bike, 'My vehicles (V)'], ['cart', ShoppingCart, 'Cart (C)'], ['settings', Settings2, 'Settings'], ['help', CircleHelp, 'Controls (Esc)']] as const as [id, Icon, label] (id)}
				<button class="relative grid h-11 w-11 place-items-center rounded-xl bg-river-950/75 text-paper shadow-lg backdrop-blur hover:bg-river-800 {panel === id ? 'ring-2 ring-saffron-500' : ''}" aria-label={label} title={label} onclick={() => (panel = panel === id ? '' : id)}>
					<Icon size={19} />
					{#if id === 'cart' && cart?.item_count}<span class="absolute -mt-7 ml-7 rounded-full bg-saffron-500 px-1.5 text-[10px] font-bold text-river-950" data-testid="cart-count">{cart.item_count}</span>{/if}
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
			<div class="absolute {hud.nav && navTarget ? 'top-24' : 'top-3'} left-1/2 flex w-[min(26rem,calc(100vw-8rem))] -translate-x-1/2 flex-col gap-2" aria-live="polite">
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

		{#if hud.mode !== 'foot'}
			<div class="pointer-events-none absolute right-3 bottom-[5.5rem] flex items-end gap-2" data-testid="hud-ride" data-mode={hud.mode} data-speed={hud.speedKmh}>
				{#if hud.wrongWay}
					<span class="flex items-center gap-1.5 rounded-full bg-brick-600 px-3 py-1.5 text-xs font-bold text-white shadow-lg" data-testid="hud-wrong-way"><TriangleAlert size={14} /> Wrong way: one-way street</span>
				{:else if hud.oneWay}
					<span class="rounded-full bg-river-950/75 px-3 py-1.5 text-[11px] font-semibold backdrop-blur">One way →</span>
				{/if}
				{#if hud.speedLimit}
					<span class="grid h-11 w-11 place-items-center rounded-full border-4 border-brick-600 bg-white text-sm font-bold text-ink shadow-lg" title="Speed limit (OSM)">{hud.speedLimit}</span>
				{/if}
				<div class="rounded-2xl bg-river-950/80 px-4 py-2 text-center shadow-xl backdrop-blur">
					<p class="font-mono text-3xl leading-none font-bold {hud.speedLimit && hud.speedKmh > hud.speedLimit + 2 ? 'text-saffron-300' : ''}">{hud.speedKmh}</p>
					<p class="mt-0.5 flex items-center justify-center gap-1 text-[10px] tracking-widest text-river-200 uppercase"><VehicleIcon kind={hud.mode} size={12} /> km/h</p>
				</div>
			</div>
		{/if}

		{#if hud.nav && navTarget}
			<div class="absolute top-3 left-1/2 z-10 w-[min(24rem,calc(100vw-8rem))] -translate-x-1/2 rounded-2xl bg-river-950/85 px-4 py-3 shadow-xl backdrop-blur" data-testid="hud-nav" data-arrived={hud.nav.arrived} data-remaining={Math.round(hud.nav.remaining)}>
				<div class="flex items-start gap-3">
					<RouteIcon size={20} class="mt-0.5 shrink-0 text-saffron-300" />
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-semibold" data-testid="hud-nav-step">{hud.nav.text}</p>
						<p class="text-xs text-river-200">
							{#if !hud.nav.arrived}in {formatDistance(hud.nav.toNext)} · {formatDistance(hud.nav.remaining)} to {navTarget.label} · {formatDuration(hud.nav.remaining / MODES[navTarget.mode].cruiseSpeed)}{:else}{navTarget.label}{/if}
						</p>
					</div>
					<div class="flex shrink-0 gap-1">
						{#if !hud.nav.arrived}
							{#if hud.nav.auto}
								<button class="grid h-8 w-8 place-items-center rounded-lg bg-white/10 hover:bg-white/20" title="Stop (or press any movement key)" aria-label="Stop" onclick={stopFollowing}><Square size={14} /></button>
							{:else}
								<button class="grid h-8 w-8 place-items-center rounded-lg bg-saffron-500 text-river-950 hover:bg-saffron-300" title={hud.mode === 'foot' ? 'Walk me there' : 'Ride me there'} aria-label="Follow the route" onclick={followRoute} data-testid="nav-follow"><Play size={14} /></button>
							{/if}
						{/if}
						<button class="grid h-8 w-8 place-items-center rounded-lg bg-white/10 hover:bg-white/20" aria-label="Clear the route" onclick={clearRoute}><X size={14} /></button>
					</div>
				</div>
			</div>
		{/if}

		{#if net && (hud.mode !== 'foot' || net.reachable)}
			<div class="absolute bottom-[11.5rem] left-1/2 -translate-x-1/2" data-testid="ride-prompt" data-kind={hud.mode !== 'foot' ? (canPark ? 'park' : 'pull_over') : 'ride'}>
				<button class="rounded-full bg-river-950/85 px-4 py-2 text-sm font-semibold shadow-lg backdrop-blur hover:bg-river-800 disabled:opacity-60" onclick={rideOrPark} disabled={net.pendingRide}>
					<kbd class="mr-2 rounded bg-saffron-500 px-1.5 font-mono text-river-950">F</kbd>
					{#if hud.mode !== 'foot'}
						{#if canPark}<CircleParking size={14} class="mr-1 inline" />Park here{:else}Pull over to the kerb to park{/if}
					{:else if net.reachable}
						Ride your {MODES[net.reachable.k].label.toLowerCase()}{net.reachable.name ? ` (${net.reachable.name})` : ''}
					{/if}
				</button>
			</div>
		{/if}

		{#if prompt || held}
			<div class="pointer-events-none absolute bottom-48 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2" data-testid="shop-prompt" data-kind={prompt?.kind ?? ''}>
				{#if held}
					<div class="flex items-center gap-3 rounded-2xl bg-paper px-3 py-2 text-ink shadow-xl" data-testid="held-product">
						{#if held.image_url}<img src={held.image_url} alt="" class="h-12 w-12 rounded-lg object-cover" />{:else}<Package size={28} class="text-ink-soft" />{/if}
						<div class="max-w-56">
							<p class="truncate text-sm font-semibold">{held.name}</p>
							<p class="text-xs text-ink-soft">{money(held.price_minor)} · {held.stock} in stock{held.min_age ? ` · ${held.min_age}+` : ''}</p>
							{#if held.description}<p class="line-clamp-2 text-[11px] text-ink-soft">{held.description}</p>{/if}
						</div>
					</div>
				{/if}
				{#if prompt}
					<p class="rounded-full bg-river-950/85 px-4 py-2 text-sm font-semibold shadow-lg backdrop-blur">
						<kbd class="mr-2 rounded bg-saffron-500 px-1.5 font-mono text-river-950">E</kbd>{prompt.label}
					</p>
				{/if}
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
			{:else if panel === 'cart'}
				<h2 class="display mb-3 text-xl font-bold">Cart</h2>
				{#if canBuy}
					<div class="h-[min(32rem,calc(100dvh-10rem))]"><CartPanel {cart} onCart={setCart} /></div>
				{:else}
					<p class="text-sm text-ink-soft">Shopping needs the buyer role.</p>
				{/if}
			{:else if panel === 'garage'}
				<h2 class="display mb-3 text-xl font-bold">My vehicles</h2>
				<div class="h-[min(32rem,calc(100dvh-10rem))]">
					<GaragePanel
						version={net?.vehiclesVersion ?? 0}
						here={hud ? { x: hud.x, z: hud.z } : null}
						riding={hud?.mode !== 'foot' ? ridingId() : null}
						online={net?.status === 'open'}
						onGuide={guideToVehicle}
						onRide={(v) => { panel = ''; net?.mount(v.id); }}
					/>
				</div>
			{:else if panel === 'shop' && browsing}
				<div class="h-[min(34rem,calc(100dvh-8rem))]"><ShopPanel shop={browsing} {canBuy} onCart={setCart} /></div>
			{:else if panel === 'places'}
				<h2 class="display text-xl font-bold">Places</h2>
				<p class="mt-1 text-xs text-ink-soft">Get directions on the real streets, or fast-travel between public spawn areas (a vehicle you ride stays parked behind).</p>
				<p class="label mt-3 flex items-center gap-1.5"><RouteIcon size={13} /> Directions by</p>
				<div class="grid grid-cols-3 gap-1 rounded-xl bg-paper-2 p-1 text-xs font-semibold" role="radiogroup" aria-label="Travel mode">
					{#each ['foot', 'bicycle', 'motorbike'] as const as m (m)}
						<button role="radio" aria-checked={navMode === m} class="rounded-lg py-1.5 {navMode === m ? 'bg-white shadow' : 'text-ink-soft'}" onclick={() => (navMode = m)} data-testid={`nav-mode-${m}`}>{m === 'foot' ? 'Walking' : MODES[m].label}</button>
					{/each}
				</div>
				<p class="hint">Vehicles keep to the right and follow one-way streets; on foot you can use footpaths and the steps of Wat Phnom.</p>
				{#if shopList.length}
					<p class="label mt-3 flex items-center gap-1.5"><Store size={13} /> Shops ({shopList.length})</p>
					<div class="grid max-h-48 gap-1.5 overflow-y-auto" data-testid="shop-directory">
						{#each [...shopList].sort((a, b) => shopDistance(a) - shopDistance(b)) as s (s.id)}
							<div class="flex items-center gap-2 rounded-xl border border-river-900/10 bg-white px-3 py-2" data-testid={`shop-row-${s.unit.code}`}>
								<span class="h-3 w-3 shrink-0 rounded-full" style="background: {s.primary_color}"></span>
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm font-semibold">{s.name}{s.is_open ? '' : ' · closed'}</span>
									<span class="block truncate text-[11px] text-ink-soft">{s.unit.street_name ?? s.unit.code} · {Math.round(shopDistance(s))} m</span>
								</span>
								<button class="btn-ghost px-2 py-1 text-xs" onclick={() => { browsing = s; panel = 'shop'; }}>Browse</button>
								<button class="btn-ghost px-2 py-1 text-xs" disabled={routing} onclick={() => showRoute(shopEntrance(s), navMode)} title="Directions" aria-label={`Directions to ${s.name}`}><RouteIcon size={13} /></button>
								<button class="btn-primary px-2 py-1 text-xs" onclick={() => walkToShop(s)} disabled={shopDistance(s) > 160} title={shopDistance(s) > 160 ? 'Fast-travel closer first' : 'Walk there'}>Walk</button>
							</div>
						{/each}
					</div>
					<p class="label mt-3">Spawn areas</p>
				{/if}
				<div class="mt-3 grid gap-2">
					{#each places as p (p.id)}
						<div class="flex items-center gap-2 rounded-xl border border-river-900/10 bg-white px-3 py-2" data-testid={`place-${p.slug}`}>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm font-semibold">{p.name}</span>
								{#if p.name_km}<span class="khmer block truncate text-xs text-ink-soft" lang="km">{p.name_km}</span>{/if}
							</span>
							<button class="btn-ghost px-2 py-1 text-xs" disabled={routing} onclick={() => showRoute({ x: p.x, z: p.z, label: p.name }, navMode)} data-testid="place-route"><RouteIcon size={13} class="inline" /> Route</button>
							<button class="btn-primary px-2 py-1 text-xs" onclick={() => travel(p)}>Go</button>
						</div>
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
				<p class="label mt-4">Shopping</p>
				<div class="grid grid-cols-2 gap-2">
					<a class="btn-ghost" href="/orders" data-sveltekit-reload>My orders</a>
					<a class="btn-ghost" href="/seller" data-sveltekit-reload>{isSeller ? 'Seller dashboard' : 'Sell here'}</a>
				</div>
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
					<dt class="font-mono font-semibold">E</dt><dd>In a shop: pick up, put in the cart, pay at the counter</dd>
					<dt class="font-mono font-semibold">C</dt><dd>Cart and demo checkout</dd>
					<dt class="font-mono font-semibold">V</dt><dd>My vehicles: get a bicycle or motorbike, find it, bring it</dd>
					<dt class="font-mono font-semibold">F</dt><dd>Ride your vehicle when next to it · park it (at the kerb, a car park or an alley)</dd>
					<dt class="font-mono font-semibold">Riding</dt><dd>W throttle · S brake / reverse · A D steer · keep right</dd>
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

<script lang="ts">
	import { onMount, untrack, tick } from 'svelte';
	import { goto, replaceState } from '$app/navigation';
	import {
		Compass, MapPin, Navigation, Settings2, CircleHelp, LogOut, X, Gauge, Users, Landmark,
		ChevronUp, ChevronDown, ArrowBigUp, ChevronLeft, ChevronRight, Footprints, Wifi, WifiOff,
		ShoppingCart, ShoppingBasket, Store, Package, Bike, Route as RouteIcon, CircleParking, TriangleAlert, Play, Square,
		Menu, MessageCircle, WalletCards, Truck, Maximize2, Minimize2, Shirt
	} from 'lucide-svelte';
	import ChatBox from '$lib/components/world/ChatBox.svelte';
	import PeoplePanel from '$lib/components/world/PeoplePanel.svelte';
	import ShopPanel from '$lib/components/world/ShopPanel.svelte';
	import CartPanel from '$lib/components/world/CartPanel.svelte';
	import GaragePanel from '$lib/components/world/GaragePanel.svelte';
	import DriverPanel from '$lib/components/world/DriverPanel.svelte';
	import WalletPanel from '$lib/components/world/WalletPanel.svelte';
	import Wardrobe from '$lib/components/world/Wardrobe.svelte';
	import SystemOffice from '$lib/components/world/SystemOffice.svelte';
	import CounterPanel from '$lib/components/world/CounterPanel.svelte';
	import MyShop from '$lib/components/myshop/MyShop.svelte';
	import type { Here } from '$lib/components/myshop/types';
	import { SYSTEM_OFFICE_DOOR, SYSTEM_OFFICE_ID } from '$lib/game/buildings/placements';
	import VehicleIcon from '$lib/components/world/VehicleIcon.svelte';
	import { transport, type Vehicle } from '$lib/api/transport';
	import { formatDistance, formatDuration } from '$lib/game/vehicles/route';
	import { MODES, type TravelMode } from '$lib/game/vehicles/specs';
	import { market, money, shopping, type Cart, type Shop } from '$lib/api/market';
	import type { Basket, Interaction, Storefronts } from '$lib/game/shop/Storefronts';
	import type { BuildingInteraction, Buildings, Inspection } from '$lib/game/buildings/Buildings';
	import type { WorldSession } from '$lib/game/net/WorldSession.svelte';
	import type { EmoteName } from '$lib/game/net/protocol';
	import { geo, me } from '$lib/api/endpoints';
	import type { Avatar, SpawnPoint } from '$lib/api/types';
	import { compassLabel } from '$lib/geo/projection';
	import type { CityController, CityState, Quality, TimeMode } from '$lib/game/city/CityEngine';
	import { session } from '$lib/stores/session.svelte';

	let { data } = $props();
	const boot = untrack(() => data.boot); // the page is rebuilt on navigation
	const preferKhmer = session.user?.preferred_language === 'km';

	let host: HTMLDivElement;
	let worldShell: HTMLDivElement;
	let minimap = $state<HTMLCanvasElement>();
	let city: CityController | null = null;
	let hud = $state<CityState | null>(null);
	let progress = $state({ loaded: 0, total: 1 });
	let ready = $state(false);
	let failure = $state('');
	let panel = $state<'' | 'places' | 'settings' | 'help' | 'people' | 'cart' | 'shop' | 'garage' | 'menu' | 'driver' | 'wallet'>('');
	let compact = $state(false);
	let chatOpen = $state(false);
	let mapExpanded = $state(false);
	const isDriver = $derived(!!session.user?.active_roles.includes('driver'));
	const labels = preferKhmer
		? { people: 'អ្នកលេង', places: 'ទីកន្លែង', garage: 'យានជំនិះ', cart: 'កន្ត្រក', more: 'បន្ថែម', chat: 'ជជែក' }
		: { people: 'People', places: 'Places & shops', garage: 'My vehicles', cart: 'Cart', more: 'More', chat: 'Chat' };
	// Transport (Phase 5)
	let navTarget = $state<{ x: number; z: number; label: string; mode: TravelMode } | null>(null);
	let navMode = $state<TravelMode>('foot');
	let routing = $state(false);
	let canPark = $state(false);
	let offRouteSince = 0;
	let lastReroute = 0;
	// Shopping (Phase 4)
	let shops: Storefronts | null = null;
	let houses: Buildings | null = null;
	let housePrompt = $state<BuildingInteraction | null>(null);
	let inspection = $state<Inspection | null>(null);
	let shopList = $state<Shop[]>([]);
	let prompt = $state<Interaction | null>(null);
	/** What the player picked in the shop they stand in (carried in a basket). */
	let basket = $state<Basket | null>(null);
	/** The shop whose counter is open, and its shopkeeper's name (if one stands there). */
	let counterShop = $state<Shop | null>(null);
	let counterKeeper = $state<string | null>(null);
	function keeperSay(text: string, gesture?: 'talk' | 'thanks') {
		if (counterShop) shops?.keeperSay(counterShop.id, text, gesture);
	}
	let cart = $state<Cart | null>(null);
	let browsing = $state<Shop | null>(null);
	let insideShop = $state<Shop | null>(null);
	const canBuy = $derived(!!session.user?.active_roles.includes('buyer'));
	/** Registered as a seller (approved or waiting): "My shop" is in the toolbar. */
	const isSeller = $derived(!!session.user?.roles.some((r) => r.role === 'seller' && (r.status === 'active' || r.status === 'pending')));
	const region = boot.spawn.region;
	let net = $state<WorldSession | null>(null);
	let chatInput = $state<HTMLInputElement>();
	const EMOTE_BUTTONS: [EmoteName, string][] = [['wave', 'Wave'], ['sampeah', 'Sampeah'], ['cheer', 'Cheer'], ['dance', 'Dance']];
	const EMOTE_FACES: Record<EmoteName, string> = { wave: '👋', sampeah: '🙏', cheer: '🎉', dance: '💃' };
	/** 100 m on the minimap, as a share of its width (170 px drawn at 1.6 m per px). */
	const MAP_SCALE = `${(100 / 1.6 / 170) * 100}%`;
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
	$effect(() => {
		const paused = (panel !== '' && panel !== 'people' && panel !== 'garage') || (compact && chatOpen);
		if (ready) city?.setPaused(paused);
	});

	onMount(() => {
		touch = matchMedia('(pointer: coarse)').matches;
		const viewport = matchMedia('(max-width: 900px), (max-height: 540px)');
		const updateViewport = () => { compact = viewport.matches; };
		updateViewport();
		viewport.addEventListener('change', updateViewport);
		const fitViewport = () => {
			worldShell.style.height = `${window.visualViewport?.height ?? window.innerHeight}px`;
			worldShell.style.top = `${window.visualViewport?.offsetTop ?? 0}px`;
		};
		fitViewport();
		window.visualViewport?.addEventListener('resize', fitViewport);
		window.visualViewport?.addEventListener('scroll', fitViewport);
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
				quality = created.quality; // 'low' on touch devices and without a GPU
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
					camera: created.camera,
					setHolding: (h) => created.setHolding(h),
					onInteraction: (i) => (prompt = i),
					onBasket: (b) => (basket = b)
				});
				shops.keeperLimit = created.quality === 'low' ? 1 : 2;
				(globalThis as { __ppwShops?: unknown }).__ppwShops = shops;
				const [{ Buildings }, { ENTERABLE, AUTO_ENTERABLE }] = await Promise.all([import('$lib/game/buildings/Buildings'), import('$lib/game/buildings/placements')]);
				if (disposed) return;
				houses = new Buildings(created, (i) => (housePrompt = i), undefined, (x) => (inspection = x), {
					payloads: () => created.chunkData(),
					list: ENTERABLE,
					auto: AUTO_ENTERABLE,
					// Buildings with a walk-in shop already have an interior.
					claimed: () => shops?.list.map((s) => [s.unit.door_x, s.unit.door_z] as [number, number]) ?? []
				});
				net.remotes.groundAt = (x, z, storey) => houses?.floorAt(x, z, storey) ?? null; // others stand on their floor too
				// Doors, windows, lights and appliances are shared with the players around, and
				// they see which storey this player is on.
				const sync = net;
				houses.onChange = (b, kind, id, on) => sync.buildings.set(b, kind, id, on);
				houses.onLoaded = (b) => sync.buildings.ask(b);
				sync.onBuildingState = (b, state, keep) => houses?.applyShared(b, state, keep);
				sync.onOpen = () => {
					for (const id of houses?.loadedIds ?? []) sync.buildings.ask(id);
				};
				sync.storey = () => houses?.storeyOn ?? 0;
				(globalThis as { __ppwBuildings?: unknown }).__ppwBuildings = houses; // e2e inspection
				// The System Office's counter: register a work role.
				houses.onService = (_building, service) => {
					if (service === 'roles') openOffice();
				};
				// The first visit: no avatar chosen yet, so the wardrobe opens to make one.
				if (session.user?.onboarding.avatar === false) openWardrobe(true);
				// /world?panel=shop (the old seller dashboard's address) opens My shop.
				else if (new URL(location.href).searchParams.get('panel') === 'shop' && isSeller) {
					openMyShop();
					replaceState('/world', {});
				}
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
						if (housePrompt) housePrompt = null;
						shops?.stow(true); // the basket or bag waits until walking again
						shops?.animateKeepers(dt, me.x, me.z);
						return; // no shopping from the saddle
					}
					shops?.stow(false);
					houses?.update(dt, me.x, me.z, me.yaw);
					if (office && houses?.insideOf !== `osm:${SYSTEM_OFFICE_ID}`) office = false; // walked out
					const named = houses?.insideName ?? null;
					if (named !== insideBuilding) insideBuilding = named;
					shops?.update(me.x, me.z, me.yaw, dt);
					const here = shops?.shopAt(me.x, me.z) ?? null;
					if (here?.id !== insideShop?.id) insideShop = here;
					if (counterShop && shops?.shopAt(me.x, me.z, 0.5)?.id !== counterShop.id) counterShop = null; // walked out
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
			if (wardrobe || office || counterShop) return; // they have their own keys (Escape closes them)
			if (myShop) {
				// Walking still works (the city reads its own keys); B or Escape (in the panel) closes it.
				if (!typing && e.key.toLowerCase() === 'b') myShop = false;
				return;
			}
			if (!typing && e.key.toLowerCase() === 'b' && isSeller && !panel) return openMyShop();
			if (!typing && e.key.toLowerCase() === 'o' && !panel) return openWardrobe();
			if (e.key === 'Escape' && !typing && inspection) return houses?.closeInspection();
			if (e.key === 'Escape' && !typing) panel = panel ? '' : 'help';
			if (typing) return;
			if (e.key.toLowerCase() === 'm') panel = panel === 'places' ? '' : 'places';
			if (e.key.toLowerCase() === 'v') panel = panel === 'garage' ? '' : 'garage';
			if (e.key.toLowerCase() === 'f' && !panel) rideOrPark();
			if (e.key.toLowerCase() === 'e' && !panel) {
				if (housePrompt || inspection) houses?.interact();
				else void interact();
			}
			if (e.key.toLowerCase() === 'c') panel = panel === 'cart' ? '' : 'cart';
			if (e.key.toLowerCase() === 'p') panel = panel === 'people' ? '' : 'people';
			if (e.key === 'Enter') {
				e.preventDefault();
				chatOpen = true;
				void tick().then(() => chatInput?.focus());
			}
			const emote = EMOTE_BUTTONS[Number(e.key) - 1];
			if (emote && net) net.emote(emote[0]);
		};
		window.addEventListener('keydown', onKey);
		return () => {
			disposed = true;
			clearInterval(timer);
			window.removeEventListener('keydown', onKey);
			viewport.removeEventListener('change', updateViewport);
			window.visualViewport?.removeEventListener('resize', fitViewport);
			window.visualViewport?.removeEventListener('scroll', fitViewport);
			net?.stop();
			net = null;
			shops?.dispose();
			shops = null;
			houses?.dispose();
			houses = null;
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

	/** E: the action the prompt shows (into the basket, the counter, browse the shop). */
	async function interact() {
		const i = shops?.interaction;
		if (!i || !shops) return;
		if (i.kind === 'browse') {
			browsing = i.shop;
			panel = 'shop';
		} else if (i.kind === 'take') {
			if (!i.shop.is_open) return net?.say(`${i.shop.name} is closed.`);
			if (!i.product.in_stock) return net?.say(`${i.product.name} is sold out.`);
			if (!canBuy) return net?.say('Choose the buyer role to shop.', 'warning');
			try {
				setCart(await shopping.add(i.product.id, 1, i.shop.id));
				const b = shops.basket;
				net?.say(`${i.product.name} is in your basket${b?.count ? ` (${b.count} item${b.count === 1 ? '' : 's'}, ${money(b.total_minor)})` : ''}.`);
			} catch (e) {
				net?.say(e instanceof Error ? e.message : 'Could not put it in the basket.', 'warning');
			}
		} else if (i.kind === 'counter') {
			panel = '';
			chatOpen = false;
			counterKeeper = shops.keeper(i.shop.id)?.name ?? null;
			counterShop = i.shop;
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
		if (shops) shops.keeperLimit = q === 'low' ? 1 : 2; // shopkeepers: one at a time on low
	}

	// ── System Office ────────────────────────────────────────────────────────────────
	let office = $state(false);
	/** The named building the player is in (shown instead of the street). */
	let insideBuilding = $state<string | null>(null);
	function openOffice() {
		panel = '';
		chatOpen = false;
		office = true;
		void session.refresh(); // how the registration stands now
	}
	const toOffice = () => showRoute(SYSTEM_OFFICE_DOOR, navMode);

	// ── My shop (sellers) ────────────────────────────────────────────────────────────
	let myShop = $state(false);
	function openMyShop() {
		if (wardrobe) return;
		panel = '';
		chatOpen = false;
		office = false;
		myShop = true;
	}
	/** Where the player stands, for the spots near them. */
	function here(): Here | null {
		if (!city) return null;
		const me = city.localState();
		const projection = city.projection;
		const { lat, lon } = projection.toLatLon(me.x, me.z);
		return { x: me.x, z: me.z, lat, lon, toWorld: (la, lo) => projection.toWorld(la, lo) };
	}

	// ── wardrobe ─────────────────────────────────────────────────────────────────────
	let wardrobe = $state(false);
	/** What the player wore when the wardrobe opened. */
	let wardrobeOutfit = $state<Avatar | null>(null);
	/** The first visit: the avatar is made here (no Cancel; saving enters the city). */
	let wardrobeFirst = $state(false);
	/** Room for the glass panel: beside the avatar on a wide screen, below it on a narrow one. */
	const showcaseView = () => (window.innerWidth >= 900 ? { right: 0.75 } : { down: 1.2, distance: 4.3, pitch: 0.28 });
	function openWardrobe(first = false) {
		if (!city || city.riding || wardrobe) return;
		wardrobeFirst = first;
		panel = '';
		chatOpen = false;
		wardrobeOutfit = city.outfit;
		wardrobe = true;
		city.setShowcase(showcaseView());
		if (net) net.remotes.hideTags = true;
	}
	function closeWardrobe() {
		wardrobe = false;
		city?.setShowcase(null);
		if (net) net.remotes.hideTags = false;
	}
	/** Wear it now (a carried basket or bag moves to the new model's hand if it was rebuilt). */
	async function wearOutfit(next: Avatar) {
		await city?.setAvatar(next);
		shops?.rebindAvatar();
	}
	function previewOutfit(next: Avatar) {
		void wearOutfit(next);
	}
	async function saveOutfit(next: Avatar) {
		await me.saveAvatar(next);
		await wearOutfit(next);
		if (wardrobeFirst) await session.refresh(); // the avatar is made: no welcome next time
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
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
			city?.setKey(key, true);
		},
		onpointerup: () => city?.setKey(key, false),
		onpointerleave: () => city?.setKey(key, false),
		onpointercancel: () => city?.setKey(key, false)
	});

	function dialogFocus(node: HTMLElement, _name: string) {
		const previous = document.activeElement as HTMLElement | null;
		const focus = () => void tick().then(() => node.querySelector<HTMLElement>('button, a, input, select')?.focus());
		focus();
		const keydown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); panel = ''; }
			if (event.key !== 'Tab') return;
			const items = [...node.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((item) => item.getClientRects().length);
			const first = items[0], last = items.at(-1);
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
		};
		node.addEventListener('keydown', keydown);
		return { update: focus, destroy() { node.removeEventListener('keydown', keydown); previous?.focus(); } };
	}
</script>

<svelte:head><title>Daun Penh · Phnom Penh Digital World</title></svelte:head>

<div bind:this={worldShell} class="world-shell fixed inset-0 overflow-hidden bg-river-950 text-paper select-none" class:compact class:wardrobe-open={wardrobe} class:office-open={office || !!counterShop} class:myshop-open={myShop} data-panel-open={!!panel} data-chat-open={chatOpen}>
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
		<div class="world-location hud-glass pointer-events-none absolute top-3 left-3 max-w-[min(19rem,calc(100vw-7rem))] rounded-xl px-3 py-2" data-testid="hud-location">
			<p class="flex items-center gap-2 text-[10px] font-bold tracking-widest text-saffron-300 uppercase">
				<Navigation size={12} style="transform: rotate({hud.heading}deg)" /> {compassLabel(hud.heading)} · Daun Penh
				<span class="ml-auto font-mono normal-case tracking-normal text-river-200" data-testid="hud-clock" title={hud.timeMode === 'live' ? 'Phnom Penh time (live sun)' : 'Fixed time of day'}>{hud.clock}{hud.timeMode === 'live' ? '' : ' ·'}</span>
			</p>
			<p class="hud-street mt-0.5 truncate font-display text-base leading-tight" data-testid="hud-street" title={insideShop?.name ?? insideBuilding ?? hud.street ?? 'Off-street'}>
				{insideShop ? insideShop.name : (insideBuilding ?? hud.street ?? 'Off-street')}
			</p>
			{#if insideShop}<p class="truncate text-xs text-saffron-300" data-testid="hud-shop">Shop {insideShop.unit.code} · {insideShop.unit.street_name ?? ''}{insideShop.is_open ? '' : ' · closed'}</p>{/if}
			{#if hud.streetAlt}<p class="khmer truncate text-xs text-river-200" lang={preferKhmer ? 'en' : 'km'}>{hud.streetAlt}</p>{/if}
			{#if hud.landmark}
				<p class="location-detail mt-1 flex items-center gap-1.5 truncate text-xs text-river-200"><Landmark size={12} /> Near {hud.landmark}</p>
			{/if}
			<p class="location-detail mt-1 font-mono text-[10px] text-river-200/80" data-testid="hud-coords">
				{hud.lat.toFixed(5)}, {hud.lon.toFixed(5)} · x {hud.x.toFixed(0)} z {hud.z.toFixed(0)}
			</p>
		</div>

		<!-- Toolbar -->
		<nav class="world-toolbar absolute top-3 right-3 flex flex-col gap-2" aria-label="World controls">
			{#each [['people', Users, 'People (P)'], ['places', MapPin, 'Places & shops (M)'], ['garage', Bike, 'My vehicles (V)'], ['cart', ShoppingCart, 'Cart (C)'], ['settings', Settings2, 'Settings'], ['help', CircleHelp, 'Controls (Esc)']] as const as [id, Icon, label] (id)}
				<button class="relative grid h-11 w-11 place-items-center rounded-xl bg-river-950/75 text-paper shadow-lg backdrop-blur hover:bg-river-800 {id === 'settings' || id === 'help' ? 'secondary-control' : ''} {panel === id ? 'ring-2 ring-saffron-500' : ''}" aria-label={preferKhmer && id in labels ? labels[id as keyof typeof labels] : label} aria-expanded={panel === id} title={id in labels ? labels[id as keyof typeof labels] : label} onclick={() => (panel = panel === id ? '' : id)}>
					<Icon size={19} />
					{#if id === 'cart' && cart?.item_count}<span class="absolute -mt-7 ml-7 rounded-full bg-saffron-500 px-1.5 text-[10px] font-bold text-river-950" data-testid="cart-count">{cart.item_count}</span>{/if}
				</button>
			{/each}
			<button class="grid h-11 w-11 place-items-center rounded-xl bg-river-950/75 text-paper shadow-lg backdrop-blur hover:bg-river-800" aria-label="Wardrobe (O)" title="Wardrobe (O)" data-testid="open-wardrobe" onclick={() => openWardrobe()}><Shirt size={19} /></button>
			{#if isSeller}<button class="grid h-11 w-11 place-items-center rounded-xl bg-river-950/75 text-paper shadow-lg backdrop-blur hover:bg-river-800" aria-label="My shop (B)" title="My shop (B)" data-testid="open-my-shop" onclick={openMyShop}><Store size={19} /></button>{/if}
			<button class="grid h-11 w-11 place-items-center rounded-xl bg-river-950/75 text-paper shadow-lg backdrop-blur hover:bg-river-800" aria-label="More controls" aria-expanded={panel === 'menu'} title={labels.more} onclick={() => panel = panel === 'menu' ? '' : 'menu'}><Menu size={19} /></button>
		</nav>

		{#snippet greetings()}
			<div class="greetings pointer-events-auto" role="group" aria-label="Greetings (keys 1–4)">
				{#each EMOTE_BUTTONS as [id, label], i (id)}
					<button class="greeting" onclick={() => net?.emote(id)} aria-keyshortcuts={String(i + 1)} data-testid={`emote-${id}`}>
						<span class="greeting-face" aria-hidden="true">{EMOTE_FACES[id]}</span>
						<kbd aria-hidden="true">{i + 1}</kbd>
						<span class="greeting-name">{label}</span>
					</button>
				{/each}
			</div>
		{/snippet}

		<!-- Minimap: a small round glass map, north up. -->
		<div class="world-minimap absolute" class:expanded={mapExpanded}>
			<div class="minimap-disc">
				<canvas bind:this={minimap} width="170" height="170" aria-label="Minimap"></canvas>
				<span class="minimap-north" aria-hidden="true">N</span>
				<span class="minimap-scale" style:width={MAP_SCALE}>100 m</span>
			</div>
			<button class="map-toggle absolute -top-1 -right-1 h-7 w-7 place-items-center rounded-full bg-river-950/85 text-paper shadow-lg" aria-label={mapExpanded ? 'Shrink minimap' : 'Expand minimap'} aria-expanded={mapExpanded} onclick={() => mapExpanded = !mapExpanded}>{#if mapExpanded}<Minimize2 size={13} />{:else}<Maximize2 size={13} />{/if}</button>
		</div>

		<!-- Status -->
		<div class="world-status pointer-events-none absolute flex items-center gap-1.5 text-[11px]">
			{#if net}
				<span class="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 {net.status === 'open' ? 'hud-glass' : 'bg-brick-600/85 backdrop-blur'}" data-testid="hud-net" data-status={net.status}>
					{#if net.status === 'open'}
						<Wifi size={12} /> <span data-testid="hud-online">{net.online}</span>&nbsp;online · {net.nearby.length} nearby{#if net.rtt} · {net.rtt} ms{/if}
					{:else}
						<WifiOff size={12} /> {net.detail || (net.status === 'connecting' ? 'Connecting…' : 'Offline')}
					{/if}
				</span>
			{/if}
			<span class="performance-status hud-glass flex items-center gap-1.5 rounded-full px-2.5 py-0.5" data-testid="hud-perf"><Gauge size={12} /> {hud.fps} fps · {hud.chunks} chunks{hud.pending ? ` (+${hud.pending})` : ''}</span>
		</div>

		{#if net}
			{#if compact}<button class="chat-toggle absolute grid h-11 w-11 place-items-center rounded-full bg-river-950/85 shadow-lg" aria-label={chatOpen ? 'Close chat' : 'Open chat'} aria-expanded={chatOpen} onclick={() => chatOpen = !chatOpen}>{#if chatOpen}<X size={20} />{:else}<MessageCircle size={20} />{/if}</button>{/if}
			{#if !compact || chatOpen}
			<div class="world-chat pointer-events-none absolute flex flex-col gap-2">
				{#if compact}{@render greetings()}{/if}
				<ChatBox session={net} bind:input={chatInput} />
			</div>
			{/if}
			{#if !compact}<div class="world-greetings absolute">{@render greetings()}</div>{/if}
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
			<div class="world-speed pointer-events-none absolute right-3 bottom-32 flex items-end gap-2" data-testid="hud-ride" data-mode={hud.mode} data-speed={hud.speedKmh}>
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
			<div class="world-guidance absolute top-3 left-1/2 z-10 w-[min(24rem,calc(100vw-8rem))] -translate-x-1/2 rounded-2xl bg-river-950/85 px-4 py-3 shadow-xl backdrop-blur" data-testid="hud-nav" data-arrived={hud.nav.arrived} data-remaining={Math.round(hud.nav.remaining)}>
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
			<div class="world-action absolute bottom-[11.5rem] left-1/2 -translate-x-1/2" data-testid="ride-prompt" data-kind={hud.mode !== 'foot' ? (canPark ? 'park' : 'pull_over') : 'ride'}>
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

		{#if inspection}
			<div class="world-action pointer-events-none absolute bottom-64 left-1/2 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl bg-paper px-4 py-3 text-ink shadow-xl" data-testid="inspect-card">
				<p class="display text-base font-bold">{inspection.title}</p>
				<p class="mt-1 text-sm text-ink-soft">{inspection.text}</p>
			</div>
		{/if}
		{#if housePrompt}
			<div class="world-action absolute bottom-48 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5" data-testid="house-prompt" data-kind={housePrompt.kind}>
				<button class="rounded-full bg-river-950/85 px-4 py-2 text-sm font-semibold shadow-lg backdrop-blur" onclick={() => houses?.interact()}>
					Press <kbd class="mx-1 rounded bg-saffron-500 px-1.5 font-mono text-river-950">E</kbd> to {housePrompt.label}
				</button>
				{#if housePrompt.kind === 'door' && housePrompt.hint}
					<button class="rounded-full bg-river-950/70 px-3 py-1 text-xs font-semibold shadow backdrop-blur" data-testid="house-hint" onclick={() => houses?.climbThrough()}>
						<kbd class="mr-1 rounded bg-saffron-500 px-1.5 font-mono text-river-950">Space</kbd>{housePrompt.hint.replace(/^Space /, '')}
					</button>
				{/if}
			</div>
		{:else if prompt || basket?.count}
			<div class="world-action pointer-events-none absolute bottom-48 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2" data-testid="shop-prompt" data-kind={prompt?.kind ?? ''}>
				{#if basket?.count}
					<div class="basket-chip" data-testid="basket" data-count={basket.count}>
						<ShoppingBasket size={16} />
						<span>Basket · {basket.count} item{basket.count === 1 ? '' : 's'} · {money(basket.total_minor)}</span>
						{#if prompt?.kind !== 'counter'}<span class="muted">Pay at the counter</span>{/if}
					</div>
				{/if}
				{#if prompt}
					<button class="pointer-events-auto rounded-full bg-river-950/85 px-4 py-2 text-sm font-semibold shadow-lg backdrop-blur" onclick={interact}>
						<kbd class="mr-2 rounded bg-saffron-500 px-1.5 font-mono text-river-950">E</kbd>{prompt.label}
					</button>
				{/if}
			</div>
		{/if}

		{#if hud.nearEdge}
			<p class="world-alert pointer-events-none absolute top-24 left-1/2 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 text-center text-sm font-semibold text-paper" data-testid="edge-alert" role="status">
				Edge of the mapped neighbourhood — more of Phnom Penh is coming
			</p>
		{/if}

		<p class="world-attribution absolute right-0 bottom-0 left-0 bg-gradient-to-t from-river-950/80 to-transparent px-3 pt-4 pb-1.5 text-center text-[10px] text-river-200">
			<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener" class="underline">© OpenStreetMap contributors (ODbL)</a><span class="attribution-detail"> · Geometry from OSM; heights, colours and trees are partly estimated · Not a live replica of Phnom Penh</span>
		</p>

		{#if touch && !panel && !(compact && chatOpen)}
			<div class="world-touch absolute right-4 bottom-44 grid grid-cols-3 gap-1.5" data-testid="touch-controls">
				<span></span><button class="pad" aria-label="Forward" {...pad('w')}><ChevronUp /></button><span></span>
				<button class="pad" aria-label="Left" {...pad('a')}><ChevronLeft /></button>
				<button class="pad" aria-label="Sprint" {...pad('shift')}><Footprints size={18} /></button>
				<button class="pad" aria-label="Right" {...pad('d')}><ChevronRight /></button>
				<span></span><button class="pad" aria-label="Back" {...pad('s')}><ChevronDown /></button><button class="pad" aria-label="Jump" {...pad(' ')}><ArrowBigUp size={18} /></button>
			</div>
		{/if}
	{/if}

	{#if office}
		<SystemOffice solid={quality === 'low'} onClose={() => (office = false)} onMyShop={openMyShop} />
	{/if}

	{#if counterShop}
		<CounterPanel
			shop={counterShop}
			{cart}
			keeper={counterKeeper}
			onSay={keeperSay}
			solid={quality === 'low'}
			onCart={setCart}
			onPaid={() => counterShop && shops?.handOver(counterShop)}
			onClose={() => (counterShop = null)}
		/>
	{/if}

	{#if myShop}
		<MyShop
			{here}
			ordersVersion={net?.ordersVersion ?? 0}
			solid={quality === 'low'}
			onRoute={(target) => {
				myShop = false;
				void showRoute(target, navMode);
			}}
			onClose={() => (myShop = false)}
		/>
	{/if}

	{#if wardrobe && wardrobeOutfit}
		<Wardrobe
			outfit={wardrobeOutfit}
			first={wardrobeFirst}
			solid={quality === 'low'}
			onPreview={previewOutfit}
			onSave={saveOutfit}
			onClose={closeWardrobe}
		/>
	{/if}

	{#if panel}
		<button class="world-backdrop" aria-label="Dismiss overlay" tabindex="-1" onclick={() => panel = ''}></button>
		<div use:dialogFocus={panel} class="world-panel glass-sheet absolute top-3 right-17 {panel === 'people' ? 'w-[min(27rem,calc(100vw-5.5rem))]' : 'w-[min(22rem,calc(100vw-5.5rem))]'} rounded-3xl p-5" class:solid={quality === 'low'} role="dialog" aria-modal="true" aria-label={panel} tabindex="-1">
			<button class="absolute top-3 right-3 rounded-lg p-1 text-ink-soft hover:bg-paper-2" aria-label="Close" onclick={() => (panel = '')}><X size={18} /></button>
			{#if panel === 'menu'}
				<h2 class="display mb-4 text-xl font-bold">Your city</h2>
				<div class="grid gap-2">
					<button class="btn-ghost justify-start" onclick={() => panel = 'wallet'}><WalletCards size={18} />Demo wallet</button>
					{#if isDriver}<button class="btn-ghost justify-start" onclick={() => panel = 'driver'}><Truck size={18} />Delivery jobs</button>{/if}
					<a class="btn-ghost justify-start" href="/orders"><Package size={18} />My orders</a>
					{#if isSeller}<button class="btn-ghost justify-start" onclick={openMyShop} data-testid="menu-my-shop"><Store size={18} />My shop (B)</button>
					{:else}<button class="btn-ghost justify-start" onclick={toOffice}><Store size={18} />Sell or deliver: the System Office</button>{/if}
					{#if session.user?.active_roles.includes('admin')}<a class="btn-ghost justify-start" href="/admin"><Users size={18} />Administration</a>{/if}
					<button class="btn-ghost justify-start" onclick={() => panel = 'settings'}><Settings2 size={18} />Settings</button>
					<button class="btn-ghost justify-start" onclick={() => panel = 'help'}><CircleHelp size={18} />Controls & map information</button>
					<button class="btn-quiet justify-start text-brick-600" onclick={signOut}><LogOut size={18} />Sign out</button>
				</div>
			{:else if panel === 'wallet'}
				<h2 class="display mb-4 text-xl font-bold">Demo wallet</h2><WalletPanel />
			{:else if panel === 'driver'}
				<h2 class="display mb-4 text-xl font-bold">Delivery jobs</h2>
				<DriverPanel onGuide={(point) => showRoute(point, city?.mode ?? 'foot')} />
			{:else if panel === 'people' && net}
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
					<div class="grid max-h-48 grid-cols-1 gap-1.5 overflow-y-auto" data-testid="shop-directory">
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
				<div class="mt-3 flex items-center gap-2 rounded-xl border border-saffron-500/50 bg-saffron-100 px-3 py-2" data-testid="place-system-office">
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-semibold">System Office</span>
						<span class="block truncate text-xs text-ink-soft">Register a work role: seller or driver · by Phsar Thmei</span>
					</span>
					<button class="btn-primary px-2 py-1 text-xs" disabled={routing} onclick={toOffice}><RouteIcon size={13} class="inline" /> Route</button>
				</div>
				<div class="mt-3 grid grid-cols-1 gap-2">
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
				<p class="hint">{hud?.fps ?? 0} fps · {hud?.chunks ?? 0} loaded chunks · {net?.rtt ?? '—'} ms latency</p>
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
					{#if isSeller}<button class="btn-ghost" onclick={openMyShop}>My shop</button>{:else}<button class="btn-ghost" onclick={toOffice}>Sell or deliver</button>{/if}
				</div>
				<p class="label mt-4">Avatar</p>
				<button class="btn-ghost w-full" onclick={() => openWardrobe()}>Change your outfit (O)</button>
				<p class="label mt-4">Visibility</p>
				<p class="text-sm">{boot.player.world_visible ? 'Visible to other players' : 'Hidden from other players'}</p>
			{:else}
				<h2 class="display text-xl font-bold">Controls</h2>
				<dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
					<dt class="font-mono font-semibold">W A S D</dt><dd>Move: jog, easing from a walk (arrow keys work too)</dd>
					<dt class="font-mono font-semibold">Shift</dt><dd>Sprint</dd>
					<dt class="font-mono font-semibold">Space</dt><dd>Jump</dd>
					<dt class="font-mono font-semibold">Drag</dt><dd>Orbit the camera</dd>
					<dt class="font-mono font-semibold">Wheel</dt><dd>Zoom</dd>
					<dt class="font-mono font-semibold">M</dt><dd>Places / fast travel</dd>
					<dt class="font-mono font-semibold">P</dt><dd>People: friends, messages, blocking</dd>
					<dt class="font-mono font-semibold">Enter</dt><dd>Chat (Tab: nearby ↔ world)</dd>
					<dt class="font-mono font-semibold">1 – 4</dt><dd>Wave · Sampeah · Cheer · Dance</dd>
					<dt class="font-mono font-semibold">E</dt><dd>In a shop: at a shelf, into your basket · at the counter, pay (it's yours at once) or collect an order · in the house: doors, light switches, the TV and stove, sit down, look at things</dd>
					<dt class="font-mono font-semibold">C</dt><dd>Cart and demo checkout</dd>
					<dt class="font-mono font-semibold">V</dt><dd>My vehicles: get a bicycle or motorbike, find it, bring it</dd>
					<dt class="font-mono font-semibold">F</dt><dd>Ride your vehicle when next to it · park it (at the kerb, a car park or an alley)</dd>
					<dt class="font-mono font-semibold">O</dt><dd>Wardrobe: change your outfit</dd>
					{#if isSeller}<dt class="font-mono font-semibold">B</dt><dd>My shop: orders, products, your spot, the shop's look</dd>{/if}
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
	.world-shell {
		height: 100dvh;
		--hud-top: max(12px, env(safe-area-inset-top));
		--hud-left: max(12px, env(safe-area-inset-left));
		--hud-right: max(12px, env(safe-area-inset-right));
		--hud-bottom: max(24px, calc(env(safe-area-inset-bottom) + 16px));
	}
	.world-location { top: var(--hud-top); left: var(--hud-left); }
	.world-toolbar { top: var(--hud-top); right: var(--hud-right); }
	.world-panel { z-index: 40; max-height: calc(100dvh - var(--hud-top) - var(--hud-bottom)); overflow-y: auto; overscroll-behavior: contain; }
	/* Clicking the city closes a panel; it stays undimmed behind the glass. */
	.world-backdrop { position: absolute; inset: 0; z-index: 30; background: transparent; }
	.map-toggle { display: none; }
	/* Bottom left: a small round glass minimap, north up, the chat beside it. Bottom right: the
	   greetings dock over the status chips. */
	.world-minimap { left: var(--hud-left); bottom: 40px; }
	.minimap-disc { position: relative; width: 136px; height: 136px; border-radius: 50%; overflow: hidden; border: 1px solid rgb(255 255 255 / .28); box-shadow: 0 12px 32px -12px rgb(0 0 0 / .6); -webkit-backdrop-filter: blur(6px) saturate(140%); backdrop-filter: blur(6px) saturate(140%); }
	.minimap-disc canvas { display: block; width: 100%; height: 100%; }
	.minimap-north { position: absolute; top: 5px; left: 50%; transform: translateX(-50%); font-size: 10px; font-weight: 800; line-height: 1; color: var(--color-saffron-300); text-shadow: 0 1px 2px rgb(11 37 36 / .9); }
	.minimap-scale { position: absolute; bottom: 13px; left: 50%; transform: translateX(-50%); padding-bottom: 2px; border-bottom: 2px solid rgb(255 250 240 / .85); text-align: center; font-size: 9px; font-weight: 700; line-height: 1; color: rgb(255 250 240 / .9); text-shadow: 0 1px 2px rgb(11 37 36 / .9); }
	.world-chat { left: calc(var(--hud-left) + 150px); bottom: 40px; }
	.world-status { right: var(--hud-right); bottom: 40px; }
	.world-greetings { right: var(--hud-right); bottom: 70px; }
	.greetings { display: flex; gap: 2px; padding: 4px; border-radius: 999px; background: rgb(11 37 36 / .45); -webkit-backdrop-filter: blur(10px) saturate(140%); backdrop-filter: blur(10px) saturate(140%); border: 1px solid rgb(255 255 255 / .16); box-shadow: 0 12px 30px -14px rgb(0 0 0 / .6); }
	.greeting { position: relative; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; color: #fffaf0; transition: background-color 120ms, transform 120ms; }
	.greeting:hover { background: rgb(255 255 255 / .14); }
	.greeting:active { transform: scale(.9); }
	.greeting-face { font-size: 20px; line-height: 1; }
	.greeting kbd { position: absolute; right: 0; bottom: 0; min-width: 14px; padding: 0 3px; border-radius: 6px; font: 700 9px/13px var(--font-sans); text-align: center; color: var(--color-river-950); background: rgb(255 250 240 / .85); }
	.greeting-name { position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translate(-50%, 4px); padding: 3px 8px; border-radius: 8px; white-space: nowrap; font-size: 11px; font-weight: 700; background: rgb(11 37 36 / .85); opacity: 0; pointer-events: none; transition: opacity 120ms, transform 120ms; }
	.greeting:is(:hover, :focus-visible) .greeting-name { opacity: 1; transform: translate(-50%, 0); }
	@media (prefers-reduced-motion: reduce) { .greeting, .greeting-name { transition: none; } }
	.world-attribution { padding-bottom: max(6px, env(safe-area-inset-bottom)); }
	.compact .world-location { max-width: min(16rem, calc(100vw - 19rem - env(safe-area-inset-left) - env(safe-area-inset-right))); padding: 6px 10px; border-radius: 12px; }
	.compact .hud-street { font-size: 14px; }
	.compact .location-detail { display: none; }
	.compact .world-toolbar { flex-direction: row; gap: 6px; }
	.compact .secondary-control { display: none; }
	.compact .world-minimap { left: var(--hud-left); bottom: var(--hud-bottom); }
	.compact .minimap-disc { width: 96px; height: 96px; }
	.compact .world-minimap.expanded .minimap-disc { width: min(230px, 50vw); height: min(230px, 50vw); }
	.compact .map-toggle { display: grid; }
	.compact :is(.minimap-north, .minimap-scale) { font-size: 8px; }
	.compact .minimap-scale { bottom: 9px; }
	.compact .world-status { top: calc(var(--hud-top) + 64px); left: var(--hud-left); right: auto; bottom: auto; flex-direction: column; align-items: flex-start; font-size: 10px; }
	/* On a phone the greetings sit in the chat drawer, named (no hover there). */
	.compact .greeting { display: flex; gap: 5px; width: auto; height: 34px; padding: 0 11px 0 8px; border-radius: 999px; }
	.compact .greeting-face { font-size: 16px; }
	.compact .greeting kbd { display: none; }
	.compact .greeting-name { position: static; opacity: 1; transform: none; padding: 0; background: none; }
	.compact .performance-status { display: none; }
	.compact .world-touch { right: var(--hud-right); bottom: var(--hud-bottom); gap: 4px; }
	.compact .pad { width: 42px; height: 42px; border: 1px solid rgb(255 255 255 / .14); border-radius: 13px; }
	.compact .chat-toggle { z-index: 21; bottom: var(--hud-bottom); left: 50%; transform: translateX(-50%); border: 1px solid rgb(255 255 255 / .15); }
	.compact .world-chat { z-index: 22; left: var(--hud-left); bottom: calc(var(--hud-bottom) + 54px); max-width: calc(100vw - var(--hud-left) - var(--hud-right)); }
	.compact .world-chat :global([data-testid='chat']) { width: min(24rem, calc(100vw - var(--hud-left) - var(--hud-right))); }
	.compact .world-chat :global([data-testid='chat-log']) { max-height: min(8rem, 26dvh); }
	.compact[data-chat-open='true'] .world-minimap { visibility: hidden; }
	.compact .world-attribution { padding-top: 0; font-size: 8px; line-height: 12px; }
	.compact .attribution-detail { display: none; }
	.compact .world-guidance { top: calc(var(--hud-top) + 54px); right: var(--hud-right); left: auto; width: min(24rem, calc(100vw - 22rem)); transform: none; padding: 10px 12px; }
	.compact .world-action { bottom: calc(var(--hud-bottom) + 64px); max-width: calc(100vw - 19rem); text-align: center; }
	.compact .world-action > button { min-height: 44px; font-size: 12px; }
	.compact .world-speed { right: calc(var(--hud-right) + 144px); bottom: calc(var(--hud-bottom) + 54px); }
	.compact .world-speed > :global(div) { padding: 6px 10px; }
	.compact .world-panel { top: var(--hud-top); right: var(--hud-right); width: min(27rem, calc(100vw - var(--hud-left) - var(--hud-right))); padding: 20px; }
	.compact[data-panel-open='true'] .world-toolbar, .compact[data-panel-open='true'] .chat-toggle { visibility: hidden; }
	/* Light glass for the HUD's small cards: the city shows through, a faint edge and a text
	   shadow keep them readable on sky and road. */
	.hud-glass { background: rgba(11, 37, 36, 0.4); -webkit-backdrop-filter: blur(10px) saturate(140%); backdrop-filter: blur(10px) saturate(140%); border: 1px solid rgba(255, 255, 255, 0.14); text-shadow: 0 1px 2px rgba(11, 37, 36, 0.6); }
	/* At the System Office's counter: its panel takes the top right. */
	.office-open :is(.world-toolbar, .world-action, .world-guidance) { display: none; }
	.compact.office-open :is(.world-touch, .world-chat, .chat-toggle) { display: none; }
	/* The basket in hand, above the action prompt. */
	.basket-chip { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 700; color: #fffaf0; background: rgba(11, 37, 36, 0.55); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); box-shadow: 0 8px 24px -10px rgba(0, 0, 0, 0.5); }
	.basket-chip .muted { font-weight: 500; opacity: 0.75; }
	/* My shop takes the right side (a sheet on a phone). */
	.myshop-open :is(.world-toolbar, .world-action, .world-guidance, .chat-toggle, .world-greetings) { display: none; }
	.compact.myshop-open :is(.world-touch, .world-chat, .world-status, .world-minimap) { display: none; }
	/* Alerts over the city are text only: a soft shadow keeps them readable on sky and road. */
	.world-alert { text-shadow: 0 1px 2px rgba(11, 37, 36, 0.9), 0 0 10px rgba(11, 37, 36, 0.7); }
	/* The wardrobe: only the city, the avatar and the glass panel. */
	.wardrobe-open :is(.world-location, .world-toolbar, .world-minimap, .world-status, .world-chat, .world-greetings, .world-speed, .world-guidance, .world-action, .world-touch, .world-alert, .chat-toggle) { display: none; }
	@media (max-width: 600px) {
		.compact .world-location { max-width: calc(100vw - var(--hud-left) - var(--hud-right)); width: calc(100vw - var(--hud-left) - var(--hud-right)); }
		.compact .world-toolbar { top: calc(var(--hud-top) + 112px); }
		.compact .world-alert { top: calc(var(--hud-top) + 166px); }
		.compact .world-guidance { top: calc(var(--hud-top) + 166px); width: calc(100vw - var(--hud-left) - var(--hud-right)); }
		.compact .world-action { bottom: calc(var(--hud-bottom) + 150px); max-width: calc(100vw - 2rem); width: max-content; }
		.compact .world-speed { right: var(--hud-right); bottom: calc(var(--hud-bottom) + 145px); }
	}
	@media (max-height: 400px) and (min-width: 601px) {
		.compact .minimap-disc { width: 84px; height: 84px; }
		.compact .world-minimap.expanded .minimap-disc { width: 180px; height: 180px; }
		.compact .world-action { bottom: calc(var(--hud-bottom) + 36px); }
	}
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

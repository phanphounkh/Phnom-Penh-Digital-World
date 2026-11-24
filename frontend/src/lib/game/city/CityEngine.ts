/**
 * The playable 3D city: renderer, day/night lighting, terrain, streamed OSM chunks (built in
 * Web Workers), Blender props and landmarks, the player's avatar, third-person camera,
 * keyboard/touch controls and collision. Phase 5: riding a bicycle or motorbike (physics,
 * staying on the streets, chase camera), route guidance and the riding/walking autopilot.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { Avatar, ChunkPayload, WorldBootstrap } from '$lib/api/types';
import { WorldProjection, compassHeading, yawForHeading } from '$lib/geo/projection';
import { createCharacter, type AvatarStyle, type GameCharacter, type Mount } from '$lib/game/avatar/character';
import type { EmoteName } from '$lib/game/net/protocol';
import { ChunkManager } from './ChunkManager';
import { CollisionWorld, escapeFootprint, moveCircle, rayFraction } from './collision';
import { DayNight, type TimeMode } from './lighting';
import { WorldAudio, waterProximity } from '../audio/WorldAudio';
import { qualityDebt, GRAPHICS_PRESETS, lowerQuality, type GraphicsQuality } from './quality';
import { DaylightClouds } from './DaylightClouds';
import { NightSky } from './NightSky';
import { StreetLighting } from './StreetLighting';
import { AvatarLighting, addAvatarLighting } from './AvatarLighting';
import { CityMaterials } from './materials';
import { PropLibrary } from './props';
import { addSurfaceDetail } from './surfaces';
import { Terrain, type Mound } from './terrain';
import type { XZ } from '$lib/api/types';
import { RoadNetwork } from '$lib/game/vehicles/RoadNetwork';
import { createVehicle, setVehicleNight, type VehicleInstance } from '$lib/game/vehicles/VehicleModels';
import { pursuitSteer, rideState, rideStep } from '$lib/game/vehicles/kinematics';
import { MODES, PULL_OVER_M, type TravelMode, type VehicleKind } from '$lib/game/vehicles/specs';
import { RouteLine } from '$lib/game/vehicles/RouteLine';
import { PathFollower, RouteGuide, lanePath, stepText, type Progress, type Route } from '$lib/game/vehicles/route';
import { JUMP_BUFFER, approachSpeed, grounded, isAirborne, stepHop, targetSpeed, turnHeading } from './locomotion';

export type Quality = GraphicsQuality;

/** True when WebGL runs on a CPU rasteriser (SwiftShader, llvmpipe, …): no usable GPU. */
export function softwareRenderer(renderer: THREE.WebGLRenderer): boolean {
	const gl = renderer.getContext();
	const info = gl.getExtension('WEBGL_debug_renderer_info');
	const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
	return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
}
export type { TimeMode };

export interface CityState {
	x: number;
	z: number;
	lat: number;
	lon: number;
	heading: number;
	speed: number;
	street: string | null;
	/** The street name in the other language (Khmer for English users and vice versa). */
	streetAlt: string | null;
	landmark: string | null;
	chunks: number;
	pending: number;
	fps: number;
	nearEdge: boolean;
	quality: Quality;
	/** Phnom Penh local time being shown, "HH:MM". */
	clock: string;
	timeMode: TimeMode;
	night: number;
	/** Height of the ground under the player (metres above street level). */
	ground: number;
	workers: number;
	/** Phase 5: on foot or riding, the speedometer, the street's limit and one-way state. */
	mode: TravelMode;
	speedKmh: number;
	speedLimit: number | null;
	oneWay: boolean;
	wrongWay: boolean;
	/** Route guidance while a route is shown. */
	nav: (Progress & { text: string; auto: boolean }) | null;
}

export interface RidingVehicle {
	id: string;
	kind: VehicleKind;
	color: string;
}

export interface LocalState {
	x: number;
	z: number;
	yaw: number;
	speed: number;
}

export interface CityController {
	readonly audio: WorldAudio;
	readonly projection: WorldProjection;
	readonly scene: THREE.Scene;
	readonly camera: THREE.PerspectiveCamera;
	readonly terrain: Terrain;
	readonly collision: CollisionWorld;
	readonly materials: CityMaterials;
	/** The local player's avatar root (shops attach a held product to its wrist). */
	readonly avatar: THREE.Object3D;
	/** Carry pose while holding a product. */
	setHolding(holding: boolean): void;
	/** Walk along waypoints (world x/z) like a player would; any movement key cancels. */
	walkTo(points: [number, number][], onDone?: (arrived: boolean) => void): void;
	/** Floor heights that differ from the terrain (enterable buildings, porches, steps): return a
	 * height for (x, z), or null for the terrain. null removes the provider. */
	setGround(provider: ((x: number, z: number) => number | null) | null): void;
	/** The ceiling over (x, z) for a camera at height y, if that is inside a building's room
	 * (enterable buildings): the camera never ends up above it, inside the building. */
	setCeiling(provider: ((x: number, y: number, z: number) => number | null) | null): void;
	/** Indoor view: the camera stays under `ceiling` (world y) and within `maxDistance` of the
	 * avatar, and the sun on the avatar softens. null = outdoors. */
	setInterior(view: { ceiling: number; maxDistance: number; lamp?: number } | null): void;
	/** Sit on a seat: the avatar turns and lowers itself onto (x, z) facing `yaw`; any movement
	 * key (or stand()) gets it up again at `standAt`. */
	sit(seat: { x: number; z: number; yaw: number }, standAt: [number, number]): boolean;
	stand(): void;
	readonly seated: boolean;
	/** Climb through an opening (a window): from here over `points[0]` to `points[1]`, rising
	 * `lift` metres at the top, taking `time` seconds, without collision. False if the avatar is
	 * busy (riding, seated, climbing). */
	climb(points: [number, number][], lift: number, time: number, onDone?: (done: boolean) => void): boolean;
	readonly climbing: boolean;
	/** Called when jump is pressed: returning true takes the jump (a window to climb through). */
	setJumpOverride(fn: (() => boolean) | null): void;
	/** Something static changed near the player (a building appeared): re-render shadows. */
	invalidateShadows(): void;
	/** The loaded chunks' data (buildings, roads…), e.g. to find buildings to open. */
	chunkData(): ChunkPayload[];
	readonly walking: boolean;
	/** Runs every frame after the player has moved (dt in seconds). */
	onFrame(callback: (dt: number) => void): () => void;
	localState(): LocalState;
	/** Authoritative position from the server (start, travel, invite, correction). */
	setPosition(x: number, z: number, yaw?: number): void;
	/** Streets and their riding/parking rules, from the loaded chunks. */
	readonly network: RoadNetwork;
	readonly mode: TravelMode;
	readonly riding: RidingVehicle | null;
	/** Get on (the server placed you on the vehicle) or off (null; you stand beside it). */
	setRiding(vehicle: RidingVehicle | null, x: number, z: number, yaw: number): void;
	/** Where "park" would leave the vehicle (null: pull over first). */
	parkingSpot(free?: (x: number, z: number) => boolean): XZ | null;
	/** Show a route in the world and on the minimap (null clears it); `destination` is the
	 * exact place to reach (the route ends at the nearest road position to it). */
	setRoute(route: Route | null, destination?: XZ): void;
	readonly route: Route | null;
	/** Follow the shown route: walk it or ride it (any movement key takes over). */
	followRoute(onDone?: (arrived: boolean) => void): void;
	readonly following: boolean;
	playEmote(name: EmoteName): void;
	/** What the player's avatar wears (the avatar description). */
	readonly outfit: Avatar;
	/** Wear another avatar: in place where the model can, else rebuilt (the wardrobe's live
	 * preview; saving it is up to the caller). */
	setAvatar(avatar: Avatar): Promise<void>;
	/** The camera turns to face the player, who stands still (movement keys are ignored), with
	 * the avatar framed `right` metres left of centre and `down` metres higher (room for a panel
	 * beside or below), from `distance` metres at `pitch` (radians); null: back behind the player. */
	setShowcase(view: { right?: number; down?: number; distance?: number; pitch?: number } | null): void;
	/** The avatar model in use: realistic, or classic if the realistic models cannot load. */
	readonly avatarStyle: AvatarStyle;
	/** Current graphics preset (may start at 'low' on software rendering, see softwareRenderer). */
	readonly quality: Quality;
	setQuality(q: Quality): void;
	setTimeMode(mode: TimeMode): void;
	setPaused(paused: boolean): void;
	teleport(x: number, z: number, headingDeg?: number): Promise<void>;
	setKey(key: string, down: boolean): void;
	drawMinimap(ctx: CanvasRenderingContext2D, size: number, metersPerPx: number): void;
	dispose(): void;
}

export interface CityOptions {
	onState?: (s: CityState) => void;
	onProgress?: (loaded: number, total: number) => void;
	preferKhmer?: boolean;
	quality?: Quality;
	timeMode?: TimeMode;
}

const RADIUS = 0.35;
const EYE = 1.55;
/** Physics sub-step while riding (stable steering on slow, software-rendered frames). */
const RIDE_STEP = 0.05;
/** The server tolerates riders this far beyond the carriageway (client stops at 2.0 m). */
const RIDE_ESCAPE_MARGIN = 2.7;

/** A displaced ground patch for each mound, coloured like a wooded hill. */
function terrainMesh(terrain: Terrain, material: THREE.Material): THREE.Group {
	const group = new THREE.Group();
	const grass = new THREE.Color('#6f8f4e'), forest = new THREE.Color('#4f6e3a'), ground = new THREE.Color('#a59b86');
	for (const m of terrain.mounds) {
		const size = m.base_radius_m * 2 + 8;
		const geometry = new THREE.PlaneGeometry(size, size, 72, 72).rotateX(-Math.PI / 2);
		const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
		const colors = new Float32Array(pos.count * 3);
		const c = new THREE.Color();
		for (let i = 0; i < pos.count; i++) {
			const x = pos.getX(i) + m.x, z = pos.getZ(i) + m.z;
			const h = terrain.height(x, z);
			pos.setY(i, h + 0.03);
			const t = h / m.height_m;
			c.copy(ground).lerp(grass, Math.min(1, t * 6)).lerp(forest, Math.max(0, t - 0.3));
			colors.set([c.r, c.g, c.b], i * 3);
		}
		geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
		geometry.translate(m.x, 0, m.z);
		geometry.computeVertexNormals();
		const mesh = new THREE.Mesh(geometry, material);
		mesh.receiveShadow = true;
		mesh.castShadow = true;
		group.add(mesh);
	}
	return group;
}

export async function createCity(
	host: HTMLElement,
	boot: WorldBootstrap,
	options: CityOptions = {}
): Promise<CityController> {
	const config = boot.config;
	const region = config.regions.find((r) => r.slug === boot.spawn.region) ?? config.regions[0];
	const projection = WorldProjection.fromConfig(config);
	const terrain = new Terrain((config.terrain ?? []) as Mound[]);
	let quality: Quality = options.quality ?? 'medium';
	const khmer = !!options.preferKhmer;

	// ── renderer & scene ──────────────────────────────────────────────────────────────
	const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.62;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	// Shadows are cached: re-rendered only when the snapped shadow window moves, the light
	// changes or chunks change, not every frame (the biggest GPU cost on integrated graphics).
	renderer.shadowMap.autoUpdate = false;
	host.appendChild(renderer.domElement);
	// No GPU (software rasteriser): start conservative; the player can still choose Quality.
	if (quality !== 'low' && softwareRenderer(renderer)) quality = 'low';
	renderer.domElement.style.touchAction = 'none';

	const scene = new THREE.Scene();
	const fog = new THREE.Fog('#c9d8db', 260, 760);
	scene.fog = fog;
	const camera = new THREE.PerspectiveCamera(55, 1, 0.3, 2500);

	const sky = new Sky();
	sky.scale.setScalar(4000);
	const skyUniforms = sky.material.uniforms;
	// A clearer, bluer tropical sky (was turbidity 7 / rayleigh 1.4: washed out to white).
	skyUniforms.turbidity.value = 2.8;
	skyUniforms.rayleigh.value = 2.7;
	skyUniforms.mieCoefficient.value = 0.003;
	skyUniforms.mieDirectionalG.value = 0.82;
	scene.add(sky);
	const nightSky = new NightSky(scene);
	const daylightClouds = new DaylightClouds(sky);

	const hemi = new THREE.HemisphereLight('#dfeaf0', '#8c806a', 1.5);
	scene.add(hemi);
	const sun = new THREE.DirectionalLight('#fff0d4', 3.1);
	sun.shadow.mapSize.set(2048, 2048);
	Object.assign(sun.shadow.camera, { left: -75, right: 75, top: 75, bottom: -75, near: 10, far: 400 });
	sun.shadow.bias = -0.0004;
	sun.shadow.normalBias = 0.08;
	scene.add(sun, sun.target);

	const b = region.world_bounds;
	const margin = 700;
	const groundPlane = new THREE.Mesh(
		new THREE.PlaneGeometry(b.max_x - b.min_x + margin * 2, b.max_z - b.min_z + margin * 2),
		new THREE.MeshStandardMaterial({ color: '#a59b86', roughness: 1 })
	);
	groundPlane.rotation.x = -Math.PI / 2;
	groundPlane.position.set((b.min_x + b.max_x) / 2, 0, (b.min_z + b.max_z) / 2);
	groundPlane.receiveShadow = true;
	scene.add(groundPlane);

	// ── world data ────────────────────────────────────────────────────────────────────
	const materials = new CityMaterials();
	(groundPlane.material as THREE.MeshStandardMaterial).color.set('#ffffff'); // colours come from the 'ground' detail
	addSurfaceDetail(groundPlane.material as THREE.MeshStandardMaterial, 'ground', { time: materials.time, detail: materials.detail, grain: materials.streetGrain, ground: materials.groundMap, relief: materials.relief });
	const props = new PropLibrary();
	await props.load();
	const hills = terrainMesh(terrain, materials.terrain);
	scene.add(hills);
	const collision = new CollisionWorld();
	collision.bounds = { minX: b.min_x + 3, minZ: b.min_z + 3, maxX: b.max_x - 3, maxZ: b.max_z - 3 };
	const chunks = new ChunkManager(scene, projection, collision, materials, props, terrain, new Set(region.chunk_keys), {
		preferKhmer: khmer,
		shadows: GRAPHICS_PRESETS[quality].shadows
	});
	const lighting = new DayNight(
		{ renderer, scene, sun, hemi, sky, fog, materials, props },
		config.origin.lat,
		config.origin.lon
	);
	lighting.mode = options.timeMode ?? 'live';
	lighting.update();
	const streetLighting = new StreetLighting(scene, chunks);
	const audio = new WorldAudio();
	let audioEnvironmentTimer = 1;
	let nearbyWater = 0;
	let nearbyRoad = false;

	// ── player ────────────────────────────────────────────────────────────────────────
	// `player` is a stable holder: the avatar model inside it can be swapped (avatar style) while
	// shops, vehicles and the camera keep their reference.
	const player = new THREE.Group();
	player.name = 'player';
	let character: GameCharacter = await createCharacter(boot.player.avatar);
	/** The wardrobe's view (see setShowcase), and the camera to go back to. */
	let showcase: { right: number; down: number } | null = null;
	let beforeShowcase: { pitch: number; distance: number } | null = null;
	let styleToken = 0;
	const wear = (c: GameCharacter) => {
		// The avatar uses the contact blob below instead of the cached shadow map.
		c.root.traverse((n) => {
			(n as THREE.Mesh).castShadow = false;
			if ((n as THREE.Mesh).isMesh) {
				for (const material of [(n as THREE.Mesh).material].flat())
					if ((material as THREE.MeshStandardMaterial).isMeshStandardMaterial)
						addAvatarLighting(material as THREE.MeshStandardMaterial);
			}
		});
		player.add(c.root);
	};
	wear(character);
	/** Build the player's model again (another build, or parts the current one cannot change),
	 * and put it on the vehicle if they are riding. The newest request wins. */
	async function rebuild(): Promise<void> {
		const token = ++styleToken;
		const next = await createCharacter(boot.player.avatar);
		if (token !== styleToken || disposed) return next.dispose();
		const mounted = rider && vehicle ? vehicle : null;
		rider?.detach(scene);
		rider = null;
		character.dispose();
		character = next;
		wear(next);
		if (mounted) {
			player.rotation.set(0, 0, 0);
			rider = character.mount(mounted, player);
		}
	}
	scene.add(player);
	const avatarLighting = new AvatarLighting();
	const frameCallbacks = new Set<(dt: number) => void>();
	const shadowBlob = new THREE.Mesh(
		new THREE.CircleGeometry(0.42, 24),
		new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.22, depthWrite: false })
	);
	shadowBlob.rotation.x = -Math.PI / 2;
	scene.add(shadowBlob);

	// Where the server says we enter: a recent session's position, or the chosen spawn point.
	let px = boot.start?.x ?? boot.spawn.x;
	let pz = boot.start?.z ?? boot.spawn.z;
	let yaw = boot.start?.yaw ?? yawForHeading(boot.spawn.heading_deg);
	let speed = 0;
	let holding = false;
	const hop = grounded();
	// Enterable buildings: floor heights, the indoor camera and seats.
	let groundProvider: ((x: number, z: number) => number | null) | null = null;
	const groundAt = (x: number, z: number) => groundProvider?.(x, z) ?? terrain.height(x, z);
	let ceilingProvider: ((x: number, y: number, z: number) => number | null) | null = null;
	let footY = NaN; // the avatar's floor height, eased over steps
	let interior: { ceiling: number; maxDistance: number; lamp?: number } | null = null;
	let indoor = 0; // 0 outdoors … 1 indoors (eased)
	let indoorLamp = 1; // the current room's lamps (eased)
	let viewDistance = NaN;
	let viewPitch = NaN;
	type SeatMove = { x: number; z: number; yaw: number; stand: [number, number]; phase: 'down' | 'sat' | 'up'; t: number; fromX: number; fromZ: number; fromYaw: number };
	let seat: SeatMove | null = null;
	/** Climbing through a window (see controller.climb). */
	let climb: { from: [number, number]; mid: [number, number]; to: [number, number]; lift: number; t: number; time: number; done?: (done: boolean) => void } | null = null;
	let jumpOverride: (() => boolean) | null = null;
	/** Jump pressed: a window to climb through takes it, else a jump. */
	const jump = () => {
		if (!jumpOverride?.()) hop.queued = JUMP_BUFFER;
	};
	// Riding (Phase 5).
	const network = new RoadNetwork();
	let riding: RidingVehicle | null = null;
	let vehicle: VehicleInstance | null = null;
	let rider: Mount | null = null;
	let rideToken = 0;
	const ride = rideState();
	let lastDrag = -10;
	// Route guidance and the riding autopilot.
	const routeLine = new RouteLine(terrain);
	scene.add(routeLine.group);
	let navRoute: Route | null = null;
	let navDestination: XZ | null = null;
	let guide: RouteGuide | null = null;
	let follower: PathFollower | null = null;
	let autoRide = false;
	let autoDone: ((arrived: boolean) => void) | undefined;
	let autoStuck = 0;
	const endAuto = (arrived: boolean) => {
		if (!autoRide) return;
		autoRide = false;
		const done = autoDone;
		autoDone = undefined;
		done?.(arrived);
	};
	// Autopilot ("walk me there"): real walking with collision, so the server sees normal moves.
	let route: [number, number][] = [];
	let routeDone: ((arrived: boolean) => void) | undefined;
	let routeStuck = 0;
	const endRoute = (arrived: boolean) => {
		route = [];
		const done = routeDone;
		routeDone = undefined;
		done?.(arrived);
	};
	let camYaw = yaw + Math.PI; // behind the player
	let camPitch = 0.38;
	let camDistance = 7.5;
	const cameraTarget = new THREE.Vector3();

	const initial = projection.keysAround(px, pz, 220).filter((k) => region.chunk_keys.includes(k));
	let done = 0;
	options.onProgress?.(0, initial.length);
	await chunks.preload(px, pz, 220, () => options.onProgress?.(++done, initial.length));
	({ x: px, z: pz } = escapeFootprint(collision, px, pz, RADIUS));

	// ── input ─────────────────────────────────────────────────────────────────────────
	const keys = new Set<string>();
	const typing = (e: Event) => {
		const t = e.target as HTMLElement | null;
		return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
	};
	const onKeyDown = (e: KeyboardEvent) => {
		if (typing(e) || showcase) return;
		const k = e.key.toLowerCase();
		// Space presses a focused button in a panel over the city (My shop, the office), not jump.
		if (k === ' ' && (e.target as HTMLElement | null)?.closest?.('[role="dialog"]')) return;
		if (k === ' ') {
			e.preventDefault(); // no page scroll, no click on a focused HUD button
			if (!e.repeat) jump();
			return;
		}
		if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
			keys.add(k);
			if (k.startsWith('arrow')) e.preventDefault();
		}
	};
	const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
	const onBlur = () => keys.clear();
	let dragging = false;
	let lastX = 0;
	let lastY = 0;
	const onPointerDown = (e: PointerEvent) => {
		dragging = true;
		lastX = e.clientX;
		lastY = e.clientY;
		renderer.domElement.setPointerCapture(e.pointerId);
	};
	const onPointerMove = (e: PointerEvent) => {
		if (!dragging) return;
		camYaw -= (e.clientX - lastX) * 0.006;
		lastDrag = performance.now() / 1000;
		camPitch = THREE.MathUtils.clamp(camPitch + (e.clientY - lastY) * 0.004, 0.08, 1.25);
		lastX = e.clientX;
		lastY = e.clientY;
	};
	const onPointerUp = () => (dragging = false);
	const onWheel = (e: WheelEvent) => {
		e.preventDefault();
		camDistance = THREE.MathUtils.clamp(camDistance * (1 + Math.sign(e.deltaY) * 0.1), 2.5, 22);
	};
	window.addEventListener('keydown', onKeyDown);
	window.addEventListener('keyup', onKeyUp);
	window.addEventListener('blur', onBlur);
	renderer.domElement.addEventListener('pointerdown', onPointerDown);
	renderer.domElement.addEventListener('pointermove', onPointerMove);
	renderer.domElement.addEventListener('pointerup', onPointerUp);
	renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

	const resize = () => {
		const w = host.clientWidth || 1;
		const h = host.clientHeight || 1;
		renderer.setSize(w, h);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	};
	const observer = new ResizeObserver(resize);
	observer.observe(host);

	function applyQuality() {
		const preset = GRAPHICS_PRESETS[quality];
		renderer.setPixelRatio(Math.min(devicePixelRatio, preset.pixelRatio));
		renderer.shadowMap.enabled = preset.shadows;
		sun.castShadow = preset.shadows;
		if (sun.shadow.mapSize.x !== preset.shadowSize) {
			sun.shadow.map?.dispose();
			sun.shadow.map = null;
			sun.shadow.mapSize.set(preset.shadowSize, preset.shadowSize);
		}
		const half = preset.shadowSpan / 2;
		Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half });
		sun.shadow.camera.updateProjectionMatrix();
		shadowBlob.visible = true;
		chunks.detailRadius = preset.detailRadius;
		chunks.facadeRadius = quality === 'high' ? 160 : quality === 'medium' ? 90 : 0;
		renderer.shadowMap.needsUpdate = true;
		chunks.radius = preset.radius;
		chunks.setShadows(preset.shadows);
		fog.near = preset.fogNear;
		fog.far = preset.fogFar;
		materials.detail.value = preset.surfaceDetail;
		materials.relief.value = quality === 'low' ? 0 : 1;
		lighting.environment = preset.environment;
		lighting.dayFill = preset.dayFill;
		lighting.update();
		scene.traverse((n) => {
			const m = (n as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
			if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
			else if (m) m.needsUpdate = true;
		});
		resize();
	}
	applyQuality();

	// ── loop ──────────────────────────────────────────────────────────────────────────
	const clock = new THREE.Clock();
	let raf = 0;
	let paused = false;
	let disposed = false;
	let stateTimer = 0;
	let lightTimer = 0;
	let frames = 0;
	let fps = 60;
	let slowTime = 0;
	const desired = new THREE.Vector3();
	const SHADOW_SNAP = 12;
	let shadowX = NaN;
	let shadowZ = NaN;
	const shadowDir = new THREE.Vector3();

	function step(dt: number) {
		network.sync(chunks.payloads(), chunks.version);
		if (riding) {
			Object.assign(hop, grounded());
			return stepRiding(dt);
		}
		indoor += ((interior ? 1 : 0) - indoor) * (1 - Math.exp(-dt * 3));
		indoorLamp += ((interior?.lamp ?? 1) - indoorLamp) * (1 - Math.exp(-dt * 6));
		lighting.setIndoor(indoor, renderer.shadowMap.enabled, indoorLamp);
		if (climb) return stepClimb(dt);
		if (seat) return stepSeated(dt);
		const forward = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
		const strafe = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
		const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
		let mx = fx * forward + -fz * strafe;
		let mz = fz * forward + fx * strafe;
		let len = Math.hypot(mx, mz);
		let autoRun = false;
		if (len > 0 && route.length) endRoute(false); // the player took over
		while (route.length && len === 0) {
			const [tx, tz] = route[0];
			const d = Math.hypot(tx - px, tz - pz);
			if (d < 0.35) {
				route.shift();
				routeStuck = 0;
				if (!route.length) endRoute(true);
				continue;
			}
			mx = (tx - px) / d;
			mz = (tz - pz) / d;
			len = 1;
			autoRun = d > 8;
			// Let the camera swing round behind the walking direction.
			let behind = Math.atan2(mx, mz) + Math.PI - camYaw;
			behind = Math.atan2(Math.sin(behind), Math.cos(behind));
			camYaw += behind * (1 - Math.exp(-dt * 2.5));
		}
		let delta = 0;
		if (len > 0) {
			mx /= len;
			mz /= len;
			delta = Math.atan2(mx, mz) - yaw;
			delta = Math.atan2(Math.sin(delta), Math.cos(delta));
		}
		const airborne = isAirborne(hop);
		speed = approachSpeed(speed, targetSpeed(len > 0, keys.has('shift') || autoRun, delta, airborne), dt, airborne);
		if (len > 0) yaw = turnHeading(yaw, delta, speed, dt, airborne);
		if (stepHop(hop, dt)) character.emotes.stop(); // vertical only: collisions stay 2D
		const lift = hop.lift;
		let travel = 0;
		if (speed > 0.02) {
			const result = moveCircle(collision, px, pz, Math.sin(yaw) * speed * dt, Math.cos(yaw) * speed * dt, RADIUS);
			travel = Math.hypot(result.x - px, result.z - pz);
			px = result.x;
			pz = result.z;
		}
		if (route.length) {
			// Blocked by a wall for a while: give up rather than push into it forever.
			routeStuck = travel < speed * dt * 0.25 ? routeStuck + dt : 0;
			if (routeStuck > 1.5) endRoute(false);
		}
		const ground = easeFoot(dt, groundAt(px, pz));
		player.position.set(px, ground + lift, pz);
		player.rotation.y = yaw;
		shadowBlob.position.set(px, ground + 0.09, pz);
		character.animations.airborne?.(isAirborne(hop), hop.vy);
		character.animations.update(dt, dt > 0 ? travel / dt : 0, holding, false, null, travel, 1);
		character.emotes.update(dt, speed > 0.3);

		shadowBlob.scale.setScalar(1 - Math.min(lift, 1) * 0.35);
		placeCamera(dt, ground + EYE + lift * 0.4, camDistance);
		updateWorld();
	}

	/** The avatar's floor height: steps up and down (porch, threshold) ease in over a few frames
	 * instead of popping; bigger jumps (teleport) snap. */
	function easeFoot(dt: number, ground: number): number {
		footY = Number.isNaN(footY) || Math.abs(ground - footY) > 0.6 ? ground : footY + (ground - footY) * (1 - Math.exp(-dt * 16));
		return footY;
	}

	const SIT_TIME = 0.75;
	const smooth = (t: number) => t * t * (3 - 2 * t);

	/** Sitting down, seated, standing up: the avatar's root moves between the spot in front of
	 * the seat and the seat while the Sit pose crossfades in or out. */
	function stepSeated(dt: number) {
		const s = seat!;
		const moving = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].some((k) => keys.has(k));
		if (s.phase === 'sat' && (moving || hop.queued > 0)) beginStand();
		s.t = Math.min(1, s.t + dt / SIT_TIME);
		if (s.phase === 'down') {
			// Turn round first, then lower back onto the seat.
			let d = s.yaw - s.fromYaw;
			d = Math.atan2(Math.sin(d), Math.cos(d));
			yaw = s.fromYaw + d * smooth(Math.min(1, s.t / 0.55));
			const k = smooth(THREE.MathUtils.clamp((s.t - 0.2) / 0.8, 0, 1));
			px = s.fromX + (s.x - s.fromX) * k;
			pz = s.fromZ + (s.z - s.fromZ) * k;
			if (s.t >= 1) s.phase = 'sat';
		} else if (s.phase === 'up') {
			const k = smooth(s.t);
			px = s.x + (s.stand[0] - s.x) * k;
			pz = s.z + (s.stand[1] - s.z) * k;
			if (s.t >= 1) seat = null;
		}
		hop.queued = 0;
		speed = 0;
		const ground = easeFoot(dt, groundAt(px, pz));
		player.position.set(px, ground, pz);
		player.rotation.y = yaw;
		shadowBlob.position.set(px, ground + 0.09, pz);
		shadowBlob.scale.setScalar(1);
		character.animations.update(dt, 0, holding, false, null, 0, 1);
		placeCamera(dt, ground + EYE - (seat?.phase === 'sat' ? 0.4 : 0), camDistance);
		updateWorld();
	}

	/** Through a window: up to the sill and over it, down on the other side (an arc, no
	 * collision: the walls are what is being climbed through). */
	function stepClimb(dt: number) {
		const c = climb!;
		c.t = Math.min(1, c.t + dt / c.time);
		const k = smooth(c.t);
		const [ax, az] = k < 0.5 ? c.from : c.mid;
		const [bx, bz] = k < 0.5 ? c.mid : c.to;
		const u = k < 0.5 ? k * 2 : (k - 0.5) * 2;
		px = ax + (bx - ax) * u;
		pz = az + (bz - az) * u;
		yaw = Math.atan2(c.to[0] - c.from[0], c.to[1] - c.from[1]);
		const lift = c.lift * Math.sin(Math.PI * c.t);
		hop.queued = 0;
		speed = 0;
		const ground = easeFoot(dt, groundAt(px, pz));
		player.position.set(px, ground + lift, pz);
		player.rotation.y = yaw;
		shadowBlob.position.set(px, ground + 0.09, pz);
		shadowBlob.scale.setScalar(1 - Math.min(lift, 1) * 0.35);
		character.animations.airborne?.(c.t < 0.9, c.t < 0.5 ? 1 : -1);
		character.animations.update(dt, 0, holding, false, null, 0, 1);
		placeCamera(dt, ground + EYE + lift * 0.4, camDistance);
		updateWorld();
		if (c.t >= 1) {
			climb = null;
			character.animations.airborne?.(false, 0);
			c.done?.(true);
		}
	}

	function beginStand() {
		if (!seat || seat.phase === 'up') return;
		character.animations.posture?.(null);
		seat.phase = 'up';
		seat.t = 0;
		seat.x = px;
		seat.z = pz;
	}

	/** Camera: orbit, pulled in when a building stands between it and the player. Indoors it
	 * stays close and under the ceiling. */
	function placeCamera(dt: number, head: number, requested: number) {
		const limit = interior ? Math.min(requested, interior.maxDistance) : requested;
		const pitchLimit = interior ? Math.min(camPitch, 0.32) : camPitch;
		const ease = 1 - Math.exp(-dt * 4);
		viewDistance = Number.isNaN(viewDistance) ? limit : viewDistance + (limit - viewDistance) * ease;
		viewPitch = Number.isNaN(viewPitch) ? pitchLimit : viewPitch + (pitchLimit - viewPitch) * ease;
		const distance = viewDistance;
		// Showcase: aim at the chest, beside the avatar (it then sits off centre, clear of a panel).
		const ox = showcase ? Math.cos(camYaw) * showcase.right : 0,
			oz = showcase ? -Math.sin(camYaw) * showcase.right : 0;
		const aim = showcase ? head - 0.5 - showcase.down : head;
		desired.set(
			px + ox + Math.sin(camYaw) * Math.cos(viewPitch) * distance,
			aim + Math.sin(viewPitch) * distance,
			pz + oz + Math.cos(camYaw) * Math.cos(viewPitch) * distance
		);
		// Camera collision: the centre ray, and indoors two more at the sides of the near plane,
		// so a wall just beside the camera is never seen through.
		let f = rayFraction(collision, px, head, pz, desired.x, desired.y, desired.z);
		if (interior) {
			const sx = Math.cos(camYaw) * 0.3,
				sz = -Math.sin(camYaw) * 0.3;
			f = Math.min(f, rayFraction(collision, px, head, pz, desired.x + sx, desired.y, desired.z + sz), rayFraction(collision, px, head, pz, desired.x - sx, desired.y, desired.z - sz));
		}
		if (f < 1) {
			const k = Math.max(0.18, f - 0.4 / distance);
			desired.set(px + (desired.x - px) * k, head + (desired.y - head) * k, pz + (desired.z - pz) * k);
		}
		// Ended up over a room (through its doorway, from a player standing in it): under the
		// ceiling, not up in the building above it, then checked again from there.
		const roof = ceilingProvider?.(desired.x, desired.y, desired.z) ?? null;
		if (roof !== null && desired.y > roof - 0.3) {
			desired.y = Math.max(head, roof - 0.3);
			const g = rayFraction(collision, px, head, pz, desired.x, desired.y, desired.z);
			if (g < 1) {
				const k = Math.max(0.18, g - 0.4 / distance);
				desired.set(px + (desired.x - px) * k, head + (desired.y - head) * k, pz + (desired.z - pz) * k);
			}
			f = Math.min(f, g);
		}
		desired.y = Math.max(desired.y, groundAt(desired.x, desired.z) + 0.8);
		if (interior) {
			// Cramped (a wall close behind): rise and look down over the avatar's head instead.
			const room = Math.hypot(desired.x - px, desired.z - pz);
			if (room < 1.4) desired.y = Math.max(desired.y, head + (1.4 - room) * 0.9);
			desired.y = Math.min(desired.y, interior.ceiling - 0.3);
		}
		camera.position.lerp(desired, 1 - Math.exp(-dt * (f < 1 ? 20 : 8)));
		camera.position.y = Math.max(camera.position.y, groundAt(camera.position.x, camera.position.z) + 0.6);
		if (interior) camera.position.y = Math.min(camera.position.y, interior.ceiling - 0.25);
		const over = ceilingProvider?.(camera.position.x, camera.position.y, camera.position.z) ?? null;
		if (over !== null) camera.position.y = Math.min(camera.position.y, over - 0.25);
		cameraTarget.set(px + ox, aim, pz + oz);
		camera.lookAt(cameraTarget);
		// Small rooms: a short near plane (no wall clipping); outdoors the usual one (depth precision).
		const near = interior ? 0.1 : 0.3;
		if (camera.near !== near) {
			camera.near = near;
			camera.updateProjectionMatrix();
		}
		// Never look out through the avatar's own head.
		const hide = camera.position.distanceTo(cameraTarget) < 0.55;
		if (character.root.visible === hide) character.root.visible = !hide;
	}

	/** Streaming, the cached shadow window and the route line follow the player. */
	function updateWorld() {
		routeLine.update(1 / 60);

		// Shadow window snapped to a 12 m grid: re-render only when it moves or things change.
		const sx = Math.round(px / SHADOW_SNAP) * SHADOW_SNAP;
		const sz = Math.round(pz / SHADOW_SNAP) * SHADOW_SNAP;
		const d = lighting.lightDir;
		if (sx !== shadowX || sz !== shadowZ || !d.equals(shadowDir) || chunks.changed) {
			shadowX = sx;
			shadowZ = sz;
			shadowDir.copy(d);
			chunks.changed = false;
			const g = terrain.height(sx, sz);
			sun.position.set(sx + d.x * 160, g + d.y * 160, sz + d.z * 160);
			sun.target.position.set(sx, g, sz);
			sun.target.updateMatrixWorld();
			renderer.shadowMap.needsUpdate = true;
		}
	}

	/** May a vehicle of this mode move to (x, z)? (Back inside from the server's wider margin.) */
	function rideAllowed(bit: number, fromX: number, fromZ: number, x: number, z: number): boolean {
		if (network.allows(bit, x, z)) return true;
		return !network.allows(bit, fromX, fromZ) && network.allows(bit, x, z, RIDE_ESCAPE_MARGIN);
	}

	function stepRiding(dt: number) {
		const kind = riding!.kind;
		const spec = MODES[kind];
		const throttleKey = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
		const steerKey = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
		if ((throttleKey || steerKey) && autoRide) endAuto(false); // the rider took over
		const n = Math.max(1, Math.ceil(dt / RIDE_STEP));
		const h = dt / n;
		for (let i = 0; i < n; i++) {
			let throttle = throttleKey,
				steer = steerKey,
				maxSpeed: number | undefined;
			if (autoRide && follower) {
				const { along } = follower.project(px, pz);
				const remaining = follower.length - along;
				const look = Math.max(4, Math.min(14, Math.abs(ride.speed) * 0.9 + 3));
				const [tx, tz] = follower.pointAt(along + look);
				steer = pursuitSteer(kind, ride.speed, yaw, tx - px, tz - pz);
				const bend = follower.bendAhead(along, 18);
				const limit = currentLimit();
				maxSpeed = spec.topSpeed * (bend > 1.0 ? 0.32 : bend > 0.55 ? 0.5 : bend > 0.25 ? 0.75 : 0.92);
				if (limit) maxSpeed = Math.min(maxSpeed, limit / 3.6);
				maxSpeed = Math.min(maxSpeed, Math.max(1.6, remaining * 0.55));
				throttle = remaining < 1.2 ? -1 : 1;
				if (remaining < 1.2 && Math.abs(ride.speed) < 0.2) {
					ride.speed = 0;
					endAuto(true);
				}
			}
			const { dyaw, distance } = rideStep(kind, ride, { throttle, steer, maxSpeed }, h);
			yaw += dyaw;
			if (Math.abs(distance) < 1e-5) continue;
			const moved = moveCircle(collision, px, pz, Math.sin(yaw) * distance, Math.cos(yaw) * distance, spec.radius);
			let nx = moved.x,
				nz = moved.z;
			if (!rideAllowed(spec.bit, px, pz, nx, nz)) {
				// The kerb of the riding area: slide along it, or stop.
				if (rideAllowed(spec.bit, px, pz, nx, pz)) nz = pz;
				else if (rideAllowed(spec.bit, px, pz, px, nz)) nx = px;
				else {
					nx = px;
					nz = pz;
				}
				ride.speed *= 0.55;
			}
			if (moved.blocked) ride.speed *= 0.6;
			px = nx;
			pz = nz;
		}
		speed = Math.abs(ride.speed);
		if (autoRide) {
			autoStuck = speed < 0.3 ? autoStuck + dt : 0;
			if (autoStuck > 4) endAuto(false);
		}
		const ground = terrain.height(px, pz);
		if (vehicle) {
			vehicle.root.position.set(px, ground, pz);
			vehicle.root.rotation.y = yaw;
			vehicle.pose(ride.wheel, ride.steer, ride.lean);
			rider?.update(dt, ride.wheel);
		} else {
			player.position.set(px, ground, pz); // the model is still loading
			player.rotation.y = yaw;
		}
		shadowBlob.position.set(px, ground + 0.09, pz);
		shadowBlob.scale.set(1.15, 2.3, 1);
		shadowBlob.rotation.z = -yaw;
		// Chase camera: swings behind the vehicle unless the player orbited it a moment ago.
		if (performance.now() / 1000 - lastDrag > 1.5 && speed > 0.5) {
			let behind = yaw + Math.PI - camYaw;
			behind = Math.atan2(Math.sin(behind), Math.cos(behind));
			camYaw += behind * (1 - Math.exp(-dt * 2.2));
		}
		placeCamera(dt, ground + EYE + 0.35, Math.max(camDistance, 5.5) + speed * 0.12);
		updateWorld();
	}

	function currentLimit(): number | null {
		const road = network.roadAt(px, pz, riding ? MODES[riding.kind].bit : 0);
		return road?.vmax ?? null;
	}

	function emitState() {
		const { lat, lon } = projection.toLatLon(px, pz);
		const street = chunks.nearestStreet(px, pz);
		const landmark = chunks.nearestLandmark(px, pz);
		const bounds = collision.bounds!;
		const edge = Math.min(px - bounds.minX, bounds.maxX - px, pz - bounds.minZ, bounds.maxZ - pz);
		options.onState?.({
			x: px,
			z: pz,
			lat,
			lon,
			heading: compassHeading(Math.sin(yaw), Math.cos(yaw)),
			speed,
			street: street ? (khmer ? (street.name_km ?? street.name) : (street.name_en ?? street.name)) : null,
			streetAlt: street ? ((khmer ? street.name_en : street.name_km) ?? null) : null,
			landmark: landmark ? (landmark.name_en ?? landmark.name) : null,
			chunks: chunks.loadedCount,
			pending: chunks.pendingCount,
			fps,
			nearEdge: edge < 25,
			quality,
			clock: lighting.clock,
			timeMode: lighting.mode,
			night: lighting.night,
			ground: terrain.height(px, pz),
			workers: chunks.workerCount,
			...rideHud()
		});
	}

	function rideHud(): Pick<CityState, 'mode' | 'speedKmh' | 'speedLimit' | 'oneWay' | 'wrongWay' | 'nav'> {
		const mode: TravelMode = riding?.kind ?? 'foot';
		const bit = MODES[mode].bit;
		const oneWay = riding ? network.oneWayAt(bit, px, pz, ride.speed < 0 ? yaw + Math.PI : yaw) : null;
		let nav: CityState['nav'] = null;
		if (guide) {
			const p = guide.progress(px, pz);
			nav = {
				...p,
				text: p.arrived ? 'You have arrived' : p.next ? stepText(p.next) : 'Continue to the destination',
				auto: autoRide || (mode === 'foot' && route.length > 0)
			};
		}
		return {
			mode,
			speedKmh: Math.round(speed * 3.6),
			speedLimit: riding ? currentLimit() : null,
			oneWay: !!oneWay,
			wrongWay: !!oneWay?.against && speed > 1,
			nav
		};
	}

	// Frame-cost diagnostics (read by tests/perf/*.mjs via window.__ppwPerf).
	const perf: Record<string, number> = { step: 0, render: 0, frames: 0, maxStep: 0, maxRender: 0, calls: 0, triangles: 0, spikes: 0 };
	(globalThis as unknown as { __ppwPerf?: unknown }).__ppwPerf = Object.assign(perf, {
		chunks: () => chunks,
		scene,
		renderer,
		materials,
		daylight: () => daylightClouds.diagnostics(),
		programs: () => renderer.info.programs?.length ?? 0,
		/** The local avatar: style in use, model name, bone count, gait and motion (e2e checks). */
		avatar: () => {
			let bones = 0;
			player.traverse((n) => (bones += (n as THREE.Bone).isBone ? 1 : 0));
			const gait = (character.animations as { gait?: string }).gait ?? null;
			const lean = (character.animations as { lean?: { roll: number; pitch: number } }).lean ?? null;
			const foot = (name: string) => character.root.getObjectByName(name)?.getWorldPosition(new THREE.Vector3()).toArray() ?? null;
			const feet = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'].map((n) => foot('mixamorig' + n));
			const ground = player.position.y - hop.lift;
			return { style: character.style, model: character.root.name, bones, riding: !!rider, gait, emote: character.emotes.playing, speed, lift: hop.lift, yaw, lean, feet, ground };
		},
		audio: () => audio.diagnostics(),
		reset() {
			Object.assign(perf, { step: 0, render: 0, frames: 0, maxStep: 0, maxRender: 0, spikes: 0 });
			chunks.assembleMs = 0;
		}
	});

	function loop() {
		raf = requestAnimationFrame(loop);
		// Real elapsed time drives fps and slow-frame detection; the simulation step is clamped
		// (movement sub-steps keep large steps collision-safe) so slow machines still move at
		// close to real speed instead of in slow motion.
		const elapsed = clock.getDelta();
		const dt = Math.min(elapsed, 0.25);
		const t0 = performance.now();
		if (!paused) step(dt);
		// Menus stop movement, while asynchronous city streaming must keep progressing.
		chunks.update(px, pz);
		materials.time.value += dt;
		audioEnvironmentTimer += dt;
		if (audio.started && audioEnvironmentTimer > .75) {
			audioEnvironmentTimer = 0;
			nearbyWater = waterProximity(chunks.payloads(), px, pz);
			nearbyRoad = !!chunks.nearestStreet(px, pz, 30);
		}
		audio.update(dt, { x:px, z:pz, lift:hop.lift, speed:Math.abs(speed), indoor,
			night:lighting.night, riding:riding?.kind ?? null, paused, water:nearbyWater, road:nearbyRoad,
			propelling:keys.has('w') || keys.has('arrowup') || autoRide });
		daylightClouds.update(lighting.night);
		nightSky.update(lighting.night, materials.time.value, quality !== 'low');
		streetLighting.update(dt, px, pz, lighting.night, quality !== 'low' && indoor < 0.5, quality === 'medium' ? 2 : 4);
		avatarLighting.update(lighting.night, indoor);
		for (const callback of frameCallbacks) callback(dt);
		lightTimer += dt;
		if (lightTimer > 2) {
			lightTimer = 0;
			lighting.update();
		}
		const t1 = performance.now();
		renderer.render(scene, camera);
		const t2 = performance.now();
		perf.frames++;
		perf.step += t1 - t0;
		perf.render += t2 - t1;
		perf.maxStep = Math.max(perf.maxStep, t1 - t0);
		perf.maxRender = Math.max(perf.maxRender, t2 - t1);
		if (t2 - t1 > 50) perf.spikes = (perf.spikes ?? 0) + 1;
		perf.calls = renderer.info.render.calls;
		perf.triangles = renderer.info.render.triangles;
		frames++;
		stateTimer += elapsed;
		slowTime = qualityDebt(slowTime, elapsed);
		if (stateTimer >= 0.25) {
			setVehicleNight(lighting.night);
			fps = Math.round(frames / stateTimer);
			frames = 0;
			stateTimer = 0;
			emitState();
			// Sustained slow rendering: drop to low quality automatically.
			if (slowTime > 3 && quality !== 'low') {
				quality = lowerQuality(quality);
				slowTime = 0;
				applyQuality();
			}
		}
	}
	const startGround = terrain.height(px, pz);
	camera.position.set(px + Math.sin(camYaw) * camDistance, startGround + EYE + 3, pz + Math.cos(camYaw) * camDistance);
	loop();

	const controller: CityController = {
		audio,
		projection,
		scene,
		camera,
		terrain,
		collision,
		materials,
		avatar: player,
		setHolding(h) {
			holding = h;
		},
		walkTo(points, onDone) {
			if (route.length) endRoute(false);
			route = points.map(([x, z]) => [x, z]);
			routeDone = onDone;
			routeStuck = 0;
		},
		get walking() {
			return route.length > 0;
		},
		setGround(provider) {
			groundProvider = provider;
		},
		setCeiling(provider) {
			ceilingProvider = provider;
		},
		setInterior(view) {
			interior = view;
		},
		sit(s, standAt) {
			if (riding || seat) return false;
			if (route.length) endRoute(false);
			seat = { x: s.x, z: s.z, yaw: s.yaw, stand: standAt, phase: 'down', t: 0, fromX: px, fromZ: pz, fromYaw: yaw };
			character.emotes.stop();
			character.animations.posture?.('Sit');
			return true;
		},
		stand() {
			beginStand();
		},
		climb(points, lift, time, onDone) {
			if (riding || seat || climb || points.length < 2) return false;
			if (route.length) endRoute(false);
			character.emotes.stop();
			climb = { from: [px, pz], mid: points[0], to: points[1], lift, t: 0, time, done: onDone };
			return true;
		},
		get climbing() {
			return !!climb;
		},
		setJumpOverride(fn) {
			jumpOverride = fn;
		},
		get seated() {
			return !!seat;
		},
		invalidateShadows() {
			renderer.shadowMap.needsUpdate = true;
		},
		chunkData: () => chunks.payloads(),
		onFrame(callback) {
			frameCallbacks.add(callback);
			return () => frameCallbacks.delete(callback);
		},
		localState: () => ({ x: px, z: pz, yaw, speed }),
		network,
		get mode() {
			return riding?.kind ?? 'foot';
		},
		get riding() {
			return riding;
		},
		setRiding(next, x, z, newYaw) {
			const token = ++rideToken;
			if (route.length) endRoute(false);
			if (seat) character.animations.posture?.(null);
			seat = null;
			endAuto(false);
			rider?.detach(scene);
			rider = null;
			vehicle?.dispose();
			vehicle = null;
			riding = next;
			Object.assign(ride, rideState());
			px = x;
			pz = z;
			yaw = newYaw;
			speed = 0;
			player.position.set(px, terrain.height(px, pz), pz);
			player.rotation.set(0, yaw, 0);
			if (!next) return;
			createVehicle(next.kind, next.color).then((v) => {
				if (token !== rideToken || disposed) return v.dispose();
				vehicle = v;
				scene.add(v.root);
				player.rotation.set(0, 0, 0);
				rider = character.mount(v, player);
			});
		},
		parkingSpot(free) {
			if (!riding) return null;
			return network.nearestParkable(MODES[riding.kind].bit, px, pz, PULL_OVER_M - 0.5, free);
		},
		setRoute(next, destination) {
			endAuto(false);
			if (route.length) endRoute(false);
			navRoute = next;
			if (destination || !next) navDestination = destination ?? null;
			guide = next ? new RouteGuide(next) : null;
			follower = null;
			if (!next) return routeLine.set(null);
			routeLine.set(lanePath(next), navDestination ?? [next.to.x, next.to.z]);
		},
		get route() {
			return navRoute;
		},
		followRoute(onDone) {
			if (!navRoute) return onDone?.(false);
			const path = lanePath(navRoute);
			const f = new PathFollower(path);
			const { along } = f.project(px, pz);
			if (!riding) {
				// Walk it with the normal autopilot: from the nearest point on, then the end.
				const ahead = path.filter((_, i) => f.cum[i] > along + 1);
				const end: XZ[] = [[navRoute.to.x, navRoute.to.z]];
				if (navDestination) end.push(navDestination); // off the road: walk the last metres
				return controller.walkTo([...ahead, ...end], onDone);
			}
			follower = f;
			autoRide = true;
			autoStuck = 0;
			autoDone = onDone;
		},
		get following() {
			return autoRide || route.length > 0;
		},
		setPosition(x, z, newYaw) {
			if (climb) {
				const done = climb.done;
				climb = null;
				done?.(false);
			}
			const far = Math.hypot(x - px, z - pz) > 30;
			if (far && route.length) endRoute(false);
			px = x;
			pz = z;
			if (newYaw !== undefined) {
				yaw = newYaw;
				if (far) camYaw = yaw + Math.PI;
			}
			speed = 0;
			ride.speed = 0;
			if (far) {
				endAuto(false);
				if (seat) character.animations.posture?.(null);
				seat = null;
				footY = NaN;
				const g = terrain.height(px, pz);
				camera.position.set(px + Math.sin(camYaw) * camDistance, g + EYE + 3, pz + Math.cos(camYaw) * camDistance);
				chunks.update(px, pz);
			}
		},
		playEmote(name) {
			if (!riding) character.emotes.play(name);
		},
		get outfit() {
			return boot.player.avatar;
		},
		async setAvatar(avatar) {
			boot.player.avatar = avatar;
			if (!character.update(avatar)) await rebuild();
		},
		setShowcase(view) {
			if (view && !showcase) {
				beforeShowcase = { pitch: camPitch, distance: camDistance };
				keys.clear();
				if (route.length) endRoute(false);
				camYaw = yaw; // in front, facing the player
			} else if (!view && showcase) {
				camYaw = yaw + Math.PI;
				camPitch = beforeShowcase?.pitch ?? 0.38;
				camDistance = beforeShowcase?.distance ?? 7.5;
				beforeShowcase = null;
			}
			if (view) {
				camPitch = view.pitch ?? 0.1;
				camDistance = view.distance ?? 3.3;
			}
			showcase = view ? { right: view.right ?? 0, down: view.down ?? 0 } : null;
		},
		get quality() {
			return quality;
		},
		get avatarStyle() {
			return character.style;
		},
		setQuality(q) {
			quality = q;
			slowTime = 0;
			applyQuality();
		},
		setTimeMode(mode) {
			lighting.mode = mode;
			lighting.update();
			emitState();
		},
		setPaused(p) {
			paused = p;
			if (p) keys.clear();
		},
		async teleport(x, z, headingDeg) {
			climb = null;
			await chunks.preload(x, z, 220);
			({ x: px, z: pz } = escapeFootprint(collision, x, z, RADIUS));
			if (headingDeg !== undefined) {
				yaw = yawForHeading(headingDeg);
				camYaw = yaw + Math.PI;
			}
			speed = 0;
			Object.assign(hop, grounded());
			if (seat) character.animations.posture?.(null);
			seat = null;
			footY = NaN;
			const g = terrain.height(px, pz);
			camera.position.set(px + Math.sin(camYaw) * camDistance, g + EYE + 3, pz + Math.cos(camYaw) * camDistance);
		},
		setKey(key, down) {
			if (key === ' ') {
				if (down) jump();
				return;
			}
			if (down) keys.add(key);
			else keys.delete(key);
		},
		drawMinimap(ctx, size, mpp) {
			drawMinimap(ctx, size, mpp, chunks, px, pz, yaw, navRoute?.points ?? null);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			cancelAnimationFrame(raf);
			frameCallbacks.clear();
			observer.disconnect();
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('blur', onBlur);
			chunks.dispose();
			routeLine.dispose();
			rider?.detach(null);
			vehicle?.dispose();
			character.dispose();
			hills.traverse((n) => (n as THREE.Mesh).geometry?.dispose());
			materials.dispose();
			props.dispose();
			groundPlane.geometry.dispose();
			(groundPlane.material as THREE.Material).dispose();
			shadowBlob.geometry.dispose();
			(shadowBlob.material as THREE.Material).dispose();
			sky.geometry.dispose();
			sky.material.dispose();
			lighting.dispose();
			audio.dispose();
			nightSky.dispose();
			daylightClouds.dispose();
			streetLighting.dispose();
			avatarLighting.dispose();
			sun.shadow.dispose();
			renderer.dispose();
			renderer.domElement.remove();
		}
	};
	return controller;
}

/**
 * The minimap is see-through glass over the city (the page blurs what is behind it): a light
 * tint of dark teal, light roads (saffron for the main ones), faint buildings, tinted water and
 * parks. Only the player's arrow and a route are solid.
 */
const MINI_ROADS: Record<string, [string, number]> = {
	trunk: ['#e8a33d', 7], primary: ['#e8a33d', 6], secondary: ['rgba(244, 207, 142, 0.9)', 5], tertiary: ['rgba(255, 250, 240, 0.85)', 4],
	residential: ['rgba(255, 250, 240, 0.75)', 3], unclassified: ['rgba(255, 250, 240, 0.75)', 3], living_street: ['rgba(255, 250, 240, 0.75)', 3],
	service: ['rgba(255, 250, 240, 0.4)', 2], pedestrian: ['rgba(244, 207, 142, 0.45)', 2.5], footway: ['rgba(244, 207, 142, 0.35)', 1.5]
};
const MINI_AREAS: Record<string, string> = {
	water: 'rgba(76, 158, 178, 0.6)', park: 'rgba(104, 158, 88, 0.5)', grass: 'rgba(116, 168, 96, 0.45)', pitch: 'rgba(116, 168, 96, 0.45)',
	temple_grounds: 'rgba(232, 200, 140, 0.35)', plaza: 'rgba(255, 250, 240, 0.12)'
};

function drawMinimap(
	ctx: CanvasRenderingContext2D,
	size: number,
	mpp: number,
	chunks: ChunkManager,
	px: number,
	pz: number,
	yaw: number,
	routePoints: XZ[] | null
) {
	const half = size / 2;
	const tx = (x: number) => half + (x - px) / mpp;
	const tz = (z: number) => half + (z - pz) / mpp;
	ctx.clearRect(0, 0, size, size);
	ctx.fillStyle = 'rgba(11, 37, 36, 0.42)';
	ctx.fillRect(0, 0, size, size);
	const payloads = chunks.payloads();
	const fillRings = (rings: [number, number][][]) => {
		ctx.beginPath();
		for (const ring of rings) ring.forEach(([x, z], i) => (i ? ctx.lineTo(tx(x), tz(z)) : ctx.moveTo(tx(x), tz(z))));
		ctx.fill('evenodd');
	};
	for (const p of payloads)
		for (const a of p.areas) {
			const c = MINI_AREAS[a.kind];
			if (!c) continue;
			ctx.fillStyle = c;
			for (const poly of a.polys) fillRings(poly);
		}
	ctx.fillStyle = 'rgba(255, 250, 240, 0.2)';
	for (const p of payloads) for (const bld of p.buildings) for (const poly of bld.polys) fillRings(poly);
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	for (const p of payloads)
		for (const r of p.roads) {
			const [color, w] = MINI_ROADS[r.cls.replace(/_link$/, '')] ?? ['rgba(255, 250, 240, 0.4)', 1.5];
			ctx.strokeStyle = color;
			ctx.lineWidth = Math.max(1, (w * 3) / (mpp * 2));
			ctx.beginPath();
			r.pts.forEach(([x, z], i) => (i ? ctx.lineTo(tx(x), tz(z)) : ctx.moveTo(tx(x), tz(z))));
			ctx.stroke();
		}
	if (routePoints && routePoints.length > 1) {
		ctx.strokeStyle = '#f0703f';
		ctx.lineWidth = 3.5;
		ctx.beginPath();
		routePoints.forEach(([x, z], i) => (i ? ctx.lineTo(tx(x), tz(z)) : ctx.moveTo(tx(x), tz(z))));
		ctx.stroke();
		const [ex, ez] = routePoints[routePoints.length - 1];
		ctx.fillStyle = '#f0703f';
		ctx.beginPath();
		ctx.arc(tx(ex), tz(ez), 5, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.save();
	ctx.translate(half, half);
	ctx.rotate(Math.PI - yaw);
	// A soft cone where the player faces, then the arrow.
	const cone = ctx.createRadialGradient(0, 0, 4, 0, 0, 46);
	cone.addColorStop(0, 'rgba(255, 250, 240, 0.32)');
	cone.addColorStop(1, 'rgba(255, 250, 240, 0)');
	ctx.fillStyle = cone;
	ctx.beginPath();
	ctx.moveTo(0, 0);
	ctx.arc(0, 0, 46, -Math.PI / 2 - 0.6, -Math.PI / 2 + 0.6);
	ctx.closePath();
	ctx.fill();
	ctx.fillStyle = '#fffaf0';
	ctx.strokeStyle = '#0b2524';
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(0, -9);
	ctx.lineTo(6.5, 7);
	ctx.lineTo(0, 3.5);
	ctx.lineTo(-6.5, 7);
	ctx.closePath();
	ctx.fill();
	ctx.stroke();
	ctx.restore();
}

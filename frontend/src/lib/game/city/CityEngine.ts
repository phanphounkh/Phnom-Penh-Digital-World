/**
 * The playable 3D city: renderer, day/night lighting, terrain, streamed OSM chunks (built in
 * Web Workers), Blender props and landmarks, the player's avatar, third-person camera,
 * keyboard/touch controls and collision. Phase 5: riding a bicycle or motorbike (physics,
 * staying on the streets, chase camera), route guidance and the riding/walking autopilot.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { WorldBootstrap } from '$lib/api/types';
import { WorldProjection, compassHeading, yawForHeading } from '$lib/geo/projection';
import { createAvatar, type AvatarInstance } from '$lib/game/avatar/avatar';
import { PlayerAnimations } from '$lib/game/player/PlayerAnimations.js';
import { EmotePlayer } from '$lib/game/avatar/emotes';
import type { EmoteName } from '$lib/game/net/protocol';
import { ChunkManager } from './ChunkManager';
import { CollisionWorld, escapeFootprint, moveCircle, rayFraction } from './collision';
import { DayNight, type TimeMode } from './lighting';
import { CityMaterials } from './materials';
import { PropLibrary } from './props';
import { Terrain, type Mound } from './terrain';
import type { XZ } from '$lib/api/types';
import { RoadNetwork } from '$lib/game/vehicles/RoadNetwork';
import { createVehicle, setVehicleNight, type VehicleInstance } from '$lib/game/vehicles/VehicleModels';
import { Rider } from '$lib/game/vehicles/Rider';
import { pursuitSteer, rideState, rideStep } from '$lib/game/vehicles/kinematics';
import { MODES, PULL_OVER_M, type TravelMode, type VehicleKind } from '$lib/game/vehicles/specs';
import { RouteLine } from '$lib/game/vehicles/RouteLine';
import { PathFollower, RouteGuide, lanePath, stepText, type Progress, type Route } from '$lib/game/vehicles/route';

export type Quality = 'high' | 'low';
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

const WALK = 2.6;
const RUN = 6.5;
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
	let quality: Quality = options.quality ?? 'high';
	const khmer = !!options.preferKhmer;

	// ── renderer & scene ──────────────────────────────────────────────────────────────
	const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.62;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	// Shadows are cached: re-rendered only when the snapped shadow window moves, the light
	// changes or chunks change, not every frame (the biggest GPU cost on integrated graphics).
	renderer.shadowMap.autoUpdate = false;
	host.appendChild(renderer.domElement);
	renderer.domElement.style.touchAction = 'none';

	const scene = new THREE.Scene();
	const fog = new THREE.Fog('#c9d8db', 260, 760);
	scene.fog = fog;
	const camera = new THREE.PerspectiveCamera(55, 1, 0.3, 2500);

	const sky = new Sky();
	sky.scale.setScalar(4000);
	const skyUniforms = sky.material.uniforms;
	skyUniforms.turbidity.value = 7;
	skyUniforms.rayleigh.value = 1.4;
	skyUniforms.mieCoefficient.value = 0.004;
	skyUniforms.mieDirectionalG.value = 0.82;
	scene.add(sky);

	const hemi = new THREE.HemisphereLight('#dfeaf0', '#8c806a', 1.5);
	scene.add(hemi);
	const sun = new THREE.DirectionalLight('#fff0d4', 3.1);
	sun.shadow.mapSize.set(2048, 2048);
	Object.assign(sun.shadow.camera, { left: -75, right: 75, top: 75, bottom: -75, near: 10, far: 400 });
	sun.shadow.bias = -0.0004;
	sun.shadow.normalBias = 0.5;
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
	const props = new PropLibrary();
	await props.load();
	const hills = terrainMesh(terrain, materials.terrain);
	scene.add(hills);
	const collision = new CollisionWorld();
	collision.bounds = { minX: b.min_x + 3, minZ: b.min_z + 3, maxX: b.max_x - 3, maxZ: b.max_z - 3 };
	const chunks = new ChunkManager(scene, projection, collision, materials, props, terrain, new Set(region.chunk_keys), {
		preferKhmer: khmer,
		shadows: quality === 'high'
	});
	const lighting = new DayNight(
		{ renderer, scene, sun, hemi, sky, fog, materials, props },
		config.origin.lat,
		config.origin.lon
	);
	lighting.mode = options.timeMode ?? 'live';
	lighting.update();

	// ── player ────────────────────────────────────────────────────────────────────────
	const avatar: AvatarInstance = await createAvatar(boot.player.avatar, { batch: true });
	const player = avatar.root;
	// The avatar uses the contact blob below instead of the cached shadow map.
	player.traverse((n) => ((n as THREE.Mesh).castShadow = false));
	scene.add(player);
	const animations = new PlayerAnimations(player);
	const emotes = new EmotePlayer(player);
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
	// Riding (Phase 5).
	const network = new RoadNetwork();
	let riding: RidingVehicle | null = null;
	let vehicle: VehicleInstance | null = null;
	let rider: Rider | null = null;
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
		return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
	};
	const onKeyDown = (e: KeyboardEvent) => {
		if (typing(e)) return;
		const k = e.key.toLowerCase();
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
		renderer.setPixelRatio(quality === 'high' ? Math.min(devicePixelRatio, 1.5) : 0.75);
		renderer.shadowMap.enabled = quality === 'high';
		sun.castShadow = quality === 'high';
		shadowBlob.visible = true;
		chunks.detailRadius = quality === 'high' ? 240 : 160;
		renderer.shadowMap.needsUpdate = true;
		chunks.radius = quality === 'high' ? 420 : 300;
		chunks.shadows = quality === 'high';
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
		if (riding) return stepRiding(dt);
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
		const target = len > 0 ? (keys.has('shift') || autoRun ? RUN : WALK) : 0;
		speed += (target - speed) * (1 - Math.exp(-dt * 8));
		let travel = 0;
		if (len > 0) {
			mx /= len;
			mz /= len;
			let delta = Math.atan2(mx, mz) - yaw;
			delta = Math.atan2(Math.sin(delta), Math.cos(delta));
			yaw += delta * (1 - Math.exp(-dt * 12));
		}
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
		const ground = terrain.height(px, pz);
		player.position.set(px, ground, pz);
		player.rotation.y = yaw;
		shadowBlob.position.set(px, ground + 0.09, pz);
		animations.update(dt, dt > 0 ? travel / dt : 0, holding, false, null, travel, 1);
		emotes.update(dt, speed > 0.3);

		shadowBlob.scale.set(1, 1, 1);
		placeCamera(dt, ground + EYE, camDistance);
		updateWorld();
	}

	/** Camera: orbit, pulled in when a building stands between it and the player. */
	function placeCamera(dt: number, head: number, distance: number) {
		desired.set(
			px + Math.sin(camYaw) * Math.cos(camPitch) * distance,
			head + Math.sin(camPitch) * distance,
			pz + Math.cos(camYaw) * Math.cos(camPitch) * distance
		);
		const f = rayFraction(collision, px, head, pz, desired.x, desired.y, desired.z);
		if (f < 1) {
			const k = Math.max(0.18, f - 0.4 / distance);
			desired.set(px + (desired.x - px) * k, head + (desired.y - head) * k, pz + (desired.z - pz) * k);
		}
		desired.y = Math.max(desired.y, terrain.height(desired.x, desired.z) + 0.8);
		camera.position.lerp(desired, 1 - Math.exp(-dt * (f < 1 ? 20 : 8)));
		camera.position.y = Math.max(camera.position.y, terrain.height(camera.position.x, camera.position.z) + 0.6);
		cameraTarget.set(px, head, pz);
		camera.lookAt(cameraTarget);
	}

	/** Streaming, the cached shadow window and the route line follow the player. */
	function updateWorld() {
		routeLine.update(1 / 60);
		chunks.update(px, pz);
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
		programs: () => renderer.info.programs?.length ?? 0,
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
		if (elapsed > 1 / 24) slowTime += elapsed;
		if (stateTimer >= 0.25) {
			setVehicleNight(lighting.night);
			fps = Math.round(frames / stateTimer);
			frames = 0;
			stateTimer = 0;
			emitState();
			// Sustained slow rendering: drop to low quality automatically.
			if (slowTime > 3 && quality === 'high') {
				quality = 'low';
				applyQuality();
			}
			slowTime = Math.max(0, slowTime - 0.25);
		}
	}
	const startGround = terrain.height(px, pz);
	camera.position.set(px + Math.sin(camYaw) * camDistance, startGround + EYE + 3, pz + Math.cos(camYaw) * camDistance);
	loop();

	const controller: CityController = {
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
				rider = new Rider(player, animations, v);
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
				const g = terrain.height(px, pz);
				camera.position.set(px + Math.sin(camYaw) * camDistance, g + EYE + 3, pz + Math.cos(camYaw) * camDistance);
				chunks.update(px, pz);
			}
		},
		playEmote(name) {
			if (!riding) emotes.play(name);
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
			await chunks.preload(x, z, 220);
			({ x: px, z: pz } = escapeFootprint(collision, x, z, RADIUS));
			if (headingDeg !== undefined) {
				yaw = yawForHeading(headingDeg);
				camYaw = yaw + Math.PI;
			}
			speed = 0;
			const g = terrain.height(px, pz);
			camera.position.set(px + Math.sin(camYaw) * camDistance, g + EYE + 3, pz + Math.cos(camYaw) * camDistance);
		},
		setKey(key, down) {
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
			animations.dispose();
			avatar.dispose();
			hills.traverse((n) => (n as THREE.Mesh).geometry?.dispose());
			materials.dispose();
			props.dispose();
			groundPlane.geometry.dispose();
			(groundPlane.material as THREE.Material).dispose();
			shadowBlob.geometry.dispose();
			(shadowBlob.material as THREE.Material).dispose();
			sky.geometry.dispose();
			sky.material.dispose();
			renderer.dispose();
			renderer.domElement.remove();
		}
	};
	return controller;
}

const MINI_ROADS: Record<string, [string, number]> = {
	trunk: ['#e8a33d', 7], primary: ['#e8a33d', 6], secondary: ['#f4cf8e', 5], tertiary: ['#ffffff', 4],
	residential: ['#ffffff', 3], unclassified: ['#ffffff', 3], living_street: ['#ffffff', 3],
	service: ['#e9e2d2', 2], pedestrian: ['#e6d8b8', 2.5], footway: ['#e6d8b8', 1.5]
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
	ctx.fillStyle = '#d8d0bf';
	ctx.fillRect(0, 0, size, size);
	const payloads = chunks.payloads();
	const fillRings = (rings: [number, number][][]) => {
		ctx.beginPath();
		for (const ring of rings) ring.forEach(([x, z], i) => (i ? ctx.lineTo(tx(x), tz(z)) : ctx.moveTo(tx(x), tz(z))));
		ctx.fill('evenodd');
	};
	const AREA: Record<string, string> = { water: '#7fb3bb', park: '#9fbb83', grass: '#a9c48a', pitch: '#a9c48a', temple_grounds: '#e5d3a8', plaza: '#e6dcc6' };
	for (const p of payloads)
		for (const a of p.areas) {
			const c = AREA[a.kind];
			if (!c) continue;
			ctx.fillStyle = c;
			for (const poly of a.polys) fillRings(poly);
		}
	ctx.fillStyle = '#b3a993';
	for (const p of payloads) for (const bld of p.buildings) for (const poly of bld.polys) fillRings(poly);
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	for (const p of payloads)
		for (const r of p.roads) {
			const [color, w] = MINI_ROADS[r.cls.replace(/_link$/, '')] ?? ['#f1ece0', 1.5];
			ctx.strokeStyle = color;
			ctx.lineWidth = Math.max(1, (w * 3) / (mpp * 2));
			ctx.beginPath();
			r.pts.forEach(([x, z], i) => (i ? ctx.lineTo(tx(x), tz(z)) : ctx.moveTo(tx(x), tz(z))));
			ctx.stroke();
		}
	if (routePoints && routePoints.length > 1) {
		ctx.strokeStyle = '#c4552f';
		ctx.lineWidth = 3.5;
		ctx.beginPath();
		routePoints.forEach(([x, z], i) => (i ? ctx.lineTo(tx(x), tz(z)) : ctx.moveTo(tx(x), tz(z))));
		ctx.stroke();
		const [ex, ez] = routePoints[routePoints.length - 1];
		ctx.fillStyle = '#c4552f';
		ctx.beginPath();
		ctx.arc(tx(ex), tz(ez), 5, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.save();
	ctx.translate(half, half);
	ctx.rotate(Math.PI - yaw);
	ctx.fillStyle = '#c4552f';
	ctx.strokeStyle = '#fff';
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

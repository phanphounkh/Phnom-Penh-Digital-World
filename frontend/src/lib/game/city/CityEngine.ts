/**
 * The playable 3D city: renderer, lighting, streamed OSM chunks, the player's avatar,
 * third-person camera, keyboard/touch controls and collision.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { WorldBootstrap } from '$lib/api/types';
import { WorldProjection, compassHeading, yawForHeading } from '$lib/geo/projection';
import { createAvatar, type AvatarInstance } from '$lib/game/avatar/avatar';
import { PlayerAnimations } from '$lib/game/player/PlayerAnimations.js';
import { CityMaterials } from './builders';
import { ChunkManager } from './ChunkManager';
import { CollisionWorld, escapeFootprint, moveCircle, rayFraction } from './collision';

export type Quality = 'high' | 'low';

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
}

export interface CityController {
	readonly projection: WorldProjection;
	setQuality(q: Quality): void;
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
}

const WALK = 2.6;
const RUN = 6.5;
const RADIUS = 0.35;
const EYE = 1.55;
const SUN_OFFSET = new THREE.Vector3(-80, 95, 38); // late afternoon, from the WSW

export async function createCity(
	host: HTMLElement,
	boot: WorldBootstrap,
	options: CityOptions = {}
): Promise<CityController> {
	const config = boot.config;
	const region = config.regions.find((r) => r.slug === boot.spawn.region) ?? config.regions[0];
	const projection = WorldProjection.fromConfig(config);
	let quality: Quality = options.quality ?? 'high';
	const khmer = !!options.preferKhmer;

	// ── renderer & scene ──────────────────────────────────────────────────────────────
	const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.62;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	host.appendChild(renderer.domElement);
	renderer.domElement.style.touchAction = 'none';

	const scene = new THREE.Scene();
	scene.fog = new THREE.Fog('#c9d8db', 260, 760);
	const camera = new THREE.PerspectiveCamera(55, 1, 0.3, 2500);

	const sky = new Sky();
	sky.scale.setScalar(4000);
	const skyUniforms = sky.material.uniforms;
	skyUniforms.turbidity.value = 7;
	skyUniforms.rayleigh.value = 1.4;
	skyUniforms.mieCoefficient.value = 0.004;
	skyUniforms.mieDirectionalG.value = 0.82;
	skyUniforms.sunPosition.value.copy(SUN_OFFSET).normalize();
	scene.add(sky);

	scene.add(new THREE.HemisphereLight('#dfeaf0', '#8c806a', 1.5));
	const sun = new THREE.DirectionalLight('#fff0d4', 3.1);
	sun.castShadow = true;
	sun.shadow.mapSize.set(2048, 2048);
	Object.assign(sun.shadow.camera, { left: -75, right: 75, top: 75, bottom: -75, near: 10, far: 320 });
	sun.shadow.bias = -0.0004;
	sun.shadow.normalBias = 0.5;
	scene.add(sun, sun.target);

	const b = region.world_bounds;
	const margin = 700;
	const ground = new THREE.Mesh(
		new THREE.PlaneGeometry(b.max_x - b.min_x + margin * 2, b.max_z - b.min_z + margin * 2),
		new THREE.MeshStandardMaterial({ color: '#a59b86', roughness: 1 })
	);
	ground.rotation.x = -Math.PI / 2;
	ground.position.set((b.min_x + b.max_x) / 2, 0, (b.min_z + b.max_z) / 2);
	ground.receiveShadow = true;
	scene.add(ground);

	// ── world data ────────────────────────────────────────────────────────────────────
	const collision = new CollisionWorld();
	collision.bounds = { minX: b.min_x + 3, minZ: b.min_z + 3, maxX: b.max_x - 3, maxZ: b.max_z - 3 };
	const materials = new CityMaterials();
	const chunks = new ChunkManager(
		scene,
		projection,
		collision,
		materials,
		new Set(region.chunk_keys),
		!!options.preferKhmer
	);

	// ── player ────────────────────────────────────────────────────────────────────────
	const avatar: AvatarInstance = await createAvatar(boot.player.avatar, { batch: true });
	const player = avatar.root;
	scene.add(player);
	const animations = new PlayerAnimations(player);
	const shadowBlob = new THREE.Mesh(
		new THREE.CircleGeometry(0.42, 24),
		new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.22, depthWrite: false })
	);
	shadowBlob.rotation.x = -Math.PI / 2;
	shadowBlob.position.y = 0.09;
	scene.add(shadowBlob);

	let px = boot.spawn.x;
	let pz = boot.spawn.z;
	let yaw = yawForHeading(boot.spawn.heading_deg);
	let speed = 0;
	let camYaw = yaw + Math.PI; // behind the player
	let camPitch = 0.38;
	let camDistance = 7.5;
	const cameraTarget = new THREE.Vector3();

	const total = projection.keysAround(px, pz, 220).filter((k) => region.chunk_keys.includes(k)).length;
	let done = 0;
	options.onProgress?.(0, total);
	await Promise.all(
		projection
			.keysAround(px, pz, 220)
			.filter((k) => region.chunk_keys.includes(k))
			.map((k) => chunks.preload(...centreOf(k)).then(() => options.onProgress?.(++done, total)))
	);
	({ x: px, z: pz } = escapeFootprint(collision, px, pz, RADIUS));

	function centreOf(key: string): [number, number, number] {
		const [ix, iz] = key.split('_').map(Number);
		return [(ix + 0.5) * projection.chunkSize, (iz + 0.5) * projection.chunkSize, 1];
	}

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
		shadowBlob.visible = quality === 'low';
		chunks.radius = quality === 'high' ? 420 : 300;
		scene.traverse((n) => {
			const m = (n as THREE.Mesh).material as THREE.Material | undefined;
			if (m) m.needsUpdate = true;
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
	let frames = 0;
	let fps = 60;
	let slowTime = 0;
	const desired = new THREE.Vector3();

	function step(dt: number) {
		const forward = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
		const strafe = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
		const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
		let mx = fx * forward + -fz * strafe;
		let mz = fz * forward + fx * strafe;
		const len = Math.hypot(mx, mz);
		const target = len > 0 ? (keys.has('shift') ? RUN : WALK) : 0;
		speed += (target - speed) * (1 - Math.exp(-dt * 8));
		let travel = 0;
		if (len > 0) {
			mx /= len;
			mz /= len;
			const want = Math.atan2(mx, mz);
			let delta = want - yaw;
			delta = Math.atan2(Math.sin(delta), Math.cos(delta));
			yaw += delta * (1 - Math.exp(-dt * 12));
		}
		if (speed > 0.02) {
			const dirX = Math.sin(yaw), dirZ = Math.cos(yaw);
			const result = moveCircle(collision, px, pz, dirX * speed * dt, dirZ * speed * dt, RADIUS);
			travel = Math.hypot(result.x - px, result.z - pz);
			px = result.x;
			pz = result.z;
		}
		const actual = dt > 0 ? travel / dt : 0;
		player.position.set(px, 0, pz);
		player.rotation.y = yaw;
		shadowBlob.position.x = px;
		shadowBlob.position.z = pz;
		animations.update(dt, actual, false, false, null, travel, 1);

		// Camera: orbit, pulled in when a building stands between it and the player.
		const head = EYE;
		desired.set(
			px + Math.sin(camYaw) * Math.cos(camPitch) * camDistance,
			head + Math.sin(camPitch) * camDistance,
			pz + Math.cos(camYaw) * Math.cos(camPitch) * camDistance
		);
		const f = rayFraction(collision, px, head, pz, desired.x, desired.y, desired.z);
		if (f < 1) {
			const k = Math.max(0.18, f - 0.4 / camDistance);
			desired.set(px + (desired.x - px) * k, head + (desired.y - head) * k, pz + (desired.z - pz) * k);
			camera.position.lerp(desired, 1 - Math.exp(-dt * 20));
		} else camera.position.lerp(desired, 1 - Math.exp(-dt * 8));
		camera.position.y = Math.max(0.6, camera.position.y);
		cameraTarget.set(px, head, pz);
		camera.lookAt(cameraTarget);

		sun.position.set(px + SUN_OFFSET.x, SUN_OFFSET.y, pz + SUN_OFFSET.z);
		sun.target.position.set(px, 0, pz);
		chunks.update(px, pz);
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
			streetAlt: street ? (khmer ? street.name_en : street.name_km) ?? null : null,
			landmark: landmark ? (landmark.name_en ?? landmark.name) : null,
			chunks: chunks.loadedCount,
			pending: chunks.pendingCount,
			fps,
			nearEdge: edge < 25,
			quality
		});
	}

	function loop() {
		raf = requestAnimationFrame(loop);
		const dt = Math.min(clock.getDelta(), 0.1);
		if (!paused) step(dt);
		renderer.render(scene, camera);
		frames++;
		stateTimer += dt;
		if (dt > 1 / 24) slowTime += dt;
		if (stateTimer >= 0.25) {
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
	camera.position.set(px + Math.sin(camYaw) * camDistance, EYE + 3, pz + Math.cos(camYaw) * camDistance);
	loop();

	return {
		projection,
		setQuality(q) {
			quality = q;
			slowTime = 0;
			applyQuality();
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
			camera.position.set(px + Math.sin(camYaw) * camDistance, EYE + 3, pz + Math.cos(camYaw) * camDistance);
		},
		setKey(key, down) {
			if (down) keys.add(key);
			else keys.delete(key);
		},
		drawMinimap(ctx, size, mpp) {
			drawMinimap(ctx, size, mpp, chunks, px, pz, yaw);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			cancelAnimationFrame(raf);
			observer.disconnect();
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('blur', onBlur);
			chunks.dispose();
			animations.dispose();
			avatar.dispose();
			materials.dispose();
			ground.geometry.dispose();
			(ground.material as THREE.Material).dispose();
			shadowBlob.geometry.dispose();
			(shadowBlob.material as THREE.Material).dispose();
			sky.geometry.dispose();
			sky.material.dispose();
			renderer.dispose();
			renderer.domElement.remove();
		}
	};
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
	yaw: number
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
	// Player arrow (north-up map).
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

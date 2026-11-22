/**
 * Enterable buildings in the city: loaded when the player comes near, with a real doorway,
 * a hinged door (E to open and close; its collision follows the leaf), an interior lit by a
 * baked lightmap, an indoor camera, and seats (E to sit down and stand up).
 *
 * A building is a GLB plus a JSON spec (spec.ts) made by tools/blender/generate_house.py; where
 * it stands comes from `placements.ts`. Nothing here talks to the server: door state is local
 * (door.ts keeps it as a shareable value for when doors are synced between players).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { CollisionWorld } from '$lib/game/city/collision';
import type { Terrain } from '$lib/game/city/terrain';
import { DOOR_REACH, Door, facing } from './door';
import { PLACEMENTS } from './placements';
import { Frame, floorAt, isInside, type BuildingPlacement, type BuildingSpec, type SeatSpec } from './spec';

/** Load within this distance (m) of the building, unload beyond the second. */
export const LOAD_RADIUS = 160;
export const UNLOAD_RADIUS = 230;
/** Seats: how close to the spot in front of the seat the player must be. */
export const SEAT_REACH = 1.4;
/** Indoor camera: the furthest the camera may sit from the avatar. */
const INDOOR_DISTANCE = 3.2;
const PLAYER_RADIUS = 0.35;
/** Brightness of the baked interior under the city's tone mapping (the bake is physically lit,
 * the street is lit by a stronger game sun). */
export const INTERIOR_GAIN = 1.9;
/** Bulbs and lamp shades glow at full brightness instead of taking the lightmap. */
const GLOWING = new Set(['Int_Bulb', 'Int_LampShade']);

/** What the building system needs from the city engine (CityController provides it). */
export interface BuildingHost {
	readonly scene: THREE.Scene;
	readonly collision: CollisionWorld;
	readonly terrain: Terrain;
	/** The city's shared night factor uniform (0 day … 1 night): picks day or night lightmap. */
	readonly materials?: { readonly night: { value: number } };
	readonly seated: boolean;
	setGround(provider: ((x: number, z: number) => number | null) | null): void;
	setInterior(view: { ceiling: number; maxDistance: number } | null): void;
	sit(seat: { x: number; z: number; yaw: number }, standAt: [number, number]): boolean;
	stand(): void;
	walkTo(points: [number, number][], onDone?: (arrived: boolean) => void): void;
	invalidateShadows(): void;
}

export type BuildingInteraction =
	| { kind: 'door'; label: string; building: string }
	| { kind: 'sit'; label: string; building: string; seat: string }
	| { kind: 'stand'; label: string; building: string };

interface Loaded {
	placement: BuildingPlacement;
	spec: BuildingSpec;
	frame: Frame;
	root: THREE.Group;
	door: Door;
	doorNode: THREE.Object3D | null;
	fanNode: THREE.Object3D | null;
	owner: string;
	doorOwner: string;
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const textures = new THREE.TextureLoader();

export class Buildings {
	private loaded = new Map<string, Loaded>();
	private loading = new Set<string>();
	private current: BuildingInteraction | null = null;
	private inside: string | null = null;
	private disposed = false;
	/** The seat the player sits on (or is walking to). */
	private seatedOn: { building: string; seat: SeatSpec } | null = null;

	constructor(
		private host: BuildingHost,
		private onInteraction?: (interaction: BuildingInteraction | null) => void,
		private placements: BuildingPlacement[] = PLACEMENTS
	) {
		host.setGround((x, z) => this.floorAt(x, z));
	}

	/** The interaction the E key would perform now. */
	get interaction(): BuildingInteraction | null {
		return this.current;
	}

	/** The building the player is inside (id), if any. */
	get insideOf(): string | null {
		return this.inside;
	}

	/** Loaded buildings (inspection and tests). */
	get list(): { id: string; door: { open: boolean; t: number }; frame: Frame; spec: BuildingSpec }[] {
		return [...this.loaded.values()].map((b) => ({ id: b.placement.id, door: { open: b.door.open, t: b.door.t }, frame: b.frame, spec: b.spec }));
	}

	floorAt(x: number, z: number): number | null {
		for (const b of this.loaded.values()) {
			const h = floorAt(b.spec, b.frame, x, z);
			if (h !== null) return h;
		}
		return null;
	}

	/** Per frame, after the player moved. */
	update(dt: number, px: number, pz: number, yaw: number): void {
		if (this.disposed) return;
		for (const p of this.placements) {
			const d = Math.hypot(p.x - px, p.z - pz);
			if (d < LOAD_RADIUS && !this.loaded.has(p.id) && !this.loading.has(p.id)) void this.load(p);
			else if (d > UNLOAD_RADIUS && this.loaded.has(p.id)) this.unload(p.id);
		}
		for (const b of this.loaded.values()) {
			if (b.door.update(dt)) {
				if (b.doorNode) b.doorNode.rotation.y = b.door.angle;
				this.doorCollision(b);
				if (!b.door.moving) this.host.invalidateShadows();
			}
			if (b.fanNode && b.spec.fan) b.fanNode.rotation.y = (b.fanNode.rotation.y + (b.spec.fan.rpm / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
		}
		this.updateInside(px, pz);
		if (this.seatedOn && !this.host.seated && !this.walkingToSeat) this.seatedOn = null;
		this.pick(px, pz, yaw);
	}

	/** Do what the prompt says. */
	interact(): void {
		const i = this.current;
		if (!i) return;
		const b = this.loaded.get(i.building);
		if (!b) return;
		if (i.kind === 'door') {
			b.door.toggle();
		} else if (i.kind === 'stand') {
			this.host.stand();
		} else if (i.kind === 'sit') {
			const seat = b.spec.seats.find((s) => s.id === i.seat);
			if (!seat) return;
			const [sx, sz] = b.frame.toWorld([seat.x, seat.z]);
			const stand = b.frame.toWorld(seat.stand);
			const target = { x: sx, z: sz, yaw: b.frame.yaw + seat.yaw };
			this.seatedOn = { building: b.placement.id, seat };
			this.walkingToSeat = true;
			// Step to the spot in front of the seat like a player would, then sit down.
			this.host.walkTo([stand], (arrived) => {
				this.walkingToSeat = false;
				if (arrived && !this.disposed) this.host.sit(target, stand);
				else this.seatedOn = null;
			});
		}
		this.current = null;
		this.onInteraction?.(null);
	}
	private walkingToSeat = false;

	private updateInside(px: number, pz: number): void {
		let inside: Loaded | null = null;
		for (const b of this.loaded.values()) {
			// Hysteresis: enter a little way in, leave a little way out (the doorway).
			const margin = this.inside === b.placement.id ? 0.25 : -0.15;
			if (isInside(b.spec, b.frame, px, pz, margin)) inside = b;
		}
		const id = inside?.placement.id ?? null;
		if (id === this.inside) return;
		this.inside = id;
		this.host.setInterior(inside ? { ceiling: inside.frame.ground + inside.spec.interior.ceiling, maxDistance: INDOOR_DISTANCE } : null);
	}

	private pick(px: number, pz: number, yaw: number): void {
		let found: BuildingInteraction | null = null;
		for (const b of this.loaded.values()) {
			const id = b.placement.id;
			if (this.host.seated && this.seatedOn?.building === id) {
				found = { kind: 'stand', label: 'Stand Up', building: id };
				break;
			}
			if (this.walkingToSeat) break;
			const [lx, lz] = b.frame.toLocal(px, pz);
			const [cx, cz] = b.frame.toWorld(b.spec.door.center);
			if (b.door.distance(lx, lz) < DOOR_REACH && facing(px, pz, yaw, cx, cz, 0.9, 0.1)) {
				if (!b.door.open || !b.door.blocksClosing(lx, lz, PLAYER_RADIUS)) {
					found = { kind: 'door', label: b.door.label, building: id };
					break;
				}
			}
			if (!isInside(b.spec, b.frame, px, pz, 0)) continue;
			let best: SeatSpec | null = null;
			let bestD = SEAT_REACH;
			for (const seat of b.spec.seats) {
				const [sx, sz] = b.frame.toWorld(seat.stand);
				const [tx, tz] = b.frame.toWorld([seat.x, seat.z]);
				const d = Math.hypot(sx - px, sz - pz);
				if (d < bestD && facing(px, pz, yaw, tx, tz, 0.7, 0.0)) {
					best = seat;
					bestD = d;
				}
			}
			if (best) {
				found = { kind: 'sit', label: 'Sit Down', building: id, seat: best.id };
				break;
			}
		}
		const same = found?.kind === this.current?.kind && found?.label === this.current?.label && found?.building === this.current?.building && (found as { seat?: string } | null)?.seat === (this.current as { seat?: string } | null)?.seat;
		if (!same) {
			this.current = found;
			this.onInteraction?.(found);
		}
	}

	private async load(p: BuildingPlacement): Promise<void> {
		this.loading.add(p.id);
		try {
			const base = p.spec.slice(0, p.spec.lastIndexOf('/') + 1);
			const spec = (await (await fetch(p.spec)).json()) as BuildingSpec;
			const [gltf, lightmap, nightmap] = await Promise.all([
				loader.loadAsync(base + spec.model),
				textures.loadAsync(base + spec.lightmap),
				spec.lightmapNight ? textures.loadAsync(base + spec.lightmapNight) : Promise.resolve(null)
			]);
			if (this.disposed || !this.placements.includes(p)) {
				lightmap.dispose();
				nightmap?.dispose();
				return;
			}
			for (const t of [lightmap, nightmap]) {
				if (!t) continue;
				t.colorSpace = THREE.SRGBColorSpace;
				t.flipY = false; // glTF UV convention
				t.channel = 1; // TEXCOORD_1
			}
			const night = nightmap && this.host.materials ? { map: nightmap, factor: this.host.materials.night } : null;
			prepareMaterials(gltf.scene, lightmap, spec.lightmapScale, night);
			this.attach(p, spec, gltf.scene);
		} catch (error) {
			console.warn(`Building ${p.id} could not load:`, error);
		} finally {
			this.loading.delete(p.id);
		}
	}

	/** Put a loaded building into the world: scene, collision, door and fan (tests call it
	 * directly with a stand-in model). */
	attach(p: BuildingPlacement, spec: BuildingSpec, root: THREE.Object3D): void {
		const frame = new Frame(p.x, p.z, p.yaw, this.host.terrain.height(p.x, p.z));
		const group = root as THREE.Group;
		group.name = `building:${p.id}`;
		group.position.set(frame.x, frame.ground, frame.z);
		group.rotation.y = frame.yaw;
		this.host.scene.add(group);
		group.updateMatrixWorld(true);
		const b: Loaded = {
			placement: p,
			spec,
			frame,
			root: group,
			door: new Door(spec.door),
			doorNode: group.getObjectByName(spec.door.node) ?? null,
			fanNode: spec.fan ? (group.getObjectByName(spec.fan.node) ?? null) : null,
			owner: `building:${p.id}`,
			doorOwner: `building:${p.id}:door`
		};
		this.collide(b);
		this.loaded.set(p.id, b);
		this.loading.delete(p.id);
		this.host.invalidateShadows();
	}

	private collide(b: Loaded): void {
		const { spec, frame, owner } = b;
		const top = frame.ground + spec.wallTop;
		const c = this.host.collision;
		for (const wall of spec.walls) c.addRing(owner, frame.ring(wall), top);
		for (const lintel of spec.lintels) c.addRing(owner, frame.ring(lintel.ring), top, frame.ground + lintel.base);
		for (const ring of spec.blockers) c.addRing(owner, frame.ring(ring), 0);
		for (const [x, z, r] of spec.posts) {
			const [wx, wz] = frame.toWorld([x, z]);
			c.addCircle(owner, wx, wz, r);
		}
		this.doorCollision(b);
	}

	/** The door leaf blocks walking (and the camera, up to the door's height) where it is now. */
	private doorCollision(b: Loaded): void {
		const c = this.host.collision;
		c.removeOwner(b.doorOwner);
		c.addRing(b.doorOwner, b.frame.ring(b.door.leafRing()), b.frame.ground + b.spec.floor + b.spec.door.height);
	}

	private unload(id: string): void {
		const b = this.loaded.get(id);
		if (!b) return;
		this.loaded.delete(id);
		this.host.collision.removeOwner(b.owner);
		this.host.collision.removeOwner(b.doorOwner);
		if (this.inside === id) {
			this.inside = null;
			this.host.setInterior(null);
		}
		b.root.removeFromParent();
		disposeTree(b.root);
		this.host.invalidateShadows();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const id of [...this.loaded.keys()]) this.unload(id);
		this.host.setGround(null);
		this.host.setInterior(null);
	}
}

/** Interior: unlit colour/texture × baked lightmap (no runtime lights, the same by day and
 * night). Exterior, door and glass keep their PBR materials and take the city's sun, sky and
 * shadows. The fan takes a flat indoor tone. */
function prepareMaterials(root: THREE.Object3D, lightmap: THREE.Texture, scale: number, night: { map: THREE.Texture; factor: { value: number } } | null): void {
	const converted = new Map<THREE.Material, THREE.Material>();
	root.traverse((node) => {
		const mesh = node as THREE.Mesh;
		if (!mesh.isMesh) return;
		const group = topNode(mesh, root).name;
		const swap = (make: (m: THREE.MeshStandardMaterial) => THREE.Material) => {
			const m = mesh.material as THREE.MeshStandardMaterial;
			let next = converted.get(m);
			if (!next) {
				next = make(m);
				next.name = m.name;
				converted.set(m, next);
			}
			mesh.material = next;
		};
		if (group === 'Interior') {
			mesh.castShadow = mesh.receiveShadow = false;
			swap((m) =>
				GLOWING.has(m.name)
					? new THREE.MeshBasicMaterial({ color: m.color.clone().multiplyScalar(1.6) })
					: blendNight(new THREE.MeshBasicMaterial({ color: m.color, map: m.map, vertexColors: m.vertexColors, lightMap: lightmap, lightMapIntensity: scale * Math.PI * INTERIOR_GAIN }), night)
			);
		} else if (group === 'Fan') {
			mesh.castShadow = mesh.receiveShadow = false;
			swap((m) => new THREE.MeshBasicMaterial({ color: m.color.clone().multiplyScalar(0.8), map: m.map, vertexColors: m.vertexColors }));
		} else if (group === 'Glass') {
			mesh.castShadow = false;
			mesh.renderOrder = 2;
			const m = mesh.material as THREE.MeshStandardMaterial;
			m.transparent = true;
			m.depthWrite = false;
			m.envMapIntensity = 1.4;
		} else {
			mesh.castShadow = true;
			mesh.receiveShadow = true;
		}
	});
}

/** Mix the day and night lightmaps by the city's night factor (one extra texture fetch). */
function blendNight<T extends THREE.MeshBasicMaterial>(material: T, night: { map: THREE.Texture; factor: { value: number } } | null): T {
	if (!night) return material;
	material.onBeforeCompile = (shader) => {
		shader.uniforms.uNightMap = { value: night.map };
		shader.uniforms.uNight = night.factor;
		shader.fragmentShader = shader.fragmentShader
			.replace('void main() {', 'uniform sampler2D uNightMap;\nuniform float uNight;\nvoid main() {')
			.replace(
				'vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );',
				'vec4 lightMapTexel = mix( texture2D( lightMap, vLightMapUv ), texture2D( uNightMap, vLightMapUv ), uNight );'
			);
	};
	material.customProgramCacheKey = () => 'ppw-lightmap-night';
	material.userData.nightMap = night.map; // disposed with the material's textures
	return material;
}

function topNode(node: THREE.Object3D, root: THREE.Object3D): THREE.Object3D {
	let n = node;
	while (n.parent && n.parent !== root) n = n.parent;
	return n;
}

function disposeTree(root: THREE.Object3D): void {
	const textures = new Set<THREE.Texture>();
	root.traverse((node) => {
		const mesh = node as THREE.Mesh;
		if (!mesh.isMesh) return;
		mesh.geometry.dispose();
		for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
			for (const value of [...Object.values(m), ...Object.values(m.userData)]) if (value instanceof THREE.Texture) textures.add(value);
			m.dispose();
		}
	});
	textures.forEach((t) => t.dispose());
}

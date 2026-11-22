/**
 * Enterable buildings in the city: loaded when the player comes near, with real doorways and
 * hinged doors (E to open and close; collision follows each leaf), rooms lit by baked lightmaps
 * whose lamps switch on and off per room, an indoor camera, and things to do inside: sit down
 * (or sit at a table), inspect objects, switch the lights, the TV and the stove.
 *
 * Two kinds of building share everything (interactions, collision, camera, culling):
 * - hand-made models: a GLB plus a JSON spec from tools/blender/generate_house.py, placed by
 *   `placements.ts` on open land;
 * - real OpenStreetMap buildings: the listed ones (or, in auto mode, the eligible ones nearest
 *   the player) get an interior generated to fit their footprint (footprint.ts, procedural.ts),
 *   a doorway cut into the facade, and are freed again when the player leaves.
 * Nothing here talks to the server: door, light and appliance states are local, kept as
 * shareable { on/open, changedAt } values (door.ts) for when they are synced between players.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { ChunkPayload } from '$lib/api/types';
import type { CollisionWorld } from '$lib/game/city/collision';
import { BUILDING_DOORS, type Doorway } from '$lib/game/city/materials';
import type { Terrain } from '$lib/game/city/terrain';
import { fitRoom, type XZ as FXZ } from './footprint';
import { interiorName, interiorType, report, scan, type Candidate, type InteriorType } from './osm';
import { buildInterior } from './procedural';
import { DOOR_REACH, Door, Switch } from './door';
import { PLACEMENTS } from './placements';
import { findPath } from './nav';
import { Frame, bounds, floorAt, isInside, rectDistance, roomAt, type BuildingPlacement, type BuildingSpec, type ItemSpec, type LightSpec, type SeatSpec, type ToggleSpec } from './spec';
import { TvPicture } from './tv';

/** Load within this distance (m) of the building, unload beyond the second. */
export const LOAD_RADIUS = 160;
export const UNLOAD_RADIUS = 230;
/** Generated interiors (OSM buildings): built within this distance, freed beyond the second;
 * the chunks around the player are searched for them every OSM_SCAN_EVERY seconds. */
export const OSM_LOAD_RADIUS = 70;
export const OSM_UNLOAD_RADIUS = 100;
const OSM_SCAN_EVERY = 1.0;
/** A generated house keeps a living-room-sized room against its entrance (m). */
const HOUSE_ROOM = { width: 8, depth: 7.5 };
/** At most this many generated buildings at once (each needs a doorway slot in the facade
 * shader: materials.BUILDING_DOORS). */
const MAX_GENERATED = BUILDING_DOORS;
/** Generating an interior takes a few to ~50 ms: one at a time, this far apart (s), nearest first. */
const BUILD_GAP = 0.2;
/** Planning newly seen buildings, per scan (ms). */
const PLAN_BUDGET = 4;
/** Interiors are drawn only when they can be seen: from inside, through an open door nearby
 * (OSM buildings), or within this distance (the model house, which has real windows). */
const INTERIOR_VISIBLE = { doorway: 35, windows: 60 };
/** How close the player must be to use each kind of thing (m). */
export const REACH = { seat: 0.95, switch: 1.2, toggle: 1.5, item: 1.8, table: 1.1 };
/** Indoor camera: the furthest the camera may sit from the avatar. */
const INDOOR_DISTANCE = 3.2;
const PLAYER_RADIUS = 0.35;
/** Brightness of the baked interior under the city's tone mapping (the bake is physically lit,
 * the street by a stronger game sun). */
export const INTERIOR_GAIN = 1.9;
/** Daylight indoors is physically a few percent of the street's; the eye adapts, so the game
 * brightens it (a room lit only by its windows reads as a room, not a cave). */
export const DAYLIGHT_GAIN = 4;
/** Seconds for lamps to fade on or off. */
const LIGHT_FADE = 0.25;

/** What the building system needs from the city engine (CityController provides it). */
export interface BuildingHost {
	readonly scene: THREE.Scene;
	readonly collision: CollisionWorld;
	readonly terrain: Terrain;
	/** The city's shared night factor uniform (0 day … 1 night), and the facade doorways. */
	readonly materials?: { readonly night: { value: number }; setDoorSet?(owner: string, doors: Doorway[]): void };
	readonly seated: boolean;
	setGround(provider: ((x: number, z: number) => number | null) | null): void;
	setInterior(view: { ceiling: number; maxDistance: number; lamp: number } | null): void;
	/** Keeps the camera under a room's ceiling (optional: tests). */
	setCeiling?(provider: ((x: number, y: number, z: number) => number | null) | null): void;
	sit(seat: { x: number; z: number; yaw: number }, standAt: [number, number]): boolean;
	stand(): void;
	walkTo(points: [number, number][], onDone?: (arrived: boolean) => void): void;
	invalidateShadows(): void;
}

/** Where OpenStreetMap buildings to enter come from. */
export interface OsmSource {
	/** The loaded chunks (CityController.chunkData). */
	payloads(): ChunkPayload[];
	/** OSM buildings that get an interior, and which kind. */
	list: { id: number; type: InteriorType; name?: string }[];
	/** Auto mode: every eligible building within `radius` (only the `max` nearest at a time). */
	auto?: { enabled: boolean; radius: number; max: number; type?: (c: Candidate) => InteriorType };
	/** Points of walk-in shop doors: their buildings are taken. */
	claimed?(): FXZ[];
}

export type BuildingInteraction =
	| { kind: 'door'; label: string; building: string; door: string }
	| { kind: 'light'; label: string; building: string; light: string }
	| { kind: 'toggle'; label: string; building: string; toggle: string }
	| { kind: 'inspect'; label: string; building: string; item: string }
	| { kind: 'table'; label: string; building: string; table: string }
	| { kind: 'sit'; label: string; building: string; seat: string }
	| { kind: 'stand'; label: string; building: string };

/** What the player is looking at closely (shown as a card by the page). */
export interface Inspection {
	building: string;
	item: string;
	title: string;
	text: string;
}

interface LightGroup {
	spec: LightSpec;
	state: Switch;
	/** Eased 0…1, fed to the shader and the glowing materials. */
	level: number;
	glow: { material: THREE.MeshBasicMaterial; lit: THREE.Color }[];
}

interface Appliance {
	spec: ToggleSpec;
	state: Switch;
	node: THREE.Object3D | null;
	tv: TvPicture | null;
	screen: { mesh: THREE.Mesh; off: THREE.Material; on: THREE.MeshBasicMaterial } | null;
}

interface Loaded {
	placement: BuildingPlacement;
	spec: BuildingSpec;
	frame: Frame;
	root: THREE.Group;
	doors: { door: Door; node: THREE.Object3D | null; owner: string }[];
	lights: LightGroup[];
	appliances: Appliance[];
	fans: { node: THREE.Object3D; rpm: number }[];
	/** Shader uniforms shared by every interior material of this building. */
	uniforms: { uLampsOn: { value: THREE.Vector4 } } | null;
	owner: string;
	/** Nodes drawn only when the interior can be seen (culling). */
	inside: THREE.Object3D[];
	/** Generated interiors: the doorway in the OSM facade (world). */
	facade: { doorway: Doorway; gap: { ax: number; az: number; bx: number; bz: number; top: number } } | null;
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const textures = new THREE.TextureLoader();
const sameInteraction = (a: BuildingInteraction | null, b: BuildingInteraction | null) => JSON.stringify(a) === JSON.stringify(b);

export class Buildings {
	private loaded = new Map<string, Loaded>();
	private loading = new Set<string>();
	/** Buildings that could not be built (not tried again). */
	private failed = new Set<string>();
	private current: BuildingInteraction | null = null;
	private inside: string | null = null;
	private insideLamp = -1;
	private disposed = false;
	private walkingToSeat = false;
	private lastLocal: [number, number] | null = null;
	/** The seat the player sits on (or is walking to). */
	private seatedOn: { building: string; seat: SeatSpec } | null = null;
	private inspecting: (Inspection & { x: number; z: number }) | null = null;
	/** OSM buildings found near the player (placements made from their plans). */
	private osmPlacements = new Map<string, BuildingPlacement>();
	private sinceScan = Infinity;
	private sinceBuild = Infinity;

	constructor(
		private host: BuildingHost,
		private onInteraction?: (interaction: BuildingInteraction | null) => void,
		private placements: BuildingPlacement[] = PLACEMENTS,
		private onInspect?: (inspection: Inspection | null) => void,
		private osm?: OsmSource
	) {
		host.setGround((x, z) => this.floorAt(x, z));
		host.setCeiling?.((x, y, z) => this.ceilingAt(x, y, z));
	}

	/** Eligibility of the OSM buildings around (x, z): totals, reasons and the eligible ones
	 * (inspection, tests and choosing which buildings to open). */
	scan(x: number, z: number, radius = 120) {
		if (!this.osm) return null;
		const candidates = scan(this.osm.payloads(), x, z, radius, this.osm.claimed?.() ?? [], (cx, cz, r) => this.host.terrain.affects(cx, cz, r));
		return {
			...report(candidates),
			eligible: candidates
				.filter((c) => c.result.ok)
				.map((c) => ({ id: c.id, name: c.name, kind: c.kind, plan: c.result.ok ? c.result.plan : null }))
		};
	}

	/** Find OSM buildings to open near the player; drop the ones no longer around. */
	private discover(px: number, pz: number): void {
		const osm = this.osm;
		if (!osm) return;
		const listed = new Map(osm.list.map((b) => [b.id, b]));
		const auto = osm.auto?.enabled ? osm.auto : null;
		const claimed = osm.claimed?.() ?? [];
		const hill = (cx: number, cz: number, r: number) => this.host.terrain.affects(cx, cz, r);
		const wanted = new Map<string, BuildingPlacement>();
		const take = (c: Candidate, type: InteriorType, name?: string | null) => {
			if (!c.result.ok || wanted.size >= MAX_GENERATED) return;
			const plan = type === 'house' ? fitRoom(c.result.plan, HOUSE_ROOM.width, HOUSE_ROOM.depth) : c.result.plan;
			const id = `osm:${c.id}`;
			wanted.set(id, this.osmPlacements.get(id) ?? { id, spec: '', x: plan.x, z: plan.z, yaw: plan.yaw, procedural: { type, plan, seed: c.id, name: name ?? undefined } });
		};
		// Kept first: a building the player is inside (it unloads once they are out and away).
		if (this.inside?.startsWith('osm:')) {
			const p = this.osmPlacements.get(this.inside);
			if (p) wanted.set(this.inside, p);
		}
		for (const c of scan(osm.payloads(), px, pz, OSM_UNLOAD_RADIUS, claimed, hill, new Set(listed.keys()))) {
			const l = listed.get(c.id)!;
			take(c, l.type, l.name ?? c.name);
		}
		if (auto) {
			// The nearest eligible buildings; ones already open stay a little longer and a little
			// further (walking past a row of shops does not build and free them over and over).
			const near = scan(osm.payloads(), px, pz, auto.radius + 20, claimed, hill, undefined, PLAN_BUDGET).filter((c) => c.result.ok && !listed.has(c.id));
			let fresh = 0;
			for (const c of near) {
				const open = this.osmPlacements.has(`osm:${c.id}`);
				if (c.d < auto.radius && fresh < auto.max) fresh++;
				else if (!open || wanted.size >= auto.max + 3 + listed.size) continue;
				const type = auto.type?.(c) ?? interiorType(c.kind, c.id);
				take(c, type, type === 'house' ? undefined : (c.name ?? interiorName(type, c.id)));
			}
		}
		for (const [id] of this.osmPlacements) if (!wanted.has(id) && this.loaded.has(id) && this.inside !== id) this.unload(id);
		this.osmPlacements = wanted;
	}

	/** The interaction the E key would perform now. */
	get interaction(): BuildingInteraction | null {
		return this.current;
	}

	/** The building the player is inside (id), if any. */
	get insideOf(): string | null {
		return this.inside;
	}

	get inspection(): Inspection | null {
		if (!this.inspecting) return null;
		const { building, item, title, text } = this.inspecting;
		return { building, item, title, text };
	}

	/** Loaded buildings and their state (inspection and tests). */
	get list() {
		return [...this.loaded.values()].map((b) => ({
			id: b.placement.id,
			frame: b.frame,
			spec: b.spec,
			door: b.doors[0] ? { open: b.doors[0].door.open, t: b.doors[0].door.t } : null,
			doors: Object.fromEntries(b.doors.map((d) => [d.door.spec.id, { open: d.door.open, t: d.door.t }])),
			lights: Object.fromEntries(b.lights.map((l) => [l.spec.id, l.state.on])),
			appliances: Object.fromEntries(b.appliances.map((a) => [a.spec.id, a.state.on]))
		}));
	}

	/** The ceiling of the room around (x, y, z), if the point is inside a loaded building (within
	 * its walls, below its roof). */
	ceilingAt(x: number, y: number, z: number): number | null {
		for (const b of this.loaded.values()) {
			const [lx, lz] = b.frame.toLocal(x, z);
			const fp = bounds(b.spec.footprint);
			if (lx < fp.minX || lx > fp.maxX || lz < fp.minZ || lz > fp.maxZ) continue;
			if (y > b.frame.ground + (b.spec.roofTop ?? b.spec.wallTop)) continue;
			return b.frame.ground + b.spec.interior.ceiling;
		}
		return null;
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
		this.sinceScan += dt;
		this.sinceBuild += dt;
		if (this.osm && this.sinceScan >= OSM_SCAN_EVERY) {
			this.sinceScan = 0;
			this.discover(px, pz);
		}
		let next: BuildingPlacement | null = null;
		let nextD = Infinity;
		for (const p of [...this.placements, ...this.osmPlacements.values()]) {
			const [load, unload] = p.procedural ? [OSM_LOAD_RADIUS, OSM_UNLOAD_RADIUS] : [LOAD_RADIUS, UNLOAD_RADIUS];
			const d = Math.hypot(p.x - px, p.z - pz);
			if (d < load && !this.loaded.has(p.id) && !this.loading.has(p.id) && !this.failed.has(p.id)) {
				if (!p.procedural) void this.load(p);
				else if (d < nextD) {
					next = p;
					nextD = d;
				}
			} else if (d > unload && this.loaded.has(p.id) && this.inside !== p.id) this.unload(p.id);
		}
		// Generated interiors: the nearest waiting one, one at a time (no hitch from building many).
		if (next && this.sinceBuild >= BUILD_GAP) {
			this.sinceBuild = 0;
			void this.load(next);
		}
		for (const b of this.loaded.values()) {
			this.animate(b, dt);
			this.cull(b, px, pz);
		}
		this.updateInside(px, pz);
		if (this.seatedOn && !this.host.seated && !this.walkingToSeat) this.seatedOn = null;
		if (this.inspecting && Math.hypot(this.inspecting.x - px, this.inspecting.z - pz) > REACH.item + 0.9) this.closeInspection();
		this.pick(px, pz, yaw);
	}

	/** Draw an interior only when it can be seen. */
	private cull(b: Loaded, px: number, pz: number): void {
		const d = Math.hypot(b.frame.x - px, b.frame.z - pz);
		const seen =
			this.inside === b.placement.id || (b.facade ? b.doors.some((x) => x.door.t > 0) && d < INTERIOR_VISIBLE.doorway : d < INTERIOR_VISIBLE.windows);
		for (const n of b.inside) if (n.visible !== seen) n.visible = seen;
	}

	private animate(b: Loaded, dt: number): void {
		for (const d of b.doors) {
			if (!d.door.update(dt)) continue;
			if (d.node) d.node.rotation.y = d.door.angle;
			this.doorCollision(b, d);
			if (!d.door.moving) this.host.invalidateShadows();
		}
		for (const f of b.fans) f.node.rotation.y = (f.node.rotation.y + (f.rpm / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
		const k = Math.min(1, dt / LIGHT_FADE);
		for (const l of b.lights) {
			const target = l.state.on ? 1 : 0;
			if (l.level === target) continue;
			l.level = l.level < target ? Math.min(target, l.level + k) : Math.max(target, l.level - k);
			if (b.uniforms) b.uniforms.uLampsOn.value.setComponent(l.spec.channel, l.level);
			for (const g of l.glow) g.material.color.copy(g.lit).multiplyScalar(0.25 + 0.75 * l.level);
		}
		for (const a of b.appliances) {
			if (a.tv && a.state.on) a.tv.update(dt);
			if (a.spec.kind === 'flame' && a.node && a.state.on) a.node.scale.y = 0.8 + 0.4 * Math.random();
		}
	}

	/** Do what the prompt says (with no prompt, E still closes an open inspection card). */
	interact(): void {
		const i = this.current;
		if (!i) return this.closeInspection();
		const b = this.loaded.get(i.building);
		if (!b) return;
		if (i.kind === 'door') {
			b.doors.find((d) => d.door.spec.id === i.door)?.door.toggle();
		} else if (i.kind === 'light') {
			b.lights.find((l) => l.spec.id === i.light)?.state.toggle();
			this.insideLamp = -1; // re-send the indoor light level
		} else if (i.kind === 'toggle') {
			const a = b.appliances.find((x) => x.spec.id === i.toggle);
			if (a) this.setAppliance(a, !a.state.on);
		} else if (i.kind === 'inspect') {
			if (this.inspecting?.item === i.item) this.closeInspection();
			else {
				const item = b.spec.items.find((x) => x.id === i.item);
				if (item) this.openInspection(b, item);
			}
		} else if (i.kind === 'stand') {
			this.host.stand();
		} else if (i.kind === 'sit' || i.kind === 'table') {
			const seat = i.kind === 'sit' ? b.spec.seats.find((s) => s.id === i.seat) : this.tableSeat(b, i.table);
			if (seat) this.sitOn(b, seat);
		}
		this.current = null;
		this.onInteraction?.(null);
	}

	/** Close the inspection card (E again, Escape, or walking away). */
	closeInspection(): void {
		if (!this.inspecting) return;
		this.inspecting = null;
		this.onInspect?.(null);
	}

	private openInspection(b: Loaded, item: ItemSpec): void {
		const [x, z] = b.frame.toWorld([item.x, item.z]);
		this.inspecting = { building: b.placement.id, item: item.id, title: item.title, text: item.text, x, z };
		this.onInspect?.(this.inspection);
	}

	/** The chair of a table nearest the player (by its stand-up spot). */
	private tableSeat(b: Loaded, tableId: string): SeatSpec | null {
		const table = b.spec.tables.find((t) => t.id === tableId);
		if (!table || !this.lastLocal) return null;
		const [lx, lz] = this.lastLocal;
		let best: SeatSpec | null = null;
		let bestD = Infinity;
		for (const id of table.seats) {
			const s = b.spec.seats.find((x) => x.id === id);
			if (!s) continue;
			const d = Math.hypot(s.stand[0] - lx, s.stand[1] - lz);
			if (d < bestD) {
				best = s;
				bestD = d;
			}
		}
		return best;
	}

	private sitOn(b: Loaded, seat: SeatSpec): void {
		const [sx, sz] = b.frame.toWorld([seat.x, seat.z]);
		const stand = b.frame.toWorld(seat.stand);
		const target = { x: sx, z: sz, yaw: b.frame.yaw + seat.yaw };
		this.seatedOn = { building: b.placement.id, seat };
		this.walkingToSeat = true;
		this.closeInspection();
		// Walk to the spot beside or in front of the seat like a player would, around furniture,
		// walls and open doors (a straight line could run into a table corner), then sit down.
		const fp = bounds(b.spec.footprint);
		const path = this.lastLocal
			? findPath(
					{ bounds: [fp.minX, fp.maxX, fp.minZ, fp.maxZ], obstacles: [...b.spec.walls, ...b.spec.blockers, ...b.doors.map((d) => d.door.leafRing())], radius: PLAYER_RADIUS + 0.03 },
					this.lastLocal,
					seat.stand
				)
			: null;
		const points = (path ?? [seat.stand]).map((p) => b.frame.toWorld(p));
		this.host.walkTo(points, (arrived) => {
			this.walkingToSeat = false;
			if (arrived && !this.disposed) this.host.sit(target, stand);
			else this.seatedOn = null;
		});
	}

	private setAppliance(a: Appliance, on: boolean): void {
		a.state.apply({ on, changedAt: Date.now() });
		if (on && a.screen && !a.tv && typeof document !== 'undefined') {
			a.tv = new TvPicture();
			a.screen.on.map = a.tv.texture;
			a.screen.on.needsUpdate = true;
		}
		if (a.spec.kind === 'flame' && a.node) a.node.visible = on;
		if (a.screen) a.screen.mesh.material = on ? a.screen.on : a.screen.off;
	}

	private updateInside(px: number, pz: number): void {
		let inside: Loaded | null = null;
		for (const b of this.loaded.values()) {
			// Hysteresis: enter a little way in, leave a little way out (the doorway).
			const margin = this.inside === b.placement.id ? 0.25 : -0.15;
			if (isInside(b.spec, b.frame, px, pz, margin)) inside = b;
		}
		const id = inside?.placement.id ?? null;
		// The room's lamps light the avatar too (a dark room at night stays dark).
		let lamp = 0;
		if (inside) {
			const [lx, lz] = inside.frame.toLocal(px, pz);
			const room = roomAt(inside.spec, lx, lz);
			const group = inside.lights.find((l) => l.spec.channel === (room?.light ?? 0));
			lamp = group?.state.on ? 1 : 0;
		}
		if (id === this.inside && lamp === this.insideLamp) return;
		this.inside = id;
		this.insideLamp = lamp;
		this.host.setInterior(inside ? { ceiling: inside.frame.ground + inside.spec.interior.ceiling, maxDistance: INDOOR_DISTANCE, lamp } : null);
	}

	private pick(px: number, pz: number, worldYaw: number): void {
		let found: BuildingInteraction | null = null;
		let best = Infinity;
		for (const b of this.loaded.values()) {
			const id = b.placement.id;
			if (this.host.seated && this.seatedOn?.building === id) {
				found = { kind: 'stand', label: 'Stand Up', building: id };
				break;
			}
			if (this.walkingToSeat) break;
			const [lx, lz] = b.frame.toLocal(px, pz);
			this.lastLocal = [lx, lz];
			const yaw = b.frame.yaw;
			const fx = Math.sin(worldYaw - yaw),
				fz = Math.cos(worldYaw - yaw);
			/** Offer `i` (distance `d` within `reach`) aimed at (tx, tz): the player must roughly
			 * face it (closer than `close` anything goes); what they face most directly wins,
			 * then the nearest. */
			const offer = (i: BuildingInteraction, d: number, reach: number, tx: number, tz: number, close = 0.7, minCos = 0.15) => {
				if (d > reach) return;
				const dx = tx - lx,
					dz = tz - lz;
				const dist = Math.hypot(dx, dz);
				const cos = dist < 1e-3 ? 1 : (dx * fx + dz * fz) / dist;
				if (dist > close && cos < minCos) return;
				const score = d / reach + (1 - Math.max(cos, 0)) * 0.8;
				if (score < best) {
					best = score;
					found = i;
				}
			};
			for (const { door } of b.doors) {
				const [cx, cz] = door.spec.center;
				if (door.open && door.blocksClosing(lx, lz, PLAYER_RADIUS)) continue;
				offer({ kind: 'door', label: door.label, building: id, door: door.spec.id }, door.distance(lx, lz), DOOR_REACH, cx, cz, 0.9, 0.1);
			}
			if (!isInside(b.spec, b.frame, px, pz, 0.1)) continue;
			for (const l of b.lights)
				for (const [sx, sz] of l.spec.switches)
					offer({ kind: 'light', label: l.state.on ? 'Turn Lights Off' : 'Turn Lights On', building: id, light: l.spec.id }, Math.hypot(sx - lx, sz - lz), REACH.switch, sx, sz, 0.4, 0.3);
			for (const a of b.appliances)
				offer({ kind: 'toggle', label: `Turn ${a.state.on ? 'Off' : 'On'} ${a.spec.label}`, building: id, toggle: a.spec.id }, Math.hypot(a.spec.x - lx, a.spec.z - lz), REACH.toggle, a.spec.x, a.spec.z, 0.5, 0.3);
			for (const item of b.spec.items) {
				const open = this.inspecting?.item === item.id;
				// Looking at something counts a little extra (a picture above a sofa is offered once
				// the player steps back from the seat).
				const d = Math.hypot(item.x - lx, item.z - lz) * (open ? 0.3 : 0.75);
				offer({ kind: 'inspect', label: open ? 'Close' : `Inspect ${item.label}`, building: id, item: item.id }, d, REACH.item, item.x, item.z, open ? Infinity : 0.5, 0.3);
			}
			for (const t of b.spec.tables) {
				const [x0, x1, z0, z1] = t.rect;
				offer({ kind: 'table', label: `Sit at the ${t.label}`, building: id, table: t.id }, rectDistance(t.rect, lx, lz), REACH.table, (x0 + x1) / 2, (z0 + z1) / 2, 0.9, 0.2);
			}
			for (const seat of b.spec.seats)
				offer({ kind: 'sit', label: 'Sit Down', building: id, seat: seat.id }, Math.hypot(seat.stand[0] - lx, seat.stand[1] - lz), REACH.seat, seat.x, seat.z, 0.75, 0.0);
		}
		if (!sameInteraction(found, this.current)) {
			this.current = found;
			this.onInteraction?.(found);
		}
	}

	private async load(p: BuildingPlacement): Promise<void> {
		if (p.procedural) {
			const { type, plan, seed, name } = p.procedural;
			try {
				const built = buildInterior(type, plan, seed, this.host.materials?.night ?? { value: 0 }, name);
				this.attach(p, built.spec, built.root, undefined, built.uniforms);
			} catch (error) {
				console.warn(`Building ${p.id} could not be generated:`, error);
				this.failed.add(p.id);
			}
			return;
		}
		this.loading.add(p.id);
		try {
			const base = p.spec.slice(0, p.spec.lastIndexOf('/') + 1);
			const spec = (await (await fetch(p.spec)).json()) as BuildingSpec;
			if (!spec.lightmaps) throw new Error('a model building needs lightmaps');
			const [gltf, day, lamps] = await Promise.all([
				loader.loadAsync(base + spec.model),
				textures.loadAsync(base + spec.lightmaps.day),
				textures.loadAsync(base + spec.lightmaps.lamps)
			]);
			if (this.disposed || !this.placements.includes(p)) {
				day.dispose();
				lamps.dispose();
				return;
			}
			day.colorSpace = THREE.SRGBColorSpace; // the lamp map stays raw: per-channel luminance
			for (const t of [day, lamps]) {
				t.flipY = false; // glTF UV convention
				t.channel = 1; // TEXCOORD_1
			}
			this.attach(p, spec, gltf.scene, { day, lamps });
		} catch (error) {
			console.warn(`Building ${p.id} could not load:`, error);
		} finally {
			this.loading.delete(p.id);
		}
	}

	/** Put a loaded building into the world: scene, collision, doors, lights, appliances, fans.
	 * Tests call it directly with a stand-in model (and no lightmaps). */
	attach(
		p: BuildingPlacement,
		spec: BuildingSpec,
		root: THREE.Object3D,
		maps?: { day: THREE.Texture; lamps: THREE.Texture },
		ownUniforms?: { uLampsOn: { value: THREE.Vector4 } }
	): void {
		const frame = new Frame(p.x, p.z, p.yaw, this.host.terrain.height(p.x, p.z));
		const group = root as THREE.Group;
		group.name = `building:${p.id}`;
		group.position.set(frame.x, frame.ground, frame.z);
		group.rotation.y = frame.yaw;
		// Lights start on after dark, off by day (the switches change that).
		const night = (this.host.materials?.night.value ?? 0) > 0.5;
		// Lights without a switch (shops, cafés) are always on.
		const lights: LightGroup[] = spec.lights.map((l) => {
			const on = l.switches.length ? night : true;
			return { spec: l, state: new Switch(on), level: on ? 1 : 0, glow: [] };
		});
		const uniforms = maps ? prepareMaterials(group, spec, maps, lights, this.host.materials?.night ?? { value: 0 }) : (ownUniforms ?? null);
		if (ownUniforms) ownUniforms.uLampsOn.value.set(lights[0]?.level ?? 1, lights[1]?.level ?? 0, lights[2]?.level ?? 0, lights[3]?.level ?? 0);
		const appliances: Appliance[] = spec.toggles.map((t) => {
			const node = group.getObjectByName(t.node) ?? null;
			const a: Appliance = { spec: t, state: new Switch(false), node, tv: null, screen: null };
			if (t.kind === 'flame' && node) node.visible = false;
			if (t.kind === 'tv' && node) {
				const mesh = findMesh(node);
				// The picture (a canvas) is made the first time the set is switched on.
				if (mesh) a.screen = { mesh, off: mesh.material as THREE.Material, on: new THREE.MeshBasicMaterial({ color: '#ffffff' }) };
			}
			return a;
		});
		this.host.scene.add(group);
		group.updateMatrixWorld(true);
		const owner = `building:${p.id}`;
		const b: Loaded = {
			placement: p,
			spec,
			frame,
			root: group,
			doors: spec.doors.map((d) => ({ door: new Door(d), node: group.getObjectByName(d.node) ?? null, owner: `${owner}:door:${d.id}` })),
			lights,
			appliances,
			fans: spec.fans.map((f) => ({ node: group.getObjectByName(f.node), rpm: f.rpm })).filter((f): f is { node: THREE.Object3D; rpm: number } => !!f.node),
			uniforms,
			owner,
			inside: group.children.filter((n) => n.name === 'Interior' || n.name === 'Extras' || n.name === 'Glass' || n.name === 'TVScreen' || n.name === 'StoveFlame' || n.name.startsWith('Fan_')),
			facade: null
		};
		if (p.procedural) {
			const { facade, doorWidth } = p.procedural.plan;
			const half = doorWidth / 2;
			// The opening runs from the street up to the top of the door (the floor is raised).
			const height = spec.floor + (spec.doors[0]?.height ?? 2.2);
			const top = frame.ground + height;
			b.facade = {
				doorway: { x: facade.x, z: facade.z, ux: facade.ux, uz: facade.uz, y: frame.ground, halfWidth: half, height },
				gap: { ax: facade.x - facade.ux * half, az: facade.z - facade.uz * half, bx: facade.x + facade.ux * half, bz: facade.z + facade.uz * half, top }
			};
		}
		this.collide(b);
		this.loaded.set(p.id, b);
		this.loading.delete(p.id);
		this.refreshDoorways();
		this.host.invalidateShadows();
	}

	/** Cut the doorways of generated interiors into the OSM facades and the collision walls. */
	private refreshDoorways(): void {
		const open = [...this.loaded.values()].filter((b) => b.facade);
		this.host.materials?.setDoorSet?.('buildings', open.map((b) => b.facade!.doorway));
		this.host.collision.setDoors('buildings', open.map((b) => b.facade!.gap));
	}

	private collide(b: Loaded): void {
		const { spec, frame, owner } = b;
		// Walls stop the camera up to the ridge, so it never ends up inside the roof.
		const top = frame.ground + (spec.roofTop ?? spec.wallTop);
		const c = this.host.collision;
		for (const wall of spec.walls) c.addRing(owner, frame.ring(wall), top);
		for (const lintel of spec.lintels) c.addRing(owner, frame.ring(lintel.ring), top, frame.ground + lintel.base);
		for (const ring of spec.blockers) c.addRing(owner, frame.ring(ring), 0);
		for (const [x, z, r] of spec.posts) {
			const [wx, wz] = frame.toWorld([x, z]);
			c.addCircle(owner, wx, wz, r);
		}
		for (const d of b.doors) this.doorCollision(b, d);
	}

	/** A door leaf blocks walking (and the camera, up to the door's height) where it is now. */
	private doorCollision(b: Loaded, d: Loaded['doors'][number]): void {
		const c = this.host.collision;
		c.removeOwner(d.owner);
		c.addRing(d.owner, b.frame.ring(d.door.leafRing()), b.frame.ground + b.spec.floor + d.door.spec.height);
	}

	private unload(id: string): void {
		const b = this.loaded.get(id);
		if (!b) return;
		this.loaded.delete(id);
		this.host.collision.removeOwner(b.owner);
		for (const d of b.doors) this.host.collision.removeOwner(d.owner);
		if (this.inside === id) {
			this.inside = null;
			this.host.setInterior(null);
		}
		if (this.inspecting?.building === id) this.closeInspection();
		if (b.facade) this.refreshDoorways();
		for (const a of b.appliances) {
			a.tv?.dispose();
			a.screen?.on.dispose();
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
		this.host.setCeiling?.(null);
		this.host.setInterior(null);
	}
}

function findMesh(node: THREE.Object3D): THREE.Mesh | null {
	let mesh: THREE.Mesh | null = null;
	node.traverse((n) => {
		if (!mesh && (n as THREE.Mesh).isMesh) mesh = n as THREE.Mesh;
	});
	return mesh;
}

/** Interior: unlit colour/texture × (daylight + the lamps that are on), from the baked maps; no
 * runtime lights. Bulbs and shades glow by their group's state. Exterior, doors and glass keep
 * their PBR materials and take the city's sun, sky and shadows; fans take a flat indoor tone. */
function prepareMaterials(
	root: THREE.Object3D,
	spec: BuildingSpec,
	maps: { day: THREE.Texture; lamps: THREE.Texture },
	lights: LightGroup[],
	night: { value: number }
): { uLampsOn: { value: THREE.Vector4 } } {
	const lm = spec.lightmaps!; // model buildings always have them (checked in load)
	const level = (channel: number) => lights.find((l) => l.spec.channel === channel)?.level ?? 0;
	const uniforms = {
		uLampMap: { value: maps.lamps },
		uLampsOn: { value: new THREE.Vector4(level(0), level(1), level(2), level(3)) },
		uNight: night,
		uDayScale: { value: lm.dayScale * DAYLIGHT_GAIN },
		uLampScale: { value: lm.lampScale },
		uLampColor: { value: new THREE.Vector3(...lm.lampColor) },
		uGain: { value: INTERIOR_GAIN }
	};
	const glowing = new Map<string, LightGroup>();
	for (const l of lights) for (const name of l.spec.materials) glowing.set(name, l);
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
			swap((m) => {
				const light = glowing.get(m.name);
				if (light) {
					const lit = m.color.clone().multiplyScalar(1.6);
					const material = new THREE.MeshBasicMaterial({ color: lit.clone().multiplyScalar(0.25 + 0.75 * light.level) });
					light.glow.push({ material, lit });
					return material;
				}
				return lightmapped(new THREE.MeshBasicMaterial({ color: m.color, map: m.map, vertexColors: m.vertexColors, lightMap: maps.day }), uniforms);
			});
		} else if (group.startsWith('Fan_')) {
			mesh.castShadow = mesh.receiveShadow = false;
			swap((m) => new THREE.MeshBasicMaterial({ color: m.color.clone().multiplyScalar(0.8), map: m.map, vertexColors: m.vertexColors }));
		} else if (group === 'TVScreen') {
			mesh.castShadow = mesh.receiveShadow = false;
			swap((m) => new THREE.MeshBasicMaterial({ color: m.color }));
		} else if (group === 'StoveFlame') {
			mesh.castShadow = mesh.receiveShadow = false;
			swap(() => new THREE.MeshBasicMaterial({ color: new THREE.Color('#5a9bff'), transparent: true, opacity: 0.85 }));
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
	return uniforms;
}

/** The interior light: day map × daylight (fading to moonlight at night) + each lamp group's
 * channel × its switch level × lamp colour. One extra texture fetch over a plain lightmap. */
function lightmapped(material: THREE.MeshBasicMaterial, uniforms: Record<string, { value: unknown }>): THREE.MeshBasicMaterial {
	material.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, uniforms);
		shader.fragmentShader = shader.fragmentShader
			.replace(
				'void main() {',
				'uniform sampler2D uLampMap;\nuniform vec4 uLampsOn;\nuniform float uNight;\nuniform float uDayScale;\nuniform float uLampScale;\nuniform vec3 uLampColor;\nuniform float uGain;\nvoid main() {'
			)
			.replace(
				'vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );',
				[
					'vec3 ppwDay = texture2D( lightMap, vLightMapUv ).rgb * uDayScale * ( 1.0 - 0.96 * uNight );',
					'vec4 ppwLamps = pow( texture2D( uLampMap, vLightMapUv ), vec4( 2.2 ) );',
					'vec4 lightMapTexel = vec4( ( ppwDay + uLampColor * uLampScale * dot( ppwLamps, uLampsOn ) ) * uGain * PI, 1.0 );'
				].join('\n\t\t')
			);
	};
	material.lightMapIntensity = 1;
	material.customProgramCacheKey = () => 'ppw-interior-lightmaps';
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
			for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
			m.dispose();
		}
	});
	textures.forEach((t) => t.dispose());
}

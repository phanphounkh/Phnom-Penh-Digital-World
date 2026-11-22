/**
 * Enterable building specs (written by tools/blender/generate_house.py next to each GLB, format
 * version 2: rooms, light groups, several doors, seats, tables, things to inspect and appliances)
 * and the placement frame that puts a building into the world.
 *
 * Model coordinates: metres, x across the front, z out of the front door (+Z), y up, origin at
 * ground level in the centre of the footprint. A placement rotates the model by `yaw` (like
 * Object3D.rotation.y) and moves it to (x, z) on the terrain.
 */

export type XZ = [number, number];

export interface DoorSpec {
	id: string;
	/** Shown in prompts: "Door" → "Open Door", "Bedroom Door" → "Open Bedroom Door". */
	label: string;
	/** GLB node whose origin is on the hinge axis; it opens by +rotation.y. */
	node: string;
	hinge: XZ;
	width: number;
	thickness: number;
	height: number;
	openYaw: number;
	/** Middle of the doorway (mid-wall) and the direction away from the side it swings into. */
	center: XZ;
	outward: XZ;
	/** The storey it is on (0 = ground floor; see BuildingSpec.levels). */
	level?: number;
}

export interface SeatSpec {
	id: string;
	label: string;
	/** Where the hips go, and the direction the sitter faces (rotation.y). */
	x: number;
	z: number;
	yaw: number;
	/** Seat height above the floor (m). */
	height: number;
	/** Where to stand before sitting down and after getting up. */
	stand: XZ;
	level?: number;
}

/** A room: its floor rectangles [x0, x1, z0, z1] and the light group (lightmap channel) it is lit by. */
export interface RoomSpec {
	id: string;
	name: string;
	rects: [number, number, number, number][];
	light: number;
	level?: number;
}

/** A group of lamps switched together: its lightmap channel, wall switches [x, z, y] and the
 * glowing materials (bulbs, shades) that go dark when it is off. */
export interface LightSpec {
	id: string;
	label: string;
	channel: number;
	switches: [number, number, number][];
	materials: string[];
	/** Switched on from the start even by day (a room without windows). */
	startOn?: boolean;
	level?: number;
}

/** Something to look at closely: E shows its title and text. */
export interface ItemSpec {
	id: string;
	label: string;
	title: string;
	text: string;
	x: number;
	z: number;
	y: number;
	level?: number;
}

/** An appliance that turns on and off: a TV screen or a stove's flames (a GLB node). */
export interface ToggleSpec {
	id: string;
	label: string;
	node: string;
	kind: 'tv' | 'flame';
	x: number;
	z: number;
	y: number;
	level?: number;
}

/** A table or desk: E near it sits on the nearest of its chairs. */
export interface TableSpec {
	id: string;
	label: string;
	rect: [number, number, number, number];
	seats: string[];
	level?: number;
}

export interface BuildingSpec {
	version: 2;
	name: string;
	model: string;
	/** Baked interior light: `day` (sun and sky, sRGB RGB / dayScale) and `lamps` (one light
	 * group per channel, luminance^(1/2.2) / lampScale, times lampColor). */
	lightmaps?: { day: string; lamps: string; dayScale: number; lampScale: number; lampColor: [number, number, number] };
	/** Floor height above the ground under the building (m). */
	floor: number;
	wallTop: number;
	/** The roof ridge: walls block the camera up to here (never into the roof space). */
	roofTop?: number;
	footprint: XZ[];
	interior: { min: XZ; max: XZ; ceiling: number };
	rooms: RoomSpec[];
	lights: LightSpec[];
	/** Wall pieces (rectangles); doorways are gaps between them. */
	walls: XZ[][];
	/** Over doorways and arches: block the camera above `base`, never walking. */
	lintels: { ring: XZ[]; base: number }[];
	doors: DoorSpec[];
	/** Raised ground outside: porch and steps (height above the ground). */
	steps: { ring: XZ[]; height: number }[];
	/** Round obstacles: [x, z, radius]. */
	posts: [number, number, number][];
	/** Furniture footprints (block walking, not the camera). */
	blockers: XZ[][];
	seats: SeatSpec[];
	tables: TableSpec[];
	items: ItemSpec[];
	toggles: ToggleSpec[];
	fans: { node: string; rpm: number }[];
	/** Storeys above the ground floor (levels[0] is level 1): floor and ceiling heights above the
	 * ground, and their own walls, lintels and furniture (the ground floor's are above). */
	levels?: LevelSpec[];
	/** Stairs between storeys. */
	stairs?: StairSpec[];
}

export interface LevelSpec {
	floor: number;
	ceiling: number;
	walls: XZ[][];
	lintels: { ring: XZ[]; base: number }[];
	blockers: XZ[][];
}

/** A straight flight of stairs: its plan rectangle [x0, x1, z0, z1], climbing along `axis`
 * towards larger (dir 1) or smaller (dir -1) coordinates, from level `from` to level `to`. */
export interface StairSpec {
	rect: [number, number, number, number];
	axis: 'x' | 'z';
	dir: 1 | -1;
	from: number;
	to: number;
}

/** A storey's floor height above the ground (level 0: the ground floor). */
export function levelFloor(spec: BuildingSpec, level: number): number {
	return level <= 0 ? spec.floor : (spec.levels?.[level - 1]?.floor ?? spec.floor);
}

/** A storey's ceiling height above the ground. */
export function levelCeiling(spec: BuildingSpec, level: number): number {
	return level <= 0 ? spec.interior.ceiling : (spec.levels?.[level - 1]?.ceiling ?? spec.interior.ceiling);
}

/** The flight of stairs at a local point and how far up it (0 at the bottom … 1 at the top). */
export function stairAt(spec: BuildingSpec, lx: number, lz: number): { stair: StairSpec; t: number } | null {
	for (const stair of spec.stairs ?? []) {
		const [x0, x1, z0, z1] = stair.rect;
		if (lx < x0 || lx > x1 || lz < z0 || lz > z1) continue;
		const [a, lo, hi] = stair.axis === 'x' ? [lx, x0, x1] : [lz, z0, z1];
		const t = (a - lo) / (hi - lo);
		return { stair, t: stair.dir > 0 ? t : 1 - t };
	}
	return null;
}

/** Where a building stands in the world. */
export interface BuildingPlacement {
	id: string;
	/** Spec URL (the GLB and lightmap are next to it); empty for generated interiors. */
	spec: string;
	x: number;
	z: number;
	/** rotation.y of the model: 0 = front door facing +Z (south), π/2 = facing +X (east). */
	yaw: number;
	/** An interior generated inside an OpenStreetMap building (procedural.ts). */
	procedural?: { type: 'house' | 'shop' | 'cafe'; plan: import('./footprint').Plan; seed: number; name?: string | null };
}

/** Model ↔ world transform of one placed building. */
export class Frame {
	private c: number;
	private s: number;

	constructor(
		readonly x: number,
		readonly z: number,
		readonly yaw: number,
		/** Ground height under the building (world y of the model origin). */
		readonly ground: number
	) {
		this.c = Math.cos(yaw);
		this.s = Math.sin(yaw);
	}

	toWorld([lx, lz]: XZ): XZ {
		return [this.x + lx * this.c + lz * this.s, this.z - lx * this.s + lz * this.c];
	}

	toLocal(x: number, z: number): XZ {
		const dx = x - this.x,
			dz = z - this.z;
		return [dx * this.c - dz * this.s, dx * this.s + dz * this.c];
	}

	/** A model-space direction in world space. */
	dirToWorld([dx, dz]: XZ): XZ {
		return [dx * this.c + dz * this.s, -dx * this.s + dz * this.c];
	}

	ring(points: XZ[]): XZ[] {
		return points.map((p) => this.toWorld(p));
	}
}

/** Axis-aligned bounds of a (model-space) ring. */
export function bounds(ring: XZ[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
	let minX = Infinity,
		maxX = -Infinity,
		minZ = Infinity,
		maxZ = -Infinity;
	for (const [x, z] of ring) {
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minZ = Math.min(minZ, z);
		maxZ = Math.max(maxZ, z);
	}
	return { minX, maxX, minZ, maxZ };
}

const inBounds = (b: ReturnType<typeof bounds>, x: number, z: number, margin = 0) =>
	x >= b.minX - margin && x <= b.maxX + margin && z >= b.minZ - margin && z <= b.maxZ + margin;

/** Floor heights of a placed building: the floor inside the footprint, porch and steps outside;
 * null elsewhere (terrain). */
export function floorAt(spec: BuildingSpec, frame: Frame, x: number, z: number): number | null {
	const [lx, lz] = frame.toLocal(x, z);
	if (inBounds(bounds(spec.footprint), lx, lz)) return frame.ground + spec.floor;
	for (const step of spec.steps) if (inBounds(bounds(step.ring), lx, lz)) return frame.ground + step.height;
	return null;
}

/** The room at a model-space point, if any. */
export function roomAt(spec: BuildingSpec, lx: number, lz: number, level = 0): RoomSpec | null {
	for (const room of spec.rooms) {
		if ((room.level ?? 0) !== level) continue;
		for (const [x0, x1, z0, z1] of room.rects) if (lx >= x0 && lx <= x1 && lz >= z0 && lz <= z1) return room;
	}
	return null;
}

/** Distance from a point to a rectangle [x0, x1, z0, z1] (0 inside). */
export function rectDistance([x0, x1, z0, z1]: [number, number, number, number], x: number, z: number): number {
	return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1));
}

/** Inside the room (the interior volume), with a margin (negative = further in). */
export function isInside(spec: BuildingSpec, frame: Frame, x: number, z: number, margin = 0): boolean {
	const [lx, lz] = frame.toLocal(x, z);
	const { min, max } = spec.interior;
	return lx >= min[0] - margin && lx <= max[0] + margin && lz >= min[1] - margin && lz <= max[1] + margin;
}

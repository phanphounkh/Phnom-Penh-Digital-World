/**
 * Enterable building specs (written by tools/blender/generate_house.py next to each GLB) and the
 * placement frame that puts a building into the world.
 *
 * Model coordinates: metres, x across the front, z out of the front door (+Z), y up, origin at
 * ground level in the centre of the footprint. A placement rotates the model by `yaw` (like
 * Object3D.rotation.y) and moves it to (x, z) on the terrain.
 */

export type XZ = [number, number];

export interface DoorSpec {
	id: string;
	/** GLB node whose origin is on the hinge axis; it opens by +rotation.y. */
	node: string;
	hinge: XZ;
	width: number;
	thickness: number;
	height: number;
	openYaw: number;
	/** Middle of the doorway (mid-wall) and the direction out of the building. */
	center: XZ;
	outward: XZ;
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
}

export interface BuildingSpec {
	version: 1;
	name: string;
	model: string;
	lightmap: string;
	/** The same room lit by its lamps only (no sun); blended in by the city's night factor. */
	lightmapNight?: string;
	/** The lightmap PNG stores light / lightmapScale (sRGB-encoded). */
	lightmapScale: number;
	/** Floor height above the ground under the building (m). */
	floor: number;
	wallTop: number;
	footprint: XZ[];
	interior: { min: XZ; max: XZ; ceiling: number };
	/** Wall pieces (rectangles); the doorway is the gap between two of them. */
	walls: XZ[][];
	/** Over a doorway: blocks the camera above `base`, never walking. */
	lintels: { ring: XZ[]; base: number }[];
	door: DoorSpec;
	/** Raised ground outside: porch and steps (height above the ground). */
	steps: { ring: XZ[]; height: number }[];
	/** Round obstacles: [x, z, radius]. */
	posts: [number, number, number][];
	/** Furniture footprints (block walking, not the camera). */
	blockers: XZ[][];
	seats: SeatSpec[];
	lamps: { x: number; z: number; y: number }[];
	fan?: { node: string; rpm: number };
}

/** Where a building stands in the world. */
export interface BuildingPlacement {
	id: string;
	/** Spec URL (the GLB and lightmap are next to it). */
	spec: string;
	x: number;
	z: number;
	/** rotation.y of the model: 0 = front door facing +Z (south), π/2 = facing +X (east). */
	yaw: number;
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

/** Inside the room (the interior volume), with a margin (negative = further in). */
export function isInside(spec: BuildingSpec, frame: Frame, x: number, z: number, margin = 0): boolean {
	const [lx, lz] = frame.toLocal(x, z);
	const { min, max } = spec.interior;
	return lx >= min[0] - margin && lx <= max[0] + margin && lz >= min[1] - margin && lz <= max[1] + margin;
}

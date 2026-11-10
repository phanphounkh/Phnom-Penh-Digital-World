/**
 * Geometry of a walk-in shop unit, in world metres (x east, z = -north).
 *
 * A unit is a W x D rectangle whose first edge (corner 0 -> corner 1) lies on the street
 * wall of a real building. The local frame has its origin at the middle of that edge:
 * `a` runs along the frontage (corner 0 -> 1), `n` runs inward (into the shop).
 */
import type { ShopUnitWorld } from '$lib/api/market';

export const DOOR_HALF_WIDTH = 2.5; // a 5 m opening in a 6 m frontage (0.5 m jambs)
export const DOOR_HEIGHT = 2.9;

export interface ShopFrame {
	ox: number;
	oz: number;
	ux: number;
	uz: number;
	nx: number;
	nz: number;
	width: number;
	depth: number;
	ceiling: number;
	/** Yaw (rotation.y) of an object facing out of the door, towards the street. */
	outYaw: number;
}

export function frameOf(unit: ShopUnitWorld): ShopFrame {
	const [c0, c1, , c3] = unit.corners;
	const w = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) || unit.width_m;
	const d = Math.hypot(c3[0] - c0[0], c3[1] - c0[1]) || unit.depth_m;
	const ux = (c1[0] - c0[0]) / w, uz = (c1[1] - c0[1]) / w;
	const nx = (c3[0] - c0[0]) / d, nz = (c3[1] - c0[1]) / d;
	return {
		ox: (c0[0] + c1[0]) / 2,
		oz: (c0[1] + c1[1]) / 2,
		ux, uz, nx, nz,
		width: w,
		depth: d,
		ceiling: unit.ceiling_m,
		outYaw: Math.atan2(-nx, -nz)
	};
}

/** World x/z of local (a along the frontage, n inward). */
export function toWorld(f: ShopFrame, a: number, n: number): [number, number] {
	return [f.ox + f.ux * a + f.nx * n, f.oz + f.uz * a + f.nz * n];
}

/** Local (a, n) of a world point. */
export function toLocal(f: ShopFrame, x: number, z: number): [number, number] {
	const dx = x - f.ox, dz = z - f.oz;
	return [dx * f.ux + dz * f.uz, dx * f.nx + dz * f.nz];
}

/** Yaw for an object whose front (+Z) faces local direction (da, dn). */
export function yawFacing(f: ShopFrame, da: number, dn: number): number {
	const x = f.ux * da + f.nx * dn, z = f.uz * da + f.nz * dn;
	return Math.atan2(x, z);
}

/** Inside the shop floor (with an optional margin, e.g. to include the doorstep). */
export function isInside(f: ShopFrame, x: number, z: number, margin = 0): boolean {
	const [a, n] = toLocal(f, x, z);
	return Math.abs(a) <= f.width / 2 + margin && n >= -margin && n <= f.depth + margin;
}

/** The doorway as a wall segment (for collision) and its centre/direction (for the shader). */
export function doorway(f: ShopFrame) {
	const [ax, az] = toWorld(f, -DOOR_HALF_WIDTH, 0);
	const [bx, bz] = toWorld(f, DOOR_HALF_WIDTH, 0);
	return { ax, az, bx, bz, x: f.ox, z: f.oz, ux: f.ux, uz: f.uz, halfWidth: DOOR_HALF_WIDTH };
}

/** The unit's floor outline as a closed ring (collision walls, height = ceiling). */
export function ring(unit: ShopUnitWorld): [number, number][] {
	return unit.corners.map(([x, z]) => [x, z] as [number, number]);
}

export interface Placement {
	a: number;
	n: number;
	y: number;
	/** Facing direction in local coordinates (where a customer stands). */
	fa: number;
	fn: number;
}

/** Shelf levels (top surfaces, m) of the Blender shelf used for display. */
export const SHELF_LEVELS = [0.57, 1.0, 1.43];
const SHELF_SLOTS = [-0.72, -0.24, 0.24, 0.72];
const SHELF_DEPTH = 0.42;

/**
 * The interior layout: two shelving units on each side wall (fronts facing the aisle), an
 * island table in the middle, the checkout counter at the back and the cart by the door.
 */
export function interiorLayout(f: ShopFrame) {
	const half = f.width / 2;
	const shelfN = [Math.min(2.6, f.depth * 0.33), Math.min(4.8, f.depth * 0.6)];
	const shelves: Placement[] = [];
	for (const side of [-1, 1])
		for (const n of shelfN)
			shelves.push({ a: side * (half - SHELF_DEPTH / 2 - 0.05), n, y: 0, fa: -side, fn: 0 });
	const slots: Placement[] = [];
	for (const shelf of shelves)
		for (const y of SHELF_LEVELS)
			for (const s of SHELF_SLOTS) {
				// Along the shelf's width (which runs along n), at the middle of its depth.
				slots.push({ a: shelf.a, n: shelf.n + s, y, fa: shelf.fa, fn: 0 });
			}
	const tableN = Math.min(3.7, f.depth * 0.46);
	const table: Placement = { a: 0, n: tableN, y: 0, fa: 0, fn: -1 };
	for (const da of [-0.22, 0.22])
		for (const dn of [-0.45, 0, 0.45]) slots.push({ a: da, n: tableN + dn, y: 0.83, fa: 0, fn: -1 });
	return {
		shelves,
		slots,
		table,
		counter: { a: half - 1.25, n: f.depth - 0.85, y: 0, fa: 0, fn: -1 } as Placement,
		cart: { a: -half + 1.2, n: 1.25, y: 0, fa: 0, fn: 1 } as Placement
	};
}

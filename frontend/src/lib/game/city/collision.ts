/**
 * 2D collision against building footprints and water (world x/z metres).
 *
 * Footprints are stored per chunk (so they unload with it) in a uniform grid of wall
 * segments. The player is a circle; movement is resolved by pushing the circle out of any
 * wall it overlaps. The camera uses a 2D ray test that respects building heights.
 */
import type { XZ } from '$lib/api/types';

export interface Wall {
	ax: number;
	az: number;
	bx: number;
	bz: number;
	/** Height of the obstacle in metres (0 = blocks walking only, e.g. water). */
	h: number;
	poly: number;
}

interface Footprint {
	ring: XZ[];
	minX: number;
	minZ: number;
	maxX: number;
	maxZ: number;
}

const CELL = 12;

class ChunkColliders {
	grid = new Map<number, Wall[]>();
	polys: Footprint[] = [];
}

const cellKey = (cx: number, cz: number) => cx * 73856093 + cz * 19349663;

export class CollisionWorld {
	private chunks = new Map<string, ChunkColliders>();
	/** Rectangular world limit (the edge of the mapped neighbourhood). */
	bounds: { minX: number; minZ: number; maxX: number; maxZ: number } | null = null;

	addRing(owner: string, ring: XZ[], height: number): void {
		if (ring.length < 3) return;
		let chunk = this.chunks.get(owner);
		if (!chunk) this.chunks.set(owner, (chunk = new ChunkColliders()));
		let minX = Infinity,
			minZ = Infinity,
			maxX = -Infinity,
			maxZ = -Infinity;
		for (const [x, z] of ring) {
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minZ = Math.min(minZ, z);
			maxZ = Math.max(maxZ, z);
		}
		const poly = chunk.polys.push({ ring, minX, minZ, maxX, maxZ }) - 1;
		for (let i = 0; i < ring.length; i++) {
			const [ax, az] = ring[i];
			const [bx, bz] = ring[(i + 1) % ring.length];
			const wall: Wall = { ax, az, bx, bz, h: height, poly };
			const c0x = Math.floor(Math.min(ax, bx) / CELL);
			const c1x = Math.floor(Math.max(ax, bx) / CELL);
			const c0z = Math.floor(Math.min(az, bz) / CELL);
			const c1z = Math.floor(Math.max(az, bz) / CELL);
			for (let cx = c0x; cx <= c1x; cx++)
				for (let cz = c0z; cz <= c1z; cz++) {
					const k = cellKey(cx, cz);
					const list = chunk.grid.get(k);
					if (list) list.push(wall);
					else chunk.grid.set(k, [wall]);
				}
		}
	}

	/** A small round obstacle (tree trunk, pole) that blocks walking but not the camera. */
	addCircle(owner: string, x: number, z: number, r: number): void {
		const ring: XZ[] = [];
		for (let i = 0; i < 6; i++) {
			const a = (i / 6) * Math.PI * 2;
			ring.push([x + Math.cos(a) * r, z + Math.sin(a) * r]);
		}
		this.addRing(owner, ring, 0);
	}

	removeOwner(owner: string): void {
		this.chunks.delete(owner);
	}

	get ownerCount(): number {
		return this.chunks.size;
	}

	/** Walls whose grid cells overlap the square around (x, z). May contain duplicates. */
	query(x: number, z: number, r: number, out: Wall[] = []): Wall[] {
		out.length = 0;
		const c0x = Math.floor((x - r) / CELL),
			c1x = Math.floor((x + r) / CELL);
		const c0z = Math.floor((z - r) / CELL),
			c1z = Math.floor((z + r) / CELL);
		for (const chunk of this.chunks.values())
			for (let cx = c0x; cx <= c1x; cx++)
				for (let cz = c0z; cz <= c1z; cz++) {
					const list = chunk.grid.get(cellKey(cx, cz));
					if (list) for (const w of list) out.push(w);
				}
		return out;
	}

	/** The footprint containing (x, z), if any. */
	containing(x: number, z: number): XZ[] | null {
		for (const chunk of this.chunks.values())
			for (const p of chunk.polys) {
				if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
				if (pointInRing(x, z, p.ring)) return p.ring;
			}
		return null;
	}
}

export function pointInRing(x: number, z: number, ring: XZ[]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, zi] = ring[i];
		const [xj, zj] = ring[j];
		if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
	}
	return inside;
}

function closestOnSegment(px: number, pz: number, w: Wall): [number, number] {
	const dx = w.bx - w.ax,
		dz = w.bz - w.az;
	const len2 = dx * dx + dz * dz;
	const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - w.ax) * dx + (pz - w.az) * dz) / len2)) : 0;
	return [w.ax + t * dx, w.az + t * dz];
}

const scratch: Wall[] = [];

/**
 * Move a circle from its current position by (dx, dz), sliding along walls.
 * Large moves are split into sub-steps so fast movement cannot tunnel through thin walls.
 */
export function moveCircle(
	world: CollisionWorld,
	x: number,
	z: number,
	dx: number,
	dz: number,
	radius: number
): { x: number; z: number; blocked: boolean } {
	const distance = Math.hypot(dx, dz);
	const steps = Math.max(1, Math.ceil(distance / (radius * 0.5)));
	let blocked = false;
	for (let s = 0; s < steps; s++) {
		x += dx / steps;
		z += dz / steps;
		for (let iteration = 0; iteration < 3; iteration++) {
			let pushed = false;
			for (const w of world.query(x, z, radius + 0.1, scratch)) {
				const [cx, cz] = closestOnSegment(x, z, w);
				let nx = x - cx,
					nz = z - cz;
				const d = Math.hypot(nx, nz);
				if (d >= radius) continue;
				if (d < 1e-6) {
					// Exactly on the wall: push along the wall's normal.
					nx = -(w.bz - w.az);
					nz = w.bx - w.ax;
				}
				const n = Math.hypot(nx, nz) || 1;
				x = cx + (nx / n) * radius;
				z = cz + (nz / n) * radius;
				pushed = blocked = true;
			}
			if (!pushed) break;
		}
		const b = world.bounds;
		if (b) {
			const cx = Math.min(b.maxX - radius, Math.max(b.minX + radius, x));
			const cz = Math.min(b.maxZ - radius, Math.max(b.minZ + radius, z));
			if (cx !== x || cz !== z) blocked = true;
			x = cx;
			z = cz;
		}
	}
	return { x, z, blocked };
}

/** If (x, z) is inside a footprint (e.g. after a data update), move it to the nearest edge. */
export function escapeFootprint(
	world: CollisionWorld,
	x: number,
	z: number,
	radius: number
): { x: number; z: number } {
	const ring = world.containing(x, z);
	if (!ring) return { x, z };
	let best = { x, z, d: Infinity };
	for (let i = 0; i < ring.length; i++) {
		const [ax, az] = ring[i];
		const [bx, bz] = ring[(i + 1) % ring.length];
		const [cx, cz] = closestOnSegment(x, z, { ax, az, bx, bz, h: 0, poly: 0 });
		const d = Math.hypot(cx - x, cz - z);
		if (d < best.d) {
			const len = d || 1;
			best = { x: cx + ((cx - x) / len) * (radius + 0.2), z: cz + ((cz - z) / len) * (radius + 0.2), d };
		}
	}
	return { x: best.x, z: best.z };
}

/**
 * Fraction (0–1) along the 3D segment from `a` to `b` where it first passes through a wall
 * that is taller than the segment at that point; 1 when unobstructed. Used by the camera.
 */
export function rayFraction(
	world: CollisionWorld,
	ax: number,
	ay: number,
	az: number,
	bx: number,
	by: number,
	bz: number
): number {
	const dx = bx - ax,
		dz = bz - az;
	const length = Math.hypot(dx, dz);
	let best = 1;
	const midX = (ax + bx) / 2,
		midZ = (az + bz) / 2;
	for (const w of world.query(midX, midZ, length / 2 + 1, scratch)) {
		if (w.h <= 0) continue;
		const ex = w.bx - w.ax,
			ez = w.bz - w.az;
		const denom = dx * ez - dz * ex;
		if (Math.abs(denom) < 1e-9) continue;
		const t = ((w.ax - ax) * ez - (w.az - az) * ex) / denom;
		const u = ((w.ax - ax) * dz - (w.az - az) * dx) / denom;
		if (t <= 0 || t >= best || u < 0 || u > 1) continue;
		const y = ay + (by - ay) * t;
		if (y < w.h) best = t;
	}
	return best;
}

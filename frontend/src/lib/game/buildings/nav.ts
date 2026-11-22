/**
 * Finding a way around furniture inside a building (model space): an A* search on a 0.2 m grid
 * whose blocked cells are within the player's radius of a wall, a door leaf or a furniture
 * footprint, then string-pulled into a few straight legs. Used to walk to a seat, so "Sit at the
 * Table" never walks into the table's corner. A few thousand cells: well under a millisecond.
 */
import type { XZ } from './spec';

const CELL = 0.2;
const MARGIN = 2;

/** Distance from a point to a polygon's edges (0 inside). */
function polygonDistance(ring: XZ[], x: number, z: number): number {
	let inside = false;
	let best = Infinity;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [ax, az] = ring[j];
		const [bx, bz] = ring[i];
		if (bz > z !== az > z && x < ((ax - bx) * (z - bz)) / (az - bz) + bx) inside = !inside;
		const dx = bx - ax,
			dz = bz - az;
		const l = dx * dx + dz * dz;
		const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l)) : 0;
		best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
	}
	return inside ? 0 : best;
}

export interface NavArea {
	/** The area searched (with a margin): [x0, x1, z0, z1]. */
	bounds: [number, number, number, number];
	/** Obstacles (rectangles/polygons in model space). */
	obstacles: XZ[][];
	radius: number;
}

/** A walkable path from `from` to `to` (both model space), or null if there is none. */
export function findPath(area: NavArea, from: XZ, to: XZ): XZ[] | null {
	const [bx0, bx1, bz0, bz1] = area.bounds;
	const x0 = bx0 - MARGIN,
		z0 = bz0 - MARGIN;
	const nx = Math.ceil((bx1 - bx0 + 2 * MARGIN) / CELL),
		nz = Math.ceil((bz1 - bz0 + 2 * MARGIN) / CELL);
	const centre = (i: number, k: number): XZ => [x0 + (i + 0.5) * CELL, z0 + (k + 0.5) * CELL];
	const blocked = new Uint8Array(nx * nz);
	const r = area.radius;
	for (const ring of area.obstacles) {
		let rx0 = Infinity,
			rx1 = -Infinity,
			rz0 = Infinity,
			rz1 = -Infinity;
		for (const [x, z] of ring) {
			rx0 = Math.min(rx0, x);
			rx1 = Math.max(rx1, x);
			rz0 = Math.min(rz0, z);
			rz1 = Math.max(rz1, z);
		}
		const i0 = Math.max(0, Math.floor((rx0 - r - x0) / CELL)),
			i1 = Math.min(nx - 1, Math.floor((rx1 + r - x0) / CELL));
		const k0 = Math.max(0, Math.floor((rz0 - r - z0) / CELL)),
			k1 = Math.min(nz - 1, Math.floor((rz1 + r - z0) / CELL));
		for (let i = i0; i <= i1; i++)
			for (let k = k0; k <= k1; k++) {
				const [cx, cz] = centre(i, k);
				if (polygonDistance(ring, cx, cz) < r) blocked[k * nx + i] = 1;
			}
	}
	const cellOf = ([x, z]: XZ) => [Math.max(0, Math.min(nx - 1, Math.floor((x - x0) / CELL))), Math.max(0, Math.min(nz - 1, Math.floor((z - z0) / CELL)))] as const;
	// Start and goal may sit right at an obstacle's edge (the stand-up spot of a dining chair):
	// search from/to the nearest free cell within half a metre; the path still ends exactly at `to`.
	const nearestFree = (p: XZ): number => {
		const [i0, k0] = cellOf(p);
		let best = k0 * nx + i0;
		if (!blocked[best]) return best;
		let bestD = Infinity;
		for (let di = -3; di <= 3; di++)
			for (let dk = -3; dk <= 3; dk++) {
				const i = i0 + di,
					k = k0 + dk;
				if (i < 0 || k < 0 || i >= nx || k >= nz || blocked[k * nx + i]) continue;
				const [cx, cz] = centre(i, k);
				const d = Math.hypot(cx - p[0], cz - p[1]);
				if (d < bestD) {
					bestD = d;
					best = k * nx + i;
				}
			}
		blocked[best] = 0;
		return best;
	};
	const start = nearestFree(from),
		goal = nearestFree(to);
	const ti = goal % nx,
		tk = Math.floor(goal / nx);
	const g = new Float32Array(nx * nz).fill(Infinity);
	const came = new Int32Array(nx * nz).fill(-1);
	const closed = new Uint8Array(nx * nz);
	const h = (c: number) => {
		const dx = Math.abs((c % nx) - ti),
			dz = Math.abs(Math.floor(c / nx) - tk);
		return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
	};
	const open: [number, number][] = [[h(start), start]];
	g[start] = 0;
	while (open.length) {
		let m = 0;
		for (let j = 1; j < open.length; j++) if (open[j][0] < open[m][0]) m = j;
		const [, c] = open[m];
		open[m] = open[open.length - 1];
		open.pop();
		if (closed[c]) continue;
		closed[c] = 1;
		if (c === goal) break;
		const ci = c % nx,
			ck = Math.floor(c / nx);
		for (let di = -1; di <= 1; di++)
			for (let dk = -1; dk <= 1; dk++) {
				if (!di && !dk) continue;
				const ni = ci + di,
					nk = ck + dk;
				if (ni < 0 || nk < 0 || ni >= nx || nk >= nz) continue;
				const n = nk * nx + ni;
				if (blocked[n] || closed[n]) continue;
				if (di && dk && (blocked[ck * nx + ni] || blocked[nk * nx + ci])) continue; // no corner cutting
				const cost = g[c] + (di && dk ? Math.SQRT2 : 1);
				if (cost < g[n]) {
					g[n] = cost;
					came[n] = c;
					open.push([cost + h(n), n]);
				}
			}
	}
	if (!closed[goal]) return null;
	const cells: number[] = [];
	for (let c = goal; c !== -1; c = came[c]) cells.push(c);
	cells.reverse();
	const points: XZ[] = [from, ...cells.map((c) => centre(c % nx, Math.floor(c / nx))), to];
	// String pulling: keep only the corners a straight walk needs.
	const clear = (a: XZ, b: XZ) => {
		const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL / 2));
		for (let s = 1; s < steps; s++) {
			const t = s / steps;
			const [i, k] = cellOf([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
			const c = k * nx + i;
			if (blocked[c] && c !== start && c !== goal) return false;
		}
		return true;
	};
	const out: XZ[] = [points[0]];
	let anchor = 0;
	for (let j = 2; j < points.length; j++) {
		if (!clear(points[anchor], points[j])) {
			anchor = j - 1;
			out.push(points[anchor]);
		}
	}
	out.push(points[points.length - 1]);
	return out.slice(1);
}

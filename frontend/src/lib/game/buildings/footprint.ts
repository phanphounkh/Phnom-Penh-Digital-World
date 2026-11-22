/**
 * Can this OpenStreetMap building have an interior, and where is its front door?
 *
 * planInterior() looks at a footprint and its surroundings and either returns a plan (an
 * interior rectangle inside the walls, a frame whose +Z points out through the entrance, and the
 * door on the facade) or the reason it said no. Buildings that cannot support a valid entrance
 * never get a broken door:
 * - holes (courtyards), raised parts (min height), landmark models and temple roofs,
 * - too small or too large, too low for a storey,
 * - irregular shapes (the interior must be a rectangle well inside the walls),
 * - too narrow for furniture and an aisle,
 * - no wall with a door-wide stretch facing a road with free space in front (shared walls of
 *   terraced shophouses and backs of blocks are skipped).
 * All pure geometry in world metres (x east, z = -north); unit-tested with many footprints.
 */

export type XZ = [number, number];

export type Reason =
	| 'holes'
	| 'landmark'
	| 'raised'
	| 'low'
	| 'too-small'
	| 'too-large'
	| 'irregular'
	| 'narrow'
	| 'no-entrance'
	| 'claimed'
	| 'hill';

export interface Plan {
	/** Interior centre (world) and rotation: local +Z points out of the entrance (rotation.y). */
	x: number;
	z: number;
	yaw: number;
	/** Interior size: across the entrance wall (local X) and into the building (local Z). */
	width: number;
	depth: number;
	/** Gap between the facade (OSM wall) and the interior wall faces (m). */
	wall: number;
	/** Ceiling height above the floor. */
	ceiling: number;
	/** The building's own height (its walls and roof around the room). */
	height: number;
	/** Door centre on the entrance wall (local X), its width. */
	doorX: number;
	doorWidth: number;
	/** The door on the facade, world: centre and along-wall unit (for the facade cut-out and the
	 * collision gap). */
	facade: { x: number; z: number; ux: number; uz: number };
}

export interface Surroundings {
	/** Road centrelines and widths near the building. */
	roads: { pts: XZ[]; w: number }[];
	/** Other buildings' outer rings near it. */
	neighbours: XZ[][];
}

export const LIMITS = { minArea: 18, maxArea: 450, minFill: 0.8, minSide: 3.4, maxSide: 12, minHeight: 2.8, wall: 0.25, door: 1.0, roadReach: 25, clearance: 1.4 };

export function area(ring: XZ[]): number {
	let s = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
	return Math.abs(s) / 2;
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

export function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
	const dx = bx - ax,
		dz = bz - az;
	const l = dx * dx + dz * dz;
	const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l)) : 0;
	return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}

function ringDistance(x: number, z: number, ring: XZ[]): number {
	let d = Infinity;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) d = Math.min(d, segmentDistance(x, z, ring[j][0], ring[j][1], ring[i][0], ring[i][1]));
	return d;
}

function nearestOnRing(x: number, z: number, ring: XZ[]): XZ {
	let best: XZ = [x, z];
	let bestD = Infinity;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [ax, az] = ring[j];
		const [bx, bz] = ring[i];
		const dx = bx - ax,
			dz = bz - az;
		const l = dx * dx + dz * dz;
		const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l)) : 0;
		const px = ax + t * dx,
			pz = az + t * dz;
		const d = Math.hypot(x - px, z - pz);
		if (d < bestD) {
			bestD = d;
			best = [px, pz];
		}
	}
	return best;
}

/** Minimum-area oriented rectangle (tested on every edge direction of the ring). */
export function orientedBox(ring: XZ[]): { cx: number; cz: number; ux: number; uz: number; halfU: number; halfV: number } {
	let best = { area: Infinity, cx: 0, cz: 0, ux: 1, uz: 0, halfU: 0, halfV: 0 };
	for (let i = 0; i < ring.length; i++) {
		const [ax, az] = ring[i];
		const [bx, bz] = ring[(i + 1) % ring.length];
		const l = Math.hypot(bx - ax, bz - az);
		if (l < 1e-6) continue;
		const ux = (bx - ax) / l,
			uz = (bz - az) / l;
		let u0 = Infinity,
			u1 = -Infinity,
			v0 = Infinity,
			v1 = -Infinity;
		for (const [x, z] of ring) {
			const u = x * ux + z * uz,
				v = -x * uz + z * ux;
			u0 = Math.min(u0, u);
			u1 = Math.max(u1, u);
			v0 = Math.min(v0, v);
			v1 = Math.max(v1, v);
		}
		const a = (u1 - u0) * (v1 - v0);
		if (a < best.area) {
			const cu = (u0 + u1) / 2,
				cv = (v0 + v1) / 2;
			best = { area: a, cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, ux, uz, halfU: (u1 - u0) / 2, halfV: (v1 - v0) / 2 };
		}
	}
	const { cx, cz, ux, uz, halfU, halfV } = best;
	return { cx, cz, ux, uz, halfU, halfV };
}

export interface BuildingInput {
	ring: XZ[];
	holes?: XZ[][];
	/** Height and base height (m) from OSM. */
	h: number;
	minH?: number;
	landmark?: boolean;
	/** On raised terrain (mounds): skipped for now (floors would not be flat). */
	hill?: boolean;
}

/**
 * The same entrance with a smaller room: at most `maxWidth` x `maxDepth`, against the entrance
 * wall and around the door (a house's living room; the rest of a big building stays closed back
 * rooms). The door and the facade do not move.
 */
export function fitRoom(plan: Plan, maxWidth: number, maxDepth: number): Plan {
	const width = Math.min(plan.width, maxWidth),
		depth = Math.min(plan.depth, maxDepth);
	if (width === plan.width && depth === plan.depth) return plan;
	// The new centre in the old room's frame: the front wall stays put, the door as central as
	// the old room allows.
	const slack = (plan.width - width) / 2;
	const lx = Math.max(-slack, Math.min(slack, plan.doorX)),
		lz = (plan.depth - depth) / 2;
	const c = Math.cos(plan.yaw),
		s = Math.sin(plan.yaw);
	return { ...plan, x: plan.x + lx * c + lz * s, z: plan.z - lx * s + lz * c, width, depth, doorX: plan.doorX - lx };
}

/** The point of segment a-b nearest to (x, z). */
function closestOnSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): XZ {
	const dx = bx - ax,
		dz = bz - az;
	const l = dx * dx + dz * dz;
	const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l)) : 0;
	return [ax + t * dx, az + t * dz];
}

/** True if segments p-q and a-b cross. */
function crosses(px: number, pz: number, qx: number, qz: number, ax: number, az: number, bx: number, bz: number): boolean {
	const side = (ox: number, oz: number, ux: number, uz: number, x: number, z: number) => (ux - ox) * (z - oz) - (uz - oz) * (x - ox);
	const d1 = side(ax, az, bx, bz, px, pz),
		d2 = side(ax, az, bx, bz, qx, qz),
		d3 = side(px, pz, qx, qz, ax, az),
		d4 = side(px, pz, qx, qz, bx, bz);
	return d1 * d2 < 0 && d3 * d4 < 0;
}

/** True if the straight walk from (x0, z0) to (x1, z1) crosses none of the rings' walls. */
export function clearLine(x0: number, z0: number, x1: number, z1: number, rings: XZ[][]): boolean {
	const minX = Math.min(x0, x1),
		maxX = Math.max(x0, x1),
		minZ = Math.min(z0, z1),
		maxZ = Math.max(z0, z1);
	for (const ring of rings)
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const [ax, az] = ring[j];
			const [bx, bz] = ring[i];
			if (Math.max(ax, bx) < minX || Math.min(ax, bx) > maxX || Math.max(az, bz) < minZ || Math.min(az, bz) > maxZ) continue;
			if (crosses(x0, z0, x1, z1, ax, az, bx, bz)) return false;
		}
	return true;
}

export function planInterior(b: BuildingInput, around: Surroundings): { ok: true; plan: Plan } | { ok: false; reason: Reason } {
	const L = LIMITS;
	if (b.landmark) return { ok: false, reason: 'landmark' };
	if (b.holes?.length) return { ok: false, reason: 'holes' };
	if ((b.minH ?? 0) > 0.5) return { ok: false, reason: 'raised' };
	if (b.hill) return { ok: false, reason: 'hill' };
	if (b.h < L.minHeight) return { ok: false, reason: 'low' };
	const A = area(b.ring);
	if (A < L.minArea) return { ok: false, reason: 'too-small' };
	if (A > L.maxArea) return { ok: false, reason: 'too-large' };
	const box = orientedBox(b.ring);
	if (A / (4 * box.halfU * box.halfV) < L.minFill) return { ok: false, reason: 'irregular' };
	// The interior rectangle: the box inset by the wall, shrunk until it sits inside the ring.
	const { cx, cz, ux, uz } = box;
	const vx = -uz,
		vz = ux;
	let hu = box.halfU - L.wall,
		hv = box.halfV - L.wall;
	const at = (u: number, v: number): XZ => [cx + ux * u + vx * v, cz + uz * u + vz * v];
	const fits = () => {
		for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const [x, z] = at(su * hu, sv * hv);
			if (!pointInRing(x, z, b.ring) || ringDistance(x, z, b.ring) < L.wall * 0.6) return false;
		}
		return true;
	};
	let shrink = 0;
	while (!fits() && shrink < 4) {
		hu -= 0.25;
		hv -= 0.25;
		shrink++;
	}
	if (!fits()) return { ok: false, reason: 'irregular' };
	if (Math.min(hu, hv) * 2 < L.minSide) return { ok: false, reason: 'narrow' };

	// Entrance: one of the four sides, on a straight stretch of the real wall, facing a road
	// with free space in front of the door.
	let bestScore = Infinity;
	let best: Plan | null = null;
	const sides = [
		{ nx: ux, nz: uz, half: hu, along: hv, tx: vx, tz: vz },
		{ nx: -ux, nz: -uz, half: hu, along: hv, tx: -vx, tz: -vz },
		{ nx: vx, nz: vz, half: hv, along: hu, tx: -ux, tz: -uz },
		{ nx: -vx, nz: -vz, half: hv, along: hu, tx: ux, tz: uz }
	];
	for (const s of sides) {
		const span = s.along - 0.8; // keep the door off the corners
		if (span < L.door / 2) continue;
		for (let a = -span; a <= span + 1e-6; a += 0.25) {
			// The door on the facade: walk outward from the interior wall to the ring.
			const ix = cx + s.nx * s.half + s.tx * a,
				iz = cz + s.nz * s.half + s.tz * a;
			let wall = -1;
			for (let d = 0; d <= L.wall + 0.6; d += 0.05)
				if (!pointInRing(ix + s.nx * d, iz + s.nz * d, b.ring)) {
					wall = d;
					break;
				}
			if (wall < 0) continue;
			// Exactly on the wall line (the collision doorway must lie on the OSM ring's edge).
			const [fx, fz] = nearestOnRing(ix + s.nx * wall, iz + s.nz * wall, b.ring);
			// The facade must be straight across the whole door (no corner, no step).
			let straight = true;
			for (const k of [-0.6, 0, 0.6]) {
				const px = fx + s.tx * k,
					pz = fz + s.tz * k;
				if (ringDistance(px, pz, b.ring) > 0.12) straight = false;
			}
			if (!straight) continue;
			// Free space in front: no other building (shared walls of terraced houses).
			const ox = fx + s.nx * L.clearance,
				oz = fz + s.nz * L.clearance;
			if (around.neighbours.some((n) => pointInRing(ox, oz, n) || ringDistance(ox, oz, n) < 0.5 || ringDistance(fx + s.nx * 0.3, fz + s.nz * 0.3, n) < 0.25)) continue;
			// A road in front, within reach.
			let road = Infinity;
			let rx_ = 0,
				rz_ = 0;
			for (const r of around.roads)
				for (let i = 0; i + 1 < r.pts.length; i++) {
					const [ax, az] = r.pts[i];
					const [bx, bz] = r.pts[i + 1];
					const d = segmentDistance(fx, fz, ax, az, bx, bz) - r.w / 2;
					const mx = (ax + bx) / 2 - fx,
						mz = (az + bz) / 2 - fz;
					if (d < road && (mx * s.nx + mz * s.nz > -1 || d < 3)) {
						road = d;
						[rx_, rz_] = closestOnSegment(ox, oz, ax, az, bx, bz);
					}
				}
			if (road > L.roadReach) continue;
			const score = road + Math.abs(a) * 0.2;
			// And a clear way out to it: nothing built between the door and the street (a door
			// onto a back yard walled in by other buildings could never be reached).
			if (score < bestScore && road > 0.5 && !clearLine(ox, oz, rx_, rz_, [b.ring, ...around.neighbours])) continue;
			if (score < bestScore) {
				bestScore = score;
				const yaw = Math.atan2(s.nx, s.nz);
				// Deep shophouses and big halls: the room is the front part (at most maxSide each
				// way), against the entrance wall and around the door; the rest are back rooms.
				const depth = Math.min(s.half * 2, L.maxSide),
					width = Math.min(s.along * 2, L.maxSide);
				const slide = Math.max(-(s.along * 2 - width) / 2, Math.min((s.along * 2 - width) / 2, a));
				const rx = cx + s.nx * (s.half - depth / 2) + s.tx * slide,
					rz = cz + s.nz * (s.half - depth / 2) + s.tz * slide;
				// Local X (rotation.y frame) is (cos yaw, -sin yaw) = (nz, -nx); the door's local X:
				const doorX = (ix - (rx + s.nx * depth / 2)) * s.nz + (iz - (rz + s.nz * depth / 2)) * -s.nx;
				best = {
					x: rx,
					z: rz,
					yaw,
					width,
					depth,
					wall,
					ceiling: Math.min(3.0, b.h - 0.3),
					height: b.h,
					doorX,
					doorWidth: L.door,
					facade: { x: fx, z: fz, ux: s.tx, uz: s.tz }
				};
			}
		}
	}
	return best ? { ok: true, plan: best } : { ok: false, reason: 'no-entrance' };
}

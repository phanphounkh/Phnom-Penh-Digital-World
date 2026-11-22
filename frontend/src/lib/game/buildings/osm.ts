/**
 * OpenStreetMap buildings as enterable buildings: find the ones near the player that are listed
 * (or, with auto mode, every eligible one), plan their interiors (footprint.ts) once, and report
 * why the others are not eligible.
 */
import type { ChunkPayload } from '$lib/api/types';
import { planInterior, pointInRing, type Plan, type Reason, type XZ } from './footprint';

export type InteriorType = 'house' | 'shop' | 'cafe';

export interface Candidate {
	/** OSM building id. */
	id: number;
	name: string | null;
	kind: string;
	ring: XZ[];
	result: { ok: true; plan: Plan } | { ok: false; reason: Reason };
}

const centroid = (ring: XZ[]): XZ => {
	let x = 0,
		z = 0;
	for (const [px, pz] of ring) {
		x += px;
		z += pz;
	}
	return [x / ring.length, z / ring.length];
};

/**
 * Plan every building in the loaded chunks whose centre is within `radius` of (x, z). `claimed`
 * points (walk-in shop doors) exclude their building; `hill` reports raised ground.
 */
export function scan(
	payloads: ChunkPayload[],
	x: number,
	z: number,
	radius: number,
	claimed: XZ[] = [],
	hill: (x: number, z: number, r: number) => boolean = () => false,
	only?: Set<number>
): Candidate[] {
	const buildings = payloads.flatMap((p) => p.buildings);
	const roads = payloads.flatMap((p) => p.roads.map((r) => ({ pts: r.pts, w: r.w })));
	const out: Candidate[] = [];
	for (const b of buildings) {
		if (b.id === null || !b.polys.length || !b.polys[0][0]?.length) continue;
		if (only && !only.has(b.id)) continue;
		const ring = b.polys[0][0] as XZ[];
		const [cx, cz] = centroid(ring);
		if (Math.hypot(cx - x, cz - z) > radius) continue;
		let result: Candidate['result'];
		if (claimed.some(([px, pz]) => pointInRing(px, pz, ring) || ringNear(px, pz, ring, 1.5))) result = { ok: false, reason: 'claimed' };
		else if (b.polys.length > 1) result = { ok: false, reason: 'irregular' };
		else {
			const near = (r: XZ[]) => r.some(([px, pz]) => Math.abs(px - cx) < 50 && Math.abs(pz - cz) < 50);
			const neighbours = buildings.filter((o) => o !== b && o.polys[0]?.[0] && near(o.polys[0][0] as XZ[])).map((o) => o.polys[0][0] as XZ[]);
			result = planInterior(
				{ ring, holes: b.polys[0].slice(1) as XZ[][], h: b.h, minH: b.min_h, landmark: !!b.model || !!b.roof, hill: hill(cx, cz, 15) },
				{ roads: roads.filter((r) => r.pts.some(([px, pz]) => Math.hypot(px - cx, pz - cz) < 80)), neighbours }
			);
		}
		out.push({ id: b.id, name: b.name, kind: b.kind, ring, result });
	}
	return out;
}

function ringNear(x: number, z: number, ring: XZ[], d: number): boolean {
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [ax, az] = ring[j];
		const [bx, bz] = ring[i];
		const dx = bx - ax,
			dz = bz - az;
		const l = dx * dx + dz * dz;
		const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l)) : 0;
		if (Math.hypot(x - ax - t * dx, z - az - t * dz) < d) return true;
	}
	return false;
}

/** How many buildings are eligible, and why the others are not. */
export function report(candidates: Candidate[]): { total: number; eligible: number; reasons: Partial<Record<Reason, number>> } {
	const reasons: Partial<Record<Reason, number>> = {};
	let eligible = 0;
	for (const c of candidates) {
		if (c.result.ok) eligible++;
		else reasons[c.result.reason] = (reasons[c.result.reason] ?? 0) + 1;
	}
	return { total: candidates.length, eligible, reasons };
}

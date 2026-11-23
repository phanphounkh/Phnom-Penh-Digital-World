/**
 * OpenStreetMap buildings as enterable buildings: find the ones near the player that are listed
 * (or, in auto mode, every eligible one), plan their interiors (footprint.ts) once, and report
 * why the others are not eligible.
 */
import type { ChunkPayload } from '$lib/api/types';
import { area, planInterior, pointInRing, type Plan, type Reason, type XZ } from './footprint';

/** What a building is inside: a home, a shop, a café, or an office (the System Office, placed by
 * id: never chosen by OSM kind). */
export type InteriorType = 'house' | 'shop' | 'cafe' | 'office';

export interface Candidate {
	/** OSM building id. */
	id: number;
	name: string | null;
	kind: string;
	ring: XZ[];
	/** Distance from the scan centre (m). */
	d: number;
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

/** Plans only depend on the (static) map: each building is planned once. */
const plans = new Map<string, Candidate['result']>();

/**
 * Plan every building in the loaded chunks whose centre is within `radius` of (x, z), nearest
 * first. `claimed` points (walk-in shop doors) exclude their building; `hill` reports raised
 * ground. With a `budget` (ms), buildings not planned yet are left for a later call once it is
 * spent (planning a big irregular building takes a few milliseconds).
 */
export function scan(
	payloads: ChunkPayload[],
	x: number,
	z: number,
	radius: number,
	claimed: XZ[] = [],
	hill: (x: number, z: number, r: number) => boolean = () => false,
	only?: Set<number>,
	budget = Infinity
): Candidate[] {
	const buildings = payloads.flatMap((p) => p.buildings);
	const roads = payloads.flatMap((p) =>
		p.roads.map((r) => {
			const xs = r.pts.map((q) => q[0]),
				zs = r.pts.map((q) => q[1]);
			return { pts: r.pts, w: r.w, box: [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)] };
		})
	);
	const near: { b: (typeof buildings)[number]; poly: XZ[][]; c: XZ; d: number }[] = [];
	for (const b of buildings) {
		if (b.id === null || !b.polys.length || !b.polys[0][0]?.length) continue;
		if (only && !only.has(b.id)) continue;
		// A building in several parts: its biggest part.
		const poly = (b.polys.length > 1 ? [...b.polys].sort((p, q) => area(q[0] as XZ[]) - area(p[0] as XZ[]))[0] : b.polys[0]) as XZ[][];
		const c = centroid(poly[0]);
		const d = Math.hypot(c[0] - x, c[1] - z);
		if (d <= radius) near.push({ b, poly, c, d });
	}
	near.sort((p, q) => p.d - q.d);
	const until = performance.now() + budget;
	const out: Candidate[] = [];
	for (const { b, poly, c, d } of near) {
		const ring = poly[0];
		let result: Candidate['result'];
		if (claimed.some(([px, pz]) => pointInRing(px, pz, ring) || ringNear(px, pz, ring, 1.5))) result = { ok: false, reason: 'claimed' };
		else {
			const key = `${b.id}:${ring.length}:${ring[0][0]}:${ring[0][1]}`;
			let cached = plans.get(key);
			if (!cached) {
				if (performance.now() > until) continue; // next time
				const [cx, cz] = c;
				const close = (r: XZ[]) => r.some(([px, pz]) => Math.abs(px - cx) < 50 && Math.abs(pz - cz) < 50);
				const neighbours = buildings.filter((o) => o !== b && o.polys[0]?.[0] && close(o.polys[0][0] as XZ[])).flatMap((o) => o.polys.map((p) => p[0] as XZ[]));
				cached = planInterior(
					{ ring, holes: poly.slice(1), h: b.h, minH: b.min_h, landmark: !!b.model || !!b.roof, hill: hill(cx, cz, 15) },
					// Roads passing within 80 m (by their extent: a long straight street has its
					// vertices far apart).
					{ roads: roads.filter(({ box: [x0, x1, z0, z1] }) => cx > x0 - 80 && cx < x1 + 80 && cz > z0 - 80 && cz < z1 + 80), neighbours: [...neighbours, ...b.polys.filter((p) => (p as unknown) !== poly).map((p) => p[0] as XZ[])] }
				);
				plans.set(key, cached);
			}
			result = cached;
		}
		out.push({ id: b.id!, name: b.name, kind: b.kind, ring, d, result });
	}
	return out;
}

/** What a building becomes inside: homes for residential buildings, shops and cafés for
 * commercial ones, and a mix (mostly homes) for the many tagged just "building". */
export function interiorType(kind: string, id: number): InteriorType {
	const k = kind.toLowerCase();
	if (/^(house|residential|detached|semidetached_house|terrace|apartments|dormitory|bungalow|hut|cabin|villa)$/.test(k)) return 'house';
	if (/^(retail|commercial|kiosk|supermarket|shop)$/.test(k)) return id % 3 === 0 ? 'cafe' : 'shop';
	const r = (id * 2654435761) % 10;
	return r < 6 ? 'house' : r < 8 ? 'shop' : 'cafe';
}

const CAFE_NAMES = ['Lotus Café', 'Mekong Coffee', 'Palm Tree Café', 'Morning Glory Café', 'Kampot Pepper Café', 'Tonle Coffee', 'Frangipani Café', 'Sugar Palm Coffee'];
const SHOP_NAMES = ['Corner Mart', 'Daily Needs', 'Sokha Mini-mart', 'Neighbourhood Store', 'Bayon Mart', 'Family Mart Phsar', 'Rumdoul Store', 'Golden Lotus Mart'];

/** A shop or café's name for its sign (made up, chosen by the building id: the same for
 * everyone). Houses have none. */
export function interiorName(type: InteriorType, id: number): string | undefined {
	if (type === 'house') return undefined;
	const names = type === 'cafe' ? CAFE_NAMES : SHOP_NAMES;
	return names[(id * 7 + 3) % names.length];
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

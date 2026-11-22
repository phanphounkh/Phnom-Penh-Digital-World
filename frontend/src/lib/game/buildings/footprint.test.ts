import { describe, expect, it } from 'vitest';
import { LIMITS, area, clearLine, largestRoom, orientedBox, planInterior, pointInRing, segmentDistance, type Surroundings, type XZ } from './footprint';

/** An axis-aligned rectangle ring, optionally rotated about its centre. */
function rect(cx: number, cz: number, w: number, d: number, angle = 0): XZ[] {
	const c = Math.cos(angle),
		s = Math.sin(angle);
	return [
		[-w / 2, -d / 2],
		[w / 2, -d / 2],
		[w / 2, d / 2],
		[-w / 2, d / 2]
	].map(([x, z]) => [cx + x * c - z * s, cz + x * s + z * c] as XZ);
}
/** The room's corners (world) from a plan. */
function corners(p: { x: number; z: number; yaw: number; width: number; depth: number }): XZ[] {
	return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
		const lx = (sx * p.width) / 2,
			lz = (sz * p.depth) / 2;
		return [p.x + lx * Math.cos(p.yaw) + lz * Math.sin(p.yaw), p.z - lx * Math.sin(p.yaw) + lz * Math.cos(p.yaw)] as XZ;
	});
}
/** A straight road along x at z = zRoad. */
const road = (zRoad: number, x0 = -50, x1 = 50, w = 8): Surroundings['roads'][number] => ({ pts: [[x0, zRoad], [x1, zRoad]], w });
const none: Surroundings = { roads: [], neighbours: [] };

describe('footprint geometry', () => {
	it('measures areas, containment and boxes', () => {
		expect(area(rect(0, 0, 10, 8))).toBeCloseTo(80);
		expect(pointInRing(0, 0, rect(0, 0, 2, 2))).toBe(true);
		expect(pointInRing(3, 0, rect(0, 0, 2, 2))).toBe(false);
		expect(segmentDistance(0, 1, -1, 0, 1, 0)).toBeCloseTo(1);
		const b = orientedBox(rect(5, 5, 12, 6, 0.5));
		expect(b.halfU * b.halfV * 4).toBeCloseTo(72, 3);
		expect(b.cx).toBeCloseTo(5);
		expect(b.cz).toBeCloseTo(5);
	});
});

describe('planInterior: which buildings can be entered, and where', () => {
	it('a plain 10 x 8 building by a road: door on the road side, facing it', () => {
		const ring = rect(0, 0, 10, 8);
		const r = planInterior({ ring, h: 6 }, { roads: [road(10)], neighbours: [] });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const p = r.plan;
		// Facing +Z (the road is at z = +10): yaw 0, the door on the z = +4 wall.
		expect(Math.cos(p.yaw)).toBeCloseTo(1, 3);
		expect(p.facade.z).toBeCloseTo(4, 1);
		expect(Math.abs(p.facade.x)).toBeLessThan(10 / 2 - 0.8);
		expect(p.width).toBeCloseTo(10 - 2 * LIMITS.wall, 1);
		expect(p.depth).toBeCloseTo(8 - 2 * LIMITS.wall, 1);
		expect(p.ceiling).toBeCloseTo(3.0);
	});

	it('works the same for a rotated building: the door sits on its wall and faces the road', () => {
		const ring = rect(20, -30, 9, 7, 0.6);
		const r = planInterior({ ring, h: 9 }, { roads: [{ pts: [[-50, -30 + 12], [80, -30 + 12]], w: 6 }], neighbours: [] });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const p = r.plan;
		// The facade point is on the ring's outline.
		let d = Infinity;
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) d = Math.min(d, segmentDistance(p.facade.x, p.facade.z, ring[j][0], ring[j][1], ring[i][0], ring[i][1]));
		expect(d).toBeLessThan(0.1);
		// Out of the door is towards the road (+z).
		expect(Math.cos(p.yaw)).toBeGreaterThan(0.3);
		// The local frame: +Z out of the door is perpendicular to the facade.
		expect(Math.abs(Math.sin(p.yaw) * p.facade.ux + Math.cos(p.yaw) * p.facade.uz)).toBeLessThan(1e-6);
	});

	it('rejects what cannot hold a room', () => {
		const roads = { roads: [road(10)], neighbours: [] };
		expect(planInterior({ ring: rect(0, 0, 3, 4), h: 6 }, roads)).toEqual({ ok: false, reason: 'too-small' });
		expect(planInterior({ ring: rect(0, 0, 50, 50), h: 6 }, roads)).toEqual({ ok: false, reason: 'too-large' });
		expect(planInterior({ ring: rect(0, 0, 2.8, 12), h: 6 }, roads)).toEqual({ ok: false, reason: 'narrow' });
		expect(planInterior({ ring: rect(0, 0, 10, 8), h: 2.4 }, roads)).toEqual({ ok: false, reason: 'low' });
		expect(planInterior({ ring: rect(0, 0, 10, 8), h: 9, minH: 3 }, roads)).toEqual({ ok: false, reason: 'raised' });
		expect(planInterior({ ring: rect(0, 0, 10, 8), h: 9, landmark: true }, roads)).toEqual({ ok: false, reason: 'landmark' });
		expect(planInterior({ ring: rect(0, 0, 10, 8), h: 9, hill: true }, roads)).toEqual({ ok: false, reason: 'hill' });
	});

	it('a deep shophouse: the room is the front part, against the entrance', () => {
		const r = planInterior({ ring: rect(0, 0, 8, 30), h: 9 }, { roads: [road(20)], neighbours: [] });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.plan.depth).toBeCloseTo(LIMITS.maxSide);
		expect(r.plan.facade.z).toBeCloseTo(15, 1);
		// The front of the room is just inside the front wall (z = 15 - wall).
		expect(r.plan.z + r.plan.depth / 2).toBeCloseTo(15 - LIMITS.wall, 1);
		expect(Math.abs(r.plan.doorX)).toBeLessThan(r.plan.width / 2);
	});

	it('an L-shaped building: the biggest room that fits, door on an outside wall', () => {
		const L: XZ[] = [[0, 0], [12, 0], [12, 5], [5, 5], [5, 12], [0, 12]];
		const r = planInterior({ ring: L, h: 6 }, { roads: [road(-6)], neighbours: [] });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		for (const [x, z] of corners(r.plan)) expect(pointInRing(x, z, L)).toBe(true);
		expect(r.plan.width * r.plan.depth).toBeGreaterThan(40); // the 12 x 5 wing, less the walls
		expect(r.plan.facade.z).toBeCloseTo(0, 1); // on the wall facing the road (z = -6)
	});

	it('a building around a courtyard: the room is beside the yard, never in it', () => {
		const yard = rect(0, 0, 3, 3);
		const r = planInterior({ ring: rect(0, 0, 14, 10), holes: [yard], h: 6 }, { roads: [road(10)], neighbours: [] });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const [x0, x1, z0, z1] = [-1.5, 1.5, -1.5, 1.5];
		const cs = corners(r.plan);
		const minX = Math.min(...cs.map((c) => c[0])),
			maxX = Math.max(...cs.map((c) => c[0])),
			minZ = Math.min(...cs.map((c) => c[1])),
			maxZ = Math.max(...cs.map((c) => c[1]));
		expect(maxX <= x0 || minX >= x1 || maxZ <= z0 || minZ >= z1).toBe(true);
	});

	it('finds the largest rectangle inside a shape', () => {
		const L: XZ[] = [[0, 0], [12, 0], [12, 5], [5, 5], [5, 12], [0, 12]];
		const room = largestRoom(L, [], orientedBox(L), 3)!;
		expect(room).not.toBeNull();
		expect(4 * room.hu * room.hv).toBeGreaterThan(45);
		expect(4 * room.hu * room.hv).toBeLessThan(60);
		expect(largestRoom(rect(0, 0, 2, 20), [], orientedBox(rect(0, 0, 2, 20)), 3)).toBeNull(); // too narrow
	});

	it('copes with a small notch by shrinking the room', () => {
		const notched: XZ[] = [[-5, -4], [5, -4], [5, 3.6], [4.4, 3.6], [4.4, 4], [-5, 4]];
		const r = planInterior({ ring: notched, h: 6 }, { roads: [road(10)], neighbours: [] });
		expect(r.ok).toBe(true);
	});

	it('terraced shophouses: never a door in a shared wall', () => {
		// Three 5 m wide houses side by side, 14 m deep, the street along their front (z = +10).
		const houses = [rect(-5, 0, 5, 14), rect(0, 0, 5, 14), rect(5, 0, 5, 14)];
		const middle = planInterior({ ring: houses[1], h: 9 }, { roads: [road(10)], neighbours: [houses[0], houses[2]] });
		expect(middle.ok).toBe(true);
		if (middle.ok) expect(middle.plan.facade.z).toBeCloseTo(7, 1); // the front, not a party wall
		// Something built right in front and no other road: no entrance at all.
		const blocked = planInterior({ ring: houses[1], h: 9 }, { roads: [road(10)], neighbours: [houses[0], houses[2], rect(0, 8, 12, 2)] });
		expect(blocked).toEqual({ ok: false, reason: 'no-entrance' });
	});

	it('needs a clear way out to the street: no building in between', () => {
		// The street is 12 m in front, but a long building stands between the door and it.
		const walledIn = planInterior({ ring: rect(0, 0, 10, 8), h: 6 }, { roads: [road(16)], neighbours: [rect(0, 10, 30, 3)] });
		expect(walledIn).toEqual({ ok: false, reason: 'no-entrance' });
		// A gap in that row, right in front of the building: the door faces the gap.
		const gap = planInterior({ ring: rect(0, 0, 10, 8), h: 6 }, { roads: [road(16)], neighbours: [rect(-9, 10, 12, 3), rect(9, 10, 12, 3)] });
		expect(gap.ok).toBe(true);
		if (gap.ok) expect(Math.abs(gap.plan.facade.x)).toBeLessThan(3);
		expect(clearLine(0, 0, 0, 20, [rect(0, 10, 4, 2)])).toBe(false);
		expect(clearLine(5, 0, 5, 20, [rect(0, 10, 4, 2)])).toBe(true);
	});

	it('needs a road within reach', () => {
		expect(planInterior({ ring: rect(0, 0, 10, 8), h: 6 }, none)).toEqual({ ok: false, reason: 'no-entrance' });
		expect(planInterior({ ring: rect(0, 0, 10, 8), h: 6 }, { roads: [road(4 + LIMITS.roadReach + 10)], neighbours: [] })).toEqual({ ok: false, reason: 'no-entrance' });
	});
});

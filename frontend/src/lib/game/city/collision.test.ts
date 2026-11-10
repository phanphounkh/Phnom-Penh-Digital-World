import { describe, expect, it } from 'vitest';
import type { XZ } from '$lib/api/types';
import { CollisionWorld, escapeFootprint, moveCircle, pointInRing, rayFraction } from './collision';

// A 10 × 10 m building, 12 m tall, from x 0..10, z 0..10.
const BOX: XZ[] = [
	[0, 0],
	[10, 0],
	[10, 10],
	[0, 10]
];

function world() {
	const w = new CollisionWorld();
	w.addRing('0_0', BOX, 12);
	return w;
}

describe('moveCircle', () => {
	it('stops the player at a wall', () => {
		const r = moveCircle(world(), -2, 5, 3, 0, 0.35);
		expect(r.blocked).toBe(true);
		expect(r.x).toBeCloseTo(-0.35, 5);
	});

	it('slides along a wall when moving diagonally', () => {
		const r = moveCircle(world(), -1, 5, 2, 2, 0.35);
		expect(r.x).toBeLessThanOrEqual(-0.35 + 1e-6);
		expect(r.z).toBeGreaterThan(6.5);
	});

	it('cannot tunnel through a wall at high speed', () => {
		const w = new CollisionWorld();
		w.addRing('0_0', [[0, 0], [0.2, 0], [0.2, 20], [0, 20]], 3); // a thin wall
		const r = moveCircle(w, -1, 10, 30, 0, 0.35);
		expect(r.x).toBeLessThan(0);
	});

	it('moves freely in open space and respects world bounds', () => {
		const w = world();
		const free = moveCircle(w, -20, -20, 1, 1, 0.35);
		expect(free.blocked).toBe(false);
		expect(free.x).toBeCloseTo(-19, 9);
		expect(free.z).toBeCloseTo(-19, 9);
		w.bounds = { minX: -30, minZ: -30, maxX: 30, maxZ: 30 };
		const r = moveCircle(w, 29, 0, 5, 0, 0.35);
		expect(r.x).toBeCloseTo(29.65);
		expect(r.blocked).toBe(true);
	});

	it('forgets colliders when their chunk unloads', () => {
		const w = world();
		w.removeOwner('0_0');
		expect(moveCircle(w, -2, 5, 3, 0, 0.35).blocked).toBe(false);
	});
});

describe('footprints', () => {
	it('detects points inside polygons', () => {
		expect(pointInRing(5, 5, BOX)).toBe(true);
		expect(pointInRing(11, 5, BOX)).toBe(false);
	});

	it('escapes to the nearest edge from inside a building', () => {
		const out = escapeFootprint(world(), 9, 5, 0.35);
		expect(out.x).toBeGreaterThan(10.3);
		expect(pointInRing(out.x, out.z, BOX)).toBe(false);
	});
});

describe('rayFraction (camera occlusion)', () => {
	it('is blocked by a building taller than the ray', () => {
		const f = rayFraction(world(), -5, 2, 5, 15, 3, 5);
		expect(f).toBeCloseTo(0.25, 2);
	});

	it('passes over a building lower than the ray', () => {
		expect(rayFraction(world(), -5, 20, 5, 15, 20, 5)).toBe(1);
	});

	it('ignores walk-only obstacles such as water', () => {
		const w = new CollisionWorld();
		w.addRing('0_0', BOX, 0);
		expect(rayFraction(w, -5, 2, 5, 15, 2, 5)).toBe(1);
	});
});

describe('doorways', () => {
	// A 10 m square building with a 4 m doorway centred on its south wall (z = 0).
	const ring: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
	const make = (withDoor: boolean) => {
		const world = new CollisionWorld();
		world.addRing('b', ring, 8);
		if (withDoor) world.doors = [{ ax: 3, az: 0, bx: 7, bz: 0 }];
		return world;
	};

	it('blocks the wall but lets the player walk through the opening', () => {
		const solid = make(false);
		expect(moveCircle(solid, 5, -2, 0, 4, 0.35).z).toBeLessThan(0);
		const open = make(true);
		const inside = moveCircle(open, 5, -2, 0, 4, 0.35);
		expect(inside.z).toBeCloseTo(2, 5);
		// Beside the opening (the door jamb) is still wall.
		expect(moveCircle(open, 1.5, -2, 0, 4, 0.35).z).toBeLessThan(0);
	});

	it('lets low camera rays through the opening but not above it', () => {
		const open = make(true);
		expect(rayFraction(open, 5, 1.5, 3, 5, 2, -5)).toBe(1);
		expect(rayFraction(open, 5, 4, 3, 5, 5, -5)).toBeLessThan(1);
		expect(rayFraction(make(false), 5, 1.5, 3, 5, 2, -5)).toBeLessThan(1);
	});
});

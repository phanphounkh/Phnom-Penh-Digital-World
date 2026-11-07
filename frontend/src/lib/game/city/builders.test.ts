import { describe, expect, it } from 'vitest';
import type { ChunkPayload } from '$lib/api/types';
import { hash, parkTrees, ribbon } from './builders';
import { pointInRing } from './collision';

describe('road ribbons', () => {
	it('have the requested width and face upwards', () => {
		const g = ribbon([[0, 0], [20, 0], [20, 20]], 6, 0.05)!;
		const p = g.getAttribute('position');
		let minZ = Infinity, maxZ = -Infinity;
		for (let i = 0; i < 6; i++) {
			minZ = Math.min(minZ, p.getZ(i));
			maxZ = Math.max(maxZ, p.getZ(i));
		}
		expect(maxZ - minZ).toBeCloseTo(6, 5);
		for (let i = 0; i < p.count; i += 3) {
			const ax = p.getX(i), az = p.getZ(i);
			const bx = p.getX(i + 1), bz = p.getZ(i + 1);
			const cx = p.getX(i + 2), cz = p.getZ(i + 2);
			// y-component of (B - A) × (C - A) must be positive (front face up).
			expect((bz - az) * (cx - ax) - (bx - ax) * (cz - az)).toBeGreaterThan(0);
		}
	});

	it('rejects degenerate lines', () => {
		expect(ribbon([[1, 1]], 4, 0)).toBeNull();
	});
});

describe('procedural park trees', () => {
	const chunk = {
		key: '0_0', ix: 0, iz: 0, size: 200, roads: [], buildings: [], landmarks: [], features: [],
		areas: [
			{ kind: 'park', name: null, polys: [[[[0, 0], [60, 0], [60, 60], [0, 60]], [[20, 20], [40, 20], [40, 40], [20, 40]]]] },
			{ kind: 'water', name: null, polys: [[[[100, 100], [150, 100], [150, 150]]]] }
		]
	} as ChunkPayload;

	it('are deterministic, inside parks and outside holes', () => {
		const a = parkTrees(chunk);
		expect(a).toEqual(parkTrees(chunk));
		expect(a.length).toBeGreaterThan(5);
		const [outer, hole] = chunk.areas[0].polys[0];
		for (const [x, z] of a) {
			expect(pointInRing(x, z, outer)).toBe(true);
			expect(pointInRing(x, z, hole)).toBe(false);
		}
	});

	it('hash is stable and in [0, 1)', () => {
		expect(hash(42)).toBe(hash(42));
		for (let i = 0; i < 100; i++) expect(hash(i)).toBeGreaterThanOrEqual(0), expect(hash(i)).toBeLessThan(1);
	});
});

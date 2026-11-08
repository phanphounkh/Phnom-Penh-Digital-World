import { describe, expect, it } from 'vitest';
import type { ChunkPayload } from '$lib/api/types';
import { buildChunkData, hash, khmerRoof, parkTrees, ribbon, transferables, treeKind } from './chunkGeometry';
import { pointInRing } from './collision';
import { Terrain } from './terrain';

const HILL = new Terrain([{ slug: 'h', x: 0, z: 0, height_m: 27, top_radius_m: 24, base_radius_m: 68 }]);

const square = (x: number, z: number, s: number): [number, number][] => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];

function chunk(extra: Partial<ChunkPayload> = {}): ChunkPayload {
	return { key: '0_0', ix: 0, iz: 0, size: 200, roads: [], buildings: [], areas: [], landmarks: [], features: [], ...extra };
}

const building = (over: Record<string, unknown> = {}) => ({
	id: 1, name: null, name_km: null, kind: 'yes', h: 10, min_h: 0, hs: 'estimated' as const, colour: null,
	polys: [[square(100, 100, 10)]], ...over
});

describe('road ribbons', () => {
	it('have the requested width and face upwards on flat ground', () => {
		const g = ribbon([[0, 0], [20, 0], [20, 20]], 6, 0.05)!;
		const p = g.getAttribute('position');
		let minZ = Infinity, maxZ = -Infinity;
		for (let i = 0; i < 6; i++) { minZ = Math.min(minZ, p.getZ(i)); maxZ = Math.max(maxZ, p.getZ(i)); }
		expect(maxZ - minZ).toBeCloseTo(6, 5);
		for (let i = 0; i < p.count; i += 3) {
			const ax = p.getX(i), az = p.getZ(i), bx = p.getX(i + 1), bz = p.getZ(i + 1), cx = p.getX(i + 2), cz = p.getZ(i + 2);
			expect((bz - az) * (cx - ax) - (bx - ax) * (cz - az)).toBeGreaterThan(0);
		}
	});

	it('follow the terrain on the hill', () => {
		const g = ribbon([[0, 0], [60, 0]], 2, 0.05, HILL)!;
		const p = g.getAttribute('position');
		expect(p.count).toBeGreaterThan(60); // densified
		for (let i = 0; i < p.count; i++) expect(p.getY(i)).toBeCloseTo(HILL.height(p.getX(i), p.getZ(i)) + 0.05, 4);
	});

	it('reject degenerate lines', () => expect(ribbon([[1, 1]], 4, 0)).toBeNull());
});

describe('buildings', () => {
	it('extrude walls with facade attributes and shopfronts for shophouses', () => {
		const build = buildChunkData(chunk({ buildings: [building(), building({ id: 2, kind: 'office', h: 40 })] }));
		const walls = build.meshes.find((m) => m.kind === 'walls')!;
		expect(walls.facade).toBeDefined();
		const shopFlags = new Set<number>();
		for (let i = 0; i < walls.facade!.length; i += 2) shopFlags.add(walls.facade![i]);
		expect(shopFlags).toEqual(new Set([0, 1])); // the shophouse has one, the tower does not
		const maxY = Math.max(...walls.position.filter((_, i) => i % 3 === 1));
		expect(maxY).toBeCloseTo(40, 3);
	});

	it('replace landmark footprints with models and add Khmer roofs', () => {
		const build = buildChunkData(chunk({
			buildings: [
				building({ id: 3, kind: 'retail', h: 26, model: { name: 'phsar-thmei-dome', c: [105, 105], r: 23, base: 10 } }),
				building({ id: 4, kind: 'yes', h: 6, polys: [[square(150, 150, 20)]], roof: { type: 'khmer', obb: [160, 160, 20, 12, 0.3] } })
			]
		}));
		expect(build.models).toEqual([{ name: 'phsar-thmei-dome', x: 105, z: 105, y: 10, r: 23, h: 16 }]);
		const roof = build.meshes.find((m) => m.kind === 'khmerRoof')!;
		const ys = roof.position.filter((_, i) => i % 3 === 1);
		expect(Math.min(...ys)).toBeCloseTo(6, 3); // eaves sit on the 6 m walls
		expect(Math.max(...ys)).toBeGreaterThan(12); // tiered ridge + finials
		const walls = build.meshes.find((m) => m.kind === 'walls')!;
		for (let i = 0; i < walls.facade!.length; i += 2) expect(walls.facade![i]).toBe(0); // no shops in temples
	});

	it('stand on the hill', () => {
		const build = buildChunkData(chunk({ buildings: [building({ polys: [[square(-5, -5, 10)]], h: 6 })] }), HILL);
		const walls = build.meshes.find((m) => m.kind === 'walls')!;
		const ys = walls.position.filter((_, i) => i % 3 === 1);
		expect(Math.min(...ys)).toBeCloseTo(27, 3);
		expect(Math.max(...ys)).toBeCloseTo(33, 3);
	});

	it('khmer roof geometry is closed-ish and coloured', () => {
		const g = khmerRoof([0, 0, 20, 10, 0], 5);
		expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count);
	});
});

describe('street furniture', () => {
	const payload = chunk({
		areas: [{ kind: 'park', name: null, polys: [[[[0, 0], [60, 0], [60, 60], [0, 60]], [[20, 20], [40, 20], [40, 40], [20, 40]]]] }],
		features: [
			{ k: 'tree', p: [70, 70] },
			{ k: 'lamp_gen', p: [80, 80], a: 0 },
			{ k: 'traffic_signals', p: [90, 90] }
		],
		signs: [{ p: [95, 95], blades: [{ en: 'Street 136', km: 'ផ្លូវ ១៣៦', a: 0 }, { en: 'Street 53', km: null, a: 1.57 }] }]
	});

	it('park trees are deterministic, inside parks and outside holes', () => {
		const a = parkTrees(payload);
		expect(a).toEqual(parkTrees(payload));
		expect(a.length).toBeGreaterThan(5);
		const [outer, hole] = payload.areas[0].polys[0];
		for (const [x, z] of a) {
			expect(pointInRing(x, z, outer)).toBe(true);
			expect(pointInRing(x, z, hole)).toBe(false);
		}
	});

	it('instances props, colliders and light pools', () => {
		const build = buildChunkData(payload);
		const props = Object.fromEntries(build.instances.map((i) => [i.prop, i.matrices.length / 16]));
		expect(props['lamp']).toBe(1);
		expect(props['traffic-signal']).toBe(1);
		expect(props['sign-post']).toBe(1);
		const trees = (props['tree-rain'] ?? 0) + (props['tree-slender'] ?? 0) + (props['tree-palm'] ?? 0);
		expect(trees).toBe(1 + parkTrees(payload).length);
		expect(build.pools.length).toBe(2 * 3); // two heads per lamp
		expect(build.posts.length / 3).toBe(trees + 3);
		expect(build.signs[0].blades).toHaveLength(2);
	});

	it('tree species and hashes are stable', () => {
		expect(treeKind(12.3, 45.6)).toBe(treeKind(12.3, 45.6));
		for (let i = 0; i < 100; i++) {
			expect(hash(i)).toBeGreaterThanOrEqual(0);
			expect(hash(i)).toBeLessThan(1);
		}
	});

	it('lists every buffer for zero-copy transfer', () => {
		const build = buildChunkData(payload);
		const buffers = transferables(build);
		expect(buffers.length).toBeGreaterThanOrEqual(build.meshes.length + build.instances.length);
		expect(new Set(buffers).size).toBe(buffers.length);
	});
});

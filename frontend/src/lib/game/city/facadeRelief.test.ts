import { expect, it } from 'vitest';
import * as THREE from 'three';
import { FacadeRelief } from './facadeRelief';
import { buildChunkData } from './chunkGeometry';
import type { ChunkPayload } from '$lib/api/types';

function wall(angle = 0) {
	const g = new THREE.BufferGeometry();
	const pts = [
		[0, 0],
		[8, 0],
		[0, 9.9],
		[8, 0],
		[8, 9.9],
		[0, 9.9]
	];
	const positions = pts.flatMap(([u, v]) => [
		u * Math.cos(angle),
		v,
		u * Math.sin(angle)
	]);
	g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	g.setAttribute('uv', new THREE.Float32BufferAttribute(pts.flat(), 2));
	g.setAttribute(
		'normal',
		new THREE.Float32BufferAttribute(
			pts.flatMap(() => [Math.sin(angle), 0, -Math.cos(angle)]),
			3
		)
	);
	return g;
}
it('aligns bounded trim with the same UV plane on straight and rotated GIS walls', () => {
	for (const angle of [0, 0.65]) {
		const g = wall(angle),
			before = g.getAttribute('position').array.slice();
		const relief = new FacadeRelief(3);
		relief.add(g, 0.3, new THREE.Color('#cccccc'), 3);
		const mesh = relief.mesh()!;
		expect(mesh).not.toBeNull();
		expect(g.getAttribute('position').array).toEqual(before);
		for (let i = 0; i < mesh.position.length; i += 3) {
			const x = mesh.position[i],
				y = mesh.position[i + 1],
				z = mesh.position[i + 2];
			const along = x * Math.cos(angle) + z * Math.sin(angle),
				out = x * Math.sin(angle) - z * Math.cos(angle);
			expect(y).toBeGreaterThan(3.3);
			expect(y).toBeLessThan(9.9);
			expect(along).toBeGreaterThan(0);
			expect(along).toBeLessThan(8);
			expect(out).toBeGreaterThanOrEqual(-0.031);
			expect(out).toBeLessThanOrEqual(0.191);
			const n = mesh.normal.slice(i, i + 3);
			expect(Math.hypot(...n)).toBeCloseTo(1, 5);
		}
		g.dispose();
	}
});
it('caps worker output and produces no geometry for a ground-only façade', () => {
	const g = wall(),
		b = new FacadeRelief(1);
	b.add(g, 0.3, new THREE.Color(), 8);
	b.add(g, 0.3, new THREE.Color(), 8);
	expect(b.frames).toBe(1);
	expect(b.mesh()!.position.length / 9).toBe(60);
	const short = wall();
	const uv = short.getAttribute('uv'),
		pos = short.getAttribute('position');
	for (let i = 0; i < pos.count; i++) {
		pos.setY(i, pos.getY(i) / 3);
		uv.setY(i, uv.getY(i) / 3);
	}
	const onlyGround = new FacadeRelief();
	onlyGround.add(short, 0.3, new THREE.Color(), 8);
	expect(onlyGround.mesh()).toBeNull();
	g.dispose();
	short.dispose();
});
it('keeps building footprint, height and wall geometry intact, and skips landmark/temple trim', () => {
	const b = {
		id: 1,
		name: null,
		name_km: null,
		kind: 'residential',
		h: 10,
		min_h: 0,
		hs: 'estimated' as const,
		colour: null,
		polys: [
			[
				[
					[0, 0],
					[12, 0],
					[12, 12],
					[0, 12]
				]
			]
		]
	};
	const make = (building: typeof b) =>
		buildChunkData({
			key: '0_0',
			ix: 0,
			iz: 0,
			size: 200,
			roads: [],
			buildings: [building],
			areas: [],
			landmarks: [],
			features: []
		} as unknown as ChunkPayload);
	const build = make(b),
		walls = build.meshes.find((m) => m.kind === 'walls')!;
	expect(build.meshes.some((m) => m.kind === 'facadeRelief')).toBe(true);
	for (let i = 0; i < walls.position.length; i += 3) {
		expect([0, 12].some((v) => Math.abs(v - walls.position[i]) < 1e-5)).toBe(
			true
		);
		expect(
			[0, 12].some((v) => Math.abs(v - walls.position[i + 2]) < 1e-5)
		).toBe(true);
		expect(walls.position[i + 1]).toBeGreaterThanOrEqual(-1e-5);
		expect(walls.position[i + 1]).toBeLessThanOrEqual(10);
	}
	expect(
		make({ ...b, kind: 'temple' }).meshes.some((m) => m.kind === 'facadeRelief')
	).toBe(false);
});

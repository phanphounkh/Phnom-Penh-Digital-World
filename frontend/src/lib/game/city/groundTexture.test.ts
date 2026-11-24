import { expect, it } from 'vitest';
import { groundTextureData } from './groundTexture';

it('creates reproducible bounded ground detail with opaque roughness and balanced normals', () => {
	const pixels = groundTextureData();
	expect(pixels).toEqual(groundTextureData());
	expect(pixels.byteLength).toBe(256 * 256 * 4);
	const red = [],
		nx = [],
		nz = [];
	let minRoughness = 255;
	for (let i = 0; i < pixels.length; i += 4) {
		red.push(pixels[i]);
		nx.push(pixels[i + 1]);
		nz.push(pixels[i + 2]);
		minRoughness = Math.min(minRoughness, pixels[i + 3]);
	}
	expect(minRoughness).toBeGreaterThanOrEqual(220);
	expect(Math.max(...red) - Math.min(...red)).toBeGreaterThan(120);
	for (const channel of [nx, nz]) {
		expect(channel.reduce((a, b) => a + b, 0) / channel.length).toBeCloseTo(
			128,
			1
		);
		expect(Math.min(...channel)).toBeGreaterThan(70);
		expect(Math.max(...channel)).toBeLessThan(185);
	}
});

it('enforces the texture memory budget before allocating', () => {
	for (const size of [0, 31, 33, 1024])
		expect(() => groundTextureData(size)).toThrow();
});

import { describe, expect, it } from 'vitest';
import { WorldProjection, compassHeading, compassLabel, yawForHeading } from './projection';

// Reference values computed by the backend (pyproj, EPSG:32648) — see backend tests.
const ORIGIN_E = 491403.0801141087;
const ORIGIN_N = 1278957.2265911433;
const REFERENCE: [number, number, number, number][] = [
	[11.5765, 104.923, 201.9106, -768.44],
	[11.565, 104.933, 1291.8738, 503.4449],
	[11.5763, 104.9232, 223.7098, -746.3192]
];

describe('WorldProjection', () => {
	const p = new WorldProjection(ORIGIN_E, ORIGIN_N, 200);

	it('matches the backend (pyproj) to the centimetre', () => {
		for (const [lat, lon, x, z] of REFERENCE) {
			const w = p.toWorld(lat, lon);
			expect(Math.abs(w.x - x)).toBeLessThan(0.01);
			expect(Math.abs(w.z - z)).toBeLessThan(0.01);
		}
	});

	it('round-trips world ↔ lat/lon', () => {
		for (const [lat, lon] of REFERENCE) {
			const w = p.toWorld(lat, lon);
			const back = p.toLatLon(w.x, w.z);
			expect(back.lat).toBeCloseTo(lat, 9);
			expect(back.lon).toBeCloseTo(lon, 9);
		}
	});

	it('uses x = east and z = -north', () => {
		const origin = p.toLatLon(0, 0);
		expect(p.toWorld(origin.lat + 0.001, origin.lon).z).toBeLessThan(-100);
		expect(p.toWorld(origin.lat, origin.lon + 0.001).x).toBeGreaterThan(100);
	});

	it('indexes chunks and lists nearby keys nearest-first', () => {
		expect(p.chunkOf(-0.5, 399)).toEqual([-1, 1]);
		const keys = p.keysAround(100, 100, 200);
		expect(keys[0]).toBe('0_0');
		expect(keys).toContain('1_0');
		expect(keys).not.toContain('3_3');
	});
});

describe('headings', () => {
	it('converts between compass headings, directions and model yaw', () => {
		expect(compassHeading(0, -1)).toBeCloseTo(0); // north
		expect(compassHeading(1, 0)).toBeCloseTo(90); // east
		expect(compassHeading(0, 1)).toBeCloseTo(180);
		expect(compassLabel(270)).toBe('W');
		for (const deg of [0, 45, 90, 200, 315]) {
			const yaw = yawForHeading(deg);
			expect(compassHeading(Math.sin(yaw), Math.cos(yaw))).toBeCloseTo(deg, 6);
		}
	});
});

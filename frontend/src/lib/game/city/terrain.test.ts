import { describe, expect, it } from 'vitest';
import { Terrain } from './terrain';
import { atPhnomPenhHour, nightFactor, phnomPenhClock, sunDirection, sunPosition } from './sun';

// Mirrors backend default_mounds(); values computed by backend/app/geography/terrain.py.
const WAT_PHNOM = { slug: 'wat-phnom-hill', x: 225.89, z: -727.52, height_m: 27, top_radius_m: 24, base_radius_m: 68 };
const PYTHON_HEIGHTS: [number, number, number][] = [
	[225.89, -727.52, 27.0],
	[235.89, -732.52, 27.0],
	[255.89, -727.52, 25.780032],
	[205.89, -702.52, 24.848775],
	[275.89, -717.52, 8.79109],
	[293.79, -727.52, 0.000344],
	[295.89, -727.52, 0.0],
	[0, 0, 0.0]
];

describe('terrain', () => {
	const terrain = new Terrain([WAT_PHNOM]);

	it('matches the Python implementation', () => {
		for (const [x, z, h] of PYTHON_HEIGHTS) expect(terrain.height(x, z)).toBeCloseTo(h, 5);
	});

	it('reports which areas it affects and height ranges', () => {
		expect(terrain.affects(225, -727)).toBe(true);
		expect(terrain.affects(0, 0)).toBe(false);
		expect(terrain.range([[225.89, -727.52], [400, -727.52]])).toEqual([0, 27]);
	});
});

describe('sun', () => {
	const PP = { lat: 11.5696, lon: 104.9211 };

	it('rises and sets at the right Phnom Penh times (8 Nov 2026)', () => {
		const at = (h: number) => sunPosition(atPhnomPenhHour(new Date('2026-11-08T00:00:00Z'), h), PP.lat, PP.lon);
		// Published: sunrise ≈ 05:57, sunset ≈ 17:33 local. Allow ±15 min.
		expect(at(5.7).elevation).toBeLessThan(0);
		expect(at(6.2).elevation).toBeGreaterThan(0);
		expect(at(17.3).elevation).toBeGreaterThan(0);
		expect(at(17.8).elevation).toBeLessThan(0);
	});

	it('stands high in the south at noon in November', () => {
		const noon = sunPosition(atPhnomPenhHour(new Date('2026-11-08T00:00:00Z'), 11.75), PP.lat, PP.lon);
		expect(noon.elevation).toBeGreaterThan(58);
		expect(noon.elevation).toBeLessThan(65);
		expect(noon.azimuth).toBeGreaterThan(160);
		expect(noon.azimuth).toBeLessThan(200);
	});

	it('is nearly overhead at the March equinox noon', () => {
		const p = sunPosition(atPhnomPenhHour(new Date('2026-03-20T00:00:00Z'), 12.1), PP.lat, PP.lon);
		expect(p.elevation).toBeGreaterThan(76);
	});

	it('converts to world directions and a night factor', () => {
		const [x, y, z] = sunDirection({ elevation: 0, azimuth: 90 });
		expect(x).toBeCloseTo(1);
		expect(y).toBeCloseTo(0);
		expect(z).toBeCloseTo(0);
		expect(sunDirection({ elevation: 0, azimuth: 0 })[2]).toBeCloseTo(-1); // north is -z
		expect(nightFactor(30)).toBe(0);
		expect(nightFactor(-20)).toBe(1);
		expect(nightFactor(-2)).toBeGreaterThan(0);
	});

	it('formats Phnom Penh local time', () => {
		expect(phnomPenhClock(new Date('2026-11-08T13:05:00Z'))).toBe('20:05');
		expect(phnomPenhClock(atPhnomPenhHour(new Date('2026-11-08T13:05:00Z'), 6.5))).toBe('06:30');
	});
});

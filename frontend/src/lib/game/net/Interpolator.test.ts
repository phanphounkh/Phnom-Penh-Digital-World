import { describe, expect, it } from 'vitest';
import { DELAY_MS, Interpolator } from './Interpolator';

describe('Interpolator', () => {
	it('interpolates between snapshots, rendering DELAY_MS in the past', () => {
		const i = new Interpolator();
		i.push({ t: 1000, x: 0, z: 0, yaw: 0, s: 2 });
		i.push({ t: 1100, x: 10, z: 0, yaw: 1, s: 2 });
		const mid = i.sample(1050 + DELAY_MS)!;
		expect(mid.x).toBeCloseTo(5);
		expect(mid.yaw).toBeCloseTo(0.5);
	});

	it('turns the short way round', () => {
		const i = new Interpolator();
		i.push({ t: 0, x: 0, z: 0, yaw: 3.0, s: 1 });
		i.push({ t: 100, x: 0, z: 0, yaw: -3.0, s: 1 });
		const yaw = i.sample(50 + DELAY_MS)!.yaw;
		expect(Math.abs(Math.cos(yaw) - Math.cos(Math.PI))).toBeLessThan(0.01);
	});

	it('extrapolates a moving player briefly, then holds', () => {
		const i = new Interpolator();
		i.push({ t: 0, x: 0, z: 0, yaw: 0, s: 3 });
		i.push({ t: 100, x: 1, z: 0, yaw: 0, s: 3 });
		expect(i.sample(150 + DELAY_MS)!.x).toBeCloseTo(1.5);
		expect(i.sample(5000)!.x).toBeCloseTo(3); // capped at 200 ms ahead
	});

	it('holds a stopped player in place', () => {
		const i = new Interpolator();
		i.push({ t: 0, x: 0, z: 0, yaw: 0, s: 3 });
		i.push({ t: 100, x: 1, z: 0, yaw: 0, s: 0 });
		expect(i.sample(400 + DELAY_MS)!.x).toBeCloseTo(1);
	});

	it('snaps on teleport instead of sliding across the city', () => {
		const i = new Interpolator();
		i.push({ t: 0, x: 0, z: 0, yaw: 0, s: 0 });
		i.push({ t: 100, x: 900, z: 0, yaw: 0, s: 0 });
		expect(i.sample(150)!.x).toBe(900);
	});
});

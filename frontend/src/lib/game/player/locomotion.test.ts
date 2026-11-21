import { describe, expect, it } from 'vitest';
import { LOCOMOTION, approachSpeed, turnSpeedScale, turnTowards } from './locomotion';

const RUN = 6.5;

describe('approachSpeed', () => {
	it('reaches walking/running speed smoothly and never overshoots it', () => {
		let s = 0;
		for (let i = 0; i < 120; i++) {
			const next = approachSpeed(s, RUN, 1 / 60);
			expect(next).toBeGreaterThanOrEqual(s);
			expect(next).toBeLessThanOrEqual(RUN);
			s = next;
		}
		expect(s).toBeGreaterThan(RUN * 0.99);
	});

	it('brakes a little faster than it accelerates', () => {
		const up = approachSpeed(0, RUN, 0.1);
		const down = RUN - approachSpeed(RUN, 0, 0.1);
		expect(down).toBeGreaterThan(up);
		expect(LOCOMOTION.brakeRate).toBeGreaterThan(LOCOMOTION.accelRate);
	});

	it('stops within a metre from a run (no long slide)', () => {
		let s = RUN,
			travelled = 0;
		for (let i = 0; i < 120; i++) {
			s = approachSpeed(s, 0, 1 / 60);
			travelled += s / 60;
		}
		expect(travelled).toBeLessThan(1);
		expect(s).toBeLessThan(0.02);
	});
});

describe('turning', () => {
	it('keeps full speed when facing the input and slows through sharp turns', () => {
		expect(turnSpeedScale(0)).toBe(1);
		expect(turnSpeedScale(Math.PI / 6)).toBeGreaterThan(0.85);
		expect(turnSpeedScale(Math.PI / 2)).toBeCloseTo(LOCOMOTION.minTurnScale, 6);
		expect(turnSpeedScale(Math.PI)).toBeCloseTo(LOCOMOTION.minTurnScale, 6);
		expect(turnSpeedScale(-3 * Math.PI)).toBeCloseTo(LOCOMOTION.minTurnScale, 6); // wraps
	});

	it('a U-turn from a run swings out less and is back to full speed within a second', () => {
		const uTurn = (scaled: boolean) => {
			let yaw = 0,
				s = RUN,
				side = 0,
				swing = 0;
			const want = Math.PI - 1e-3;
			for (let i = 0; i < 60; i++) {
				const dt = 1 / 60;
				const remaining = want - yaw;
				yaw = turnTowards(yaw, want, dt);
				s = approachSpeed(s, RUN * (scaled ? turnSpeedScale(remaining) : 1), dt);
				side += Math.sin(yaw) * s * dt;
				swing = Math.max(swing, Math.abs(side));
			}
			return { swing, speed: s };
		};
		const before = uTurn(false),
			after = uTurn(true);
		// Before: a ≈ 1 m sideways arc at running speed; now about a quarter less.
		expect(after.swing).toBeLessThan(before.swing * 0.8);
		expect(after.speed).toBeGreaterThan(RUN * 0.98);
	});

	it('turns the short way and is frame-rate independent', () => {
		expect(turnTowards(3, -3, 1 / 60)).toBeGreaterThan(3);
		let a = 0;
		for (let i = 0; i < 10; i++) a = turnTowards(a, 1, 1 / 60);
		const b = turnTowards(turnTowards(0, 1, 1 / 12), 1, 1 / 12);
		expect(a).toBeCloseTo(b, 6);
	});
});

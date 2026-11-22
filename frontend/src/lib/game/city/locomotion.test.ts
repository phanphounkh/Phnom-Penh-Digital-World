import { describe, expect, it } from 'vitest';
import {
	ACCEL, BRAKE, GRAVITY, JUMP_BUFFER, JUMP_REST, JUMP_SPEED, RUN, SHARP_SLOW, SHARP_TURN, TURN_GRIP, WALK,
	approachSpeed, grounded, isAirborne, stepHop, targetSpeed, turnHeading
} from './locomotion';

const DT = 1 / 60;

/** Frames until `speed` reaches `until` (or the limit), with the distance covered. */
function ramp(from: number, target: number, until: (s: number) => boolean, airborne = false) {
	let speed = from;
	let t = 0;
	let dist = 0;
	let maxDelta = 0;
	while (!until(speed) && t < 10) {
		const next = approachSpeed(speed, target, DT, airborne);
		if (next > 0) maxDelta = Math.max(maxDelta, Math.abs(next - speed) / DT); // not the final stop
		speed = next;
		dist += speed * DT;
		t += DT;
	}
	return { t, dist, speed, maxDelta };
}

describe('speed', () => {
	it('speeds up no faster than ACCEL and reaches a jog in about half a second', () => {
		const jog = ramp(0, WALK, (s) => s >= WALK * 0.95);
		expect(jog.maxDelta).toBeLessThanOrEqual(ACCEL + 1e-9);
		expect(jog.t).toBeGreaterThan(0.35);
		expect(jog.t).toBeLessThan(0.75);
		const sprint = ramp(0, RUN, (s) => s >= RUN * 0.95);
		expect(sprint.t).toBeGreaterThan(1.0);
		expect(sprint.t).toBeLessThan(1.6);
	});

	it('brakes harder than it accelerates and stops in a short, natural distance', () => {
		const fromSprint = ramp(RUN, 0, (s) => s === 0);
		expect(fromSprint.maxDelta).toBeLessThanOrEqual(BRAKE + 1e-9);
		expect(fromSprint.t).toBeLessThan(1.0);
		expect(fromSprint.dist).toBeGreaterThan(1.5); // momentum: no instant stop from a sprint
		expect(fromSprint.dist).toBeLessThan(3.0);
		const fromJog = ramp(WALK, 0, (s) => s === 0);
		expect(fromJog.t).toBeLessThan(0.5);
		expect(fromJog.dist).toBeLessThan(0.8);
	});

	it('keeps most of its momentum in the air', () => {
		const air = ramp(RUN, 0, () => false, true);
		const half = ramp(RUN, 0, (s) => s < RUN * 0.5, true);
		expect(half.t).toBeGreaterThan(0.6); // longer than a whole jump
		expect(air.speed).toBeGreaterThanOrEqual(0);
	});

	it('slows down for sharp turns so the avatar pivots', () => {
		expect(targetSpeed(false, true, 0, false)).toBe(0);
		expect(targetSpeed(true, false, 0, false)).toBe(WALK);
		expect(targetSpeed(true, true, SHARP_TURN * 0.9, false)).toBe(RUN);
		const uTurn = targetSpeed(true, true, Math.PI, false);
		expect(uTurn).toBeCloseTo(RUN * (1 - SHARP_SLOW));
		expect(targetSpeed(true, true, 2, false)).toBeLessThan(RUN);
		expect(targetSpeed(true, true, 2, false)).toBeGreaterThan(uTurn);
		expect(targetSpeed(true, true, Math.PI, true)).toBe(RUN); // no braking in the air
	});
});

describe('turning', () => {
	it('turns more slowly the faster it goes', () => {
		const still = turnHeading(0, 1, 0, DT, false);
		const jog = turnHeading(0, 1, WALK, DT, false);
		const sprint = turnHeading(0, 1, RUN, DT, false);
		expect(still).toBeGreaterThan(jog);
		expect(jog).toBeGreaterThan(sprint);
		expect(sprint).toBeGreaterThan(0);
		expect(turnHeading(0, 1, RUN, DT, true)).toBeLessThan(sprint);
	});

	it('never turns faster than grip allows at speed', () => {
		for (const speed of [2.6, 4, 6.5]) {
			const step = turnHeading(0, Math.PI, speed, DT, false);
			expect(step / DT).toBeLessThanOrEqual(TURN_GRIP / speed + 1e-9);
		}
	});

	/** Simulate turning to `goal` from a run at `v0`. */
	function turn(v0: number, goal: number) {
		let yaw = 0;
		let speed = v0;
		let t = 0;
		let min = v0;
		while (Math.abs(goal - yaw) > 0.1 && t < 3) {
			const delta = goal - yaw;
			speed = approachSpeed(speed, targetSpeed(true, v0 === RUN, delta, false), DT, false);
			yaw = turnHeading(yaw, delta, speed, DT, false);
			min = Math.min(min, speed);
			t += DT;
		}
		return { t, min };
	}

	it('pivots quickly from a jog, slows down to reverse from a sprint', () => {
		const jogU = turn(WALK, Math.PI * 0.999);
		expect(jogU.t).toBeLessThan(0.6);
		const sprintU = turn(RUN, Math.PI * 0.999);
		expect(sprintU.t).toBeGreaterThan(0.5); // momentum: never a snap
		expect(sprintU.t).toBeLessThan(1.3);
		expect(sprintU.min).toBeLessThan(RUN * 0.6); // it braked into the turn
		const sprintCorner = turn(RUN, Math.PI / 2);
		expect(sprintCorner.t).toBeLessThan(0.9);
		expect(sprintCorner.min).toBeGreaterThan(RUN * 0.9); // a corner keeps the pace
	});
});

describe('jump', () => {
	it('hops about 0.46 m, lands after about half a second, then rests', () => {
		const h = grounded();
		h.queued = JUMP_BUFFER;
		expect(stepHop(h, DT)).toBe(true);
		let apex = 0;
		let t = DT;
		while (isAirborne(h) && t < 2) {
			expect(stepHop(h, DT)).toBe(false);
			apex = Math.max(apex, h.lift);
			t += DT;
		}
		expect(apex).toBeCloseTo((JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY), 1);
		expect(t).toBeCloseTo((2 * JUMP_SPEED) / GRAVITY, 1);
		expect(h.lift).toBe(0);
		expect(h.rest).toBeCloseTo(JUMP_REST);
		// A press during the rest is buffered only briefly.
		h.queued = JUMP_BUFFER;
		let took = false;
		for (let i = 0; i < 30 && !took; i++) took = stepHop(h, DT);
		expect(took).toBe(JUMP_BUFFER >= JUMP_REST);
	});

	it('reaches the same height on slow frames (software rendering)', () => {
		for (const dt of [1 / 60, 1 / 10, 0.25]) {
			const h = grounded();
			h.queued = JUMP_BUFFER;
			let apex = 0;
			let t = 0;
			do {
				stepHop(h, dt);
				apex = Math.max(apex, h.lift);
				t += dt;
			} while (isAirborne(h) && t < 2);
			expect(apex).toBeGreaterThan(0.4);
			expect(apex).toBeLessThanOrEqual((JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY) + 1e-9);
			expect(t).toBeLessThan(0.8);
		}
	});

	it('buffers a press made just before landing', () => {
		const h = grounded();
		h.queued = JUMP_BUFFER;
		stepHop(h, DT);
		while (h.vy > -JUMP_SPEED * 0.8) stepHop(h, DT); // nearly down
		h.queued = JUMP_BUFFER;
		let frames = 0;
		while (isAirborne(h)) {
			stepHop(h, DT);
			frames++;
		}
		expect(frames * DT).toBeLessThan(JUMP_BUFFER);
		// Landed with the press still buffered, but the rest blocks it until it has passed.
		let took = false;
		for (let i = 0; i < 60 && !took; i++) took = stepHop(h, DT);
		expect(took).toBe(false);
	});
});

/**
 * On-foot movement model (pure functions, so the feel can be unit-tested):
 * - speed changes are limited to ACCEL when speeding up and BRAKE when slowing down, and ease in
 *   near the target (SETTLE per second), so the gait clips never jolt;
 * - the heading turns towards the input direction quickly when standing and more slowly at a
 *   sprint, within a sideways-grip limit, and a sharp turn slows the avatar so it pivots instead
 *   of orbiting at full speed;
 * - a jump is a vertical hop with gravity; the server tracks x/z only, so height stays local
 *   (other players see a jump as a short stop).
 */
import * as THREE from 'three';

export const WALK = 2.6;
export const RUN = 6.5;
/** m/s² limits and the settle rate (1/s). */
export const ACCEL = 6;
export const BRAKE = 11;
export const SETTLE = 8;
/** Heading ease rates (1/s), standing and at RUN, and where a turn counts as sharp (rad). */
export const TURN_STILL = 14;
export const TURN_FAST = 6;
export const SHARP_TURN = 1.2;
/** Share of the speed given up for a full reversal (less for gentler sharp turns). */
export const SHARP_SLOW = 0.75;
/** Grip: the sideways acceleration a turn may take (m/s², ≈1.4 g), so at speed v the heading
 * turns at most TURN_GRIP / v rad/s: a sprint corners wide (or slows down first), a jog pivots. */
export const TURN_GRIP = 14;
/** Take-off speed (m/s) and gravity (m/s²): a ≈0.46 m hop, 0.51 s in the air. Gravity is a little
 * above 9.81 so a hop reads crisply on a third-person camera. */
export const JUMP_SPEED = 3.6;
export const GRAVITY = 14;
/** A press this early (s) still jumps on landing; the rest (s) after landing before the next. */
export const JUMP_BUFFER = 0.15;
export const JUMP_REST = 0.2;
/** Share of ground acceleration and turning kept in the air. */
export const AIR_CONTROL = 0.25;
/** Below this, a stopping avatar is simply stopped (m/s). */
const STOP_BELOW = 0.25;

/** Target speed for the input: 0, WALK or RUN, cut back on sharp turns (|delta| rad between the
 * heading and the input direction) while on the ground. */
export function targetSpeed(moving: boolean, run: boolean, delta: number, airborne: boolean): number {
	if (!moving) return 0;
	const target = run ? RUN : WALK;
	const sharp = Math.abs(delta);
	if (airborne || sharp <= SHARP_TURN) return target;
	return target * (1 - SHARP_SLOW * THREE.MathUtils.smoothstep(sharp, SHARP_TURN, Math.PI));
}

/** Speed after `dt` towards `target`. */
export function approachSpeed(speed: number, target: number, dt: number, airborne: boolean): number {
	const control = airborne ? AIR_CONTROL : 1;
	const next = speed + THREE.MathUtils.clamp((target - speed) * (1 - Math.exp(-dt * SETTLE)), -BRAKE * control * dt, ACCEL * control * dt);
	return target === 0 && next < STOP_BELOW && !airborne ? 0 : next;
}

/** Heading after `dt`, turning `delta` rad towards the input direction. */
export function turnHeading(yaw: number, delta: number, speed: number, dt: number, airborne: boolean): number {
	const control = airborne ? AIR_CONTROL : 1;
	const rate = THREE.MathUtils.lerp(TURN_STILL, TURN_FAST, THREE.MathUtils.clamp(speed / RUN, 0, 1)) * control;
	const cap = ((TURN_GRIP * control) / Math.max(speed, 0.5)) * dt;
	return yaw + THREE.MathUtils.clamp(delta * (1 - Math.exp(-dt * rate)), -cap, cap);
}

/** Vertical state: height above the ground, vertical speed, buffered press, rest after landing. */
export interface Hop {
	lift: number;
	vy: number;
	queued: number;
	rest: number;
}

export const grounded = (): Hop => ({ lift: 0, vy: 0, queued: 0, rest: 0 });
export const isAirborne = (h: Hop) => h.lift > 0 || h.vy > 0;

/** Advance the hop by `dt`; returns true on the frame the avatar takes off. */
export function stepHop(h: Hop, dt: number): boolean {
	h.rest = Math.max(0, h.rest - dt);
	let took = false;
	if (h.queued > 0 && !isAirborne(h) && h.rest === 0) {
		h.vy = JUMP_SPEED;
		h.queued = 0;
		took = true;
	}
	h.queued = Math.max(0, h.queued - dt); // age the press after using it (one slow frame may exceed the buffer)
	if (isAirborne(h)) {
		// Exact ballistic step: the same height and airtime at 60 fps or at 4 fps.
		h.lift += h.vy * dt - 0.5 * GRAVITY * dt * dt;
		h.vy -= GRAVITY * dt;
		if (h.lift <= 0) {
			h.lift = h.vy = 0;
			h.rest = JUMP_REST;
		}
	}
	return took;
}

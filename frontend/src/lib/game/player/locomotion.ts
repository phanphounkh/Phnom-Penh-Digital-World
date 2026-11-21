/**
 * On-foot movement feel for the city player: how quickly walking speed builds up and dies
 * away, and how the avatar turns towards the input direction. Pure functions so the feel can
 * be tested without a renderer.
 *
 * These only ever slow the player down relative to the walk/run speeds, so the server's
 * authoritative speed check (backend/app/multiplayer/validation.py) is unaffected.
 */

export const LOCOMOTION = {
	/** Speed-up towards walk/run speed (s⁻¹). */
	accelRate: 8,
	/** Slow-down when keys are released or the target speed drops (s⁻¹): a little snappier. */
	brakeRate: 10,
	/** How fast the avatar turns to face the input direction (s⁻¹). */
	turnRate: 12,
	/** Speed kept (fraction) while still turning through ≥ 90° (U-turns stay tight). */
	minTurnScale: 0.3
} as const;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Move `speed` towards `target`, braking a little faster than accelerating. */
export function approachSpeed(speed: number, target: number, dt: number): number {
	const rate = target < speed ? LOCOMOTION.brakeRate : LOCOMOTION.accelRate;
	return speed + (target - speed) * (1 - Math.exp(-rate * dt));
}

/**
 * Fraction of the target speed allowed while the avatar still has to turn `remaining` radians
 * to face where the player is steering: 1 when facing it, `minTurnScale` from 90° onwards.
 */
export function turnSpeedScale(remaining: number): number {
	const c = Math.max(0, Math.cos(wrap(remaining)));
	return LOCOMOTION.minTurnScale + (1 - LOCOMOTION.minTurnScale) * c;
}

/** Turn `yaw` towards `want` (radians) the short way round; returns the new yaw. */
export function turnTowards(yaw: number, want: number, dt: number): number {
	return yaw + wrap(want - yaw) * (1 - Math.exp(-dt * LOCOMOTION.turnRate));
}

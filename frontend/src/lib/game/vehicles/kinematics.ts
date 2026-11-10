/**
 * Riding physics for two-wheelers (pure, unit-tested): throttle and brakes, a kinematic
 * bicycle model for steering (yaw rate = v / wheelbase · tan(steer)), less steering lock at
 * speed, and a visual lean into turns. World conventions: forward = (sin yaw, cos yaw);
 * steering right (+) turns clockwise seen from above, which *decreases* yaw.
 */
import { HANDLING, MODES, type VehicleKind } from './specs';

export interface RideState {
	speed: number; // m/s, negative when reversing
	steer: number; // rad at the front wheel, + = right
	lean: number; // rad, + = leaning right
	wheel: number; // accumulated wheel rotation (rad)
}

export interface RideInput {
	/** -1 (brake / reverse) … 1 (full throttle). */
	throttle: number;
	/** -1 (left) … 1 (right). */
	steer: number;
	/** Cap on the forward speed (m/s), e.g. an autopilot slowing for a corner. */
	maxSpeed?: number;
}

export function rideState(): RideState {
	return { speed: 0, steer: 0, lean: 0, wheel: 0 };
}

const G = 9.81;

/** The steering lock available at a speed: full lock when slow, much less when fast. */
export function steerLimit(kind: VehicleKind, speed: number): number {
	const h = HANDLING[kind];
	return h.maxSteer / (1 + (speed * speed) / 45);
}

/**
 * Advance the ride by `dt` seconds. Returns the yaw change (rad) and the distance travelled
 * along the heading (m); the caller moves the vehicle (collision, road limits).
 */
export function rideStep(
	kind: VehicleKind,
	s: RideState,
	input: RideInput,
	dt: number
): { dyaw: number; distance: number } {
	const h = HANDLING[kind];
	const top = Math.min(MODES[kind].topSpeed, input.maxSpeed ?? Infinity);
	const throttle = Math.max(-1, Math.min(1, input.throttle));
	if (throttle > 0) {
		if (s.speed < 0) s.speed = Math.min(0, s.speed + h.brake * dt);
		else if (s.speed < top) s.speed = Math.min(top, s.speed + h.accel * throttle * (1 - (0.6 * s.speed) / top) * dt);
		else s.speed = Math.max(top, s.speed - h.brake * dt); // over a lowered cap: ease off
	} else if (throttle < 0) {
		if (s.speed > 0.05) s.speed = Math.max(0, s.speed + h.brake * throttle * dt);
		else s.speed = h.reverse > 0 ? Math.max(-h.reverse, s.speed + h.accel * 0.4 * throttle * dt) : 0;
	} else {
		// Coasting: drag plus a little rolling resistance, to a stop.
		const loss = (Math.abs(s.speed) * h.drag + 0.25) * dt;
		s.speed = Math.sign(s.speed) * Math.max(0, Math.abs(s.speed) - loss);
	}
	const lock = steerLimit(kind, Math.abs(s.speed));
	const target = Math.max(-1, Math.min(1, input.steer)) * lock;
	const maxDelta = h.steerRate * dt;
	s.steer += Math.max(-maxDelta, Math.min(maxDelta, target - s.steer));
	s.steer = Math.max(-lock, Math.min(lock, s.steer));
	const yawRate = -(s.speed / h.wheelbase) * Math.tan(s.steer);
	// Lean into the turn: the angle where gravity balances the centripetal acceleration.
	const leanTarget = Math.max(-h.maxLean, Math.min(h.maxLean, Math.atan((s.speed * -yawRate) / G)));
	s.lean += (leanTarget - s.lean) * (1 - Math.exp(-dt * 6));
	const distance = s.speed * dt;
	s.wheel += distance / h.wheelRadius;
	return { dyaw: yawRate * dt, distance };
}

/**
 * Pure-pursuit steering towards a look-ahead point: the steering input (-1…1) that puts the
 * vehicle on the arc through the target.
 */
export function pursuitSteer(kind: VehicleKind, speed: number, yaw: number, dx: number, dz: number): number {
	const distance = Math.hypot(dx, dz);
	if (distance < 1e-3) return 0;
	// Angle of the target relative to the heading, + = target on the right.
	const heading = Math.atan2(Math.sin(yaw), Math.cos(yaw));
	let alpha = heading - Math.atan2(dx, dz);
	alpha = Math.atan2(Math.sin(alpha), Math.cos(alpha));
	const h = HANDLING[kind];
	const steer = Math.atan((2 * h.wheelbase * Math.sin(alpha)) / distance);
	return Math.max(-1, Math.min(1, steer / steerLimit(kind, Math.abs(speed))));
}

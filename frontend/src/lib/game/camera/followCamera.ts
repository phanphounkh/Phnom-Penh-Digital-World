/**
 * Third-person follow camera for the city: an orbit "boom" from the player's head.
 *
 * - The view orbits on the arc (yaw/pitch are smoothed, not the camera position), so turning
 *   the camera never cuts a chord through the player or the scenery.
 * - The focus (what the camera looks at) eases after the head: footsteps, the hill and
 *   server corrections do not jolt the view.
 * - Buildings: the boom is shortened at once when a wall would come between the camera and the
 *   player, then eases back out once the view is clear (no flicker in and out when walking
 *   past gaps). The lens is also kept clear of walls beside it, so the near plane does not
 *   clip into a facade.
 * Pure TypeScript over `CollisionWorld`; trees are handled by `city/foliageFade.ts`.
 */
import { clearOfWalls, rayFraction, type CollisionWorld } from '$lib/game/city/collision';

export interface FollowCameraTuning {
	/** How fast the view follows orbit input (s⁻¹). */
	orbitRate: number;
	/** How fast the focus follows the player's head (s⁻¹). */
	focusRate: number;
	/** How fast the boom follows zoom changes (s⁻¹). */
	zoomRate: number;
	/** How fast the boom grows back once a wall no longer blocks the view (s⁻¹). */
	recoverRate: number;
	/** Shortest boom (m), even right against a wall. */
	minBoom: number;
	/** Gap kept between the lens and a blocking wall, along the boom (m). */
	wallMargin: number;
	/** Clearance kept between the lens and walls beside it (m). */
	lensRadius: number;
	/** The lens stays this far above the ground (m). */
	groundClearance: number;
	/** A head jump larger than this (m) snaps the focus instead of easing (travel, respawn). */
	snapDistance: number;
}

export const FOLLOW_CAMERA: FollowCameraTuning = {
	orbitRate: 16,
	focusRate: 14,
	zoomRate: 10,
	recoverRate: 3.5,
	minBoom: 1.1,
	wallMargin: 0.35,
	lensRadius: 0.3,
	groundClearance: 0.7,
	snapDistance: 12
};

export interface FollowTarget {
	/** The player's head (world metres). */
	x: number;
	y: number;
	z: number;
	/** Orbit input: the camera sits at this yaw/pitch from the head. */
	yaw: number;
	pitch: number;
	/** Wanted boom length (zoom), before obstacles. */
	distance: number;
}

type V3 = { x: number; y: number; z: number };

/** Exponential smoothing that is independent of the frame rate. */
export function damp(current: number, target: number, rate: number, dt: number): number {
	return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export function wrapAngle(a: number): number {
	return Math.atan2(Math.sin(a), Math.cos(a));
}

/** `damp` for angles: always turns the short way round. */
export function dampAngle(current: number, target: number, rate: number, dt: number): number {
	return current + wrapAngle(target - current) * (1 - Math.exp(-rate * dt));
}

/**
 * Next boom length. A shorter target (a wall, or zooming in) applies at once, so the view is
 * never blocked; a longer one (the view cleared) eases out at `recoverRate`.
 */
export function stepBoom(boom: number, target: number, recoverRate: number, dt: number): number {
	return target <= boom ? target : damp(boom, target, recoverRate, dt);
}

export class FollowCamera {
	readonly tuning: FollowCameraTuning;
	/** Smoothed orbit angles (what is on screen). */
	yaw = 0;
	pitch = 0;
	/** Smoothed zoom and the boom actually used (≤ zoom when a wall is in the way). */
	zoom = 0;
	boom = 0;
	/** Longest unobstructed boom found this frame. */
	limit = 0;
	/** The point the camera looks at, and the camera position. */
	readonly focus: V3 = { x: 0, y: 0, z: 0 };
	readonly position: V3 = { x: 0, y: 0, z: 0 };
	private ready = false;

	constructor(tuning: Partial<FollowCameraTuning> = {}) {
		this.tuning = { ...FOLLOW_CAMERA, ...tuning };
	}

	/** Jump straight to the target (start, travel, respawn); the next update places the camera. */
	reset(target: FollowTarget): void {
		this.yaw = target.yaw;
		this.pitch = target.pitch;
		this.zoom = this.boom = this.limit = target.distance;
		this.focus.x = target.x;
		this.focus.y = target.y;
		this.focus.z = target.z;
		this.ready = true;
	}

	/**
	 * Advance by `dt` seconds and return the camera position (also in `position`); the camera
	 * should look at `focus`. `ground(x, z)` is the terrain height.
	 */
	update(dt: number, target: FollowTarget, world: CollisionWorld, ground: (x: number, z: number) => number): V3 {
		const t = this.tuning;
		if (!this.ready) this.reset(target);
		this.yaw = dampAngle(this.yaw, target.yaw, t.orbitRate, dt);
		this.pitch = damp(this.pitch, target.pitch, t.orbitRate, dt);
		this.zoom = damp(this.zoom, target.distance, t.zoomRate, dt);
		const f = this.focus;
		if (Math.hypot(target.x - f.x, target.y - f.y, target.z - f.z) > t.snapDistance) {
			f.x = target.x;
			f.y = target.y;
			f.z = target.z;
		} else {
			f.x = damp(f.x, target.x, t.focusRate, dt);
			f.y = damp(f.y, target.y, t.focusRate, dt);
			f.z = damp(f.z, target.z, t.focusRate, dt);
		}
		// Boom direction (unit) from the focus towards the camera.
		const cp = Math.cos(this.pitch);
		const dx = Math.sin(this.yaw) * cp,
			dy = Math.sin(this.pitch),
			dz = Math.cos(this.yaw) * cp;
		const hit = rayFraction(world, f.x, f.y, f.z, f.x + dx * this.zoom, f.y + dy * this.zoom, f.z + dz * this.zoom);
		this.limit = hit < 1 ? Math.max(t.minBoom, hit * this.zoom - t.wallMargin) : this.zoom;
		this.boom = stepBoom(this.boom, Math.min(this.zoom, this.limit), t.recoverRate, dt);
		const p = this.position;
		p.x = f.x + dx * this.boom;
		p.y = f.y + dy * this.boom;
		p.z = f.z + dz * this.boom;
		const clear = clearOfWalls(world, p.x, p.y, p.z, t.lensRadius);
		p.x = clear.x;
		p.z = clear.z;
		p.y = Math.max(p.y, ground(p.x, p.z) + t.groundClearance);
		return p;
	}

	/** Does a building stand between the camera and the focus right now? (diagnostics) */
	sightBlocked(world: CollisionWorld): boolean {
		const p = this.position,
			f = this.focus;
		return rayFraction(world, f.x, f.y, f.z, p.x, p.y, p.z) < 0.999;
	}
}

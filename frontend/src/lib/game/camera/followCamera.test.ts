import { describe, expect, it } from 'vitest';
import type { XZ } from '$lib/api/types';
import { CollisionWorld, pointInRing } from '$lib/game/city/collision';
import { FollowCamera, damp, dampAngle, stepBoom, type FollowTarget } from './followCamera';

const flat = () => 0;
const DT = 1 / 60;

/** A 12 m tall building, x 4..14, z −10..10, east of a player standing at the origin. */
const BUILDING: XZ[] = [
	[4, -10],
	[14, -10],
	[14, 10],
	[4, 10]
];

function city(withBuilding = true) {
	const world = new CollisionWorld();
	if (withBuilding) world.addRing('0_0', BUILDING, 12);
	return world;
}

// yaw = π/2 puts the camera east of the player (towards the building); pitch 0.38 as in game.
const target = (over: Partial<FollowTarget> = {}): FollowTarget => ({ x: 0, y: 1.55, z: 0, yaw: 0, pitch: 0.38, distance: 7.5, ...over });

function run(cam: FollowCamera, world: CollisionWorld, t: FollowTarget, seconds: number, dt = DT) {
	for (let s = 0; s < seconds; s += dt) cam.update(dt, t, world, flat);
	return cam.position;
}

describe('smoothing helpers', () => {
	it('damp is frame-rate independent', () => {
		let a = 0;
		for (let i = 0; i < 60; i++) a = damp(a, 10, 5, 1 / 60);
		let b = 0;
		for (let i = 0; i < 6; i++) b = damp(b, 10, 5, 1 / 6);
		expect(a).toBeCloseTo(b, 6);
	});

	it('dampAngle turns the short way across ±π', () => {
		const next = dampAngle(Math.PI - 0.1, -Math.PI + 0.1, 10, 1 / 60);
		expect(next).toBeGreaterThan(Math.PI - 0.1); // through π, not back through 0
	});

	it('stepBoom pulls in at once and lets out gently', () => {
		expect(stepBoom(7.5, 2, 3.5, DT)).toBe(2);
		const out = stepBoom(2, 7.5, 3.5, DT);
		expect(out).toBeGreaterThan(2);
		expect(out).toBeLessThan(2.5);
	});
});

describe('FollowCamera', () => {
	it('sits behind and above the head at the wanted distance in the open', () => {
		const cam = new FollowCamera();
		const p = run(cam, city(false), target(), 1);
		expect(Math.hypot(p.x, p.y - 1.55, p.z)).toBeCloseTo(7.5, 3);
		expect(p.z).toBeGreaterThan(6);
		expect(p.y).toBeGreaterThan(3);
		expect(cam.boom).toBeCloseTo(7.5, 3);
	});

	it('orbits on the arc: the boom length holds while the view swings round', () => {
		const cam = new FollowCamera();
		const world = city(false);
		run(cam, world, target(), 1);
		for (let i = 0; i < 30; i++) {
			const p = cam.update(DT, target({ yaw: Math.PI }), world, flat);
			// The old position lerp cut across the circle (≈ 0 m from the head half-way round).
			expect(Math.hypot(p.x, p.y - 1.55, p.z)).toBeCloseTo(7.5, 2);
		}
	});

	it('never lets a building block the view, even on slow frames', () => {
		for (const dt of [1 / 60, 1 / 8, 0.25]) {
			const cam = new FollowCamera();
			const world = city();
			run(cam, world, target(), 1, dt);
			// Swing the camera towards the building: every frame keeps a clear line of sight.
			for (let i = 0; i < 40; i++) {
				const p = cam.update(dt, target({ yaw: Math.PI / 2 }), world, flat);
				expect(cam.sightBlocked(world)).toBe(false);
				expect(pointInRing(p.x, p.z, BUILDING)).toBe(false);
			}
			expect(cam.boom).toBeLessThan(4);
			expect(cam.position.x).toBeLessThan(4 - 0.29);
		}
	});

	it('eases back out once the building is out of the way, without overshooting', () => {
		const cam = new FollowCamera();
		const world = city();
		run(cam, world, target({ yaw: Math.PI / 2 }), 1);
		const pulled = cam.boom;
		expect(pulled).toBeLessThan(4);
		let previous = pulled;
		cam.update(DT, target({ yaw: -Math.PI / 2 }), world, flat);
		for (let i = 0; i < 180; i++) {
			cam.update(DT, target({ yaw: -Math.PI / 2 }), world, flat);
			expect(cam.boom).toBeGreaterThanOrEqual(previous - 1e-9);
			expect(cam.boom - previous).toBeLessThan(0.35); // no snap back out
			previous = cam.boom;
		}
		expect(cam.boom).toBeCloseTo(7.5, 1);
	});

	it('keeps the lens off a facade it runs alongside', () => {
		const cam = new FollowCamera();
		const world = city();
		// Player 0.4 m west of the wall x = 4, camera behind them and almost parallel to it: the
		// boom never crosses the wall, but its end would be 0.18 m from the facade.
		const p = run(cam, world, target({ x: 3.6, yaw: Math.PI - 0.03, pitch: 0.1 }), 2);
		expect(cam.limit).toBeCloseTo(cam.zoom, 6); // not a blocking wall…
		expect(p.x).toBeGreaterThan(3.6); // …so the lens is nudged sideways, not pulled in
		expect(4 - p.x).toBeGreaterThanOrEqual(0.3 - 1e-6);
		expect(p.z).toBeLessThan(-7);
		expect(cam.sightBlocked(world)).toBe(false);
	});

	it('eases the focus after small moves but snaps after a long jump', () => {
		const cam = new FollowCamera();
		const world = city(false);
		run(cam, world, target(), 1);
		cam.update(DT, target({ x: 1 }), world, flat);
		expect(cam.focus.x).toBeGreaterThan(0.1);
		expect(cam.focus.x).toBeLessThan(0.5);
		cam.update(DT, target({ x: 500 }), world, flat);
		expect(cam.focus.x).toBe(500);
	});

	it('keeps the lens above the ground on a hill', () => {
		const cam = new FollowCamera();
		const hill = (x: number, z: number) => Math.max(0, 10 - Math.hypot(x, z - 8));
		for (let i = 0; i < 60; i++) cam.update(DT, target({ pitch: 0.08 }), city(false), hill);
		expect(cam.position.y).toBeGreaterThanOrEqual(hill(cam.position.x, cam.position.z) + 0.7 - 1e-9);
	});
});

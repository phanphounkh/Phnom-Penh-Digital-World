import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CollisionWorld, moveCircle, rayFraction } from '$lib/game/city/collision';
import { FLAT } from '$lib/game/city/terrain';
import { Buildings, type BuildingHost, type BuildingInteraction } from './Buildings';
import { Door, SWING_TIME, facing } from './door';
import { Frame, floorAt, isInside, type BuildingPlacement, type BuildingSpec } from './spec';

/** The real spec written by tools/blender/generate_house.py. */
const SPEC = JSON.parse(readFileSync(new URL('../../../../static/models/buildings/house-riverside.json', import.meta.url), 'utf8')) as BuildingSpec;
const PLACE: BuildingPlacement = { id: 'house', spec: '/x/house.json', x: 100, z: -50, yaw: Math.PI / 2 };
const R = 0.35;

describe('placement frame', () => {
	it('turns model space into world space and back', () => {
		const f = new Frame(100, -50, Math.PI / 2, 0);
		// yaw π/2: the model's front (+Z) faces world +X.
		const [x, z] = f.toWorld([0, 1]);
		expect(x).toBeCloseTo(101);
		expect(z).toBeCloseTo(-50);
		const p = f.toLocal(...f.toWorld([1.3, -2.1]));
		expect(p[0]).toBeCloseTo(1.3);
		expect(p[1]).toBeCloseTo(-2.1);
		const [dx, dz] = f.dirToWorld([1, 0]);
		expect(dx).toBeCloseTo(0);
		expect(dz).toBeCloseTo(-1);
	});

	it('gives the floor inside, the porch and step outside, and the terrain elsewhere', () => {
		const f = new Frame(0, 0, 0, 0.5);
		expect(floorAt(SPEC, f, 0, 0)).toBeCloseTo(0.5 + SPEC.floor);
		const porch = SPEC.steps[0].ring;
		expect(floorAt(SPEC, f, (porch[0][0] + porch[1][0]) / 2, (porch[0][1] + porch[2][1]) / 2)).toBeCloseTo(0.5 + SPEC.steps[0].height);
		const step = SPEC.steps[1].ring;
		expect(floorAt(SPEC, f, (step[0][0] + step[1][0]) / 2, (step[0][1] + step[2][1]) / 2)).toBeCloseTo(0.5 + SPEC.steps[1].height);
		expect(floorAt(SPEC, f, 20, 20)).toBeNull();
		expect(isInside(SPEC, f, 0, 0)).toBe(true);
		expect(isInside(SPEC, f, 0, SPEC.interior.max[1] + 0.2)).toBe(false);
	});
});

describe('door', () => {
	it('swings open and closed over SWING_TIME with an eased angle', () => {
		const d = new Door(SPEC.door);
		expect(d.label).toBe('Open Door');
		d.toggle(1);
		expect(d.label).toBe('Close Door');
		let t = 0;
		while (d.update(1 / 60)) t += 1 / 60;
		expect(t).toBeCloseTo(SWING_TIME, 1);
		expect(d.angle).toBeCloseTo(SPEC.door.openYaw);
		d.toggle(2);
		while (d.update(1 / 60));
		expect(d.angle).toBe(0);
	});

	it('keeps the newest state (ready for doors shared between players)', () => {
		const d = new Door(SPEC.door);
		d.apply({ open: true, changedAt: 200 });
		d.apply({ open: false, changedAt: 100 }); // older: ignored
		expect(d.open).toBe(true);
	});

	it('closed, the leaf spans the doorway; open, it lies against the inside', () => {
		const d = new Door(SPEC.door);
		const closed = d.leafRing();
		const xs = closed.map((p) => p[0]);
		const [cx, cz] = SPEC.door.center;
		expect(Math.min(...xs)).toBeLessThan(cx - 0.4);
		expect(Math.max(...xs)).toBeGreaterThan(cx + 0.4);
		for (const p of closed) expect(Math.abs(p[1] - cz)).toBeLessThan(0.1);
		const open = d.leafRing(SPEC.door.openYaw);
		for (const p of open) expect(p[1]).toBeLessThan(cz + 0.1); // swung inwards (-Z)
		expect(Math.min(...open.map((p) => p[1]))).toBeLessThan(cz - 0.8);
	});

	it('will not close on a player standing in its path', () => {
		const d = new Door(SPEC.door);
		const [cx, cz] = SPEC.door.center;
		expect(d.blocksClosing(cx, cz, R)).toBe(true); // in the doorway
		expect(d.blocksClosing(cx, cz - 0.6, R)).toBe(true); // just inside, in the swing
		expect(d.blocksClosing(cx, cz + 1.2, R)).toBe(false); // outside on the porch
		expect(d.blocksClosing(cx + 2.5, cz - 2.5, R)).toBe(false); // across the room
	});

	it('prompts only when the player roughly faces the target', () => {
		expect(facing(0, 0, 0, 0, 2)).toBe(true); // straight ahead (+Z)
		expect(facing(0, 0, Math.PI, 0, 2)).toBe(false); // behind
		expect(facing(0, 0, Math.PI, 0, 0.5)).toBe(true); // close enough
	});
});

function host() {
	const calls = { interior: [] as ({ ceiling: number } | null)[], sit: [] as unknown[], stand: 0, walk: [] as [number, number][][], shadows: 0 };
	type Ground = ((x: number, z: number) => number | null) | null;
	let ground: Ground = null;
	let seated = false;
	const h: BuildingHost & { readonly ground: Ground } = {
		scene: new THREE.Scene(),
		collision: new CollisionWorld(),
		terrain: FLAT,
		get seated() {
			return seated;
		},
		get ground() {
			return ground;
		},
		setGround: (g) => (ground = g),
		setInterior: (v) => calls.interior.push(v),
		sit: (seat) => {
			calls.sit.push(seat);
			seated = true;
			return true;
		},
		stand: () => {
			calls.stand++;
			seated = false;
		},
		walkTo: (points, done) => {
			calls.walk.push(points);
			done?.(true);
		},
		invalidateShadows: () => calls.shadows++
	};
	return { h, calls };
}

/** A stand-in model with the nodes the system animates. */
function model() {
	const root = new THREE.Group();
	for (const name of ['Exterior', 'Interior', 'Door', 'Fan']) {
		const o = new THREE.Object3D();
		o.name = name;
		root.add(o);
	}
	return root;
}

describe('enterable building', () => {
	const setup = () => {
		const { h, calls } = host();
		let prompt: BuildingInteraction | null = null;
		const b = new Buildings(h, (i) => (prompt = i), [PLACE]);
		b.attach(PLACE, SPEC, model());
		const f = new Frame(PLACE.x, PLACE.z, PLACE.yaw, 0);
		const w = (lx: number, lz: number) => f.toWorld([lx, lz]);
		return { h, calls, b, f, w, prompt: () => prompt };
	};
	const [cx, cz] = SPEC.door.center;
	const towardDoor = PLACE.yaw + Math.PI; // the front faces +X: the door is towards -X
	/** Open the door from the porch and let it swing fully. */
	const openDoor = (b: Buildings, w: (lx: number, lz: number) => [number, number]) => {
		const [x, z] = w(cx, cz + 1.2);
		b.update(0, x, z, towardDoor);
		expect(b.interaction?.kind).toBe('door');
		b.interact();
		for (let t = 0; t < SWING_TIME + 0.1; t += 1 / 30) b.update(1 / 30, x, z, towardDoor);
	};
	/** Walk the player circle in a straight line; returns where it ended. */
	const walk = (h: BuildingHost, from: [number, number], to: [number, number]) => {
		let [x, z] = from;
		for (let i = 0; i < 200; i++) {
			const dx = to[0] - x,
				dz = to[1] - z;
			const d = Math.hypot(dx, dz);
			if (d < 0.05) break;
			const step = Math.min(d, 0.05);
			({ x, z } = moveCircle(h.collision, x, z, (dx / d) * step, (dz / d) * step, R));
		}
		return [x, z] as [number, number];
	};

	it('walls block walking; the closed door blocks the doorway; the open door lets you in', () => {
		const { h, b, w } = setup();
		const outside = w(cx, cz + 2.2);
		const inside = w(cx, cz - 2.2);
		// Through the closed door: stopped on the porch.
		let end = walk(h, outside, inside);
		expect(Math.hypot(end[0] - inside[0], end[1] - inside[1])).toBeGreaterThan(1.5);
		// Through a wall (beside the door): stopped too.
		end = walk(h, w(cx + 2.5, cz + 2.2), w(cx + 2.5, cz - 2.2));
		expect(Math.hypot(end[0] - w(cx + 2.5, cz - 2.2)[0], end[1] - w(cx + 2.5, cz - 2.2)[1])).toBeGreaterThan(1.5);
		// Open the door (it swings for SWING_TIME), then walk in: no teleport, just walking.
		openDoor(b, w);
		end = walk(h, outside, inside);
		expect(Math.hypot(end[0] - inside[0], end[1] - inside[1])).toBeLessThan(0.1);
		// ...and back out.
		end = walk(h, inside, outside);
		expect(Math.hypot(end[0] - outside[0], end[1] - outside[1])).toBeLessThan(0.1);
	});

	it('shows "Open Door" / "Close Door" near the doorway, facing it', () => {
		const { b, w, prompt } = setup();
		const [x, z] = w(cx, cz + 1.2);
		b.update(0, x, z, towardDoor);
		expect(prompt()).toMatchObject({ kind: 'door', label: 'Open Door' });
		b.interact();
		b.update(0.05, x, z, towardDoor);
		expect(prompt()).toMatchObject({ kind: 'door', label: 'Close Door' });
		b.update(0, x, z, towardDoor + Math.PI); // facing away
		expect(prompt()).toBeNull();
		const [fx, fz] = w(cx, cz + 6);
		b.update(0, fx, fz, towardDoor); // too far
		expect(prompt()).toBeNull();
	});

	it('the camera is blocked by the closed door and the lintel, not by the open doorway', () => {
		const { h, b, w } = setup();
		const [ax, az] = w(cx, cz - 1.5);
		const [bx, bz] = w(cx, cz + 1.5);
		const lintel = SPEC.lintels[0].base;
		expect(rayFraction(h.collision, ax, lintel - 0.4, az, bx, lintel - 0.4, bz)).toBeLessThan(1); // closed door
		openDoor(b, w);
		expect(rayFraction(h.collision, ax, lintel - 0.4, az, bx, lintel - 0.4, bz)).toBe(1);
		expect(rayFraction(h.collision, ax, lintel + 0.3, az, bx, lintel + 0.3, bz)).toBeLessThan(1);
	});

	it('switches to the indoor camera inside, back outside, with hysteresis at the doorway', () => {
		const { b, calls, w } = setup();
		b.update(0, ...w(0, 0), 0);
		expect(calls.interior.at(-1)).toMatchObject({ ceiling: SPEC.interior.ceiling });
		expect(b.insideOf).toBe('house');
		b.update(0, ...w(cx, SPEC.interior.max[1] + 0.1), 0); // on the threshold: still inside
		expect(b.insideOf).toBe('house');
		b.update(0, ...w(cx, SPEC.interior.max[1] + 0.6), 0);
		expect(calls.interior.at(-1)).toBeNull();
	});

	it('sits on the armchair from in front of it and stands up again', () => {
		const { b, calls, f, prompt } = setup();
		const seat = SPEC.seats.find((s) => s.id === 'armchair')!;
		const [sx, sz] = f.toWorld(seat.stand);
		const [tx, tz] = f.toWorld([seat.x, seat.z]);
		const toward = Math.atan2(tx - sx, tz - sz);
		b.update(0, sx, sz, toward);
		expect(prompt()).toMatchObject({ kind: 'sit', label: 'Sit Down', seat: 'armchair' });
		b.interact();
		expect(calls.walk.at(-1)).toEqual([[sx, sz]]);
		expect(calls.sit).toHaveLength(1);
		expect(calls.sit[0]).toMatchObject({ yaw: PLACE.yaw + seat.yaw });
		b.update(0.016, tx, tz, PLACE.yaw + seat.yaw);
		expect(prompt()).toMatchObject({ kind: 'stand', label: 'Stand Up' });
		b.interact();
		expect(calls.stand).toBe(1);
	});

	it('provides the floor height and cleans up after itself', () => {
		const { h, b, w } = setup();
		const ground = (h as unknown as { ground: (x: number, z: number) => number | null }).ground;
		expect(ground(...w(0, 0))).toBeCloseTo(SPEC.floor);
		expect(h.collision.ownerCount).toBe(2); // building + door leaf
		b.dispose();
		expect(h.collision.ownerCount).toBe(0);
		expect(h.scene.children).toHaveLength(0);
	});
});

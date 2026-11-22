import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CollisionWorld, moveCircle, rayFraction } from '$lib/game/city/collision';
import { FLAT } from '$lib/game/city/terrain';
import { Buildings, type BuildingHost, type BuildingInteraction, type Inspection } from './Buildings';
import { Door, SWING_TIME, Switch, facing } from './door';
import { findPath } from './nav';
import { Frame, floorAt, isInside, rectDistance, roomAt, type BuildingPlacement, type BuildingSpec, type XZ } from './spec';

/** The real spec written by tools/blender/generate_house.py. */
const SPEC = JSON.parse(readFileSync(new URL('../../../../static/models/buildings/house-riverside.json', import.meta.url), 'utf8')) as BuildingSpec;
const PLACE: BuildingPlacement = { id: 'house', spec: '/x/house.json', x: 100, z: -50, yaw: Math.PI / 2 };
const R = 0.35;
const door = (id: string) => SPEC.doors.find((d) => d.id === id)!;

describe('placement frame and spec', () => {
	it('turns model space into world space and back', () => {
		const f = new Frame(100, -50, Math.PI / 2, 0);
		const [x, z] = f.toWorld([0, 1]); // yaw π/2: the front (+Z) faces world +X
		expect(x).toBeCloseTo(101);
		expect(z).toBeCloseTo(-50);
		const p = f.toLocal(...f.toWorld([1.3, -2.1]));
		expect(p[0]).toBeCloseTo(1.3);
		expect(p[1]).toBeCloseTo(-2.1);
	});

	it('gives the floor inside, the porch and step outside, and the terrain elsewhere', () => {
		const f = new Frame(0, 0, 0, 0.5);
		expect(floorAt(SPEC, f, 0, 0)).toBeCloseTo(0.5 + SPEC.floor);
		const mid = (ring: XZ[]): XZ => [(ring[0][0] + ring[1][0]) / 2, (ring[0][1] + ring[2][1]) / 2];
		expect(floorAt(SPEC, f, ...mid(SPEC.steps[0].ring))).toBeCloseTo(0.5 + SPEC.steps[0].height);
		expect(floorAt(SPEC, f, ...mid(SPEC.steps[1].ring))).toBeCloseTo(0.5 + SPEC.steps[1].height);
		expect(floorAt(SPEC, f, 30, 30)).toBeNull();
		expect(isInside(SPEC, f, 0, 0)).toBe(true);
	});

	it('has a living room, dining room, kitchen, bedroom, bathroom and hall, each with a lit group', () => {
		expect(SPEC.rooms.map((r) => r.id).sort()).toEqual(['bathroom', 'bedroom', 'dining', 'hall', 'kitchen', 'living']);
		const centre = (id: string): XZ => {
			const [x0, x1, z0, z1] = SPEC.rooms.find((r) => r.id === id)!.rects[0];
			return [(x0 + x1) / 2, (z0 + z1) / 2];
		};
		for (const room of SPEC.rooms) expect(roomAt(SPEC, ...centre(room.id))?.id).toBe(room.id);
		expect(new Set(SPEC.rooms.map((r) => r.light))).toEqual(new Set(SPEC.lights.map((l) => l.channel)));
		for (const l of SPEC.lights) expect(l.switches.length).toBeGreaterThan(0);
		expect(rectDistance([0, 1, 0, 1], 0.5, 0.5)).toBe(0);
		expect(rectDistance([0, 1, 0, 1], 2, 0.5)).toBeCloseTo(1);
	});

	it('every seat can be reached: its stand-up spot is clear of furniture and walls', () => {
		const world = new CollisionWorld();
		const f = new Frame(0, 0, 0, 0);
		for (const w of SPEC.walls) world.addRing('w', f.ring(w), 3);
		for (const b of SPEC.blockers) world.addRing('b', f.ring(b), 0);
		for (const s of SPEC.seats) {
			// A circle placed on the spot is pushed out by less than the arrival tolerance.
			const r = moveCircle(world, s.stand[0], s.stand[1], 0, 0, R);
			expect(Math.hypot(r.x - s.stand[0], r.z - s.stand[1]), s.id).toBeLessThan(0.34);
		}
	});
});

describe('finding a way around furniture', () => {
	const table: XZ[] = [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]];
	const area = { bounds: [-4, 4, -4, 4] as [number, number, number, number], obstacles: [table], radius: R };
	const clear = (path: XZ[], from: XZ) => {
		// Every leg keeps the player circle off the table.
		let a = from;
		for (const b of path) {
			for (let t = 0; t <= 1; t += 0.02) {
				const x = a[0] + (b[0] - a[0]) * t,
					z = a[1] + (b[1] - a[1]) * t;
				const dx = Math.max(-1 - x, 0, x - 1),
					dz = Math.max(-0.5 - z, 0, z - 0.5);
				expect(Math.hypot(dx, dz)).toBeGreaterThan(R - 0.12);
			}
			a = b;
		}
	};

	it('walks straight when nothing is in the way', () => {
		expect(findPath(area, [-3, 2], [3, 2])).toEqual([[3, 2]]);
	});

	it('goes round a table instead of through it', () => {
		const path = findPath(area, [0, 1.6], [0, -1.6])!;
		expect(path.length).toBeGreaterThan(1);
		expect(path.at(-1)).toEqual([0, -1.6]);
		clear(path, [0, 1.6]);
	});

	it('reaches the dining chairs of the real house from across the table', () => {
		const f = new Frame(0, 0, 0, 0);
		const obstacles = [...SPEC.walls, ...SPEC.blockers].map((r) => f.ring(r));
		const t = SPEC.tables.find((x) => x.id === 'dining')!;
		for (const id of t.seats) {
			const seat = SPEC.seats.find((s) => s.id === id)!;
			expect(findPath({ bounds: [-5.2, 5.2, -4.4, 4.4], obstacles, radius: R + 0.03 }, [2.8, 3.5], seat.stand), id).not.toBeNull();
		}
	});
});

describe('door and switch state', () => {
	it('swings open and closed over SWING_TIME with an eased angle and labelled prompts', () => {
		const d = new Door(door('front'));
		expect(d.label).toBe('Open Door');
		expect(new Door(door('bedroom')).label).toBe('Open Bedroom Door');
		d.toggle(1);
		expect(d.label).toBe('Close Door');
		let t = 0;
		while (d.update(1 / 60)) t += 1 / 60;
		expect(t).toBeCloseTo(SWING_TIME, 1);
		expect(d.angle).toBeCloseTo(d.spec.openYaw);
	});

	it('keeps the newest state (ready for doors and lights shared between players)', () => {
		const d = new Door(door('front'));
		d.apply({ open: true, changedAt: 200 });
		d.apply({ open: false, changedAt: 100 });
		expect(d.open).toBe(true);
		const s = new Switch(false);
		s.apply({ on: true, changedAt: 50 });
		s.apply({ on: false, changedAt: 10 });
		expect(s.on).toBe(true);
		s.toggle(60);
		expect(s.on).toBe(false);
	});

	it('closed, a leaf spans its doorway; open, it lies against the inside', () => {
		for (const spec of SPEC.doors) {
			const d = new Door(spec);
			const [cx, cz] = spec.center;
			const closed = d.leafRing();
			expect(Math.min(...closed.map((p) => p[0]))).toBeLessThan(cx - spec.width / 2 + 0.1);
			expect(Math.max(...closed.map((p) => p[0]))).toBeGreaterThan(cx + spec.width / 2 - 0.1);
			const open = d.leafRing(spec.openYaw);
			expect(Math.min(...open.map((p) => p[1]))).toBeLessThan(cz - spec.width + 0.1);
		}
	});

	it('prompts only when the player roughly faces the target', () => {
		expect(facing(0, 0, 0, 0, 2)).toBe(true);
		expect(facing(0, 0, Math.PI, 0, 2)).toBe(false);
		expect(facing(0, 0, Math.PI, 0, 0.5)).toBe(true);
	});
});

function host() {
	const calls = { interior: [] as ({ ceiling: number; lamp: number } | null)[], sit: [] as unknown[], stand: 0, walk: [] as [number, number][][], shadows: 0 };
	type Ground = ((x: number, z: number) => number | null) | null;
	let ground: Ground = null;
	let seated = false;
	const night = { value: 0 };
	const h: BuildingHost & { readonly ground: Ground } = {
		scene: new THREE.Scene(),
		collision: new CollisionWorld(),
		terrain: FLAT,
		materials: { night },
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
	return { h, calls, night };
}

/** A stand-in model with the nodes the system animates. */
function model() {
	const root = new THREE.Group();
	for (const name of ['Exterior', 'Interior', 'Glass', ...SPEC.doors.map((d) => d.node), ...SPEC.fans.map((f) => f.node), 'StoveFlame', 'TVScreen']) {
		const o = new THREE.Object3D();
		o.name = name;
		root.add(o);
	}
	root.getObjectByName('TVScreen')!.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial()));
	return root;
}

describe('the house in the world', () => {
	const setup = () => {
		const { h, calls } = host();
		let prompt: BuildingInteraction | null = null;
		let card: Inspection | null = null;
		const b = new Buildings(h, (i) => (prompt = i), [PLACE], (x) => (card = x));
		b.attach(PLACE, SPEC, model());
		const f = new Frame(PLACE.x, PLACE.z, PLACE.yaw, 0);
		const w = (lx: number, lz: number) => f.toWorld([lx, lz]);
		/** World yaw from a model-space point towards another. */
		const toward = (from: XZ, to: XZ) => Math.atan2(to[0] - from[0], to[1] - from[1]) + PLACE.yaw;
		/** Stand at a model-space point facing a model-space target and look for the prompt. */
		const at = (p: XZ, target: XZ) => {
			b.update(0, ...w(...p), toward(p, target));
			return prompt as BuildingInteraction | null;
		};
		return { h, calls, b, f, w, at, card: () => card };
	};
	/** Walk the player circle in a straight line (model space); returns where it ended. */
	const walk = (h: BuildingHost, f: Frame, from: XZ, to: XZ) => {
		let [x, z] = f.toWorld(from);
		const [tx, tz] = f.toWorld(to);
		for (let i = 0; i < 400; i++) {
			const dx = tx - x,
				dz = tz - z;
			const d = Math.hypot(dx, dz);
			if (d < 0.05) break;
			const step = Math.min(d, 0.05);
			({ x, z } = moveCircle(h.collision, x, z, (dx / d) * step, (dz / d) * step, R));
		}
		return f.toLocal(x, z);
	};
	const near = (a: XZ, b: XZ, tol = 0.1) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;
	const open = (b: Buildings, at: (p: XZ, t: XZ) => BuildingInteraction | null, from: XZ, id: string) => {
		const d = door(id);
		expect(at(from, d.center)).toMatchObject({ kind: 'door', door: id });
		b.interact();
		for (let t = 0; t < SWING_TIME + 0.1; t += 1 / 30) b.update(1 / 30, 0, 0, 0);
	};

	it('the front door: closed it blocks, open you walk in and out (no teleport)', () => {
		const { h, b, f, at } = setup();
		const [cx, cz] = door('front').center;
		const outside: XZ = [cx, cz + 2.2];
		const inside: XZ = [cx, cz - 2.0];
		expect(near(walk(h, f, outside, inside), inside, 1.5)).toBe(false);
		open(b, at, [cx, cz + 1.2], 'front');
		expect(near(walk(h, f, outside, inside), inside)).toBe(true);
		expect(near(walk(h, f, inside, outside), outside)).toBe(true);
	});

	it('partitions and the bedroom door separate the rooms', () => {
		const { h, b, f, at } = setup();
		const [bx, bz] = door('bedroom').center;
		const living: XZ = [bx, bz + 1.5];
		const bedroom: XZ = [bx, bz - 1.5];
		expect(near(walk(h, f, living, bedroom), bedroom, 1)).toBe(false); // closed door
		expect(near(walk(h, f, [bx - 1.5, bz + 1.5], [bx - 1.5, bz - 1.5]), [bx - 1.5, bz - 1.5], 1)).toBe(false); // wall
		open(b, at, [bx, bz + 1.0], 'bedroom');
		expect(at([bx, bz + 1.0], [bx, bz])).toMatchObject({ kind: 'door', label: 'Close Bedroom Door' });
		expect(near(walk(h, f, living, bedroom), bedroom)).toBe(true);
	});

	it('light switches turn a room group on and off, and the room light reaches the avatar', () => {
		const { calls, b, at } = setup();
		const front = SPEC.lights.find((l) => l.id === 'front')!;
		const [sx, sz] = front.switches[0];
		const from: XZ = [sx, sz - 0.8];
		expect(at(from, [sx, sz])).toMatchObject({ kind: 'light', label: 'Turn Lights On', light: 'front' }); // by day: off
		expect(calls.interior.at(-1)).toMatchObject({ lamp: 0 });
		b.interact();
		b.update(0.5, 0, 0, 0);
		expect(b.list[0].lights.front).toBe(true);
		expect(at(from, [sx, sz])).toMatchObject({ kind: 'light', label: 'Turn Lights Off' });
		expect(calls.interior.at(-1)).toMatchObject({ lamp: 1 });
		expect(b.list[0].lights.bedroom).toBe(false); // other rooms are separate
	});

	it('turns the TV and the stove on and off', () => {
		const { b, at } = setup();
		for (const id of ['tv', 'stove']) {
			const t = SPEC.toggles.find((x) => x.id === id)!;
			const from: XZ = [t.x, t.z + (id === 'tv' ? -1.0 : 0.9)];
			const label = id === 'tv' ? 'TV' : 'Stove';
			expect(at(from, [t.x, t.z])).toMatchObject({ kind: 'toggle', label: `Turn On ${label}` });
			b.interact();
			expect(b.list[0].appliances[id]).toBe(true);
			expect(at(from, [t.x, t.z])).toMatchObject({ kind: 'toggle', label: `Turn Off ${label}` });
		}
	});

	it('inspects an object, shows its card, and closes it again', () => {
		const { b, at, card } = setup();
		const painting = SPEC.items.find((i) => i.id === 'painting')!;
		// In front of the sofa: sit down; a step back (past the coffee table): the painting above it.
		const sofa = SPEC.seats.find((s) => s.id === 'sofa-left')!;
		expect(at(sofa.stand, [painting.x, painting.z])).toMatchObject({ kind: 'sit' });
		const from: XZ = [painting.x, 2.65];
		expect(at(from, [painting.x, painting.z])).toMatchObject({ kind: 'inspect', label: 'Inspect Painting' });
		b.interact();
		expect(card()).toMatchObject({ title: painting.title, text: painting.text });
		expect(at(from, [painting.x, painting.z])).toMatchObject({ kind: 'inspect', label: 'Close' });
		b.interact();
		expect(card()).toBeNull();
		// Right after E opens the card (no prompt until the next frame), E closes it again too.
		at(from, [painting.x, painting.z]);
		b.interact();
		expect(card()).not.toBeNull();
		expect(b.interaction).toBeNull();
		b.interact();
		expect(card()).toBeNull();
	});

	it('"Sit at the Table" picks the nearest chair and sits facing the table; E stands up', () => {
		const { calls, b, at } = setup();
		const table = SPEC.tables.find((t) => t.id === 'dining')!;
		const [x0, x1, z0, z1] = table.rect;
		const from: XZ = [(x0 + x1) / 2, z1 + 1.0];
		expect(at(from, [(x0 + x1) / 2, (z0 + z1) / 2])).toMatchObject({ kind: 'table', label: 'Sit at the Table' });
		b.interact();
		const dist = (s: { stand: XZ }) => Math.hypot(s.stand[0] - from[0], s.stand[1] - from[1]);
		const chosen = SPEC.seats.filter((s) => table.seats.includes(s.id)).sort((a, c) => dist(a) - dist(c))[0];
		expect(calls.sit).toHaveLength(1);
		expect(calls.sit[0]).toMatchObject({ yaw: PLACE.yaw + chosen.yaw });
		// The chair faces the table.
		const toTable = [(x0 + x1) / 2 - chosen.x, (z0 + z1) / 2 - chosen.z];
		expect(Math.sin(chosen.yaw) * toTable[0] + Math.cos(chosen.yaw) * toTable[1]).toBeGreaterThan(0);
		b.update(0.016, 0, 0, 0);
		expect(b.interaction).toMatchObject({ kind: 'stand', label: 'Stand Up' });
		b.interact();
		expect(calls.stand).toBe(1);
	});

	it('with another building loaded, still picks the chair nearest the player in this one', () => {
		// (The player's spot must be read in the frame of the building being used, not in the
		// frame of whichever building was looked at last.)
		const table = SPEC.tables.find((t) => t.id === 'dining')!;
		const [x0, x1, z0, z1] = table.rect;
		const chairs = SPEC.seats.filter((s) => table.seats.includes(s.id));
		const sides: XZ[] = [
			[(x0 + x1) / 2, z1 + 1.0],
			[(x0 + x1) / 2, z0 - 1.0]
		];
		const picked = sides.map((from) => {
			const { calls, b, at } = setup();
			b.attach({ ...PLACE, id: 'next-door', x: PLACE.x + 60, z: PLACE.z - 40, yaw: PLACE.yaw + 1.2 }, SPEC, model());
			expect(at(from, [(x0 + x1) / 2, (z0 + z1) / 2])).toMatchObject({ kind: 'table', building: PLACE.id });
			b.interact();
			const nearest = [...chairs].sort((a, c) => Math.hypot(a.stand[0] - from[0], a.stand[1] - from[1]) - Math.hypot(c.stand[0] - from[0], c.stand[1] - from[1]))[0];
			expect(calls.sit[0]).toMatchObject({ yaw: PLACE.yaw + nearest.yaw });
			return nearest.id;
		});
		expect(picked[0]).not.toBe(picked[1]);
	});

	it('sits on the armchair from in front of it', () => {
		const { calls, b, at } = setup();
		const seat = SPEC.seats.find((s) => s.id === 'armchair')!;
		expect(at(seat.stand, [seat.x, seat.z])).toMatchObject({ kind: 'sit', label: 'Sit Down', seat: 'armchair' });
		b.interact();
		expect(calls.sit[0]).toMatchObject({ yaw: PLACE.yaw + seat.yaw });
	});

	it('the camera passes the open front doorway but not the lintel above it', () => {
		const { h, b, f, at } = setup();
		const [cx, cz] = door('front').center;
		const [ax, az] = f.toWorld([cx, cz - 1.5]);
		const [bx, bz] = f.toWorld([cx, cz + 1.5]);
		const lintel = SPEC.lintels[0].base;
		expect(rayFraction(h.collision, ax, lintel - 0.4, az, bx, lintel - 0.4, bz)).toBeLessThan(1); // closed door
		open(b, at, [cx, cz + 1.2], 'front');
		expect(rayFraction(h.collision, ax, lintel - 0.4, az, bx, lintel - 0.4, bz)).toBe(1);
		expect(rayFraction(h.collision, ax, lintel + 0.3, az, bx, lintel + 0.3, bz)).toBeLessThan(1);
	});

	it('switches to the indoor camera inside and back outside, with hysteresis at the doorway', () => {
		const { b, calls, w } = setup();
		b.update(0, ...w(0, 0), 0);
		expect(calls.interior.at(-1)).toMatchObject({ ceiling: SPEC.interior.ceiling });
		b.update(0, ...w(door('front').center[0], SPEC.interior.max[1] + 0.1), 0);
		expect(b.insideOf).toBe('house');
		b.update(0, ...w(door('front').center[0], SPEC.interior.max[1] + 0.6), 0);
		expect(calls.interior.at(-1)).toBeNull();
	});

	it('provides the floor height and cleans up after itself', () => {
		const { h, b, w } = setup();
		const ground = (h as unknown as { ground: (x: number, z: number) => number | null }).ground;
		expect(ground(...w(0, 0))).toBeCloseTo(SPEC.floor);
		expect(h.collision.ownerCount).toBe(1 + SPEC.doors.length);
		b.dispose();
		expect(h.collision.ownerCount).toBe(0);
		expect(h.scene.children).toHaveLength(0);
	});
});

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { ChunkPayload } from '$lib/api/types';
import { CollisionWorld, moveCircle } from '$lib/game/city/collision';
import type { Doorway } from '$lib/game/city/materials';
import { FLAT } from '$lib/game/city/terrain';
import { Buildings, type BuildingHost, type BuildingInteraction } from './Buildings';
import { SWING_TIME } from './door';
import { planInterior, type Plan, type XZ } from './footprint';
import { findPath } from './nav';
import { buildInterior } from './procedural';
import { Frame } from './spec';

const R = 0.35;
const rect = (cx: number, cz: number, w: number, d: number): XZ[] => [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]];

function planFor(w: number, d: number): Plan {
	const r = planInterior({ ring: rect(0, 0, w, d), h: 7 }, { roads: [{ pts: [[-60, d / 2 + 6], [60, d / 2 + 6]], w: 8 }], neighbours: [] });
	if (!r.ok) throw new Error(r.reason);
	return r.plan;
}

describe('generated interiors', () => {
	for (const type of ['cafe', 'shop', 'house'] as const)
		for (const [w, d] of [[6, 7], [9, 11], [13, 9]])
			it(`${type} in a ${w} x ${d} m building: furnished, lit, reachable`, () => {
				const plan = planFor(w, d);
				const { spec, root } = buildInterior(type, plan, 42, { value: 0 });
				const interior = root.getObjectByName('Interior') as THREE.Mesh;
				expect(interior).toBeTruthy();
				expect(root.getObjectByName('Door_front')).toBeTruthy();
				const g = interior.geometry;
				for (const a of ['position', 'normal', 'color', 'light']) expect(g.getAttribute(a)).toBeTruthy();
				const light = g.getAttribute('light').array as Float32Array;
				for (const v of light) expect(Number.isFinite(v) && v >= 0 && v <= 3).toBe(true);
				// The door is on the front wall, where the plan put it.
				const door = spec.doors[0];
				expect(door.center[0]).toBeCloseTo(plan.doorX);
				expect(door.center[1]).toBeGreaterThan(plan.depth / 2);
				// Everything stays inside the room.
				const [x0, z0] = spec.interior.min;
				const [x1, z1] = spec.interior.max;
				for (const ring of spec.blockers) for (const [x, z] of ring) expect(x >= x0 - 1e-6 && x <= x1 + 1e-6 && z >= z0 - 1e-6 && z <= z1 + 1e-6).toBe(true);
				// From just inside the door, every seat's stand-up spot can be walked to.
				const area = { bounds: [x0, x1, z0, z1] as [number, number, number, number], obstacles: [...spec.walls, ...spec.blockers], radius: R };
				const from: XZ = [plan.doorX, z1 - 0.5];
				for (const s of spec.seats) expect(findPath(area, from, s.stand), `${type} ${s.id} from ${from} to ${s.stand} plan ${plan.width},${plan.depth},${plan.doorX}`).not.toBeNull();
				for (const t of spec.tables) for (const id of t.seats) expect(spec.seats.some((s) => s.id === id)).toBe(true);
				// Each kind has its things.
				if (type === 'cafe') {
					expect(spec.toggles.map((t) => t.id)).toContain('coffee');
					expect(spec.items.map((i) => i.id)).toContain('menu');
					expect(spec.tables.length).toBeGreaterThan(0);
				}
				if (type === 'shop') expect(spec.items.map((i) => i.id)).toEqual(expect.arrayContaining(['fridge', 'rice']));
				if (type === 'house') expect(spec.lights[0].switches.length).toBe(1);
			});

	it('walls face into the room, the floor up and the ceiling down', () => {
		const plan = planFor(9, 11);
		const { root } = buildInterior('cafe', plan, 1, { value: 0 });
		const g = (root.getObjectByName('Interior') as THREE.Mesh).geometry;
		const pos = g.getAttribute('position'),
			nor = g.getAttribute('normal'),
			col = g.getAttribute('color');
		const wall = new THREE.Color('#efe2cc'); // the café's wall colour (the shell, not furniture)
		let wrong = 0,
			checked = 0;
		for (let i = 0; i < pos.count; i++) {
			const x = pos.getX(i),
				y = pos.getY(i),
				z = pos.getZ(i);
			const isWall = Math.abs(col.getX(i) - wall.r) + Math.abs(col.getY(i) - wall.g) + Math.abs(col.getZ(i) - wall.b) < 1e-4;
			const onWall = isWall && (Math.abs(Math.abs(x) - plan.width / 2) < 1e-4 || Math.abs(z + plan.depth / 2) < 1e-4);
			if (y === 0 && nor.getY(i) < 0.5 && Math.abs(nor.getY(i)) > 0.9) wrong++;
			if (onWall && Math.abs(nor.getY(i)) < 0.1) {
				checked++;
				if (-x * nor.getX(i) - z * nor.getZ(i) < 0) wrong++; // must point towards the room's middle
			}
		}
		expect(checked).toBeGreaterThan(50);
		expect(wrong).toBe(0);
	});

	it('is the same for the same building (seeded), and different for another', () => {
		const plan = planFor(9, 11);
		const a = buildInterior('shop', plan, 7, { value: 0 }).root.getObjectByName('Interior') as THREE.Mesh;
		const b = buildInterior('shop', plan, 7, { value: 0 }).root.getObjectByName('Interior') as THREE.Mesh;
		const c = buildInterior('shop', plan, 8, { value: 0 }).root.getObjectByName('Interior') as THREE.Mesh;
		expect(Array.from(a.geometry.getAttribute('color').array)).toEqual(Array.from(b.geometry.getAttribute('color').array));
		expect(Array.from(a.geometry.getAttribute('color').array)).not.toEqual(Array.from(c.geometry.getAttribute('color').array));
	});
});

describe('an OpenStreetMap building opened as a café', () => {
	// A 10 x 8 m building at (40, 0) with a street along its south side.
	const ring = rect(40, 0, 10, 8);
	const payload = {
		key: '0_0',
		ix: 0,
		iz: 0,
		size: 500,
		roads: [{ id: 1, name: 'Street', name_en: null, name_km: null, cls: 'residential', w: 8, oneway: false, bridge: false, layer: 0, pts: [[0, 10], [80, 10]] }],
		buildings: [{ id: 777, name: null, name_km: null, kind: 'commercial', h: 9, min_h: 0, hs: 'osm', colour: null, polys: [[ring]] }],
		areas: [],
		landmarks: [],
		features: []
	} as unknown as ChunkPayload;

	function world() {
		const collision = new CollisionWorld();
		collision.addRing('chunk', ring, 9); // the OSM building itself, as the chunk adds it
		const doorSets = new Map<string, Doorway[]>();
		let prompt: BuildingInteraction | null = null;
		const host: BuildingHost = {
			scene: new THREE.Scene(),
			collision,
			terrain: FLAT,
			materials: { night: { value: 0 }, setDoorSet: (o, d) => doorSets.set(o, d) },
			seated: false,
			setGround: () => {},
			setInterior: () => {},
			sit: () => true,
			stand: () => {},
			walkTo: (_p, done) => done?.(true),
			invalidateShadows: () => {}
		};
		const b = new Buildings(host, (i) => (prompt = i), [], undefined, { payloads: () => [payload], list: [{ id: 777, type: 'cafe', name: 'Riverside Café' }] });
		return { b, host, doorSets, prompt: () => prompt };
	}

	it('is found near the player, built, and gets a doorway in its facade', () => {
		const { b, host, doorSets } = world();
		b.update(0.016, 40, 20, 0); // 20 m away: discovered and built
		expect(b.list.map((x) => x.id)).toEqual(['osm:777']);
		expect(b.list[0].spec.name).toBe('Riverside Café');
		expect(doorSets.get('buildings')).toHaveLength(1);
		expect(host.collision.doors).toHaveLength(1);
		const d = doorSets.get('buildings')![0];
		expect(d.z).toBeCloseTo(4, 1); // on the street side of the building
	});

	it('closed, the door stops you; open, you walk in through the OSM wall', () => {
		const { b, host, prompt } = world();
		b.update(0.016, 40, 20, 0);
		const { frame, spec } = b.list[0];
		const [cx, cz] = spec.doors[0].center;
		const out = frame.toWorld([cx, cz + 2.0]);
		const inside = frame.toWorld([cx, cz - 2.2]);
		const walk = (from: XZ, to: XZ) => {
			let [x, z] = from;
			for (let i = 0; i < 400; i++) {
				const dx = to[0] - x,
					dz = to[1] - z,
					l = Math.hypot(dx, dz);
				if (l < 0.05) break;
				({ x, z } = moveCircle(host.collision, x, z, (dx / l) * Math.min(l, 0.05), (dz / l) * Math.min(l, 0.05), R));
			}
			return Math.hypot(x - to[0], z - to[1]);
		};
		expect(walk(out, inside)).toBeGreaterThan(1.5);
		const at = frame.toWorld([cx, cz + 1.0]);
		b.update(0.016, at[0], at[1], Math.atan2(...(([dx, dz]) => [dx, dz] as [number, number])([frame.toWorld([cx, cz])[0] - at[0], frame.toWorld([cx, cz])[1] - at[1]])));
		expect(prompt()).toMatchObject({ kind: 'door', label: 'Open Door' });
		b.interact();
		for (let t = 0; t < SWING_TIME + 0.1; t += 1 / 30) b.update(1 / 30, at[0], at[1], 0);
		expect(walk(out, inside)).toBeLessThan(0.1);
	});

	it('keeps a camera that looks in through the doorway under the ceiling', () => {
		const { b } = world();
		b.update(0.016, 40, 20, 0);
		const { frame, spec } = b.list[0];
		const [cx, cz] = spec.doors[0].center;
		const [ix, iz] = frame.toWorld([cx, cz - 2]); // in the room
		const [ox, oz] = frame.toWorld([cx, cz + 2]); // on the street
		expect(b.ceilingAt(ix, 5, iz)).toBeCloseTo(spec.interior.ceiling); // up in the building: capped
		expect(b.ceilingAt(ix, 12, iz)).toBeNull(); // above its 9 m roof: free
		expect(b.ceilingAt(ox, 5, oz)).toBeNull(); // outside
	});

	it('is freed again when the player walks away', () => {
		const { b, host, doorSets } = world();
		b.update(0.016, 40, 20, 0);
		b.update(2, 40, 400, 0);
		expect(b.list).toHaveLength(0);
		expect(doorSets.get('buildings')).toHaveLength(0);
		expect(host.collision.doors).toHaveLength(0);
		const f = new Frame(0, 0, 0, 0);
		expect(f).toBeTruthy();
	});
});

describe('auto mode: the buildings nearest the player open as they walk along a street', () => {
	// Twelve 8 x 8 m houses in a row along a street (z = 10), 12 m apart.
	const rings = Array.from({ length: 12 }, (_, i) => rect(i * 12, 0, 8, 8));
	const payload = {
		key: '0_0',
		ix: 0,
		iz: 0,
		size: 500,
		roads: [{ id: 1, name: 'Street', name_en: null, name_km: null, cls: 'residential', w: 8, oneway: false, bridge: false, layer: 0, pts: [[-30, 10], [170, 10]] }],
		buildings: rings.map((ring, i) => ({ id: 1000 + i, name: null, name_km: null, kind: 'house', h: 7, min_h: 0, hs: 'osm', colour: null, polys: [[ring]] })),
		areas: [],
		landmarks: [],
		features: []
	} as unknown as ChunkPayload;
	function town() {
		const host: BuildingHost = {
			scene: new THREE.Scene(),
			collision: new CollisionWorld(),
			terrain: FLAT,
			materials: { night: { value: 0 } },
			seated: false,
			setGround: () => {},
			setInterior: () => {},
			sit: () => true,
			stand: () => {},
			walkTo: (_p, done) => done?.(true),
			invalidateShadows: () => {}
		};
		for (const ring of rings) host.collision.addRing('chunk', ring, 7);
		const b = new Buildings(host, () => {}, [], undefined, { payloads: () => [payload], list: [], auto: { enabled: true, radius: 45, max: 3 } });
		/** Stand at (x, 16) for `seconds`, in quarter-second frames. */
		const stay = (x: number, seconds: number) => {
			for (let t = 0; t < seconds; t += 0.25) b.update(0.25, x, 16, 0);
		};
		const open = () => b.list.map((l) => l.id).sort();
		return { b, stay, open };
	}

	it('builds the nearest ones, one at a time', () => {
		const { b, open } = town();
		b.update(0.016, 0, 16, 0);
		expect(open()).toEqual(['osm:1000']); // the nearest first; the others wait their turn
		for (let i = 0; i < 4; i++) b.update(0.25, 0, 16, 0);
		expect(open()).toEqual(['osm:1000', 'osm:1001', 'osm:1002']);
		expect(b.list.every((l) => l.spec.doors.length === 1)).toBe(true);
	});

	it('follows the player down the street, keeping the ones just passed a little longer', () => {
		const { stay, open } = town();
		stay(0, 2);
		stay(60, 3); // houses 1003-1007 are now the nearest
		const now = open();
		expect(now).toEqual(expect.arrayContaining(['osm:1004', 'osm:1005', 'osm:1006']));
		expect(now).toContain('osm:1002'); // 36 m back: still open
		expect(now.length).toBeLessThanOrEqual(6);
		stay(130, 4);
		expect(open()).not.toContain('osm:1000'); // far behind: freed
		expect(open()).toEqual(expect.arrayContaining(['osm:1010', 'osm:1011']));
	});
});

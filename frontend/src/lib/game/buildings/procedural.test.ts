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
import { PARTITION, SURFACE, assembleInterior, buildInterior, buildInteriorData, interiorTransferables, planRooms } from './procedural';
import { Frame, roomAt, type BuildingSpec } from './spec';

const R = 0.35;
const rect = (cx: number, cz: number, w: number, d: number): XZ[] => [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]];

function planFor(w: number, d: number, h = 7): Plan {
	const r = planInterior({ ring: rect(0, 0, w, d), h }, { roads: [{ pts: [[-60, d / 2 + 6], [60, d / 2 + 6]], w: 8 }], neighbours: [] });
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
				// From just inside the door (or, upstairs, the head of the stairs), every seat's
				// stand-up spot can be walked to.
				for (const s of spec.seats) {
					const level = s.level ?? 0;
					const { walls, blockers } = level ? spec.levels![level - 1] : spec;
					const area = { bounds: [x0, x1, z0, z1] as [number, number, number, number], obstacles: [...walls, ...blockers], radius: R };
					const from: XZ = level ? stairHead(spec) : [plan.doorX, z1 - 0.5];
					expect(findPath(area, from, s.stand), `${type} ${s.id} from ${from} to ${s.stand} plan ${plan.width},${plan.depth},${plan.doorX}`).not.toBeNull();
				}
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
			// The wall's paint, give or take the plaster's mottling (the same tint in every channel).
			const k = col.getX(i) / wall.r;
			const isWall = k > 0.96 && k < 1.04 && Math.abs(col.getY(i) / wall.g - k) < 1e-4 && Math.abs(col.getZ(i) / wall.b - k) < 1e-4;
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
		expect(b.list.every((l) => l.spec.doors[0].id === 'front')).toBe(true);
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

describe('floor plans: rooms behind the entrance room, joined by doors', () => {
	const kinds = (p: ReturnType<typeof planRooms>) => p.rooms.map((r) => r.kind);
	it('a small home is one room; bigger ones have a bedroom, kitchen and bathroom behind', () => {
		expect(kinds(planRooms('house', 5, 6, 0))).toEqual(['living']);
		const wide = planRooms('house', 12.5, 8.5, 0);
		expect(kinds(wide)).toEqual(['living', 'bedroom', 'bathroom', 'kitchen']);
		expect(wide.doors.every((d) => d.front === 'living')).toBe(true); // each opens onto the living room
		// A narrow shophouse: one room behind the other, each through the one before.
		const narrow = planRooms('house', 4.5, 11.5, 0);
		expect(kinds(narrow)).toEqual(['living', 'bedroom', 'kitchen', 'bathroom']);
		expect(narrow.doors.map((d) => `${d.front}>${d.back}`)).toEqual(['living>bedroom', 'bedroom>kitchen', 'kitchen>bathroom']);
		expect(kinds(planRooms('house', 4.5, 9, 0))).toEqual(['living', 'kitchen', 'bathroom']);
	});

	it('a shop gets a storeroom and a café a kitchen once deep enough', () => {
		expect(kinds(planRooms('shop', 6, 10, 0))).toEqual(['sales', 'store']);
		expect(kinds(planRooms('shop', 6, 7, 0))).toEqual(['sales']);
		expect(kinds(planRooms('cafe', 8, 11, 0))).toEqual(['dining', 'galley']);
		expect(kinds(planRooms('cafe', 8, 8, 0))).toEqual(['dining']);
	});

	it('rooms tile the interior: inside it, apart by a partition, big enough, one light channel each', () => {
		for (const type of ['house', 'shop', 'cafe'] as const)
			for (const W of [3.2, 4.5, 6, 7.5, 9, 12])
				for (const D of [5, 7, 9.5, 12]) {
					const p = planRooms(type, W, D, W / 5);
					const at = `${type} ${W}x${D}`;
					expect(p.rooms.map((r) => r.channel), at).toEqual(p.rooms.map((_, i) => i));
					expect(p.rooms.length, at).toBeLessThanOrEqual(4);
					for (const r of p.rooms) {
						const [x0, x1, z0, z1] = r.rect;
						expect(x0 >= -W / 2 - 1e-9 && x1 <= W / 2 + 1e-9 && z0 >= -D / 2 - 1e-9 && z1 <= D / 2 + 1e-9, at).toBe(true);
						expect(Math.min(x1 - x0, z1 - z0), `${at} ${r.id}`).toBeGreaterThanOrEqual(1.6);
						for (const o of p.rooms)
							if (o !== r) {
								const [a0, a1, b0, b1] = o.rect;
								const gap = Math.max(a0 - x1, x0 - a1, b0 - z1, z0 - b1);
								expect(gap, `${at} ${r.id}/${o.id}`).toBeGreaterThanOrEqual(PARTITION - 1e-9);
							}
					}
					// Every room but the first is entered from a room nearer the entrance.
					const seen = new Set([p.rooms[0].id]);
					for (const d of p.doors) {
						expect(seen.has(d.front), at).toBe(true);
						seen.add(d.back);
					}
					expect(seen.size, at).toBe(p.rooms.length);
				}
	});

	it('every room can be walked into from the entrance, round the furniture', () => {
		for (const type of ['house', 'shop', 'cafe'] as const)
			for (const [w, d, h] of [[5, 9, 7], [8, 12, 7], [13, 9, 7], [4.5, 12.5, 7], [10, 12.5, 10], [5, 12.5, 10]]) {
				const plan = planFor(w, d, h);
				const { spec } = buildInterior(type, plan, 3, { value: 0 });
				const [x0, z0] = spec.interior.min;
				const [x1, z1] = spec.interior.max;
				for (const room of spec.rooms) {
					const level = room.level ?? 0;
					const { walls, blockers } = level ? spec.levels![level - 1] : spec;
					const area = { bounds: [x0, x1, z0, z1] as [number, number, number, number], obstacles: [...walls, ...blockers], radius: 0.38 };
					const from: XZ = level ? stairHead(spec) : [plan.doorX, z1 - 0.5];
					const [rx0, rx1, rz0, rz1] = room.rects[0];
					// The free spot nearest the middle of the room.
					const spots: XZ[] = [];
					for (let x = rx0 + 0.45; x <= rx1 - 0.45; x += 0.25) for (let z = rz0 + 0.45; z <= rz1 - 0.45; z += 0.25) spots.push([x, z]);
					spots.sort((a, b) => Math.hypot(a[0] - (rx0 + rx1) / 2, a[1] - (rz0 + rz1) / 2) - Math.hypot(b[0] - (rx0 + rx1) / 2, b[1] - (rz0 + rz1) / 2));
					const spot = spots.find((p) => blockers.every((ring) => !inRect(ring, p, 0.4)) && !(spec.stairs ?? []).some((st) => inRect(ringOf(st.rect), p, 0.4)));
					expect(spot, `${type} ${w}x${d} ${room.id}: some free floor`).toBeTruthy();
					expect(findPath(area, from, spot!), `${type} ${w}x${d} ${room.id}`).not.toBeNull();
				}
			}
	});

	it('a home: each room has its own lights, switched beside its door; inner doors hang in gaps', () => {
		const plan = planFor(13, 10);
		const { spec, root } = buildInterior('house', plan, 5, { value: 0 });
		expect(spec.rooms.length).toBeGreaterThan(2);
		expect(spec.lights.map((l) => l.channel)).toEqual(spec.rooms.map((r) => r.light));
		for (const l of spec.lights) {
			expect(l.switches).toHaveLength(1);
			const [sx, sz] = l.switches[0];
			expect(roomAt(spec, sx, sz, l.level ?? 0)?.id).toBe(l.id);
		}
		const inner = spec.doors.slice(1).filter((d) => d.kind !== 'window');
		expect(inner.length).toBe(spec.rooms.length - (spec.levels ? 2 : 1)); // one less than rooms, per storey
		for (const d of inner) {
			expect(root.getObjectByName(d.node)).toBeTruthy();
			const [cx, cz] = d.center;
			expect(spec.walls.some((ring) => inRect(ring, [cx, cz], 0))).toBe(false); // a gap in the partition
			expect(spec.lintels.some((l) => inRect(l.ring, [cx, cz], 0))).toBe(true); // a wall over it
		}
	});
});

/** Just past the top of a building's stairs (upstairs). */
function stairHead(spec: BuildingSpec): XZ {
	const { rect: [x0, x1, z0, z1], axis, dir } = spec.stairs![0];
	if (axis === 'x') return [dir > 0 ? x1 + 0.45 : x0 - 0.45, (z0 + z1) / 2];
	return [(x0 + x1) / 2, dir > 0 ? z1 + 0.45 : z0 - 0.45];
}

const ringOf = ([x0, x1, z0, z1]: [number, number, number, number]): XZ[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

/** Within `margin` of a rectangle given as a ring. */
function inRect(ring: XZ[], [x, z]: XZ, margin: number): boolean {
	const xs = ring.map((p) => p[0]),
		zs = ring.map((p) => p[1]);
	return x > Math.min(...xs) - margin && x < Math.max(...xs) + margin && z > Math.min(...zs) - margin && z < Math.max(...zs) + margin;
}

describe('a home with rooms, in the game', () => {
	// A 13 x 10 m building on a street: a living room with a bedroom, bathroom and kitchen behind.
	const ring = rect(0, 0, 13, 10);
	const payload = {
		key: '0_0',
		ix: 0,
		iz: 0,
		size: 500,
		roads: [{ id: 1, name: 'Street', name_en: null, name_km: null, cls: 'residential', w: 8, oneway: false, bridge: false, layer: 0, pts: [[-60, 11], [60, 11]] }],
		buildings: [{ id: 555, name: null, name_km: null, kind: 'house', h: 7, min_h: 0, hs: 'osm', colour: null, polys: [[ring]] }],
		areas: [],
		landmarks: [],
		features: []
	} as unknown as ChunkPayload;
	function home() {
		const collision = new CollisionWorld();
		collision.addRing('chunk', ring, 7);
		const host: BuildingHost = {
			scene: new THREE.Scene(),
			collision,
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
		const b = new Buildings(host, () => {}, [], undefined, { payloads: () => [payload], list: [{ id: 555, type: 'house' }] });
		b.update(0.016, 0, 20, 0);
		const l = b.list[0];
		/** Stand at a local point facing a local target; the prompt then. */
		const at = (p: XZ, target: XZ) => {
			const [x, z] = l.frame.toWorld(p);
			const [tx, tz] = l.frame.toWorld(target);
			b.update(0.016, x, z, Math.atan2(tx - x, tz - z));
			return b.interaction;
		};
		return { b, spec: l.spec, at };
	}

	it("offers only what is in the player's room: nothing through a partition", () => {
		const { spec, at } = home();
		const jar = spec.items.find((i) => i.id === 'kitchen-jar')!;
		expect(jar).toBeTruthy();
		const wall = spec.doors.find((d) => d.id === 'kitchen')!.center[1];
		// In the living room, right across the wall from the jar, facing it.
		const prompt = at([jar.x, wall + 0.5], [jar.x, jar.z]);
		expect(prompt?.kind === 'inspect' && prompt.item === 'kitchen-jar').toBe(false);
		// In the kitchen, in front of it: offered.
		expect(at([jar.x, jar.z - 0.1], [jar.x, jar.z - 0.8])?.kind).not.toBe('door');
	});

	it("a room's switch turns on that room's lamps only", () => {
		const { b, spec, at } = home();
		const bedroom = spec.lights.find((l) => l.id === 'bedroom')!;
		const [sx, sz] = bedroom.switches[0];
		const prompt = at([sx + 0.1, sz - 0.7], [sx, sz]);
		expect(prompt).toMatchObject({ kind: 'light', light: 'bedroom' });
		const before = b.list[0].lights;
		b.interact();
		const after = b.list[0].lights;
		expect(after.bedroom).toBe(!before.bedroom);
		for (const id of Object.keys(before)) if (id !== 'bedroom') expect(after[id]).toBe(before[id]);
	});
});

describe('stairs to an upper floor', () => {
	it('a building tall enough gets stairs and a furnished upper floor; a low one does not', () => {
		const low = buildInterior('house', planFor(10, 12.5, 6), 1, { value: 0 }).spec;
		expect(low.stairs).toBeUndefined();
		expect(low.levels).toBeUndefined();
		const { spec, root } = buildInterior('house', planFor(10, 12.5, 10), 1, { value: 0 });
		expect(spec.stairs).toHaveLength(1);
		expect(spec.levels).toHaveLength(1);
		const up = spec.rooms.filter((r) => r.level === 1);
		expect(up.map((r) => r.id)).toContain('up-family');
		expect(up.length).toBeGreaterThan(1);
		expect(spec.seats.some((s) => s.level === 1)).toBe(true);
		expect(root.getObjectByName('Interior_1')).toBeTruthy();
		// Every upstairs room has its own lights, switched inside it.
		for (const l of spec.lights.filter((x) => x.level === 1)) {
			expect(l.switches).toHaveLength(1);
			expect(roomAt(spec, l.switches[0][0], l.switches[0][1], 1)?.id).toBe(l.id);
		}
		// Channels are all different (eight at most).
		const channels = spec.lights.map((l) => l.channel);
		expect(new Set(channels).size).toBe(channels.length);
		expect(Math.max(...channels)).toBeLessThan(8);
	});

	it('the stairs are in the entrance room, clear of the furniture on both floors, with landings', () => {
		for (const type of ['house', 'shop', 'cafe'] as const)
			for (const [w, d] of [[5, 12.5], [8, 12.5], [12.5, 12.5], [6, 9]]) {
				const { spec } = buildInterior(type, planFor(w, d, 10), 2, { value: 0 });
				if (!spec.stairs) continue;
				const at = `${type} ${w}x${d}`;
				const { rect: [x0, x1, z0, z1], axis, dir } = spec.stairs[0];
				const [rx0, rx1, rz0, rz1] = spec.rooms[0].rects[0];
				expect(x0 >= rx0 - 1e-9 && x1 <= rx1 + 1e-9 && z0 >= rz0 - 1e-9 && z1 <= rz1 + 1e-9, at).toBe(true);
				// The foot (below) and the head (above) each have a landing kept clear.
				const lo: [number, number, number, number] = axis === 'x' ? [x0 - 0.8, x0, z0, z1] : [x0, x1, z0 - 0.8, z0];
				const hi: [number, number, number, number] = axis === 'x' ? [x1, x1 + 0.8, z0, z1] : [x0, x1, z1, z1 + 0.8];
				const [foot, head] = dir > 0 ? [lo, hi] : [hi, lo];
				const overlap = (ring: XZ[], r: [number, number, number, number]) => {
					const xs = ring.map((p) => p[0]),
						zs = ring.map((p) => p[1]);
					return Math.min(...xs) < r[1] - 1e-6 && Math.max(...xs) > r[0] + 1e-6 && Math.min(...zs) < r[3] - 1e-6 && Math.max(...zs) > r[2] + 1e-6;
				};
				for (const ring of spec.blockers) expect(overlap(ring, [x0, x1, z0, z1]) || overlap(ring, foot), at).toBe(false);
				for (const ring of spec.levels![0].blockers) expect(overlap(ring, [x0, x1, z0, z1]) || overlap(ring, head), at).toBe(false);
			}
	});
});

describe('a home with an upper floor, in the game', () => {
	// A 10 x 13 m, three-storey building on a street.
	const ring = rect(0, 0, 10, 13);
	const payload = {
		key: '0_0',
		ix: 0,
		iz: 0,
		size: 500,
		roads: [{ id: 1, name: 'Street', name_en: null, name_km: null, cls: 'residential', w: 8, oneway: false, bridge: false, layer: 0, pts: [[-60, 13], [60, 13]] }],
		buildings: [{ id: 556, name: null, name_km: null, kind: 'house', h: 10, min_h: 0, hs: 'osm', colour: null, polys: [[ring]] }],
		areas: [],
		landmarks: [],
		features: []
	} as unknown as ChunkPayload;

	it('walking up the stairs takes the player to the upper floor, and back down', () => {
		const collision = new CollisionWorld();
		collision.addRing('chunk', ring, 10);
		let ceiling = NaN;
		const host: BuildingHost = {
			scene: new THREE.Scene(),
			collision,
			terrain: FLAT,
			materials: { night: { value: 0 } },
			seated: false,
			setGround: () => {},
			setInterior: (v) => (ceiling = v?.ceiling ?? NaN),
			sit: () => true,
			stand: () => {},
			walkTo: (_p, done) => done?.(true),
			invalidateShadows: () => {}
		};
		const b = new Buildings(host, () => {}, [], undefined, { payloads: () => [payload], list: [{ id: 556, type: 'house' }] });
		b.update(0.016, 0, 20, 0);
		const { spec, frame } = b.list[0];
		expect(spec.stairs).toBeTruthy();
		const { rect: [x0, x1, z0, z1], axis, dir } = spec.stairs![0];
		const mid = axis === 'x' ? (z0 + z1) / 2 : (x0 + x1) / 2;
		const along = (a: number): XZ => (axis === 'x' ? [a, mid] : [mid, a]);
		const [lo, hi] = axis === 'x' ? [x0, x1] : [z0, z1];
		const foot = along(dir > 0 ? lo - 0.5 : hi + 0.5),
			head = along(dir > 0 ? hi + 0.5 : lo - 0.5);
		/** Walk in small steps like the player (collision, then the buildings' frame update). */
		const walk = (from: XZ, to: XZ) => {
			let [x, z] = frame.toWorld(from);
			const [tx, tz] = frame.toWorld(to);
			for (let i = 0; i < 600; i++) {
				const dx = tx - x,
					dz = tz - z,
					l = Math.hypot(dx, dz);
				if (l < 0.05) break;
				({ x, z } = moveCircle(host.collision, x, z, (dx / l) * Math.min(l, 0.05), (dz / l) * Math.min(l, 0.05), R));
				b.update(1 / 60, x, z, Math.atan2(dx, dz));
			}
			return [x, z] as XZ;
		};
		// Into the house and to the foot of the stairs.
		const [ex, ez] = spec.doors[0].center;
		b.interact; // (the door: open it as a player would)
		const at = frame.toWorld([ex, ez + 1.0]);
		b.update(0.016, at[0], at[1], Math.PI);
		const door = b.interaction;
		expect(door).toMatchObject({ kind: 'door' });
		b.interact();
		for (let t = 0; t < SWING_TIME + 0.2; t += 1 / 30) b.update(1 / 30, at[0], at[1], Math.PI);
		walk([ex, ez + 1.0], [ex, ez - 1.5]);
		walk([ex, ez - 1.5], foot);
		expect(b.storeyOn).toBe(0);
		const ground = b.floorAt(...frame.toWorld(foot))!;
		// Up: the floor rises with the steps; past half way the player is upstairs.
		const top = walk(foot, head);
		expect(b.storeyOn).toBe(1);
		const upper = ground + spec.levels![0].floor - spec.floor;
		expect(b.floorAt(...top)!).toBeCloseTo(upper, 3);
		expect(ceiling).toBeCloseTo(spec.levels![0].ceiling, 3);
		// Other players stand on their own storey (the server tells which), not on this one's.
		expect(b.floorAt(...frame.toWorld(foot), 0)!).toBeCloseTo(ground, 3);
		expect(b.floorAt(...top, 1)!).toBeCloseTo(upper, 3);
		const midway = frame.toWorld(along((lo + hi) / 2));
		expect(b.floorAt(...midway, 0)!).toBeCloseTo((ground + upper) / 2, 1); // on the stairs: their slope
		// Upstairs, the family room's switch is offered by the head of the stairs, not a ground
		// floor one.
		const sw = spec.lights.find((l) => l.id === 'up-family')!.switches[0];
		const near = frame.toWorld([head[0] + (sw[0] - head[0]) * 0.5, head[1] + (sw[1] - head[1]) * 0.5]);
		const [swx, swz] = frame.toWorld([sw[0], sw[1]]);
		b.update(0.016, near[0], near[1], Math.atan2(swx - near[0], swz - near[1]));
		expect(b.interaction).toMatchObject({ kind: 'light', light: 'up-family' });
		// Back down.
		walk(head, foot);
		expect(b.storeyOn).toBe(0);
		expect(b.floorAt(...frame.toWorld(foot))!).toBeCloseTo(ground, 3);
		// From downstairs, someone upstairs is still drawn upstairs; outside, on the street.
		expect(b.floorAt(...top, 1)!).toBeCloseTo(upper, 3);
		expect(b.floorAt(...frame.toWorld([ex, ez + 30]), 0)).toBeNull();
	});
});

describe('windows: open them and climb through', () => {
	it('ground-floor windows where the street front is straight, each with a clear spot inside', () => {
		const plan = planFor(10, 9, 7);
		const { spec, root } = buildInterior('house', plan, 4, { value: 0 });
		const windows = spec.doors.filter((d) => d.kind === 'window');
		expect(windows).toHaveLength(2);
		const front = spec.interior.max[1];
		for (const wn of windows) {
			expect(root.getObjectByName(wn.node)).toBeTruthy();
			expect(wn.sill).toBeGreaterThan(0.5);
			expect(wn.level).toBe(0);
			// Where one lands climbing in: free of furniture.
			const landing: XZ = [wn.center[0], front - 0.75];
			expect(spec.blockers.every((ring) => !inRect(ring, landing, 0.35))).toBe(true);
		}
		// A front that is not straight away from the door: no windows to open there.
		const crooked = buildInterior('house', { ...plan, front: [plan.doorX - 0.6, plan.doorX + 0.6] }, 4, { value: 0 }).spec;
		expect(crooked.doors.filter((d) => d.kind === 'window')).toHaveLength(0);
	});
});

describe('climbing in through a window, in the game', () => {
	const ring = rect(0, 0, 10, 9);
	const payload = {
		key: '0_0',
		ix: 0,
		iz: 0,
		size: 500,
		roads: [{ id: 1, name: 'Street', name_en: null, name_km: null, cls: 'residential', w: 8, oneway: false, bridge: false, layer: 0, pts: [[-60, 11], [60, 11]] }],
		buildings: [{ id: 557, name: null, name_km: null, kind: 'house', h: 6, min_h: 0, hs: 'osm', colour: null, polys: [[ring]] }],
		areas: [],
		landmarks: [],
		features: []
	} as unknown as ChunkPayload;

	it('opens a window from the street, climbs in (Space), and climbs back out', () => {
		const climbs: { points: [number, number][]; lift: number }[] = [];
		let jump: (() => boolean) | null = null;
		const doorSets = new Map<string, Doorway[]>();
		const host: BuildingHost = {
			scene: new THREE.Scene(),
			collision: new CollisionWorld(),
			terrain: FLAT,
			materials: { night: { value: 0 }, setDoorSet: (o, d) => doorSets.set(o, d) },
			seated: false,
			setGround: () => {},
			setInterior: () => {},
			sit: () => true,
			stand: () => {},
			walkTo: (_p, done) => done?.(true),
			invalidateShadows: () => {},
			climb: (points, lift) => (climbs.push({ points, lift }), true),
			setJumpOverride: (fn) => (jump = fn)
		};
		const b = new Buildings(host, () => {}, [], undefined, { payloads: () => [payload], list: [{ id: 557, type: 'house' }] });
		b.update(0.016, 0, 20, 0);
		const { spec, frame } = b.list[0];
		const wn = spec.doors.find((d) => d.kind === 'window')!;
		const [cx, cz] = wn.center;
		const front = spec.interior.max[1];
		/** Stand at a local point facing the window; the prompt then. */
		const at = (lx: number, lz: number) => {
			const [x, z] = frame.toWorld([lx, lz]);
			const [tx, tz] = frame.toWorld([cx, cz]);
			b.update(1 / 30, x, z, Math.atan2(tx - x, tz - z));
			return b.interaction;
		};
		// From the street: the window's cut-out is in the facade, and E opens it.
		expect(at(cx, cz + 1.0)).toMatchObject({ kind: 'door', door: wn.id, label: 'Open Window' });
		expect(doorSets.get('buildings')!.some((d) => d.window)).toBe(true);
		expect(jump!()).toBe(false); // shut: a jump is a jump
		b.interact();
		for (let t = 0; t < SWING_TIME + 0.2; t += 1 / 30) at(cx, cz + 1.0);
		expect(b.interaction).toMatchObject({ kind: 'door', label: 'Close Window', hint: 'Space to climb through' });
		// Space: over the sill to a free spot inside.
		expect(jump!()).toBe(true);
		const [mid, inside] = climbs[0].points.map((p) => frame.toLocal(p[0], p[1]));
		expect(mid[0]).toBeCloseTo(cx);
		expect(inside[1]).toBeLessThan(front);
		expect(climbs[0].lift).toBeGreaterThan(wn.sill!);
		// And from inside, back out to the street (where the casement swings it cannot be closed:
		// climbing is what E offers).
		expect(at(inside[0], inside[1])).toMatchObject({ kind: 'climb', label: 'Climb Through Window' });
		expect(jump!()).toBe(true);
		const outside = frame.toLocal(...climbs[1].points[1]);
		expect(outside[1]).toBeGreaterThan(cz);
		// Facing away from it, no climb.
		const [x, z] = frame.toWorld([cx, cz + 1.0]);
		b.update(1 / 30, x, z, Math.atan2(0, 1) + frame.yaw);
		expect(jump!()).toBe(false);
	});
});

describe('materials', () => {
	/** How many vertices of each surface kind an interior has (and which tile sizes). */
	const surfaces = (type: 'house' | 'shop' | 'cafe', w: number, d: number, h = 7) => {
		const { root } = buildInterior(type, planFor(w, d, h), 9, { value: 0 });
		const counts = new Map<number, number>();
		root.traverse((o) => {
			const g = (o as THREE.Mesh).geometry;
			const a = g?.getAttribute('surface');
			if (!a) return;
			for (let i = 0; i < a.count; i++) counts.set(a.getX(i), (counts.get(a.getX(i)) ?? 0) + 1);
		});
		return counts;
	};
	it('every surface says what it is made of: wood, fabric, metal, ceramic, tiles, glass…', () => {
		const home = surfaces('house', 13, 10);
		for (const kind of ['paint', 'wood', 'fabric', 'metal', 'ceramic', 'glass'] as const) expect(home.get(SURFACE[kind]) ?? 0, kind).toBeGreaterThan(0);
		expect([...home.keys()].some((k) => k >= 10)).toBe(true); // tiled floors and walls
		const shop = surfaces('shop', 8, 12);
		expect(shop.get(SURFACE.card) ?? 0).toBeGreaterThan(0); // the goods on the shelves
		expect(shop.get(SURFACE.concrete) ?? 0).toBeGreaterThan(0); // the storeroom floor
		const cafe = surfaces('cafe', 9, 11);
		expect(cafe.get(SURFACE.wood) ?? 0).toBeGreaterThan(cafe.get(SURFACE.paint) ?? 0); // a plank floor
	});

	it('tiles are laid on a fixed grid, so the grout lines fall between them', () => {
		const { root } = buildInterior('house', planFor(13, 10), 9, { value: 0 });
		const g = (root.getObjectByName('Interior') as THREE.Mesh).geometry;
		const pos = g.getAttribute('position'),
			nor = g.getAttribute('normal'),
			surf = g.getAttribute('surface');
		let checked = 0;
		for (let i = 0; i < pos.count; i++) {
			const kind = surf.getX(i);
			if (kind < 10 || Math.abs(pos.getY(i)) > 1e-6 || nor.getY(i) < 0.9) continue;
			const size = (kind - 10) / 10;
			// A floor tile corner: on the grid, or where the floor ends (a wall, a doorway).
			for (const v of [pos.getX(i), pos.getZ(i)]) {
				const off = Math.abs(v / size - Math.round(v / size));
				const edge = spec0.some((e) => Math.abs(e - v) < 1e-6);
				expect(off < 1e-6 || edge).toBe(true);
			}
			checked++;
		}
		expect(checked).toBeGreaterThan(100);
	});
	const spec0: number[] = (() => {
		const { spec } = buildInterior('house', planFor(13, 10), 9, { value: 0 });
		return spec.rooms.flatMap((r) => r.rects[0]);
	})();
});

describe('built in a worker, put together here', () => {
	it('the data round trip gives the same interior (spec, nodes, vertices)', () => {
		const plan = planFor(10, 12.5, 10);
		const direct = buildInterior('house', plan, 21, { value: 0 }, 'Home');
		const data = buildInteriorData('house', plan, 21, 'Home');
		// What a worker would post: plain data and the arrays to transfer.
		expect(interiorTransferables(data).length).toBeGreaterThan(0);
		const made = assembleInterior(structuredClone(data), 'house', plan, { value: 0 }, 'Home');
		expect(made.spec).toEqual(direct.spec);
		const shape = (root: THREE.Object3D) => {
			const out: string[] = [];
			root.traverse((o) => {
				const g = (o as THREE.Mesh).geometry;
				out.push(`${o.name}:${g ? g.getAttribute('position').count : '-'}:${o.position.toArray().map((v) => v.toFixed(3))}`);
			});
			return out;
		};
		expect(shape(made.root)).toEqual(shape(direct.root));
		expect(made.root.getObjectByName('Interior_1')).toBeTruthy();
	});
});

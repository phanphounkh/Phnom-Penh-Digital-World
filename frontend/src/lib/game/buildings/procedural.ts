/**
 * Interiors generated for OpenStreetMap buildings: a café, a shop (mini-mart) or a home, laid
 * out to fit the plan from footprint.ts. Built in the building's local frame (+Z out of the
 * entrance, origin at the interior's centre, floor at y = 0).
 *
 * A floor plan first (`planRooms`): the room by the entrance (living room, sales floor, café)
 * and, when the building is big enough, rooms behind it (bedroom, kitchen, bathroom;
 * storeroom; café kitchen) behind partition walls with inner doors. Then each room's shell
 * (floor, walls with doorways, wainscot, ceiling) and furniture from shared templates, set
 * against its walls and kept clear of its doorways. Everything static is merged into one mesh
 * (one draw call); door leaves and a few toggled parts (steam, flames, a shower) are separate.
 *
 * Lighting is computed per vertex at build time: daylight from the street front (the back
 * rooms only get a little), warm light from each lamp of the same room, soft occlusion in
 * corners, along wall bases and under furniture. Each vertex carries its room's light channel,
 * so every room's lamps switch on and off on their own. No textures, no runtime lights.
 */
import * as THREE from 'three';
import type { Plan } from './footprint';
import type { InteriorType } from './osm';
import type { BuildingSpec, DoorSpec, ItemSpec, SeatSpec, ServiceSpec, TableSpec, ToggleSpec, XZ } from './spec';

type V3 = [number, number, number];
type Glow = [number, number] | null;
/** [x0, x1, z0, z1] in the building's local frame. */
export type Rect = [number, number, number, number];

const DOOR_H = 2.2;
/** Doors between rooms (m). */
export const INNER_DOOR = { width: 1.0, height: 2.05 };
/** Thickness of the partition walls between rooms (m). */
export const PARTITION = 0.12;
const DAY = { base: 0.34, front: 0.62, reach: 3.2, back: 0.29 };
export const PROCEDURAL_GAIN = 1.25;
/** The interior's floor sits this far above the street (m): clear of the city's ground and the
 * plazas and car parks drawn on it (up to 2.6 cm), which would otherwise show through it. */
export const FLOOR_LIFT = 0.05;

/** A seeded random number generator (the same building always looks the same). */
function rng(seed: number) {
	let s = (seed >>> 0) || 1;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

const hex = (h: string): V3 => {
	const c = new THREE.Color(h);
	return [c.r, c.g, c.b];
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const overlaps = (a: Rect, b: Rect) => a[0] < b[1] && b[0] < a[1] && a[2] < b[3] && b[2] < a[3];

/** What a surface is made of: the interior shader draws its detail (grain, weave, grout…). */
export const SURFACE = { paint: 0, wood: 1, fabric: 2, metal: 3, ceramic: 4, concrete: 5, card: 6, glass: 7 } as const;
export type Surface = keyof typeof SURFACE;
/** Square tiles of `size` metres (grout lines): surface ids 10 and up. */
const tiles = (size: number) => 10 + Math.round(size * 10);

/** A smooth ±2.5% variation over a metre or so: hand-applied paint on plaster. */
function mottle([x, y, z]: V3): number {
	const h = (a: number, b: number) => {
		const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
		return v - Math.floor(v);
	};
	const n = (a: number, b: number) => {
		const i = Math.floor(a),
			j = Math.floor(b),
			fa = a - i,
			fb = b - j;
		const u = fa * fa * (3 - 2 * fa),
			v = fb * fb * (3 - 2 * fb);
		return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
	};
	return 0.975 + 0.05 * n(x * 1.3 + z * 0.7, y * 1.6 + z * 1.1);
}

/** Accumulates coloured triangles; `at` places a piece (x, z, yaw) in the building, `as` sets
 * what the next ones are made of. */
class MeshBuilder {
	pos: number[] = [];
	nor: number[] = [];
	col: number[] = [];
	surf: number[] = [];
	private surface = 0;
	glow: (Glow | undefined)[] = [];
	kind: ('floor' | 'wall' | 'piece' | 'ceiling')[] = [];
	idx: number[] = [];
	private t = { x: 0, z: 0, c: 1, s: 0 };

	at(x: number, z: number, yaw = 0): this {
		this.t = { x, z, c: Math.cos(yaw), s: Math.sin(yaw) };
		return this;
	}

	/** The material of what is drawn next (a surface kind, or a tile id from `tiles`). */
	as(surface: Surface | number): this {
		this.surface = typeof surface === 'number' ? surface : SURFACE[surface];
		return this;
	}

	private p([x, y, z]: V3): V3 {
		const { c, s } = this.t;
		return [this.t.x + x * c + z * s, y, this.t.z - x * s + z * c];
	}

	private n([x, y, z]: V3): V3 {
		const { c, s } = this.t;
		return [x * c + z * s, y, -x * s + z * c];
	}

	/** A quad p0..p3 (counter-clockwise seen from its front), subdivided nu × nv. */
	quad(p0: V3, p1: V3, p2: V3, p3: V3, color: V3, kind: MeshBuilder['kind'][number] = 'piece', glow: Glow = null, nu = 1, nv = 1): void {
		const e1: V3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
		const e2: V3 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
		let n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
		const l = Math.hypot(...n) || 1;
		n = this.n([n[0] / l, n[1] / l, n[2] / l]);
		const base = this.pos.length / 3;
		for (let j = 0; j <= nv; j++)
			for (let i = 0; i <= nu; i++) {
				const u = i / nu,
					v = j / nv;
				const q: V3 = [0, 1, 2].map((k) => p0[k] * (1 - u) * (1 - v) + p1[k] * u * (1 - v) + p2[k] * u * v + p3[k] * (1 - u) * v) as V3;
				const at = this.p(q);
				this.pos.push(...at);
				this.nor.push(...n);
				// Painted plaster: soft mottling, baked in (nothing to compute when drawing).
				const k = this.surface === 0 && kind !== 'piece' ? mottle(at) : 1;
				this.col.push(color[0] * k, color[1] * k, color[2] * k);
				this.surf.push(this.surface);
				this.glow.push(glow);
				this.kind.push(kind);
			}
		for (let j = 0; j < nv; j++)
			for (let i = 0; i < nu; i++) {
				const a = base + j * (nu + 1) + i;
				this.idx.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1);
			}
	}

	box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: V3, glow: Glow = null, bottom = false): void {
		const q = (a: V3, b: V3, c: V3, d: V3, shade = 1) => this.quad(a, b, c, d, [color[0] * shade, color[1] * shade, color[2] * shade], 'piece', glow);
		q([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]); // top
		q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // front (+z)
		q([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // back
		q([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // right
		q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // left
		if (bottom) q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
	}

	cylinder(x: number, z: number, y0: number, y1: number, r: number, color: V3, segments = 10, glow: Glow = null, r2 = r): void {
		for (let k = 0; k < segments; k++) {
			const a0 = (k / segments) * Math.PI * 2,
				a1 = ((k + 1) / segments) * Math.PI * 2;
			const p = (a: number, y: number, rr: number): V3 => [x + Math.cos(a) * rr, y, z + Math.sin(a) * rr];
			this.quad(p(a1, y0, r), p(a0, y0, r), p(a0, y1, r2), p(a1, y1, r2), color, 'piece', glow);
			this.quad(p(a0, y1, r2), [x, y1, z], [x, y1, z], p(a1, y1, r2), color, 'piece', glow);
		}
	}

	/** A straight bar from p0 to p1 (a handrail on a slope): `w` wide, `h` high, square ends. */
	beam(p0: V3, p1: V3, w: number, h: number, color: V3): void {
		const [dx, , dz] = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
		const l = Math.hypot(dx, dz) || 1;
		const side: V3 = [(-dz / l) * (w / 2), 0, (dx / l) * (w / 2)];
		const at = (p: V3, s: number, u: number): V3 => [p[0] + side[0] * s, p[1] + (u * h) / 2, p[2] + side[2] * s];
		/** A face, wound to face `out`. */
		const face = (a: V3, b: V3, c: V3, d: V3, out: V3) => {
			const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
				e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
			const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
			if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] >= 0) this.quad(a, b, c, d, color);
			else this.quad(a, d, c, b, color);
		};
		const up: V3 = [0, 1, 0],
			down: V3 = [0, -1, 0],
			right = side,
			left: V3 = [-side[0], 0, -side[2]];
		face(at(p0, -1, 1), at(p0, 1, 1), at(p1, 1, 1), at(p1, -1, 1), up);
		face(at(p0, -1, -1), at(p1, -1, -1), at(p1, 1, -1), at(p0, 1, -1), down);
		face(at(p0, 1, -1), at(p1, 1, -1), at(p1, 1, 1), at(p0, 1, 1), right);
		face(at(p0, -1, -1), at(p0, -1, 1), at(p1, -1, 1), at(p1, -1, -1), left);
	}

	geometry({ light, channel }: { light: Float32Array; channel: Float32Array }): THREE.BufferGeometry {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
		g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
		g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
		g.setAttribute('light', new THREE.BufferAttribute(light, 2));
		g.setAttribute('channel', new THREE.BufferAttribute(channel, 1));
		g.setAttribute('surface', new THREE.Float32BufferAttribute(this.surf, 1));
		g.setIndex(this.idx);
		g.computeBoundingSphere();
		return g;
	}
}

// ── Floor plans ─────────────────────────────────────────────────────────────────────────────

export type RoomKind = 'living' | 'bedroom' | 'kitchen' | 'bathroom' | 'sales' | 'store' | 'dining' | 'galley' | 'family' | 'hall' | 'records';

export interface RoomPlan {
	id: string;
	kind: RoomKind;
	name: string;
	rect: Rect;
	/** Its lights' channel (0–7: the interior shader switches eight groups, four per storey). */
	channel: number;
}

/** A door in a partition running along x at z: its centre x; the room in front of it (towards
 * the entrance) and the one behind, which it swings into. */
export interface InnerDoor {
	id: string;
	label: string;
	x: number;
	z: number;
	front: string;
	back: string;
}

/** A partition wall's centre line: along x at z = `at` (axis 'x') or along z at x = `at`. */
export interface Partition {
	axis: 'x' | 'z';
	at: number;
	from: number;
	to: number;
}

export interface FloorPlan {
	rooms: RoomPlan[];
	partitions: Partition[];
	doors: InnerDoor[];
}

const ROOM_NAMES: Record<RoomKind, string> = {
	living: 'Living Room',
	bedroom: 'Bedroom',
	kitchen: 'Kitchen',
	bathroom: 'Bathroom',
	sales: 'Shop',
	store: 'Storeroom',
	dining: 'Café',
	galley: 'Kitchen',
	family: 'Family Room',
	hall: 'Service Hall',
	records: 'Records Room'
};

/**
 * The rooms of a W × D interior (centred on 0, the entrance on the z = D/2 side, the door at
 * x = `doorX`). Homes: a living room at the front; behind it a bedroom, kitchen and (if wide or
 * deep enough) a bathroom, side by side in a wide house or one behind the other in a narrow
 * shophouse. Shops get a storeroom and cafés a kitchen at the back once deep enough. Every room
 * is reachable through doors from the entrance room.
 */
export function planRooms(type: InteriorType, W: number, D: number, doorX: number, upper = false): FloorPlan {
	const T = PARTITION;
	const [x0, x1, z0, z1] = [-W / 2, W / 2, -D / 2, D / 2];
	const rooms: RoomPlan[] = [];
	const partitions: Partition[] = [];
	const doors: InnerDoor[] = [];
	const room = (kind: RoomKind, rect: Rect) => {
		rooms.push({ id: kind, kind, name: ROOM_NAMES[kind], rect, channel: rooms.length });
		return kind;
	};
	/** A door's centre between xa and xb, at least a jamb's width from the walls. */
	const at = (xa: number, xb: number, prefer: number) => clamp(prefer, xa + INNER_DOOR.width / 2 + 0.3, xb - INNER_DOOR.width / 2 - 0.3);
	const door = (back: string, front: string, x: number, z: number) => doors.push({ id: back, label: `${ROOM_NAMES[back as RoomKind]} Door`, x, z, front, back });

	if (type === 'house') {
		if (D < 6.5 || W * D < 32) {
			room('living', [x0, x1, z0, z1]);
			return { rooms, partitions, doors };
		}
		// The living room takes the front half (a narrow shophouse's a little less: its other
		// rooms are one behind the other).
		// With an upper floor, a shophouse's bedrooms are upstairs and its living room is deep
		// enough for the stairs.
		const zc = z1 - (W >= 7.2 ? clamp(D * 0.5, upper ? 4.9 : 3.6, 6) : upper ? clamp(D * 0.45, 5.0, 5.4) : clamp(D * 0.35, 3.6, 5));
		room('living', [x0, x1, zc + T / 2, z1]);
		partitions.push({ axis: 'x', at: zc, from: x0, to: x1 });
		const back = zc - T / 2;
		if (W >= 7.2) {
			// Wide: the back rooms side by side, each opening onto the living room.
			const parts: [RoomKind, number][] = W >= 9.6 ? [['bedroom', clamp(W * 0.42, 3, 4.5)], ['bathroom', 2.2], ['kitchen', 0]] : [['bedroom', (W - T) / 2], ['kitchen', 0]];
			let xa = x0;
			parts.forEach(([kind, width], i) => {
				const last = i === parts.length - 1;
				const xb = last ? x1 : xa + width;
				room(kind, [xa, xb, z0, back]);
				// The doors towards the middle of the house (the living room's side walls stay free).
				door(kind, 'living', at(xa, xb, 0), zc);
				if (!last) partitions.push({ axis: 'z', at: xb + T / 2, from: z0, to: back });
				xa = xb + T;
			});
		} else {
			// Narrow (a shophouse): one room behind the other, doors on alternate sides.
			const B = back - z0;
			const seq: [RoomKind, number][] = B >= 7.3 && !upper ? [['bedroom', 2.9], ['kitchen', 0], ['bathroom', 1.7]] : B >= 4.5 ? [['kitchen', 0], ['bathroom', 1.7]] : [['kitchen', 0]];
			const rest = B - seq.reduce((s, [, depth]) => s + depth, 0) - T * (seq.length - 1);
			let top = back,
				line = zc,
				from = 'living',
				side = doorX > 0 ? -1 : 1;
			seq.forEach(([kind, depth], i) => {
				const bottom = i === seq.length - 1 ? z0 : top - (depth || rest);
				room(kind, [x0, x1, bottom, top]);
				door(kind, from, at(x0, x1, side * W), line);
				side = -side;
				from = kind;
				line = bottom - T / 2;
				if (i < seq.length - 1) partitions.push({ axis: 'x', at: line, from: x0, to: x1 });
				top = bottom - T;
			});
		}
		return { rooms, partitions, doors };
	}
	// A shop's storeroom (door on the counter's side), a café's kitchen (door on the left, the
	// counter takes the right) or an office's records room (door on the left, the service
	// counter is in the middle).
	const [front, behind, deepEnough, depth, doorAt] =
		type === 'shop'
			? (['sales', 'store', D >= 8 && W >= 3.4, clamp(D * 0.3, 2.2, 3.4), (doorX > 0 ? -1 : 1) * W] as const)
			: type === 'office'
				? (['hall', 'records', D >= 8 && W >= 4.4, clamp(D * 0.26, 2.4, 3.2), -W] as const)
				: (['dining', 'galley', D >= 9 && W >= 4.4, clamp(D * 0.28, 2.4, 3.4), -W] as const);
	if (!deepEnough) {
		room(front, [x0, x1, z0, z1]);
		return { rooms, partitions, doors };
	}
	const zc = z0 + depth + T / 2;
	room(front, [x0, x1, zc + T / 2, z1]);
	room(behind, [x0, x1, z0, zc - T / 2]);
	partitions.push({ axis: 'x', at: zc, from: x0, to: x1 });
	door(behind, front, at(x0, x1, doorAt), zc);
	return { rooms, partitions, doors };
}

/** The room a point is in (or, in a doorway, the nearest). */
export function roomOf(rooms: RoomPlan[], x: number, z: number): RoomPlan {
	let best = rooms[0],
		bestD = Infinity;
	for (const r of rooms) {
		const [x0, x1, z0, z1] = r.rect;
		const d = Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1));
		if (d < bestD) {
			best = r;
			bestD = d;
		}
	}
	return best;
}

// ── Lighting ────────────────────────────────────────────────────────────────────────────────

interface Lamp {
	x: number;
	y: number;
	z: number;
	power: number;
	channel: number;
}

interface LightContext {
	rooms: RoomPlan[];
	entrance: string;
	/** The interior's depth: daylight comes in at z = D/2. */
	D: number;
	ceiling: number;
	lamps: Lamp[];
	blockers: Rect[];
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Daylight, lamplight of the vertex's own room, and occlusion, per vertex; and its room's
 * light channel. */
function lightUp(b: MeshBuilder, ctx: LightContext): { light: Float32Array; channel: Float32Array } {
	const n = b.pos.length / 3;
	const light = new Float32Array(n * 2);
	const channel = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const x = b.pos[i * 3],
			y = b.pos[i * 3 + 1],
			z = b.pos[i * 3 + 2];
		const nx = b.nor[i * 3],
			ny = b.nor[i * 3 + 1],
			nz = b.nor[i * 3 + 2];
		// The room the surface faces into.
		const room = roomOf(ctx.rooms, x + nx * 0.04, z + nz * 0.04);
		channel[i] = room.channel;
		const g = b.glow[i];
		if (g) {
			light[i * 2] = g[0];
			light[i * 2 + 1] = g[1];
			continue;
		}
		const [rx0, rx1, rz0, rz1] = room.rect;
		let day = room.id === ctx.entrance ? DAY.base + DAY.front * Math.exp(-(ctx.D / 2 - z) / DAY.reach) * (0.75 + 0.25 * Math.max(nz, 0)) : DAY.back;
		if (ny < -0.5) day *= 0.6;
		let lamp = 0;
		for (const L of ctx.lamps) {
			if (L.channel !== room.channel) continue;
			const dx = L.x - x,
				dy = L.y - y,
				dz = L.z - z;
			const dist = Math.hypot(dx, dy, dz) || 1;
			const facing = Math.max(0.2, (dx * nx + dy * ny + dz * nz) / dist);
			lamp += (L.power * facing) / (1 + (dist / 1.7) ** 2);
		}
		let ao = 1;
		const toWall = Math.max(0, Math.min(x - rx0, rx1 - x, z - rz0, rz1 - z));
		const kind = b.kind[i];
		if (kind === 'floor') {
			ao = 0.62 + 0.38 * smooth(Math.min(1, toWall / 0.7));
			for (const [x0, x1, z0, z1] of ctx.blockers) {
				const out = Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1));
				if (out < 0.35) ao *= 0.62 + 0.38 * smooth(out / 0.35);
			}
		} else if (kind === 'wall') {
			// Darker at the foot of the wall, in the corners and just under the ceiling.
			const corner = Math.max(0, Math.abs(nz) > 0.5 ? Math.min(x - rx0, rx1 - x) : Math.min(z - rz0, rz1 - z));
			ao = (0.7 + 0.3 * smooth(Math.min(1, y / 0.6))) * (0.8 + 0.2 * smooth(Math.min(1, corner / 0.5))) * (0.9 + 0.1 * smooth(Math.min(1, Math.max(0, ctx.ceiling - y) / 0.4)));
		} else if (kind === 'ceiling') ao = 0.85 + 0.15 * smooth(Math.min(1, toWall / 0.6));
		else ao = 0.8 + 0.2 * smooth(Math.min(1, Math.max(0, y) / 0.45));
		light[i * 2] = day * ao;
		light[i * 2 + 1] = Math.min(2.2, lamp) * ao;
	}
	return { light, channel };
}

/** Surface detail by material, in the fragment shader from the surface's position (no
 * textures, no UVs), kept cheap for integrated GPUs: wood grain, fabric weave, brushed metal and
 * tile grout from a few sines and a fract; concrete with one noise lookup; glazed ceramic from
 * the normal. (Painted plaster's mottling is baked into the vertex colours instead, free to draw.)
 * It fades out where it would shimmer, and with the detail switch (off in Performance mode). */
const SURFACE_GLSL = /* glsl */ `
float ppwH(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
float ppwN(vec2 p) {
	vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
	return mix(mix(ppwH(i), ppwH(i + vec2(1.0, 0.0)), u.x), mix(ppwH(i + vec2(0.0, 1.0)), ppwH(i + vec2(1.0, 1.0)), u.x), u.y);
}
float ppwSurface(float kind, vec2 uv, vec3 n, float px) {
	// px: metres per pixel here; detail smaller than ~2 pixels fades out.
	if (kind > 9.5) {
		// Tiles of (kind - 10) / 10 m: grout lines.
		float size = (kind - 10.0) * 0.1;
		vec2 g = abs(fract(uv / size) - 0.5) * 2.0;
		float grout = smoothstep(1.0 - 0.014 / size, 1.0, max(g.x, g.y)) * (1.0 - smoothstep(0.004, 0.012, px));
		return 1.0 - 0.32 * grout;
	}
	if (kind < 0.5) return 1.0;
	if (kind < 1.5) {
		// Wood: wavering grain along the surface's first axis.
		float grain = 0.5 + 0.5 * sin(uv.y * 230.0 + 5.0 * sin(uv.x * 2.1 + uv.y * 7.0) + 2.0 * sin(uv.x * 9.0));
		return 0.9 + 0.16 * mix(0.5, grain * grain, 1.0 - smoothstep(0.006, 0.02, px));
	}
	if (kind < 2.5) return 1.0 + 0.05 * sin(uv.x * 760.0) * sin(uv.y * 760.0) * (1.0 - smoothstep(0.003, 0.008, px));
	if (kind < 3.5) return 0.97 + 0.05 * sin(uv.y * 520.0 + 3.0 * sin(uv.x * 4.0)) * (1.0 - smoothstep(0.004, 0.01, px));
	if (kind < 4.5) return 1.0 + 0.06 * max(n.y, 0.0);
	if (kind < 5.5) return 0.92 + 0.12 * ppwN(uv * 6.0);
	if (kind < 6.5) return 0.95 + 0.05 * sin(uv.y * 160.0 + 2.0 * sin(uv.x * 7.0));
	return 1.0;
}
`;

/** The interior material: vertex colour × surface detail × (daylight × day factor + lamplight ×
 * its room's lights level). */
function interiorMaterial(uniforms: Record<string, { value: unknown }>): THREE.MeshBasicMaterial {
	const m = new THREE.MeshBasicMaterial({ vertexColors: true });
	m.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, uniforms);
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nattribute vec2 light;\nattribute float channel;\nattribute float surface;\nvarying vec2 vPpwLight;\nflat varying float vPpwChannel;\nflat varying float vPpwSurface;\nvarying vec3 vPpwPos;\nvarying vec3 vPpwNor;')
			.replace('#include <begin_vertex>', '#include <begin_vertex>\nvPpwLight = light;\nvPpwChannel = channel;\nvPpwSurface = surface;\nvPpwPos = position;\nvPpwNor = normal;');
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', '#include <common>\nvarying vec2 vPpwLight;\nflat varying float vPpwChannel;\nflat varying float vPpwSurface;\nvarying vec3 vPpwPos;\nvarying vec3 vPpwNor;\nuniform vec4 uLampsOn;\nuniform vec4 uLampsOn2;\nuniform float uNight;\nuniform float uGain;\nuniform float uDetail;\nuniform vec3 uLampColor;\n' + SURFACE_GLSL)
			.replace(
				'#include <color_fragment>',
				`#include <color_fragment>
if (uDetail > 0.5 && vPpwSurface > 0.5) {
	vec3 ppwN3 = normalize(vPpwNor);
	vec2 ppwUv = abs(ppwN3.y) > 0.6 ? vPpwPos.xz : abs(ppwN3.x) > 0.6 ? vPpwPos.zy : vPpwPos.xy;
	diffuseColor.rgb *= ppwSurface(vPpwSurface, ppwUv, ppwN3, length(fwidth(ppwUv)));
}
vec4 ppwSet = vPpwChannel < 3.5 ? uLampsOn : uLampsOn2;
float ppwCh = mod(vPpwChannel, 4.0);
float ppwOn = ppwCh < 0.5 ? ppwSet.x : ppwCh < 1.5 ? ppwSet.y : ppwCh < 2.5 ? ppwSet.z : ppwSet.w;
diffuseColor.rgb *= ( vPpwLight.x * ( 1.0 - 0.9 * uNight ) + vPpwLight.y * ppwOn * uLampColor ) * uGain;`
			);
	};
	m.customProgramCacheKey = () => 'ppw-procedural-interior-materials';
	return m;
}

export interface ProceduralBuilding {
	spec: BuildingSpec;
	root: THREE.Group;
	/** Lights levels of channels 0–3 and 4–7 (set by Buildings). */
	uniforms: { uLampsOn: { value: THREE.Vector4 }; uLampsOn2: { value: THREE.Vector4 } };
}

/** Surfaces per kind of room: walls, a wainscot (or skirting, or tiles) and its height, the floor. */
const STYLE: Record<RoomKind, { wall: string; band: string; bandH: number; bandOf: Surface | number; floor: [string, string]; pattern: 'planks' | number; floorOf?: Surface; ceiling: string }> = {
	living: { wall: '#f1ead8', band: '#b9c9b5', bandH: 0.9, bandOf: 'paint', floor: ['#e9e1cf', '#a8452f'], pattern: 0.3, ceiling: '#fbf8f0' },
	bedroom: { wall: '#ece2d2', band: '#8a6a4a', bandH: 0.1, bandOf: 'wood', floor: ['#a8794e', '#93673f'], pattern: 'planks', ceiling: '#fbf8f0' },
	kitchen: { wall: '#f2efe6', band: '#cfe0dc', bandH: 1.25, bandOf: tiles(0.15), floor: ['#d9d6cf', '#b8b4ab'], pattern: 0.3, ceiling: '#fbf8f0' },
	bathroom: { wall: '#e8f0f2', band: '#9cc6d6', bandH: 1.5, bandOf: tiles(0.15), floor: ['#e9eef0', '#7fb2c8'], pattern: 0.2, ceiling: '#ffffff' },
	sales: { wall: '#f3f3ee', band: '#c9d7d2', bandH: 0.12, bandOf: 'paint', floor: ['#e4e2dc', '#cfcdc6'], pattern: 0.5, ceiling: '#ffffff' },
	store: { wall: '#e6e4de', band: '#9a978f', bandH: 0.12, bandOf: 'concrete', floor: ['#b9b6ae', '#b1aea6'], pattern: 1.0, floorOf: 'concrete', ceiling: '#f4f4f2' },
	dining: { wall: '#efe2cc', band: '#5b3a28', bandH: 1.0, bandOf: 'wood', floor: ['#8a5a38', '#7a4c2e'], pattern: 'planks', ceiling: '#f6efe2' },
	galley: { wall: '#f2efe6', band: '#e0d6c2', bandH: 1.25, bandOf: tiles(0.15), floor: ['#cfc8bb', '#b3ab9c'], pattern: 0.3, ceiling: '#fbf8f0' },
	family: { wall: '#f0e6d6', band: '#c9b89a', bandH: 0.9, bandOf: 'paint', floor: ['#9c6b43', '#8a5c38'], pattern: 'planks', ceiling: '#fbf8f0' },
	hall: { wall: '#eef0ea', band: '#2f6f68', bandH: 1.0, bandOf: 'paint', floor: ['#e3e0d8', '#c9c5bb'], pattern: 0.6, ceiling: '#ffffff' },
	records: { wall: '#e9e6dd', band: '#8f8a7f', bandH: 0.12, bandOf: 'paint', floor: ['#c9c3b6', '#bdb7aa'], pattern: 0.5, ceiling: '#f6f5f0' }
};

const SIGN_NAMES = { cafe: 'Café', shop: 'Mini-mart', house: 'House', office: 'Office' } as const;

/** The name over the door, outside (cafés and shops): a painted board, so a building that can be
 * entered stands out on the street. Needs a canvas (none in unit tests: no sign). */
function nameSign(text: string, type: InteriorType, width: number): THREE.Mesh | null {
	if (type === 'house' || typeof document === 'undefined') return null;
	const canvas = document.createElement('canvas');
	canvas.width = 512;
	canvas.height = 128;
	const g = canvas.getContext('2d');
	if (!g) return null;
	const [board, paint] = type === 'cafe' ? ['#3e2a1e', '#f4e6c8'] : type === 'office' ? ['#123b3a', '#f6f1e6'] : ['#b8322a', '#ffffff'];
	g.fillStyle = board;
	g.fillRect(0, 0, 512, 128);
	g.strokeStyle = paint;
	g.lineWidth = 5;
	g.strokeRect(12, 12, 488, 104);
	g.fillStyle = paint;
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	let size = 66;
	const font = () => (g.font = `600 ${size}px Georgia, 'Times New Roman', serif`);
	font();
	while (g.measureText(text).width > 450 && size > 26) {
		size -= 4;
		font();
	}
	g.fillText(text, 256, 68);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	const sign = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 4), new THREE.MeshBasicMaterial({ map: texture }));
	sign.name = 'Sign';
	return sign;
}

/** The shader uniforms shared by every material of one building (its lights levels are set by
 * Buildings): eight light channels, two storeys of up to four rooms. */
function interiorUniforms(night: { value: number }, detail: { value: number }) {
	return {
		uLampsOn: { value: new THREE.Vector4(1, 0, 0, 0) },
		uLampsOn2: { value: new THREE.Vector4(0, 0, 0, 0) },
		uNight: night,
		uDetail: detail,
		uGain: { value: PROCEDURAL_GAIN },
		uLampColor: { value: new THREE.Vector3(1.25, 1.0, 0.75) }
	};
}

/** The name board over a café's or shop's door, on the facade (needs a canvas: on the main
 * thread). */
function addSign(root: THREE.Group, type: InteriorType, plan: Plan, name?: string | null): void {
	const sw = Math.min(1.8, plan.width - 0.4);
	const sign = nameSign(name ?? SIGN_NAMES[type], type, sw);
	if (!sign) return;
	const half = plan.width / 2 - sw / 2;
	sign.position.set(Math.max(-half, Math.min(half, plan.doorX)), FLOOR_LIFT + DOOR_H + 0.2 + sw / 8, plan.depth / 2 + plan.wall + 0.08);
	root.add(sign);
}

/** A built interior as plain data (posted from the worker): its spec, and its node tree with
 * each mesh's vertex arrays (transferred, not copied). */
export interface InteriorData {
	spec: BuildingSpec;
	nodes: NodeData[];
}
interface NodeData {
	name: string;
	position: [number, number, number];
	mesh?: { attributes: Record<string, { array: Float32Array; itemSize: number }>; index: Uint16Array | Uint32Array | null; sphere: [number, number, number, number] };
	children: NodeData[];
}

/** Build an interior as data (in the interior worker: the heavy part, off the main thread). */
export function buildInteriorData(type: InteriorType, plan: Plan, seed: number, name?: string | null): InteriorData {
	const { spec, root } = buildInterior(type, plan, seed, { value: 0 }, name);
	const node = (o: THREE.Object3D): NodeData => {
		const mesh = o as THREE.Mesh;
		const out: NodeData = { name: o.name, position: [o.position.x, o.position.y, o.position.z], children: o.children.filter((c) => c.name !== 'Sign').map(node) };
		if (mesh.isMesh) {
			const g = mesh.geometry;
			const attributes: NonNullable<NodeData['mesh']>['attributes'] = {};
			for (const [key, a] of Object.entries(g.attributes)) attributes[key] = { array: a.array as Float32Array, itemSize: a.itemSize };
			const sphere = g.boundingSphere ?? (g.computeBoundingSphere(), g.boundingSphere!);
			out.mesh = { attributes, index: (g.index?.array as Uint16Array | Uint32Array) ?? null, sphere: [sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius] };
		}
		return out;
	};
	return { spec, nodes: root.children.filter((c) => c.name !== 'Sign').map(node) };
}

/** The arrays to transfer with an InteriorData message. */
export function interiorTransferables(data: InteriorData): ArrayBuffer[] {
	const out: ArrayBuffer[] = [];
	const walk = (n: NodeData) => {
		if (n.mesh) {
			for (const a of Object.values(n.mesh.attributes)) out.push(a.array.buffer as ArrayBuffer);
			if (n.mesh.index) out.push(n.mesh.index.buffer as ArrayBuffer);
		}
		n.children.forEach(walk);
	};
	data.nodes.forEach(walk);
	return [...new Set(out)];
}

/** Put a built interior together (main thread): meshes with this building's materials, and its
 * sign. */
export function assembleInterior(data: InteriorData, type: InteriorType, plan: Plan, night: { value: number }, name?: string | null, detail: { value: number } = { value: 1 }): ProceduralBuilding {
	const uniforms = interiorUniforms(night, detail);
	const make = (n: NodeData): THREE.Object3D => {
		let o: THREE.Object3D;
		if (n.mesh) {
			const g = new THREE.BufferGeometry();
			for (const [key, a] of Object.entries(n.mesh.attributes)) g.setAttribute(key, new THREE.BufferAttribute(a.array, a.itemSize));
			if (n.mesh.index) g.setIndex(new THREE.BufferAttribute(n.mesh.index, 1));
			const [x, y, z, r] = n.mesh.sphere;
			g.boundingSphere = new THREE.Sphere(new THREE.Vector3(x, y, z), r);
			o = new THREE.Mesh(g, interiorMaterial(uniforms));
		} else o = new THREE.Group();
		o.name = n.name;
		o.position.set(...n.position);
		for (const c of n.children) o.add(make(c));
		return o;
	};
	const root = new THREE.Group();
	for (const n of data.nodes) root.add(make(n));
	addSign(root, type, plan, name);
	return { spec: data.spec, root, uniforms };
}

/** A piece of furniture against a wall: the middle of its back edge (on the wall face), its
 * turn (local +z points into the room, local x along the wall) and its footprint. */
interface Mount {
	x: number;
	z: number;
	yaw: number;
	rect: Rect;
}

/** Upper floors: the floor slab between storeys (m); a flight of stairs' width, tread and the
 * landing kept clear at each end. */
export const SLAB = 0.3;
export const STAIR = { width: 0.95, tread: 0.2, landing: 1.0 };

/** The parts of `r` outside `hole`. */
function minus(r: Rect, hole: Rect | null): Rect[] {
	if (!hole || !overlaps(r, hole)) return [r];
	const [x0, x1, z0, z1] = r;
	const [hx0, hx1, hz0, hz1] = [Math.max(x0, hole[0]), Math.min(x1, hole[1]), Math.max(z0, hole[2]), Math.min(z1, hole[3])];
	const out: Rect[] = [];
	if (hz0 > z0) out.push([x0, x1, z0, hz0]);
	if (hz1 < z1) out.push([x0, x1, hz1, z1]);
	if (hx0 > x0) out.push([x0, hx0, hz0, hz1]);
	if (hx1 < x1) out.push([hx1, x1, hz0, hz1]);
	return out.filter(([a, b, c, e]) => b - a > 1e-6 && e - c > 1e-6);
}

/** The upper floor: the same rooms (the walls stand on those below) as a family room at the
 * front, where the stairs come up, and bedrooms and a bathroom behind. */
export function upperRooms(ground: FloorPlan): FloorPlan {
	const offset = ground.rooms.length;
	const ids = new Map<string, string>();
	let bedrooms = 0;
	const rooms = ground.rooms.map((r, i): RoomPlan => {
		const kind: RoomKind = i === 0 ? 'family' : r.kind === 'bathroom' ? 'bathroom' : 'bedroom';
		const id = kind === 'bedroom' ? `up-bedroom${++bedrooms > 1 ? bedrooms : ''}` : `up-${kind}`;
		ids.set(r.id, id);
		return { id, kind, name: ROOM_NAMES[kind], rect: r.rect, channel: offset + i };
	});
	const doors = ground.doors.map((d) => {
		const back = ids.get(d.back)!;
		return { ...d, id: back, label: `${ROOM_NAMES[rooms.find((r) => r.id === back)!.kind]} Door`, front: ids.get(d.front)!, back };
	});
	return { rooms, partitions: ground.partitions, doors };
}

/** A flight of stairs in the entrance room: its plan, the way it climbs, and the landings kept
 * clear at its foot (below) and at its head (above). */
/** An opening in a wall: [from, to] along it, [bottom, top] above the floor. */
type Opening = [number, number, number, number];

interface Flight {
	rect: Rect;
	axis: 'x' | 'z';
	dir: 1 | -1;
	foot: Rect;
	head: Rect;
	/** The landings' open sides (the room side; the other is against the wall). */
	footWay: Rect;
	headWay: Rect;
}

/** Build the interior of a planned building: the ground floor and, in a building tall enough,
 * an upper floor reached by stairs. */
export function buildInterior(type: InteriorType, plan: Plan, seed: number, night: { value: number }, name?: string | null, detail: { value: number } = { value: 1 }): ProceduralBuilding {
	const r = rng(seed);
	// Uniforms shared by all materials of this building (the lights levels are set by Buildings):
	// eight light channels (two storeys of up to four rooms).
	const uniforms = interiorUniforms(night, detail);
	const w = plan.width,
		d = plan.depth,
		H = plan.ceiling,
		dx = plan.doorX,
		T = PARTITION;
	const g0 = dx - plan.doorWidth / 2,
		g1 = dx + plan.doorWidth / 2;
	const storey = H + SLAB;
	const steps = Math.max(12, Math.round(storey / 0.235)); // steep, as in a shophouse
	const rise = storey / steps,
		run = steps * STAIR.tread;

	/** Casement windows that open on the ground floor's street front, where the real facade is
	 * straight (so their cut-out in it lines up): one each side of the door, filling a home's
	 * window or in the middle of a shopfront. Climbed through from the street or from inside. */
	const top = Math.min(H - 0.35, 2.4);
	const regions: [number, number][] =
		type === 'house'
			? [[Math.max(-w / 2 + 0.4, g0 - 0.5 - 1.6), g0 - 0.5], [g1 + 0.5, Math.min(w / 2 - 0.4, g1 + 0.5 + 1.6)]]
			: [[-w / 2 + 0.4, g0 - 0.35], [g1 + 0.35, w / 2 - 0.4]];
	const sill = type === 'house' ? 1.0 : 0.7;
	const windowTop = type === 'house' ? Math.min(top, 2.2) : top;
	const windows = regions
		.map(([ra, rb], k) => {
			const ww = Math.min(type === 'house' ? 1.2 : 1.0, rb - ra);
			const c = (ra + rb) / 2;
			return { id: `window-${k}`, region: k, a: c - ww / 2, b: c + ww / 2, x: c };
		})
		.filter((wn) => wn.b - wn.a >= 0.8 && wn.a >= plan.front[0] - 0.05 && wn.b <= plan.front[1] + 0.05);

	/** Doorways and inner doors' swings (and where one lands inside a window), kept clear of
	 * furniture (and stairs). */
	const zones = (fp: FloorPlan, entranceDoor: boolean): Rect[] => {
		const out: Rect[] = entranceDoor ? [[dx - 0.65, dx + 0.65, d / 2 - 1.4, d / 2], ...windows.map((wn): Rect => [wn.x - 0.5, wn.x + 0.5, d / 2 - 1.15, d / 2])] : [];
		const half = INNER_DOOR.width / 2;
		for (const dr of fp.doors) {
			out.push([dr.x - half - 0.08, dr.x + half + 0.08, dr.z + T / 2, dr.z + T / 2 + 1.1]);
			out.push([dr.x - half - 0.13, dr.x + half + 0.13, dr.z - T / 2 - 1.15, dr.z - T / 2]);
		}
		return out;
	};
	/** Stairs along the entrance room's back wall or a side wall, as far from the front door as
	 * they fit with both landings clear, or null. */
	const placeStairs = (ground: FloorPlan, upper: FloorPlan): Flight | null => {
		const [x0, x1, z0, z1] = ground.rooms[0].rect;
		// Keep the room's own fixture free too: a café's counter, a shop's drinks fridge.
		const reserved: Rect[] = [];
		if (type === 'cafe') reserved.push([x1 - 0.5 - Math.min(x1 - x0 - 1.6, 3.6), x1 - 0.5, z0, z0 + 1.35]);
		if (type === 'office') reserved.push([x0 + 0.6, x1 - 0.6, z0, z0 + 1.9]);
		// (The fridge goes at the back, on the side of the door: the counter is on the other.)
		if (type === 'shop') reserved.push(dx > 0 ? [x1 - 1.5, x1, z0, z0 + 0.85] : [x0, x0 + 1.5, z0, z0 + 0.85]);
		// And a wide way up to each inner door (stairs beside a counter could wall one off).
		const aisles: Rect[] = type === 'house' ? [] : ground.doors.map((dr) => [dr.x - 0.75, dr.x + 0.75, dr.z + T / 2, dr.z + T / 2 + 2.3]);
		const below = [...zones(ground, true), ...reserved, ...aisles],
			above = zones(upper, false);
		const within = (q: Rect) => q[0] >= x0 - 1e-6 && q[1] <= x1 + 1e-6 && q[2] >= z0 - 1e-6 && q[3] <= z1 + 1e-6;
		const ok = (q: Rect, clearOf: Rect[]) => within(q) && !clearOf.some((c) => overlaps(q, c));
		const [SW, LD] = [STAIR.width, STAIR.landing];
		const options: Flight[] = [];
		/** The strip beside a landing on the room side, to walk onto it from. */
		const way = (q: Rect, axis: 'x' | 'z', onLeft: boolean): Rect => (axis === 'x' ? [q[0], q[1], q[3], q[3] + LD] : onLeft ? [q[1], q[1] + LD, q[2], q[3]] : [q[0] - LD, q[0], q[2], q[3]]);
		for (let a = x0 + LD; a + run + LD <= x1 + 1e-6; a += 0.1)
			for (const dir of [1, -1] as const) {
				const lo: Rect = [a - LD, a, z0, z0 + SW],
					hi: Rect = [a + run, a + run + LD, z0, z0 + SW];
				const [foot, head] = dir > 0 ? [lo, hi] : [hi, lo];
				options.push({ rect: [a, a + run, z0, z0 + SW], axis: 'x', dir, foot, head, footWay: way(foot, 'x', false), headWay: way(head, 'x', false) });
			}
		for (const [wa, wb] of [[x0, x0 + SW], [x1 - SW, x1]])
			for (let a = z0 + LD; a + run + LD <= z1 + 1e-6; a += 0.1)
				for (const dir of [1, -1] as const) {
					const lo: Rect = [wa, wb, a - LD, a],
						hi: Rect = [wa, wb, a + run, a + run + LD];
					const [foot, head] = dir > 0 ? [lo, hi] : [hi, lo];
					const onLeft = wa === x0;
					options.push({ rect: [wa, wb, a, a + run], axis: 'z', dir, foot, head, footWay: way(foot, 'z', onLeft), headWay: way(head, 'z', onLeft) });
				}
		const far = (f: Flight) => Math.hypot((f.rect[0] + f.rect[1]) / 2 - dx, (f.rect[2] + f.rect[3]) / 2 - d / 2);
		options.sort((p, q) => far(q) - far(p));
		return options.find((f) => ok(f.rect, below) && ok(f.foot, below) && ok(f.footWay, below) && ok(f.rect, above) && ok(f.head, above) && ok(f.headWay, above)) ?? null;
	};
	// An upper floor in a building tall enough for it, if stairs fit in the entrance room.
	let ground = planRooms(type, w, d, dx, false);
	let upper: FloorPlan | null = null;
	let flight: Flight | null = null;
	// (A shop or café keeps its upper floor only if the stairs leave room for business below.)
	const roomy = (fp: FloorPlan) => {
		const [x0, x1, z0, z1] = fp.rooms[0].rect;
		return type === 'house' || (x1 - x0) * (z1 - z0) >= (type === 'cafe' ? 40 : 30);
	};
	// (An office keeps to one floor: the hall and the records room are all it needs.)
	if (type !== 'office' && plan.height >= FLOOR_LIFT + storey + H + 0.6 && roomy(planRooms(type, w, d, dx, true))) {
		const withUpper = planRooms(type, w, d, dx, true);
		const up = upperRooms(withUpper);
		flight = placeStairs(withUpper, up);
		if (flight) {
			ground = withUpper;
			upper = up;
		}
	}

	const seats: SeatSpec[] = [];
	const tables: TableSpec[] = [];
	const items: ItemSpec[] = [];
	const toggles: ToggleSpec[] = [];
	const services: ServiceSpec[] = [];
	const root = new THREE.Group();
	// The storey being built: its plan, mesh builder, lighting, the parts kept clear, and the
	// stairwell in its floor (above) or its ceiling (below).
	let L = 0;
	let rooms = ground.rooms;
	let doors = ground.doors;
	let entrance = rooms[0];
	let current = entrance;
	let b = new MeshBuilder();
	let ctx: LightContext = { rooms, entrance: entrance.id, D: d, ceiling: H, lamps: [], blockers: [] };
	let clear: Rect[] = zones(ground, true);
	let extra = new THREE.Group();
	if (flight) clear.push(flight.rect, flight.foot, flight.footWay);
	const lit = (mb: MeshBuilder) => new THREE.Mesh(mb.geometry(lightUp(mb, ctx)), interiorMaterial(uniforms));
	const block = (x0: number, x1: number, z0: number, z1: number) => ctx.blockers.push([Math.min(x0, x1), Math.max(x0, x1), Math.min(z0, z1), Math.max(z0, z1)]);
	/** Inside `room`, clear of doorways and of furniture already placed. */
	const free = (room: RoomPlan, rc: Rect, margin = 0.02) => {
		const [x0, x1, z0, z1] = room.rect;
		if (rc[0] < x0 - 1e-6 || rc[1] > x1 + 1e-6 || rc[2] < z0 - 1e-6 || rc[3] > z1 + 1e-6) return false;
		const grown: Rect = [rc[0] - margin, rc[1] + margin, rc[2] - margin, rc[3] + margin];
		return !clear.some((c) => overlaps(grown, c)) && !ctx.blockers.some((c) => overlaps(grown, c));
	};
	/**
	 * A spot against one of the room's walls for a piece `len` long and `depth` deep, as near the
	 * wall's `prefer` point (0 … 1 along it) as is free, or null.
	 */
	const mount = (room: RoomPlan, wall: 'back' | 'front' | 'left' | 'right', len: number, depth: number, prefer = 0.5): Mount | null => {
		const [x0, x1, z0, z1] = room.rect;
		const along = wall === 'back' || wall === 'front';
		const [a0, a1] = along ? [x0, x1] : [z0, z1];
		if (a1 - a0 < len + 0.1) return null;
		const lo = a0 + len / 2 + 0.05,
			hi = a1 - len / 2 - 0.05;
		const target = a0 + (a1 - a0) * prefer;
		const options: number[] = [];
		for (let a = lo; a <= hi + 1e-6; a += 0.1) options.push(a);
		options.sort((p, q) => Math.abs(p - target) - Math.abs(q - target));
		for (const a of options) {
			let m: Mount;
			if (wall === 'back') m = { x: a, z: z0, yaw: 0, rect: [a - len / 2, a + len / 2, z0, z0 + depth] };
			else if (wall === 'front') m = { x: a, z: z1, yaw: Math.PI, rect: [a - len / 2, a + len / 2, z1 - depth, z1] };
			else if (wall === 'left') m = { x: x0, z: a, yaw: Math.PI / 2, rect: [x0, x0 + depth, a - len / 2, a + len / 2] };
			else m = { x: x1, z: a, yaw: -Math.PI / 2, rect: [x1 - depth, x1, a - len / 2, a + len / 2] };
			if (free(room, m.rect)) return m;
		}
		return null;
	};
	/** A local point of a mount in the building frame. */
	const toB = (m: Mount, lx: number, lz: number): XZ => [m.x + lx * Math.cos(m.yaw) + lz * Math.sin(m.yaw), m.z - lx * Math.sin(m.yaw) + lz * Math.cos(m.yaw)];
	const lampAt = (room: RoomPlan, x: number, z: number, drop: number, power: number, shade?: string) => {
		const y = H - drop;
		b.as('paint').cylinder(x, z, y, H, 0.006, hex('#222222'), 4, [0.3, 0]);
		if (shade) b.as('fabric').cylinder(x, z, y - 0.16, y, 0.18, hex(shade), 14, [0.6, 1.4], 0.05);
		else b.as('glass').cylinder(x, z, y - 0.12, y, 0.07, hex('#fff4dc'), 8, [0.6, 1.6]);
		b.as('paint');
		ctx.lamps.push({ x, y: y - 0.15, z, power, channel: room.channel });
	};
	const tube = (room: RoomPlan, x: number, z: number) => {
		b.as('glass').box(x - 0.6, x + 0.6, H - 0.05, H - 0.01, z - 0.05, z + 0.05, hex('#ffffff'), [0.6, 1.6]);
		b.as('paint');
		ctx.lamps.push({ x, y: H - 0.2, z, power: 0.6, channel: room.channel });
	};
	/** A toggled part (steam, a flame, running water): its own small mesh, hidden while off. */
	const toggled = (node: string, draw: (mb: MeshBuilder) => void) => {
		const mb = new MeshBuilder().as('glass');
		draw(mb);
		const mesh = lit(mb);
		mesh.name = node;
		extra.add(mesh);
	};
	const trim = hex(type === 'cafe' ? '#3e2a1e' : '#f7f5f0');

	// ── The shell of a storey: floor, walls with doorways, wainscot, ceiling, windows, stairs ──
	const div = (len: number) => Math.max(1, Math.round(len / 0.5));
	/** Openings in a room's back (z0) or front (z1) wall: [xa, xb, bottom, top] (doors from the
	 * floor; windows from their sill). */
	const openings = (room: RoomPlan, side: 'back' | 'front'): Opening[] => {
		const out: Opening[] = [];
		for (const dr of doors) if ((side === 'back' && dr.front === room.id) || (side === 'front' && dr.back === room.id)) out.push([dr.x - INNER_DOOR.width / 2, dr.x + INNER_DOOR.width / 2, 0, INNER_DOOR.height]);
		if (side === 'front' && room === entrance && L === 0) {
			out.push([g0, g1, 0, DOOR_H]);
			for (const wn of windows) out.push([wn.a, wn.b, sill, windowTop]);
		}
		return out.sort((p, q) => p[0] - q[0]);
	};
	/** Spans of [a0, a1] outside the openings. */
	const spans = (a0: number, a1: number, open: Opening[]) => {
		const out: [number, number][] = [];
		let a = a0;
		for (const [oa, ob] of open) {
			if (oa > a) out.push([a, oa]);
			a = Math.max(a, ob);
		}
		if (a1 > a) out.push([a, a1]);
		return out;
	};
	/** A pane seen from inside: the street, the buildings across it and the sky, in daylight
	 * (glowing by day only, dark at night). `a`, `c`: its bottom corners, `y0`..`y1`: its height. */
	const view = (a: XZ, c: XZ, y0: number, y1: number) => {
		const bands: [number, string, number][] = [
			[0.3, '#8f918b', 1.0], // pavement
			[0.62, '#d3c6ae', 1.15], // facades across the street
			[1, '#d6ebf7', 1.55] // sky
		];
		let lo = y0;
		b.as('glass');
		for (const [t, color, glow] of bands) {
			const hi = y0 + (y1 - y0) * t;
			b.quad([a[0], lo, a[1]], [c[0], lo, c[1]], [c[0], hi, c[1]], [a[0], hi, a[1]], hex(color), 'piece', [glow, 0]);
			lo = hi;
		}
		b.as('paint');
	};
	const pane = (x0: number, x1: number, y0: number, y1: number) => {
		if (x1 - x0 < 0.8) return;
		view([x1, d / 2 - 0.02], [x0, d / 2 - 0.02], y0, y1);
		b.box(x0, x1, y0 - 0.08, y0, d / 2 - 0.08, d / 2, trim);
		for (let x = x0; x <= x1 + 1e-6; x += (x1 - x0) / Math.max(1, Math.round((x1 - x0) / 1.2))) b.box(x - 0.03, x + 0.03, y0, y1, d / 2 - 0.05, d / 2, trim);
	};
	function shell(floorHole: Rect | null, ceilingHole: Rect | null) {
		for (const room of rooms) {
			const st = STYLE[room.kind];
			const [x0, x1, z0, z1] = room.rect;
			const wall = hex(st.wall);
			// Floor (around a stairwell).
			const floor = (fx0: number, fx1: number, fz0: number, fz1: number, c: V3) => b.quad([fx0, 0, fz1], [fx1, 0, fz1], [fx1, 0, fz0], [fx0, 0, fz0], c, 'floor');
			for (const [px0, px1, pz0, pz1] of minus(room.rect, floorHole)) {
				b.as(st.pattern === 'planks' ? 'wood' : (st.floorOf ?? tiles(st.pattern)));
				if (st.pattern === 'planks') {
					for (let z = pz0, row = 0; z < pz1 - 1e-6; z += 0.18, row++) {
						const zz = Math.min(pz1, z + 0.18);
						for (let x = px0 - (row % 3) * 0.4, k = 0; x < px1; x += 1.2, k++) {
							const t = 0.85 + 0.25 * r();
							floor(Math.max(px0, x), Math.min(px1, x + 1.2), z, zz, hex(k % 2 ? st.floor[0] : st.floor[1]).map((v) => v * t) as V3);
						}
					}
				} else {
					// Tiles on a fixed grid (so the shader's grout lines fall between them).
					const s = st.pattern;
					for (let i = Math.floor(px0 / s + 1e-6); i * s < px1 - 1e-6; i++)
						for (let k = Math.floor(pz0 / s + 1e-6); k * s < pz1 - 1e-6; k++)
							floor(Math.max(px0, i * s), Math.min(px1, (i + 1) * s), Math.max(pz0, k * s), Math.min(pz1, (k + 1) * s), hex((((i + k) % 2) + 2) % 2 ? st.floor[0] : st.floor[1]));
				}
			}
			// Walls, facing into the room; the back and front walls with their doorways.
			b.as('paint');
			const nv = div(H);
			for (const [side, z, facing] of [['back', z0, 1], ['front', z1, -1]] as const) {
				const open = openings(room, side);
				const quad = (a: number, c: number, y0: number, y1: number) =>
					facing > 0
						? b.quad([a, y0, z], [c, y0, z], [c, y1, z], [a, y1, z], wall, 'wall', null, div(c - a), Math.max(1, Math.round((y1 - y0) / 0.5)))
						: b.quad([c, y0, z], [a, y0, z], [a, y1, z], [c, y1, z], wall, 'wall', null, div(c - a), Math.max(1, Math.round((y1 - y0) / 0.5)));
				const band = (a: number, c: number, y1: number) => {
					b.as(st.bandOf).box(a, c, 0, y1, facing > 0 ? z : z - 0.012, facing > 0 ? z + 0.012 : z, hex(st.band));
					b.as('paint');
				};
				for (const [a, c] of spans(x0, x1, open)) {
					quad(a, c, 0, H);
					band(a, c, st.bandH);
				}
				for (const [a, c, bottom, top] of open) {
					// Under a window: wall (and wainscot) up to its sill.
					if (bottom > 0) {
						quad(a, c, 0, bottom);
						band(a, c, Math.min(st.bandH, bottom));
					}
					quad(a, c, top, H);
				}
			}
			b.quad([x0, 0, z1], [x0, 0, z0], [x0, H, z0], [x0, H, z1], wall, 'wall', null, div(z1 - z0), nv);
			b.quad([x1, 0, z0], [x1, 0, z1], [x1, H, z1], [x1, H, z0], wall, 'wall', null, div(z1 - z0), nv);
			b.as(st.bandOf).box(x0, x0 + 0.012, 0, st.bandH, z0, z1, hex(st.band));
			b.box(x1 - 0.012, x1, 0, st.bandH, z0, z1, hex(st.band));
			b.as('paint');
			// Ceiling (around a stairwell).
			for (const [cx0, cx1, cz0, cz1] of minus(room.rect, ceilingHole)) b.quad([cx0, H, cz0], [cx1, H, cz0], [cx1, H, cz1], [cx0, H, cz1], hex(st.ceiling), 'ceiling', null, div(cx1 - cx0), div(cz1 - cz0));
		}
		// Inner doorways: through the partition (jambs, head, threshold) and a frame on both faces.
		for (const dr of doors) {
			const [ga, gb] = [dr.x - INNER_DOOR.width / 2, dr.x + INNER_DOOR.width / 2];
			const [zf, zb] = [dr.z + T / 2, dr.z - T / 2];
			const h = INNER_DOOR.height;
			const c = hex(STYLE[roomOf(rooms, dr.x, zf + 0.1).kind].wall);
			b.quad([ga, 0, zf], [ga, 0, zb], [ga, h, zb], [ga, h, zf], c, 'wall');
			b.quad([gb, 0, zb], [gb, 0, zf], [gb, h, zf], [gb, h, zb], c, 'wall');
			b.quad([ga, h, zb], [gb, h, zb], [gb, h, zf], [ga, h, zf], c, 'wall');
			b.as('wood').quad([ga, 0.002, zf], [gb, 0.002, zf], [gb, 0.002, zb], [ga, 0.002, zb], hex('#8a7a66'), 'floor');
			b.as('paint');
			const frame = hex('#e9e2d4');
			for (const [fa, fb] of [[zf, zf + 0.015], [zb - 0.015, zb]]) {
				b.box(ga - 0.06, ga, 0, h + 0.06, fa, fb, frame);
				b.box(gb, gb + 0.06, 0, h + 0.06, fa, fb, frame);
				b.box(ga - 0.06, gb + 0.06, h, h + 0.06, fa, fb, frame);
			}
		}
		// The stairwell through the ceiling: the slab's edges round it.
		if (ceilingHole) {
			const [hx0, hx1, hz0, hz1] = ceilingHole;
			const slab = hex(STYLE[entrance.kind].wall);
			b.quad([hx0, H, hz0], [hx1, H, hz0], [hx1, storey, hz0], [hx0, storey, hz0], slab, 'wall');
			b.quad([hx1, H, hz1], [hx0, H, hz1], [hx0, storey, hz1], [hx1, storey, hz1], slab, 'wall');
			b.quad([hx0, H, hz1], [hx0, H, hz0], [hx0, storey, hz0], [hx0, storey, hz1], slab, 'wall');
			b.quad([hx1, H, hz0], [hx1, H, hz1], [hx1, storey, hz1], [hx1, storey, hz0], slab, 'wall');
		}
	}
	/** The steps of the flight (solid, one block per tread) and a handrail on its open side. */
	function stairs(f: Flight) {
		const [x0, x1, z0, z1] = f.rect;
		const tread = (k: number): Rect => {
			const a = k * STAIR.tread,
				c = (k + 1) * STAIR.tread;
			if (f.axis === 'x') return f.dir > 0 ? [x0 + a, x0 + c, z0, z1] : [x1 - c, x1 - a, z0, z1];
			return f.dir > 0 ? [x0, x1, z0 + a, z0 + c] : [x0, x1, z1 - c, z1 - a];
		};
		for (let k = 0; k < steps; k++) {
			const [a0, a1, c0, c1] = tread(k);
			b.as('paint').box(a0, a1, 0, (k + 1) * rise, c0, c1, hex(k % 2 ? '#c9bba3' : '#d3c6ae'));
			b.as('wood').box(a0, a1, (k + 1) * rise, (k + 1) * rise + 0.02, c0, c1, hex('#8a6a4a'));
		}
		// The open side (away from the wall it runs along): balusters and a sloping rail.
		const [rx0, rx1, rz0, rz1] = entrance.rect;
		const openSide = f.axis === 'x' ? (z0 - rz0 < rz1 - z1 ? z1 : z0) : x0 - rx0 < rx1 - x1 ? x1 : x0;
		// Balusters on every other step up to a rail that follows the slope (0.9 m above the
		// nose of each step).
		const inner = f.axis === 'x' ? (openSide === z1 ? -0.02 : 0.02) : openSide === x1 ? -0.02 : 0.02;
		const point = (k: number, y: number): V3 => {
			const [a0, a1, c0, c1] = tread(k);
			return f.axis === 'x' ? [(a0 + a1) / 2, y, openSide + inner] : [openSide + inner, y, (c0 + c1) / 2];
		};
		for (let k = 0; k < steps; k += 2) {
			const [px, , pz] = point(k, 0);
			const y = (k + 1) * rise;
			b.box(px - 0.02, px + 0.02, y, y + 0.9, pz - 0.02, pz + 0.02, hex('#5a3824'));
		}
		b.beam(point(0, rise + 0.9), point(steps - 1, steps * rise + 0.9), 0.06, 0.05, hex('#6e4a2c'));
		b.as('paint');
	}
	/** Upstairs: a railing round the stairwell, open where the stairs arrive. */
	function railing(f: Flight) {
		const [x0, x1, z0, z1] = f.rect;
		const [rx0, rx1, rz0, rz1] = entrance.rect;
		const wood = hex('#6e4a2c');
		b.as('wood');
		const rail = (a: XZ, c: XZ) => {
			const [ax, az] = a,
				[cx, cz] = c;
			b.box(Math.min(ax, cx) - 0.03, Math.max(ax, cx) + 0.03, 0.95, 1.0, Math.min(az, cz) - 0.03, Math.max(az, cz) + 0.03, wood);
			const len = Math.hypot(cx - ax, cz - az);
			for (let t = 0; t <= len + 1e-6; t += 0.3) {
				const px = ax + ((cx - ax) * t) / (len || 1),
					pz = az + ((cz - az) * t) / (len || 1);
				b.box(px - 0.02, px + 0.02, 0, 0.95, pz - 0.02, pz + 0.02, wood);
			}
		};
		// The long side away from the wall, and the far end from where the stairs arrive.
		if (f.axis === 'x') {
			const side = z0 - rz0 < rz1 - z1 ? z1 : z0;
			rail([x0, side], [x1, side]);
			const end = f.dir > 0 ? x0 : x1;
			rail([end, z0], [end, z1]);
		} else {
			const side = x0 - rx0 < rx1 - x1 ? x1 : x0;
			rail([side, z0], [side, z1]);
			const end = f.dir > 0 ? z0 : z1;
			rail([x0, end], [x1, end]);
		}
		b.as('paint');
	}

	// ── Furniture ──────────────────────────────────────────────────────────────────────────
	/** A chair; its stand-up spot is beside it: towards `out` (building frame) if given, else on
	 * the side towards the middle of its room. */
	function chair(x: number, z: number, yaw: number, id: string, out?: XZ) {
		b.at(x, z, yaw).as('wood');
		const wood = hex('#4a2f20');
		b.box(-0.21, 0.21, 0.42, 0.46, -0.21, 0.21, wood);
		b.box(-0.21, 0.21, 0.46, 0.92, -0.23, -0.19, wood);
		for (const lx of [-0.17, 0.17]) for (const lz of [-0.19, 0.17]) b.box(lx - 0.02, lx + 0.02, 0, 0.42, lz - 0.02, lz + 0.02, wood);
		b.at(0, 0, 0).as('paint');
		const c = Math.cos(yaw),
			s = Math.sin(yaw);
		const [rx0, rx1, rz0, rz1] = current.rect;
		const [cx, cz, hw, hd] = [(rx0 + rx1) / 2, (rz0 + rz1) / 2, (rx1 - rx0) / 2, (rz1 - rz0) / 2];
		const options: XZ[] = [[x + 0.6 * c, z - 0.6 * s], [x - 0.6 * c, z + 0.6 * s]];
		const stand: XZ = out ? [x + out[0] * 0.6, z + out[1] * 0.6] : options.sort((a, b2) => Math.abs(a[0] - cx) / hw + Math.abs(a[1] - cz) / hd - (Math.abs(b2[0] - cx) / hw + Math.abs(b2[1] - cz) / hd))[0];
		seats.push({ id, label: 'chair', x, z, yaw, height: 0.46, stand });
	}
	/** A table with chairs on two or four sides, if it fits clear of everything. */
	function diningTable(room: RoomPlan, id: string, cx: number, cz: number, four: boolean): boolean {
		const [hx, hz] = [0.7, 0.42];
		// The table, its chairs and the spots beside them to sit down from.
		const reach: Rect = four ? [cx - 1.3, cx + 1.3, cz - hz - 0.75, cz + hz + 0.75] : [cx - hx - 0.1, cx + hx + 0.1, cz - hz - 0.75, cz + hz + 0.75];
		if (!free(room, reach)) return false;
		b.at(cx, cz).as('wood');
		b.box(-hx, hx, 0.72, 0.76, -hz, hz, hex('#9a6a3e'));
		for (const lx of [-hx + 0.07, hx - 0.07]) for (const lz of [-hz + 0.07, hz - 0.07]) b.box(lx - 0.03, lx + 0.03, 0, 0.72, lz - 0.03, lz + 0.03, hex('#9a6a3e'));
		b.at(0, 0, 0).as('paint');
		block(cx - hx, cx + hx, cz - hz - 0.02, cz + hz + 0.02);
		const ids: string[] = [];
		const spots = four ? [[-0.35, -1], [0.35, -1], [-0.35, 1], [0.35, 1]] : [[0, -1], [0, 1]];
		spots.forEach(([lx, sz], k) => {
			// At a table for four, each chair is got up from on the outer side (not onto its neighbour).
			chair(cx + lx, cz + sz * (hz + 0.3), sz < 0 ? 0 : Math.PI, `${id}${k}`, four ? [Math.sign(lx), 0] : undefined);
			ids.push(`${id}${k}`);
		});
		tables.push({ id, label: 'Table', rect: [cx - hx, cx + hx, cz - hz, cz + hz], seats: ids });
		return true;
	}
	function plant(room: RoomPlan, x: number, z: number) {
		if (!free(room, [x - 0.24, x + 0.24, z - 0.24, z + 0.24])) return;
		b.as('ceramic').cylinder(x, z, 0, 0.42, 0.2, hex('#a5583a'), 10, null, 0.16);
		b.as('paint');
		for (let k = 0; k < 8; k++) {
			const a = k * 2.4,
				rr = 0.08 + 0.03 * k;
			b.at(x + Math.cos(a) * rr * 0.5, z + Math.sin(a) * rr * 0.5, a);
			b.box(-0.18, 0.18, 0.5 + k * 0.09, 0.53 + k * 0.09, -0.06, 0.06, hex('#4e7a3a'));
		}
		b.at(0, 0, 0);
		block(x - 0.24, x + 0.24, z - 0.24, z + 0.24);
	}
	/** Something on a wall (a picture, a mirror): the item stands 0.6 m out in front of it. */
	function onWall(m: Mount, y0: number, y1: number, half: number, frame: string, face: string, glow: Glow, item: Omit<ItemSpec, 'x' | 'z' | 'y'>) {
		b.at(m.x, m.z, m.yaw).as(item.id === 'mirror' ? 'metal' : 'wood');
		b.box(-half, half, y0, y1, 0, 0.03, hex(frame));
		b.as(item.id === 'mirror' ? 'glass' : 'paint').box(-half + 0.06, half - 0.06, y0 + 0.06, y1 - 0.06, 0.03, 0.035, hex(face), glow);
		b.at(0, 0, 0).as('paint');
		const [ix, iz] = toB(m, 0, 0.6);
		items.push({ ...item, x: ix, z: iz, y: (y0 + y1) / 2 });
	}
	/** A point `dist` from (x, z) towards the middle of the room, kept inside it. */
	function towardsMiddle(room: RoomPlan, x: number, z: number, dist: number): XZ {
		const [x0, x1, z0, z1] = room.rect;
		const mx = (x0 + x1) / 2 - x,
			mz = (z0 + z1) / 2 - z;
		const l = Math.hypot(mx, mz) || 1;
		return [clamp(x + (mx / l) * dist, x0 + 0.1, x1 - 0.1), clamp(z + (mz / l) * dist, z0 + 0.1, z1 - 0.1)];
	}
	/** A big glazed water jar (every Khmer kitchen and bathroom has one). */
	function waterJar(room: RoomPlan, x: number, z: number) {
		b.as('ceramic').cylinder(x, z, 0, 0.55, 0.3, hex('#5a3b26'), 12, null, 0.24);
		b.cylinder(x, z, 0.55, 0.62, 0.2, hex('#4a2f1f'), 12);
		b.as('glass').cylinder(x, z, 0.61, 0.62, 0.18, hex('#6f9fb5'), 12, [0.5, 0.4]);
		b.as('paint');
		block(x - 0.31, x + 0.31, z - 0.31, z + 0.31);
		const [ix, iz] = towardsMiddle(room, x, z, 0.7);
		items.push({ id: room.kind === 'bathroom' ? 'jar' : 'kitchen-jar', label: 'Water Jar', title: 'Water jar', text: 'A big glazed jar from Kampong Chhnang, full of rainwater, with a plastic dipper floating on top.', x: ix, z: iz, y: 0.6 });
	}

	function living(room: RoomPlan, dining: boolean) {
		const [x0, x1, z0, z1] = room.rect;
		// The sofa on the side wall away from the entrance door, the TV facing it.
		const sofaSide = dx > (x0 + x1) / 2 ? 'left' : 'right';
		const prefer = clamp((z1 - 1.6 - z0) / (z1 - z0), 0.2, 0.8);
		const sofa = mount(room, sofaSide, 1.9, 0.84, prefer);
		if (sofa) {
			b.at(sofa.x, sofa.z, sofa.yaw).as('fabric');
			b.box(-0.95, 0.95, 0.1, 0.44, 0.03, 0.87, hex('#5b6f8a'));
			b.box(-0.95, 0.95, 0.44, 0.82, 0.03, 0.25, hex('#5b6f8a'));
			b.box(-0.9, 0.9, 0.44, 0.5, 0.25, 0.85, hex('#d8b26a'));
			b.at(0, 0, 0).as('paint');
			ctx.blockers.push(sofa.rect);
			for (const [k, lx] of [[0, -0.42], [1, 0.42]] as const) {
				const [sx, sz] = toB(sofa, lx, 0.45);
				seats.push({ id: `sofa${k}`, label: 'sofa', x: sx, z: sz, yaw: sofa.yaw, height: 0.44, stand: toB(sofa, lx, 1.3) });
			}
			// A coffee table in front (if it leaves the way clear), the TV across the room.
			const [ta, tb] = [toB(sofa, -0.35, 1.75), toB(sofa, 0.35, 2.45)];
			const table: Rect = [Math.min(ta[0], tb[0]), Math.max(ta[0], tb[0]), Math.min(ta[1], tb[1]), Math.max(ta[1], tb[1])];
			if (free(room, table, 0.3)) {
				b.as('wood').box(table[0], table[1], 0.4, 0.44, table[2], table[3], hex('#9a6a3e'));
				b.as('paint');
				ctx.blockers.push(table);
			}
			const tv = mount(room, sofaSide === 'left' ? 'right' : 'left', 1.4, 0.44, prefer);
			if (tv) {
				b.at(tv.x, tv.z, tv.yaw).as('wood');
				b.box(-0.7, 0.7, 0, 0.5, 0, 0.44, hex('#9a6a3e'));
				b.as('glass').box(-0.45, 0.45, 0.6, 1.1, 0.02, 0.06, hex('#1d1e20'));
				b.at(0, 0, 0).as('paint');
				ctx.blockers.push(tv.rect);
			}
			lampAt(room, (sofa.x + (tv?.x ?? sofa.x)) / 2 || 0, sofa.z, 0.3, 1.0);
		} else lampAt(room, (x0 + x1) / 2, (z0 + z1) / 2, 0.3, 1.0);
		// The family altar high on the wall by the entrance.
		const altarX = sofaSide === 'left' ? x0 : x1;
		const sx = sofaSide === 'left' ? 1 : -1;
		b.as('wood').box(Math.min(altarX, altarX + sx * 0.3), Math.max(altarX, altarX + sx * 0.3), 1.9, 1.94, z1 - 0.9, z1 - 0.3, hex('#a8322c'));
		b.as('metal').cylinder(altarX + sx * 0.16, z1 - 0.6, 1.94, 2.12, 0.05, hex('#d4a63f'), 8);
		b.as('paint');
		items.push({ id: 'altar', label: 'Family Altar', title: 'Family altar', text: 'A small Buddha, jasmine and incense, high on the wall as in every Khmer home.', x: altarX + sx * 0.5, z: z1 - 0.6, y: 2.0 });
		if (dining) {
			const tz = z1 - z0 > 7 ? (z0 + z1) / 2 : z0 + 1.4;
			if (diningTable(room, 'dining', (x0 + x1) / 2 + 0.3, tz, true)) lampAt(room, (x0 + x1) / 2 + 0.3, tz, 0.5, 0.9, '#e8d2a0');
		}
		plant(room, sofaSide === 'left' ? x1 - 0.4 : x0 + 0.4, z1 - 0.4);
	}

	function bedroom(room: RoomPlan) {
		const [x0, x1, z0, z1] = room.rect;
		const doorAt = doors.find((dr) => dr.back === room.id)?.x ?? (x0 + x1) / 2;
		// The bed's head against the back wall, away from the door; across the room if too short.
		const away = doorAt > (x0 + x1) / 2 ? 0.2 : 0.8;
		const bed = mount(room, 'back', 1.6, 2.05, away) ?? mount(room, doorAt > (x0 + x1) / 2 ? 'left' : 'right', 1.6, 2.05, 0.5) ?? mount(room, 'back', 1.0, 1.95, away);
		if (bed) {
			const half = (bed.rect[1] - bed.rect[0] > 1.5 && bed.yaw === 0) || (bed.rect[3] - bed.rect[2] > 1.5 && bed.yaw !== 0) ? 0.8 : 0.5;
			const len = bed.yaw === 0 ? bed.rect[3] - bed.rect[2] : bed.rect[1] - bed.rect[0];
			b.at(bed.x, bed.z, bed.yaw).as('fabric');
			b.box(-half, half, 0.12, 0.52, 0.05, len, hex('#efe9df'));
			b.box(-half - 0.02, half + 0.02, 0.5, 0.55, 0.75, len, hex('#b0262c'));
			b.box(-half + 0.08, half - 0.08, 0.52, 0.64, 0.12, 0.5, hex('#f7f3ea'));
			b.as('wood').box(-half - 0.05, half + 0.05, 0.12, 1.1, 0, 0.07, hex('#5a3824'));
			b.at(0, 0, 0).as('paint');
			ctx.blockers.push(bed.rect);
			const [sx, sz] = toB(bed, 0, len - 0.35);
			const stand = toB(bed, 0, len + 0.45);
			seats.push({ id: 'bed', label: 'bed', x: sx, z: sz, yaw: bed.yaw, height: 0.52, stand });
			// A bedside table with a lamp.
			const side: Rect = (() => {
				const [ax, az] = toB(bed, half + 0.05, 0.05);
				const [bx, bz] = toB(bed, half + 0.5, 0.5);
				return [Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz), Math.max(az, bz)];
			})();
			if (free(room, side)) {
				b.as('wood').box(side[0], side[1], 0, 0.5, side[2], side[3], hex('#7a5232'));
				const [lx, lz] = [(side[0] + side[1]) / 2, (side[2] + side[3]) / 2];
				b.as('ceramic').cylinder(lx, lz, 0.5, 0.75, 0.03, hex('#d9c7a0'), 6);
				b.as('fabric').cylinder(lx, lz, 0.75, 0.95, 0.13, hex('#f3e2bd'), 10, [0.6, 1.3], 0.08);
				b.as('paint');
				ctx.blockers.push(side);
				ctx.lamps.push({ x: lx, y: 0.85, z: lz, power: 0.5, channel: room.channel });
			}
		}
		// The wedding photo on a free stretch of side wall, where one can stand in front of it.
		const photo = mount(room, doorAt > (x0 + x1) / 2 ? 'left' : 'right', 0.9, 0.9, 0.5) ?? mount(room, doorAt > (x0 + x1) / 2 ? 'right' : 'left', 0.9, 0.9, 0.5);
		if (photo) onWall(photo, 1.35, 1.85, 0.4, '#3a2a1c', '#c9a46a', [0.8, 0.4], { id: 'photo', label: 'Photo', title: 'Wedding photo', text: 'The couple in gold silk, the day of their wedding in Kandal.' });
		const wardrobe = mount(room, doorAt > (x0 + x1) / 2 ? 'right' : 'left', 1.2, 0.6, 0.3) ?? mount(room, 'back', 1.2, 0.6, 0.5);
		if (wardrobe) {
			b.at(wardrobe.x, wardrobe.z, wardrobe.yaw).as('wood');
			b.box(-0.6, 0.6, 0, 2.0, 0, 0.6, hex('#9a6a3e'));
			b.box(-0.01, 0.01, 0.2, 1.9, 0.6, 0.61, hex('#6e4a2c'));
			b.at(0, 0, 0).as('paint');
			ctx.blockers.push(wardrobe.rect);
		}
		lampAt(room, (x0 + x1) / 2, (z0 + z1) / 2, 0.3, 0.8);
	}

	function kitchen(room: RoomPlan, table: boolean) {
		const [x0, x1, z0, z1] = room.rect;
		// The counter along the longest free wall: a stove, a sink, a shelf above.
		const len = (span: number) => Math.min(3.2, span - 0.4);
		const counter = mount(room, 'back', len(x1 - x0), 0.6, 0.5) ?? mount(room, 'left', len(z1 - z0), 0.6, 0.5) ?? mount(room, 'right', len(z1 - z0), 0.6, 0.5) ?? mount(room, 'back', 1.4, 0.6, 0.5);
		if (counter) {
			const L = counter.yaw === 0 || counter.yaw === Math.PI ? counter.rect[1] - counter.rect[0] : counter.rect[3] - counter.rect[2];
			b.at(counter.x, counter.z, counter.yaw).as('wood');
			b.box(-L / 2, L / 2, 0, 0.88, 0, 0.6, hex('#c9b79a'));
			b.as('ceramic').box(-L / 2 - 0.02, L / 2 + 0.02, 0.88, 0.92, 0, 0.62, hex('#e9e4da'));
			// Gas stove on the left, sink on the right.
			b.as('metal').box(-L / 2 + 0.15, -L / 2 + 0.75, 0.92, 1.0, 0.1, 0.5, hex('#2a2c2e'));
			b.box(L / 2 - 0.75, L / 2 - 0.2, 0.86, 0.93, 0.12, 0.48, hex('#9aa3a8'));
			b.box(L / 2 - 0.5, L / 2 - 0.46, 0.92, 1.2, 0.06, 0.1, hex('#b8bcbf'));
			// A shelf above with jars and pots.
			b.as('wood').box(-L / 2, L / 2, 1.6, 1.63, 0, 0.3, hex('#7a5232'));
			b.as('ceramic');
			for (let k = 0; k < Math.floor(L / 0.22); k++) b.cylinder(-L / 2 + 0.12 + k * 0.22, 0.15, 1.63, 1.75 + (k % 3) * 0.04, 0.06, hex(['#d9a441', '#7a2e1d', '#e7e1d3', '#4e7a3a'][k % 4]), 8);
			b.at(0, 0, 0).as('paint');
			ctx.blockers.push(counter.rect);
			const [fx, fz] = toB(counter, -L / 2 + 0.45, 0.3);
			toggled('Flame_stove', (mb) => {
				for (const [ox, oz] of [[-0.12, 0], [0.12, 0]]) mb.cylinder(fx + ox, fz + oz, 1.0, 1.06, 0.07, hex('#3f7bff'), 10, [1.6, 0.6], 0.03);
			});
			const [tx, tz] = toB(counter, -L / 2 + 0.45, 0.9);
			toggles.push({ id: 'stove', label: 'Stove', node: 'Flame_stove', kind: 'flame', x: tx, z: tz, y: 1.0 });
		}
		// The fridge in a corner, the water jar in another.
		const fridge = mount(room, 'back', 0.7, 0.7, 0.95) ?? mount(room, 'left', 0.7, 0.7, 0.1) ?? mount(room, 'right', 0.7, 0.7, 0.1);
		if (fridge) {
			b.at(fridge.x, fridge.z, fridge.yaw).as('metal');
			b.box(-0.35, 0.35, 0, 1.8, 0, 0.7, hex('#e8eeef'));
			b.box(0.25, 0.28, 0.9, 1.4, 0.7, 0.74, hex('#b8bcbf'));
			b.at(0, 0, 0).as('paint');
			ctx.blockers.push(fridge.rect);
		}
		const jar = mount(room, 'front', 0.7, 0.7, 0.9) ?? mount(room, 'front', 0.7, 0.7, 0.1);
		if (jar) waterJar(room, (jar.rect[0] + jar.rect[1]) / 2, (jar.rect[2] + jar.rect[3]) / 2);
		if (table) {
			const cx = (x0 + x1) / 2,
				cz = (z0 + z1) / 2 + 0.2;
			if (diningTable(room, 'dining', cx, cz, x1 - x0 > 3.2) || diningTable(room, 'dining', cx, cz, false)) lampAt(room, cx, cz, 0.5, 0.9, '#e8d2a0');
			else lampAt(room, cx, cz, 0.3, 0.9);
		} else lampAt(room, (x0 + x1) / 2, (z0 + z1) / 2, 0.3, 0.9);
	}

	function bathroom(room: RoomPlan) {
		const [x0, x1, z0, z1] = room.rect;
		const white = hex('#f4f4f2');
		const toilet = mount(room, 'back', 0.5, 0.75, 0.75) ?? mount(room, 'left', 0.5, 0.75, 0.3);
		if (toilet) {
			b.at(toilet.x, toilet.z, toilet.yaw).as('ceramic');
			b.box(-0.2, 0.2, 0, 0.4, 0.2, 0.68, white);
			b.box(-0.22, 0.22, 0.4, 0.44, 0.18, 0.72, hex('#e8e8e4'));
			b.box(-0.24, 0.24, 0.3, 0.85, 0, 0.2, white);
			b.at(0, 0, 0).as('paint');
			ctx.blockers.push(toilet.rect);
		}
		const basin = mount(room, 'left', 0.6, 0.45, 0.4) ?? mount(room, 'right', 0.6, 0.45, 0.4);
		if (basin) {
			b.at(basin.x, basin.z, basin.yaw).as('ceramic');
			b.box(-0.05, 0.05, 0, 0.75, 0.12, 0.22, white);
			b.box(-0.3, 0.3, 0.75, 0.85, 0, 0.45, white);
			b.at(0, 0, 0).as('paint');
			ctx.blockers.push(basin.rect);
			onWall(basin, 1.2, 1.75, 0.28, '#b8bcbf', '#cfe4ec', [1.1, 0.6], { id: 'mirror', label: 'Mirror', title: 'Mirror', text: 'You look ready for a day in Phnom Penh.' });
		}
		// The shower: a head on the wall over the corner by the jar; water when it is on.
		const jarSpot = mount(room, 'right', 0.7, 0.7, 0.2) ?? mount(room, 'left', 0.7, 0.7, 0.8);
		if (jarSpot) {
			const [jx, jz] = [(jarSpot.rect[0] + jarSpot.rect[1]) / 2, (jarSpot.rect[2] + jarSpot.rect[3]) / 2];
			waterJar(room, jx, jz);
			const [hx, hz] = toB(jarSpot, 0, 0.08);
			b.as('metal').cylinder(hx, hz, 1.95, 2.0, 0.07, hex('#b8bcbf'), 8);
			b.as('paint');
			const [wx, wz] = toB(jarSpot, 0, 0.35);
			toggled('Water_shower', (mb) => {
				for (const [ox, oz] of [[-0.04, 0], [0.04, 0.03], [0, -0.04]]) mb.cylinder(wx + ox, wz + oz, 0.65, 1.95, 0.008, hex('#cfe9f5'), 4, [1.3, 0.4]);
			});
			const [sx, sz] = toB(jarSpot, 0, 1.0);
			toggles.push({ id: 'shower', label: 'Shower', node: 'Water_shower', kind: 'flame', x: sx, z: sz, y: 1.2 });
		}
		lampAt(room, (x0 + x1) / 2, (z0 + z1) / 2, 0.15, 0.7);
	}

	function sales(room: RoomPlan, storeBehind: boolean) {
		const [x0, x1, z0, z1] = room.rect;
		const W = x1 - x0;
		// Counter by the door with a register, on the side away from the door.
		const side = dx > 0 ? -1 : 1;
		const ccx = side * (W / 2 - 0.9);
		// (Further in if a window's landing spot is in the way.)
		const ccz = [z1 - 1.2, z1 - 1.75].find((z) => free(room, [ccx - 0.82, ccx + 0.82, z - 0.32, z + 0.32])) ?? z1 - 1.2;
		if (free(room, [ccx - 0.82, ccx + 0.82, ccz - 0.32, ccz + 0.32])) {
			b.as('wood').box(ccx - 0.8, ccx + 0.8, 0, 0.95, ccz - 0.3, ccz + 0.3, hex('#c45a2d'));
			b.as('ceramic').box(ccx - 0.82, ccx + 0.82, 0.95, 0.99, ccz - 0.32, ccz + 0.32, hex('#efe7d6'));
			b.as('metal').box(ccx - 0.15, ccx + 0.15, 0.99, 1.22, ccz - 0.12, ccz + 0.12, hex('#2a2c2e'));
			b.as('paint');
			block(ccx - 0.82, ccx + 0.82, ccz - 0.32, ccz + 0.32);
			items.push({ id: 'cards', label: 'Phone Cards', title: 'Phone top-up cards', text: 'Scratch cards for every network, and a QR code to pay by KHQR.', x: ccx, z: ccz, y: 1.1 });
		}
		// The drinks fridge on the back wall (glowing glass), first: the shelves give way to it.
		const fridge = mount(room, 'back', 1.12, 0.74, side > 0 ? 0.15 : 0.85) ?? mount(room, 'back', 1.12, 0.74, 0.5);
		if (fridge) {
			b.at(fridge.x, fridge.z, fridge.yaw).as('metal');
			b.box(-0.55, 0.55, 0, 2.0, 0, 0.7, hex('#e8eeef'));
			b.as('glass').box(-0.5, 0.5, 0.1, 1.9, 0.7, 0.72, hex('#cfe8f2'), [0.6, 1.6]);
			for (let k = 0; k < 4; k++) for (let j = 0; j < 6; j++) b.cylinder(-0.38 + j * 0.15, 0.6, 0.2 + k * 0.42, 0.44 + k * 0.42, 0.035, hex(['#d23b2f', '#3fa34d', '#f2c230', '#2f7bd2'][k]), 6, [0.5, 1.2]);
			b.at(0, 0, 0).as('paint');
			ctx.blockers.push(fridge.rect);
			const [ix, iz] = toB(fridge, 0, 0.75);
			items.push({ id: 'fridge', label: 'Drinks Fridge', title: 'Drinks fridge', text: 'Cold Angkor beer, sugarcane juice, coconut water and soy milk.', x: ix, z: iz, y: 1.2 });
		}
		const shelf = (x: number, sz0: number, sz1: number, facing: number) => {
			const xb = x,
				xf = x + facing * 0.4;
			const [sx0, sx1] = [Math.min(xb, xf), Math.max(xb, xf)];
			// Shorten it until it is clear of doorways and other furniture.
			while (sz1 - sz0 > 1.2 && !free(room, [sx0, sx1, sz0, sz1])) sz0 += 0.2;
			if (sz1 - sz0 <= 1.2 || !free(room, [sx0, sx1, sz0, sz1])) return false;
			b.as('metal').box(sx0, sx1, 0, 1.8, sz0, sz0 + 0.03, hex('#8c9aa3'));
			b.box(sx0, sx1, 0, 1.8, sz1 - 0.03, sz1, hex('#8c9aa3'));
			b.box(facing > 0 ? sx0 : sx1 - 0.03, facing > 0 ? sx0 + 0.03 : sx1, 0, 1.8, sz0, sz1, hex('#8c9aa3'));
			for (const y of [0.1, 0.55, 1.0, 1.45]) {
				b.as('metal').box(sx0, sx1, y, y + 0.03, sz0, sz1, hex('#d5dbe0'));
				b.as('card');
				for (let z = sz0 + 0.06; z < sz1 - 0.12; z += 0.16) {
					const hgt = 0.14 + r() * 0.2;
					const tone = ['#d23b2f', '#f2c230', '#2f7bd2', '#3fa34d', '#f08a24', '#7c4bc9', '#f4f1ea'][Math.floor(r() * 7)];
					b.box(sx0 + 0.05, sx1 - 0.05, y + 0.03, y + 0.03 + hgt, z + 0.01, Math.min(sz1 - 0.06, z + 0.12), hex(tone));
				}
			}
			b.as('paint');
			block(sx0, sx1, sz0, sz1);
			return true;
		};
		const sz0 = z0 + 0.3,
			sz1 = z1 - 2.0;
		if (sz1 - sz0 > 1.2) {
			const a = shelf(x0, sz0, sz1, 1);
			shelf(x1, sz0, sz1, -1);
			if (W >= 5.4) {
				shelf(-0.42, sz0 + 0.8, sz1 - 0.4, 1);
				shelf(0.42, sz0 + 0.8, sz1 - 0.4, -1);
			}
			if (a) items.push({ id: 'snacks', label: 'Snacks', title: 'Snack shelf', text: 'Prawn crackers, dried mango, Khmer coffee sachets and instant noodles.', x: x0 + 0.4, z: (sz0 + sz1) / 2, y: 1.2 });
		}
		if (!storeBehind) riceSacks(room, side > 0 ? 0.85 : 0.15);
		for (let x = x0 + 1.0; x < x1 - 0.5; x += 1.6) for (let z = z0 + 1.2; z < z1 - 0.5; z += 2.2) tube(room, x, z);
	}

	function riceSacks(room: RoomPlan, prefer: number) {
		const spot = mount(room, 'back', 0.74, 0.5, prefer) ?? mount(room, 'left', 0.74, 0.5, 0.5) ?? mount(room, 'right', 0.74, 0.5, 0.5);
		if (!spot) return;
		const [rx0, rx1, rz0, rz1] = spot.rect;
		b.as('fabric');
		for (let k = 0; k < 3; k++) b.box(rx0 + 0.02, rx1 - 0.02, k * 0.22, k * 0.22 + 0.22, rz0 + 0.02, rz1 - 0.02, hex(k % 2 ? '#e9e1cf' : '#d8ccb0'));
		b.as('paint');
		ctx.blockers.push(spot.rect);
		const [ix, iz] = toB(spot, 0, 0.8);
		items.push({ id: 'rice', label: 'Rice', title: 'Rice sacks', text: 'Jasmine rice from Battambang, sold by the kilo or by the 25 kg sack.', x: ix, z: iz, y: 0.6 });
	}

	function store(room: RoomPlan) {
		const [x0, x1, z0, z1] = room.rect;
		// Steel racks of cartons along the back wall, stacks on the floor, a desk with the ledger.
		const rack = mount(room, 'back', Math.min(3.0, x1 - x0 - 1.4), 0.5, 0.5);
		if (rack) {
			const L = rack.rect[1] - rack.rect[0];
			b.at(rack.x, rack.z, rack.yaw).as('metal');
			for (const lx of [-L / 2, L / 2 - 0.04]) b.box(lx, lx + 0.04, 0, 2.0, 0, 0.5, hex('#5d6770'));
			for (const y of [0.15, 0.85, 1.55]) {
				b.as('metal').box(-L / 2, L / 2, y, y + 0.03, 0, 0.5, hex('#8c9aa3'));
				b.as('card');
				for (let x = -L / 2 + 0.08; x < L / 2 - 0.4; x += 0.42) b.box(x, x + 0.38, y + 0.03, y + 0.33 + r() * 0.1, 0.05, 0.45, hex(r() > 0.3 ? '#b88a55' : '#d9c7a0'));
			}
			b.at(0, 0, 0).as('paint');
			ctx.blockers.push(rack.rect);
		}
		riceSacks(room, 0.1);
		const desk = mount(room, 'left', 1.1, 0.6, 0.6) ?? mount(room, 'right', 1.1, 0.6, 0.6);
		if (desk) {
			b.at(desk.x, desk.z, desk.yaw).as('wood');
			b.box(-0.55, 0.55, 0.72, 0.76, 0, 0.6, hex('#7a5232'));
			for (const lx of [-0.5, 0.5]) b.box(lx - 0.03, lx + 0.03, 0, 0.72, 0.05, 0.55, hex('#5a3824'));
			b.as('card').box(-0.2, 0.15, 0.76, 0.8, 0.2, 0.45, hex('#2f5d8c'));
			b.at(0, 0, 0).as('paint');
			ctx.blockers.push(desk.rect);
			const [ix, iz] = toB(desk, 0, 0.9);
			items.push({ id: 'ledger', label: 'Stock Book', title: 'Stock book', text: 'Water: 40 cases. Rice: 12 sacks. Instant noodles: order more before the weekend.', x: ix, z: iz, y: 0.9 });
		}
		for (let k = 0; k < 4; k++) {
			const cx = x0 + 0.5 + r() * (x1 - x0 - 1),
				cz = z0 + 0.8 + r() * Math.max(0, z1 - z0 - 1.6);
			if (free(room, [cx - 0.3, cx + 0.3, cz - 0.25, cz + 0.25], 0.3)) {
				const hgt = 0.3 + Math.floor(r() * 3) * 0.3;
				b.as('card').box(cx - 0.3, cx + 0.3, 0, hgt, cz - 0.25, cz + 0.25, hex('#b88a55'));
				b.as('paint');
				block(cx - 0.3, cx + 0.3, cz - 0.25, cz + 0.25);
			}
		}
		tube(room, (x0 + x1) / 2, (z0 + z1) / 2);
	}

	function dining(room: RoomPlan) {
		const [x0, x1, z0, z1] = room.rect;
		const W = x1 - x0;
		// The counter along the back wall (clear of the kitchen door): an espresso machine, a pastry
		// case, the menu board above and cups on a shelf.
		const cw = Math.min(W - 1.6, 3.6);
		const counter = mount(room, 'back', cw, 1.28, 0.95) ?? mount(room, 'back', Math.max(1.6, cw - 1.0), 1.28, 0.95);
		if (counter) {
			const L = counter.rect[1] - counter.rect[0];
			const cx0 = counter.rect[0];
			const cz = z0 + 0.95;
			b.as('wood').box(cx0, cx0 + L, 0, 1.0, cz - 0.3, cz + 0.3, hex('#6b4530'));
			b.as('ceramic').box(cx0 - 0.03, cx0 + L + 0.03, 1.0, 1.04, cz - 0.33, cz + 0.33, hex('#d9cbb3'));
			ctx.blockers.push([cx0, cx0 + L, cz - 0.33, cz + 0.33]);
			const mx = cx0 + L - 0.5;
			b.as('metal').box(mx - 0.25, mx + 0.25, 1.04, 1.5, cz - 0.2, cz + 0.12, hex('#b8bcbf'));
			b.box(mx - 0.2, mx + 0.2, 1.3, 1.36, cz + 0.12, cz + 0.2, hex('#2a2c2e'));
			b.as('paint');
			toggled('Steam', (mb) => {
				for (let k = 0; k < 3; k++) mb.cylinder(mx - 0.08 + k * 0.08, cz + 0.16, 1.16 + k * 0.05, 1.3 + k * 0.08, 0.025, hex('#ffffff'), 6, [1.4, 0.5], 0.04);
			});
			toggles.push({ id: 'coffee', label: 'Coffee Machine', node: 'Steam', kind: 'flame', x: mx, z: cz + 0.3, y: 1.3 });
			const px = cx0 + 0.75;
			if (L > 2.2) {
				b.as('glass').box(px - 0.55, px + 0.55, 1.04, 1.38, cz - 0.1, cz + 0.3, hex('#cfe0e6'), [1.0, 0.8]);
				b.as('paint');
				for (let k = 0; k < 6; k++) b.cylinder(px - 0.4 + k * 0.16, cz + 0.1, 1.08, 1.14, 0.05, hex(k % 2 ? '#d7a24a' : '#8a4a2a'), 8);
				items.push({ id: 'pastries', label: 'Pastries', title: 'Pastry case', text: 'Croissants, num kom and banana cake, baked this morning.', x: px, z: cz + 0.3, y: 1.2 });
			}
			const mbx = cx0 + L / 2;
			b.box(mbx - 0.7, mbx + 0.7, 1.6, 2.4, z0 + 0.01, z0 + 0.04, hex('#2b2b2b'));
			for (let k = 0; k < 5; k++) b.box(mbx - 0.55, mbx + 0.25 - (k % 2) * 0.2, 2.25 - k * 0.13, 2.28 - k * 0.13, z0 + 0.04, z0 + 0.045, hex('#f1e9d8'), [0.9, 0.3]);
			items.push({ id: 'menu', label: 'Menu', title: 'Menu', text: 'Iced coffee with condensed milk · lemongrass tea · fresh coconut · num pang · mango sticky rice.', x: mbx, z: z0 + 0.6, y: 2.0 });
			b.as('wood').box(cx0, cx0 + L, 1.75, 1.78, z0, z0 + 0.25, hex('#6b4530'));
			b.as('ceramic');
			for (let k = 0; k < Math.floor(L / 0.18); k++) b.cylinder(cx0 + 0.1 + k * 0.18, z0 + 0.12, 1.78, 1.86, 0.04, hex(k % 3 ? '#f4f1ea' : '#3e6fa3'), 8);
			b.as('paint');
			lampAt(room, mbx, cz, 0.6, 0.6, '#c9894a');
		}
		// Tables for two in a roomy grid, keeping an aisle from the door to the counter and a
		// wide one along the counter (where people queue, and the way to the kitchen).
		let n = 0;
		const cz = z0 + 0.95;
		// (The first row stands back from the windows, where one lands climbing in.)
		for (let z = z1 - (windows.length ? 2.25 : 1.4); z > cz + 2.1; z -= 2.3)
			for (let x = x0 + 0.95; x < x1 - 0.85; x += 2.2) {
				if (Math.abs(x - dx) < 1.0 && z > z1 - 2.6) continue;
				if (!free(room, [x - 0.38, x + 0.38, z - 1.0, z + 1.0])) continue;
				n++;
				b.at(x, z).as('ceramic');
				b.box(-0.36, 0.36, 0.72, 0.75, -0.36, 0.36, hex('#d9cbb3'));
				b.as('metal').cylinder(0, 0, 0, 0.72, 0.04, hex('#2a2c2e'), 8);
				b.box(-0.25, 0.25, 0, 0.02, -0.25, 0.25, hex('#2a2c2e'));
				b.as('ceramic').cylinder(0.1, 0.05, 0.75, 0.83, 0.035, hex('#f4f1ea'), 8);
				b.as('glass').cylinder(-0.05, -0.1, 0.75, 0.84, 0.03, hex('#6db33f'), 6);
				b.at(0, 0, 0).as('paint');
				block(x - 0.38, x + 0.38, z - 0.38, z + 0.38);
				chair(x, z - 0.6, 0, `t${n}a`);
				chair(x, z + 0.6, Math.PI, `t${n}b`);
				tables.push({ id: `table${n}`, label: 'Table', rect: [x - 0.36, x + 0.36, z - 0.36, z + 0.36], seats: [`t${n}a`, `t${n}b`] });
				lampAt(room, x, z, 0.65, 0.7, '#c9894a');
			}
		plant(room, x0 + 0.4, z0 + 0.4);
		plant(room, x1 - 0.4, z1 - 0.45);
		const art = mount(room, 'left', 1.0, 0.04, 0.5);
		if (art) onWall(art, 1.4, 2.1, 0.5, '#3e2a1e', '#b5552f', [0.9, 0.5], { id: 'art', label: 'Painting', title: 'Painting', text: 'Boats on the Tonle Sap at dusk, by a local artist.' });
	}

	/** The System Office's hall: the service counter along the back wall (a glass screen with
	 * two windows, the registration sign above), rows of waiting chairs facing it with an aisle
	 * from the door, a ticket machine and the notice board. */
	function hall(room: RoomPlan) {
		const [x0, x1, z0, z1] = room.rect;
		const W = x1 - x0;
		const cz = z0 + 0.95;
		const cw = Math.min(W - 1.4, 4.4);
		const counter = mount(room, 'back', cw, 1.3, 0.5) ?? mount(room, 'back', Math.max(1.8, cw - 1.2), 1.3, 0.5);
		if (counter) {
			const L = counter.rect[1] - counter.rect[0];
			const cx0 = counter.rect[0];
			const mid = cx0 + L / 2;
			b.as('wood').box(cx0, cx0 + L, 0, 1.05, cz - 0.3, cz + 0.3, hex('#2f5f59'));
			b.as('ceramic').box(cx0 - 0.03, cx0 + L + 0.03, 1.05, 1.09, cz - 0.33, cz + 0.33, hex('#ece8dc'));
			ctx.blockers.push([cx0 - 0.03, cx0 + L + 0.03, cz - 0.33, cz + 0.33]);
			// The glass screen, with a frame between the two windows and a pass-through slot.
			b.as('glass').box(cx0, cx0 + L, 1.09, 1.95, cz - 0.02, cz + 0.02, hex('#9cc8d2'), [1.0, 0.8]);
			b.as('metal');
			for (const fx of [cx0, mid, cx0 + L]) b.box(fx - 0.03, fx + 0.03, 1.09, 1.95, cz - 0.04, cz + 0.04, hex('#9aa3a8'));
			b.box(cx0, cx0 + L, 1.93, 1.97, cz - 0.04, cz + 0.04, hex('#9aa3a8'));
			// Behind it: two screens on the desk.
			for (const wx of [cx0 + L * 0.25, cx0 + L * 0.75]) {
				b.box(wx - 0.22, wx + 0.22, 1.12, 1.42, cz - 0.24, cz - 0.2, hex('#2a2c2e'));
				b.as('glass').box(wx - 0.19, wx + 0.19, 1.15, 1.39, cz - 0.2, cz - 0.19, hex('#7fb7c4'), [1.2, 0.9]);
				b.as('metal');
			}
			// The sign above: "Work roles · registration" (a dark board with light lettering).
			b.as('paint').box(mid - 1.0, mid + 1.0, 2.1, 2.55, z0 + 0.01, z0 + 0.04, hex('#123b3a'));
			for (let k = 0; k < 3; k++) b.box(mid - 0.8, mid + 0.8 - k * 0.35, 2.42 - k * 0.12, 2.46 - k * 0.12, z0 + 0.04, z0 + 0.045, hex('#f6f1e6'), [1.0, 0.4]);
			// Where the player is served: in front of the left window.
			services.push({ id: 'roles', label: 'Register a Work Role', x: cx0 + L * 0.25, z: cz + 0.8 });
			lampAt(room, mid, cz + 0.4, 0.5, 0.8);
		}
		// Rows of chairs facing the counter, clear of the way from the door to it.
		let n = 0;
		for (let z = z1 - (windows.length ? 2.2 : 1.4); z > cz + 2.0; z -= 1.5)
			for (let x = x0 + 0.8; x < x1 - 0.6; x += 0.62) {
				if (Math.abs(x - dx) < 1.0) continue;
				if (!free(room, [x - 0.3, x + 0.3, z - 0.3, z + 0.9])) continue;
				n++;
				chair(x, z, Math.PI, `wait${n}`, [0, 1]);
				block(x - 0.25, x + 0.25, z - 0.25, z + 0.25);
			}
		// A ticket machine by the door.
		const tx = dx + (dx > (x0 + x1) / 2 ? -1.2 : 1.2);
		if (free(room, [tx - 0.25, tx + 0.25, z1 - 0.9, z1 - 0.4])) {
			b.as('metal').box(tx - 0.2, tx + 0.2, 0, 1.25, z1 - 0.85, z1 - 0.45, hex('#2f6f68'));
			b.as('glass').box(tx - 0.14, tx + 0.14, 0.9, 1.15, z1 - 0.86, z1 - 0.85, hex('#9fd0d8'), [1.2, 0.9]);
			b.as('paint');
			block(tx - 0.22, tx + 0.22, z1 - 0.87, z1 - 0.43);
			items.push({ id: 'ticket', label: 'Ticket Machine', title: 'Ticket machine', text: 'Take a number and wait to be called to a window. Today the queue is short.', x: tx, z: z1 - 1.2, y: 1.0 });
		}
		const notice = mount(room, 'left', 1.4, 0.04, 0.4) ?? mount(room, 'right', 1.4, 0.04, 0.4);
		if (notice)
			onWall(notice, 1.2, 2.1, 0.7, '#123b3a', '#f6f1e6', [1.0, 0.5], {
				id: 'notice',
				label: 'Notice Board',
				title: 'Work roles',
				text: 'Seller: open a shop on a real street of Daun Penh (an administrator checks your business first). Driver: deliver orders across the city (an administrator approves you). One work role at a time. Register at the counter.'
			});
		plant(room, x0 + 0.4, z1 - 0.45);
		plant(room, x1 - 0.4, z1 - 0.45);
		tube(room, (x0 + x1) / 2, (z0 + z1) / 2 + 1);
	}

	/** Behind the hall: file shelves along the back wall and a clerk's desk. */
	function records(room: RoomPlan) {
		const [x0, x1, z0, z1] = room.rect;
		const shelf = mount(room, 'back', Math.min(x1 - x0 - 1.0, 3.6), 0.4, 0.5);
		if (shelf) {
			const L = shelf.rect[1] - shelf.rect[0];
			const sx0 = shelf.rect[0];
			b.as('metal').box(sx0, sx0 + L, 0, 2.0, z0, z0 + 0.38, hex('#8a9196'));
			b.as('card');
			for (let k = 0; k < 4; k++)
				for (let j = 0; j < Math.floor(L / 0.12); j++)
					b.box(sx0 + 0.05 + j * 0.12, sx0 + 0.14 + j * 0.12, 0.15 + k * 0.48, 0.45 + k * 0.48, z0 + 0.05, z0 + 0.33, hex(['#2f6f68', '#c9894a', '#8a4a2a', '#e8dcc4'][(j + k) % 4]));
			b.as('paint');
			ctx.blockers.push(shelf.rect);
			const [ix, iz] = toB(shelf, 0, 0.9);
			items.push({ id: 'archive', label: 'Files', title: 'Registry files', text: 'A binder for every shop and driver registered in Daun Penh, filed by street and number.', x: ix, z: iz, y: 1.1 });
		}
		const desk = mount(room, 'right', 1.2, 0.6, 0.6) ?? mount(room, 'left', 1.2, 0.6, 0.6);
		if (desk) {
			const [ax, az] = toB(desk, 0, 0.3);
			b.at(ax, az, desk.yaw).as('wood');
			b.box(-0.6, 0.6, 0.72, 0.76, -0.3, 0.3, hex('#6b4530'));
			for (const lx of [-0.55, 0.55]) b.box(lx - 0.03, lx + 0.03, 0, 0.72, -0.27, 0.27, hex('#6b4530'));
			b.as('card').box(-0.25, 0.15, 0.76, 0.8, -0.15, 0.15, hex('#f4f1ea'));
			b.at(0, 0, 0).as('paint');
			ctx.blockers.push(desk.rect);
		}
		tube(room, (x0 + x1) / 2, (z0 + z1) / 2);
	}

	function galley(room: RoomPlan) {
		const [x0, x1, z0, z1] = room.rect;
		// Counters along the back wall: two wok burners, a sink; a fridge; rice and a recipe board.
		const counter = mount(room, 'back', Math.min(3.6, x1 - x0 - 1.2), 0.65, 0.6);
		if (counter) {
			const L = counter.rect[1] - counter.rect[0];
			b.at(counter.x, counter.z, counter.yaw).as('metal');
			b.box(-L / 2, L / 2, 0, 0.88, 0, 0.65, hex('#b8bcbf'));
			b.box(-L / 2, L / 2, 0.88, 0.91, 0, 0.66, hex('#d5dbe0'));
			for (const ox of [-L / 2 + 0.4, -L / 2 + 1.0]) b.cylinder(ox, 0.33, 0.91, 1.05, 0.22, hex('#2a2c2e'), 12, null, 0.26);
			b.box(L / 2 - 0.7, L / 2 - 0.15, 0.85, 0.92, 0.12, 0.5, hex('#9aa3a8'));
			b.at(0, 0, 0).as('paint');
			ctx.blockers.push(counter.rect);
			toggled('Flame_wok', (mb) => {
				for (const ox of [-L / 2 + 0.4, -L / 2 + 1.0]) {
					const [fx, fz] = toB(counter, ox, 0.33);
					mb.cylinder(fx, fz, 0.9, 0.97, 0.12, hex('#ff8a2a'), 10, [1.8, 0.6], 0.04);
				}
			});
			const [tx, tz] = toB(counter, -L / 2 + 0.7, 1.0);
			toggles.push({ id: 'wok', label: 'Wok Burner', node: 'Flame_wok', kind: 'flame', x: tx, z: tz, y: 1.0 });
			onWall({ ...counter, x: counter.x + L / 2 - 0.4 }, 1.4, 1.9, 0.35, '#5a3824', '#f1e9d8', [0.9, 0.3], { id: 'recipes', label: 'Recipes', title: 'Recipe board', text: 'Fish amok, beef lok lak, num banh chok with green curry, and today: mango sticky rice.' });
		}
		const fridge = mount(room, 'right', 0.75, 0.7, 0.3) ?? mount(room, 'left', 0.75, 0.7, 0.3);
		if (fridge) {
			b.at(fridge.x, fridge.z, fridge.yaw).as('metal');
			b.box(-0.37, 0.37, 0, 1.9, 0, 0.7, hex('#d5dbe0'));
			b.at(0, 0, 0).as('paint');
			ctx.blockers.push(fridge.rect);
		}
		riceSacks(room, 0.95);
		tube(room, (x0 + x1) / 2, (z0 + z1) / 2);
	}

	/** Furnish the storey being built, and put light switches by the ways into its rooms. */
	function furnish(): Map<string, [number, number, number]> {
		const kinds = new Set(rooms.map((rm) => rm.kind));
		for (const room of rooms) {
			current = room;
			if (room.kind === 'living') living(room, !kinds.has('kitchen'));
			else if (room.kind === 'family') {
				living(room, false);
				if (rooms.length === 1) bedroom(room);
			} else if (room.kind === 'bedroom') bedroom(room);
			else if (room.kind === 'kitchen') kitchen(room, true);
			else if (room.kind === 'bathroom') bathroom(room);
			else if (room.kind === 'sales') sales(room, kinds.has('store'));
			else if (room.kind === 'store') store(room);
			else if (room.kind === 'dining') dining(room);
			else if (room.kind === 'hall') hall(room);
			else if (room.kind === 'records') records(room);
			else galley(room);
		}
		// A single-room home deep enough for it: the bed at the back.
		if (L === 0 && type === 'house' && rooms.length === 1 && d > 7) {
			const [x0, , z0] = entrance.rect;
			const bz = z0 + 1.05;
			const bed: Rect = [x0 + 0.38, x0 + 2.02, z0, bz + 1.0];
			if (free(entrance, bed)) {
				b.at(x0 + 1.2, bz).as('fabric');
				b.box(-0.8, 0.8, 0.12, 0.52, -1.0, 1.0, hex('#efe9df'));
				b.box(-0.82, 0.82, 0.5, 0.55, -0.3, 1.0, hex('#b0262c'));
				b.as('wood').box(-0.85, 0.85, 0.12, 1.1, -1.05, -0.98, hex('#5a3824'));
				b.at(0, 0, 0).as('paint');
				ctx.blockers.push(bed);
				seats.push({ id: 'bed', label: 'bed', x: x0 + 1.2, z: bz + 0.7, yaw: 0, height: 0.52, stand: [x0 + 1.2, bz + 1.35] });
			}
		}
		// Light switches: in every room of a home (upstairs, every building is one), beside the
		// way in; the family room's at the head of the stairs.
		const switches = new Map<string, [number, number, number]>();
		if (type === 'house' || L > 0)
			for (const room of rooms) {
				const [x0, x1, z0, z1] = room.rect;
				if (L > 0 && room === entrance && flight) {
					const [hx0, hx1, hz0, hz1] = flight.head;
					// On the wall the stairs run along, beside their head.
					const sx = flight.axis === 'x' ? (hx0 + hx1) / 2 : hx0 - x0 < x1 - hx1 ? x0 + 0.05 : x1 - 0.05;
					const sz = flight.axis === 'x' ? (hz0 - z0 < z1 - hz1 ? z0 + 0.05 : z1 - 0.05) : (hz0 + hz1) / 2;
					switches.set(room.id, [sx, sz, 1.3]);
					continue;
				}
				const way = room === entrance ? g0 : (doors.find((dr) => dr.back === room.id)?.x ?? 0) - INNER_DOOR.width / 2;
				const gb = room === entrance ? g1 : way + INNER_DOOR.width;
				const sx = way - 0.3 >= x0 + 0.2 ? way - 0.3 : Math.min(x1 - 0.2, gb + 0.3);
				switches.set(room.id, [sx, z1 - 0.05, 1.3]);
			}
		return switches;
	}

	/** The storey's meshes: its merged interior and its small parts (switch plates, toggled
	 * parts), raised to its floor. */
	function storeyMeshes(suffix: string, y: number, switches: Map<string, [number, number, number]>) {
		const interior = lit(b);
		interior.name = `Interior${suffix}`;
		interior.position.y = y;
		root.add(interior);
		if (switches.size) {
			const sb = new MeshBuilder().as('ceramic');
			for (const [sx, sz] of switches.values()) sb.box(sx - 0.04, sx + 0.04, 1.24, 1.36, sz - 0.03, sz + 0.03, hex('#f4f4f2'), [0.8, 0.6]);
			extra.add(lit(sb));
		}
		extra.name = `Extras${suffix}`;
		extra.position.y = y;
		root.add(extra);
	}

	// ── The ground floor ───────────────────────────────────────────────────────────────────
	shell(null, flight?.rect ?? null);
	if (flight) stairs(flight);
	// The entrance: the reveal through the outside wall to the facade, a sill and a frame.
	const fz = d / 2 + plan.wall;
	const entranceWall = hex(STYLE[entrance.kind].wall);
	b.quad([g0, 0, fz], [g0, 0, d / 2], [g0, DOOR_H, d / 2], [g0, DOOR_H, fz], entranceWall, 'wall'); // faces +X
	b.quad([g1, 0, d / 2], [g1, 0, fz], [g1, DOOR_H, fz], [g1, DOOR_H, d / 2], entranceWall, 'wall'); // faces -X
	b.quad([g0, DOOR_H, d / 2], [g1, DOOR_H, d / 2], [g1, DOOR_H, fz], [g0, DOOR_H, fz], entranceWall, 'wall'); // faces down
	b.as('concrete').quad([g0, 0.002, fz], [g1, 0.002, fz], [g1, 0.002, d / 2], [g0, 0.002, d / 2], hex('#9a948a'), 'floor');
	b.quad([g0, -FLOOR_LIFT, fz], [g1, -FLOOR_LIFT, fz], [g1, 0.002, fz], [g0, 0.002, fz], hex('#8a847a'), 'wall'); // the sill's front, down to the street
	b.as(type === 'cafe' ? 'wood' : 'paint');
	b.box(g0 - 0.08, g0, 0, DOOR_H + 0.08, d / 2 - 0.02, d / 2, trim);
	b.box(g1, g1 + 0.08, 0, DOOR_H + 0.08, d / 2 - 0.02, d / 2, trim);
	b.box(g0 - 0.08, g1 + 0.08, DOOR_H, DOOR_H + 0.08, d / 2 - 0.02, d / 2, trim);
	// Windows on the street front: a casement that opens in each (in the middle of a
	// shopfront, the rest painted glass), or painted glass where the facade is not straight.
	regions.forEach(([ra, rb], k) => {
		const wn = windows.find((x) => x.region === k);
		if (!wn) return pane(ra, rb, sill, windowTop);
		pane(ra, wn.a - 0.06, sill, windowTop);
		pane(wn.b + 0.06, rb, sill, windowTop);
		// The reveal through the wall to the facade (jambs, head, sill), a sill board, a frame.
		const [ga, gb, y0, y1] = [wn.a, wn.b, sill, windowTop];
		b.quad([ga, y0, fz], [ga, y0, d / 2], [ga, y1, d / 2], [ga, y1, fz], entranceWall, 'wall'); // faces +X
		b.quad([gb, y0, d / 2], [gb, y0, fz], [gb, y1, fz], [gb, y1, d / 2], entranceWall, 'wall'); // faces -X
		b.quad([ga, y1, d / 2], [gb, y1, d / 2], [gb, y1, fz], [ga, y1, fz], entranceWall, 'wall'); // faces down
		b.quad([ga, y0, fz], [gb, y0, fz], [gb, y0, d / 2], [ga, y0, d / 2], entranceWall, 'wall'); // faces up
		b.as(type === 'cafe' ? 'wood' : 'paint').box(ga - 0.06, gb + 0.06, y0 - 0.04, y0, d / 2 - 0.14, d / 2, trim);
		b.box(ga - 0.06, ga, y0, y1 + 0.06, d / 2 - 0.02, d / 2, trim);
		b.box(gb, gb + 0.06, y0, y1 + 0.06, d / 2 - 0.02, d / 2, trim);
		b.box(ga - 0.06, gb + 0.06, y1, y1 + 0.06, d / 2 - 0.02, d / 2, trim);
		b.as('paint');
	});
	b.as('paint');
	const switches0 = furnish();
	const storeys: { level: number; doors: InnerDoor[]; light: LightContext }[] = [{ level: 0, doors, light: ctx }];
	storeyMeshes('', FLOOR_LIFT, switches0);
	const blockers0 = ctx.blockers;
	const allSwitches = new Map(switches0);

	// ── The upper floor ────────────────────────────────────────────────────────────────────
	let blockers1: Rect[] = [];
	if (upper && flight) {
		const marks = { seats: seats.length, tables: tables.length, items: items.length, toggles: toggles.length };
		L = 1;
		rooms = upper.rooms;
		doors = upper.doors;
		entrance = rooms[0];
		current = entrance;
		b = new MeshBuilder();
		ctx = { rooms, entrance: entrance.id, D: d, ceiling: H, lamps: [], blockers: [] };
		clear = [...zones(upper, false), flight.rect, flight.head, flight.headWay];
		extra = new THREE.Group();
		shell(flight.rect, null);
		railing(flight);
		// Windows on the street front, evenly along it.
		const n = Math.max(1, Math.floor((w - 0.8) / 2.4));
		for (let k = 0; k < n; k++) {
			const cx = -w / 2 + (w / n) * (k + 0.5);
			pane(cx - 0.7, cx + 0.7, 1.0, Math.min(top, 2.2));
		}
		const switches1 = furnish();
		// Upstairs things get their own ids and the level they are on.
		const up = (id: string) => `${id}_up`;
		for (const s of seats.slice(marks.seats)) Object.assign(s, { id: up(s.id), level: 1 });
		for (const t of tables.slice(marks.tables)) Object.assign(t, { id: up(t.id), seats: t.seats.map(up), level: 1 });
		for (const it of items.slice(marks.items)) Object.assign(it, { id: up(it.id), level: 1 });
		for (const tg of toggles.slice(marks.toggles)) Object.assign(tg, { id: up(tg.id), node: up(tg.node), level: 1 });
		for (const child of extra.children) if (child.name) child.name = up(child.name);
		storeyMeshes('_1', FLOOR_LIFT + storey, switches1);
		blockers1 = ctx.blockers;
		for (const [k, v] of switches1) allSwitches.set(k, v);
		storeys.push({ level: 1, doors, light: ctx });
	}

	// ── Door leaves and the sign ───────────────────────────────────────────────────────────
	/** A door leaf on its hinge, lit where it stands (by its storey's lamps), its node's origin
	 * on the hinge. */
	const leafNode = (node: string, hingeX: number, hingeZ: number, level: number, draw: (mb: MeshBuilder) => void) => {
		const lb = new MeshBuilder().at(hingeX, hingeZ);
		draw(lb);
		const leaf = new THREE.Mesh(lb.geometry(lightUp(lb, storeys[level].light)).translate(-hingeX, 0, -hingeZ), interiorMaterial(uniforms));
		const y = FLOOR_LIFT + level * storey;
		const group = new THREE.Group();
		group.name = node;
		group.position.set(hingeX, y, hingeZ);
		group.add(leaf);
		root.add(group);
	};
	const hingeX = g0 + 0.02,
		hingeZ = d / 2 + plan.wall / 2;
	const leafW = plan.doorWidth - 0.04;
	leafNode('Door_front', hingeX, hingeZ, 0, (lb) => {
		if (type === 'house') {
			lb.as('wood').box(0, leafW, 0.01, DOOR_H - 0.01, -0.025, 0.025, hex('#6e3f22'));
			lb.as('metal').box(leafW - 0.16, leafW - 0.06, 1.0, 1.03, -0.06, 0.06, hex('#c8a24a'));
		} else {
			const frame = hex('#9aa3a8');
			lb.as('metal').box(0, leafW, 0.01, 0.12, -0.025, 0.025, frame);
			lb.box(0, leafW, DOOR_H - 0.12, DOOR_H - 0.01, -0.025, 0.025, frame);
			lb.box(0, 0.06, 0.12, DOOR_H - 0.12, -0.025, 0.025, frame);
			lb.box(leafW - 0.06, leafW, 0.12, DOOR_H - 0.12, -0.025, 0.025, frame);
			lb.as('glass').box(0.06, leafW - 0.06, 0.12, DOOR_H - 0.12, -0.01, 0.01, hex('#bcd3dc'), [0.9, 0.4]);
			lb.as('metal').box(leafW - 0.16, leafW - 0.12, 0.8, 1.3, -0.06, 0.06, hex('#d0d4d6'));
		}
	});
	const doorSpecs: DoorSpec[] = [
		{ id: 'front', label: 'Door', node: 'Door_front', hinge: [hingeX, hingeZ], width: leafW, thickness: 0.05, height: DOOR_H, openYaw: Math.PI / 2, center: [dx, hingeZ], outward: [0, 1] }
	];
	const innerW = INNER_DOOR.width - 0.04;
	for (const { level, doors: ds } of storeys)
		for (const dr of ds) {
			const hx = dr.x - INNER_DOOR.width / 2 + 0.02;
			const node = `Inner_${dr.id}`;
			leafNode(node, hx, dr.z, level, (lb) => {
				lb.as('wood').box(0, innerW, 0.01, INNER_DOOR.height - 0.01, -0.02, 0.02, hex('#8a5a36'));
				lb.box(0.1, innerW - 0.1, 0.2, 0.95, -0.025, 0.025, hex('#7a4c2c'));
				lb.box(0.1, innerW - 0.1, 1.1, INNER_DOOR.height - 0.15, -0.025, 0.025, hex('#7a4c2c'));
				lb.as('metal').box(innerW - 0.14, innerW - 0.06, 0.98, 1.01, -0.05, 0.05, hex('#c8a24a'));
			});
			doorSpecs.push({ id: dr.id, label: dr.label, node, hinge: [hx, dr.z], width: innerW, thickness: 0.04, height: INNER_DOOR.height, openYaw: Math.PI / 2, center: [dr.x, dr.z], outward: [0, 1], level });
		}
	// The windows' casements, hinged on their left jamb like the doors, swinging in.
	for (const wn of windows) {
		const hx = wn.a + 0.02,
			hz = d / 2 + plan.wall / 2;
		const lw = wn.b - wn.a - 0.04,
			lh = windowTop - sill - 0.02;
		const node = `Window_${wn.id}`;
		leafNode(node, hx, hz, 0, (lb) => {
			const frame = hex(type === 'cafe' ? '#3e2a1e' : type === 'shop' ? '#9aa3a8' : '#6e4a2c');
			const y = sill + 0.01;
			lb.as(type === 'shop' ? 'metal' : 'wood').box(0, lw, y, y + 0.07, -0.02, 0.02, frame);
			lb.box(0, lw, y + lh - 0.07, y + lh, -0.02, 0.02, frame);
			lb.box(0, 0.06, y + 0.07, y + lh - 0.07, -0.02, 0.02, frame);
			lb.box(lw - 0.06, lw, y + 0.07, y + lh - 0.07, -0.02, 0.02, frame);
			lb.as('glass').box(0.06, lw - 0.06, y + 0.07, y + lh - 0.07, -0.008, 0.008, hex('#cfe2ea'), [0.7, 0.3]);
			lb.as('metal').box(lw - 0.14, lw - 0.1, y + lh / 2 - 0.08, y + lh / 2 + 0.08, -0.05, 0.05, hex('#c8a24a'));
		});
		doorSpecs.push({ id: wn.id, label: 'Window', node, hinge: [hx, hz], width: lw, thickness: 0.04, height: lh, openYaw: Math.PI / 2, center: [wn.x, hz], outward: [0, 1], level: 0, kind: 'window', sill });
	}

	const pal = SIGN_NAMES[type];
	addSign(root, type, plan, name);

	// ── The spec: rooms and their lights, collision, doors, stairs, things to do ──────────────
	const rect = (x0: number, x1: number, z0: number, z1: number): XZ[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
	const ring = ([x0, x1, z0, z1]: Rect) => rect(x0, x1, z0, z1);
	const t = 0.1; // collision walls just behind the outer wall faces
	/** A storey's walls: the outside ones (the entrance only on the ground floor), the
	 * partitions with their doorways, and lintels over the doorways. */
	const storeyWalls = (level: number, ds: InnerDoor[]) => {
		const walls: XZ[][] = [rect(-w / 2 - t, w / 2 + t, -d / 2 - t, -d / 2), rect(-w / 2 - t, -w / 2, -d / 2, d / 2), rect(w / 2, w / 2 + t, -d / 2, d / 2)];
		const lift = FLOOR_LIFT + level * storey;
		const lintels: { ring: XZ[]; base: number }[] = [];
		if (level === 0) {
			walls.push(rect(-w / 2 - t, g0, d / 2, d / 2 + t), rect(g1, w / 2 + t, d / 2, d / 2 + t));
			lintels.push({ ring: rect(g0, g1, d / 2, d / 2 + t), base: lift + DOOR_H });
		} else walls.push(rect(-w / 2 - t, w / 2 + t, d / 2, d / 2 + t));
		for (const p of ground.partitions) {
			if (p.axis === 'z') {
				walls.push(rect(p.at - T / 2, p.at + T / 2, p.from, p.to));
				continue;
			}
			const gaps = ds.filter((dr) => Math.abs(dr.z - p.at) < 1e-6).map((dr): Opening => [dr.x - INNER_DOOR.width / 2, dr.x + INNER_DOOR.width / 2, 0, INNER_DOOR.height]);
			for (const [a, c] of spans(p.from, p.to, gaps.sort((m, n) => m[0] - n[0]))) walls.push(rect(a, c, p.at - T / 2, p.at + T / 2));
			for (const [a, c] of gaps) lintels.push({ ring: rect(a, c, p.at - T / 2, p.at + T / 2), base: lift + INNER_DOOR.height });
		}
		// The stairs: below, their sides and the wall under their head (walk on at the foot);
		// above, the railing round the stairwell (step on at the head).
		if (flight) {
			const [x0, x1, z0, z1] = flight.rect;
			const e = 0.03;
			const sides: Rect[] = flight.axis === 'x' ? [[x0, x1, z0 - e, z0 + e], [x0, x1, z1 - e, z1 + e]] : [[x0 - e, x0 + e, z0, z1], [x1 - e, x1 + e, z0, z1]];
			const atHigh = (level === 0) === (flight.dir > 0); // the head end below, the foot end above
			const end: Rect = flight.axis === 'x' ? (atHigh ? [x1 - e, x1 + e, z0, z1] : [x0 - e, x0 + e, z0, z1]) : atHigh ? [x0, x1, z1 - e, z1 + e] : [x0, x1, z0 - e, z0 + e];
			walls.push(...sides.map(ring), ring(end));
		}
		return { walls, lintels };
	};
	const s0 = storeyWalls(0, ground.doors);
	const roomSpecs = (fp: FloorPlan, level: number) => fp.rooms.map((rm) => ({ id: rm.id, name: fp.rooms.length === 1 && level === 0 ? (name ?? pal) : rm.name, rects: [rm.rect], light: rm.channel, level }));
	// Rooms behind the front room have no windows: their lights start on.
	const lightSpecs = (fp: FloorPlan, level: number) => fp.rooms.map((rm, i) => ({ id: rm.id, label: 'Lights', channel: rm.channel, switches: allSwitches.has(rm.id) ? [allSwitches.get(rm.id)!] : [], materials: [], startOn: i > 0, level }));
	const spec: BuildingSpec = {
		version: 2,
		name: name ?? pal,
		model: '',
		floor: FLOOR_LIFT,
		wallTop: FLOOR_LIFT + H,
		roofTop: Math.max(FLOOR_LIFT + H + 0.4, plan.height), // the OSM building around the rooms
		footprint: rect(-w / 2 - plan.wall, w / 2 + plan.wall, -d / 2 - plan.wall, d / 2 + plan.wall),
		interior: { min: [-w / 2, -d / 2], max: [w / 2, d / 2], ceiling: FLOOR_LIFT + H },
		rooms: [...roomSpecs(ground, 0), ...(upper ? roomSpecs(upper, 1) : [])],
		lights: [...lightSpecs(ground, 0), ...(upper ? lightSpecs(upper, 1) : [])],
		walls: s0.walls,
		lintels: s0.lintels,
		doors: doorSpecs,
		steps: [],
		posts: [],
		blockers: blockers0.map(ring),
		seats,
		tables,
		items,
		toggles,
		...(services.length ? { services } : {}),
		fans: []
	};
	if (upper && flight) {
		const s1 = storeyWalls(1, upper.doors);
		spec.levels = [{ floor: FLOOR_LIFT + storey, ceiling: FLOOR_LIFT + storey + H, walls: s1.walls, lintels: s1.lintels, blockers: blockers1.map(ring) }];
		spec.stairs = [{ rect: flight.rect, axis: flight.axis, dir: flight.dir, from: 0, to: 1 }];
	}
	return { spec, root, uniforms };
}

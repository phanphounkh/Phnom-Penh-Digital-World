/**
 * Interiors generated for OpenStreetMap buildings: a café, a shop (mini-mart) or a house, laid
 * out to fit the plan from footprint.ts. Built in the building's local frame (+Z out of the
 * entrance, origin at the room's centre, floor at y = 0) from shared furniture templates, merged
 * into one mesh (one draw call) plus the door leaf and a few small toggled parts.
 *
 * Lighting is computed per vertex at build time — daylight from the shopfront, falling off into
 * the room; warm light from each lamp; soft occlusion in corners, along wall bases and under
 * furniture — and the shader scales it by the city's day/night factor and the lights switch.
 * No textures, no runtime lights.
 */
import * as THREE from 'three';
import type { Plan } from './footprint';
import type { InteriorType } from './osm';
import type { BuildingSpec, SeatSpec, TableSpec, ItemSpec, ToggleSpec, XZ } from './spec';

type V3 = [number, number, number];
type Glow = [number, number] | null;

const DOOR_H = 2.2;
const DAY = { base: 0.34, front: 0.62, reach: 3.2 };
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

/** Accumulates coloured, lit triangles; `transform` places a piece (x, z, yaw) in the room. */
class MeshBuilder {
	pos: number[] = [];
	nor: number[] = [];
	col: number[] = [];
	glow: (Glow | undefined)[] = [];
	kind: ('floor' | 'wall' | 'piece' | 'ceiling')[] = [];
	idx: number[] = [];
	private t = { x: 0, z: 0, c: 1, s: 0 };

	at(x: number, z: number, yaw = 0): this {
		this.t = { x, z, c: Math.cos(yaw), s: Math.sin(yaw) };
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
				this.pos.push(...this.p(q));
				this.nor.push(...n);
				this.col.push(...color);
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

	geometry(light: Float32Array): THREE.BufferGeometry {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
		g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
		g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
		g.setAttribute('light', new THREE.BufferAttribute(light, 2));
		g.setIndex(this.idx);
		g.computeBoundingSphere();
		return g;
	}
}

interface Room {
	w: number;
	d: number;
	ceiling: number;
	doorX: number;
	lamps: { x: number; y: number; z: number; power: number }[];
	blockers: [number, number, number, number][];
}

/** Daylight from the front, lamplight, and occlusion, per vertex. */
function lightUp(b: MeshBuilder, room: Room): Float32Array {
	const n = b.pos.length / 3;
	const out = new Float32Array(n * 2);
	const { w, d } = room;
	for (let i = 0; i < n; i++) {
		const g = b.glow[i];
		if (g) {
			out[i * 2] = g[0];
			out[i * 2 + 1] = g[1];
			continue;
		}
		const x = b.pos[i * 3],
			y = b.pos[i * 3 + 1],
			z = b.pos[i * 3 + 2];
		const nx = b.nor[i * 3],
			ny = b.nor[i * 3 + 1],
			nz = b.nor[i * 3 + 2];
		let day = DAY.base + DAY.front * Math.exp(-(d / 2 - z) / DAY.reach) * (0.75 + 0.25 * Math.max(nz, 0));
		if (ny < -0.5) day *= 0.6;
		let lamp = 0;
		for (const L of room.lamps) {
			const dx = L.x - x,
				dy = L.y - y,
				dz = L.z - z;
			const dist = Math.hypot(dx, dy, dz) || 1;
			const facing = Math.max(0.2, (dx * nx + dy * ny + dz * nz) / dist);
			lamp += (L.power * facing) / (1 + (dist / 1.7) ** 2);
		}
		let ao = 1;
		const toWall = Math.min(w / 2 - Math.abs(x), d / 2 - Math.abs(z));
		const kind = b.kind[i];
		if (kind === 'floor') {
			ao = 0.62 + 0.38 * smooth(Math.min(1, toWall / 0.7));
			for (const [x0, x1, z0, z1] of room.blockers) {
				const out = Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1));
				if (out < 0.35) ao *= 0.62 + 0.38 * smooth(out / 0.35);
			}
		} else if (kind === 'wall') {
			// Darker at the foot of the wall, in the corners and just under the ceiling.
			const corner = Math.abs(nz) > 0.5 ? w / 2 - Math.abs(x) : d / 2 - Math.abs(z);
			ao = (0.7 + 0.3 * smooth(Math.min(1, y / 0.6))) * (0.8 + 0.2 * smooth(Math.min(1, corner / 0.5))) * (0.9 + 0.1 * smooth(Math.min(1, (room.ceiling - y) / 0.4)));
		}
		else if (kind === 'ceiling') ao = 0.85 + 0.15 * smooth(Math.min(1, toWall / 0.6));
		else ao = 0.8 + 0.2 * smooth(Math.min(1, y / 0.45));
		out[i * 2] = day * ao;
		out[i * 2 + 1] = Math.min(2.2, lamp) * ao;
	}
	return out;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** The interior material: vertex colour × (daylight × day factor + lamplight × lights level). */
function interiorMaterial(uniforms: Record<string, { value: unknown }>): THREE.MeshBasicMaterial {
	const m = new THREE.MeshBasicMaterial({ vertexColors: true });
	m.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, uniforms);
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nattribute vec2 light;\nvarying vec2 vPpwLight;')
			.replace('#include <begin_vertex>', '#include <begin_vertex>\nvPpwLight = light;');
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', '#include <common>\nvarying vec2 vPpwLight;\nuniform vec4 uLampsOn;\nuniform float uNight;\nuniform float uGain;\nuniform vec3 uLampColor;')
			.replace(
				'#include <color_fragment>',
				'#include <color_fragment>\ndiffuseColor.rgb *= ( vPpwLight.x * ( 1.0 - 0.9 * uNight ) + vPpwLight.y * uLampsOn.x * uLampColor ) * uGain;'
			);
	};
	m.customProgramCacheKey = () => 'ppw-procedural-interior';
	return m;
}

export interface ProceduralBuilding {
	spec: BuildingSpec;
	root: THREE.Group;
	uniforms: { uLampsOn: { value: THREE.Vector4 } };
}

const PALETTE = {
	cafe: { wall: '#efe2cc', wainscot: '#5b3a28', floorA: '#8a5a38', floorB: '#7a4c2e', ceiling: '#f6efe2', name: 'Café' },
	shop: { wall: '#f3f3ee', wainscot: '#c9d7d2', floorA: '#e4e2dc', floorB: '#cfcdc6', ceiling: '#ffffff', name: 'Mini-mart' },
	house: { wall: '#f1ead8', wainscot: '#b9c9b5', floorA: '#e9e1cf', floorB: '#a8452f', ceiling: '#fbf8f0', name: 'House' }
} as const;

/** Build the interior of a planned building. */
/** The name over the door, outside (cafés and shops): a painted board, so a building that can be
 * entered stands out on the street. Needs a canvas (none in unit tests: no sign). */
function nameSign(text: string, type: InteriorType, width: number): THREE.Mesh | null {
	if (type === 'house' || typeof document === 'undefined') return null;
	const canvas = document.createElement('canvas');
	canvas.width = 512;
	canvas.height = 128;
	const g = canvas.getContext('2d');
	if (!g) return null;
	const [board, paint] = type === 'cafe' ? ['#3e2a1e', '#f4e6c8'] : ['#b8322a', '#ffffff'];
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

export function buildInterior(type: InteriorType, plan: Plan, seed: number, night: { value: number }, name?: string | null): ProceduralBuilding {
	const r = rng(seed);
	const pal = PALETTE[type];
	// Uniforms shared by all materials of this building (the lights level is set by Buildings).
	const uniforms = {
		uLampsOn: { value: new THREE.Vector4(1, 0, 0, 0) },
		uNight: night,
		uGain: { value: PROCEDURAL_GAIN },
		uLampColor: { value: new THREE.Vector3(1.25, 1.0, 0.75) }
	};
	const w = plan.width,
		d = plan.depth,
		ceiling = plan.ceiling,
		dx = plan.doorX;
	const room: Room = { w, d, ceiling, doorX: dx, lamps: [], blockers: [] };
	const b = new MeshBuilder();
	const seats: SeatSpec[] = [];
	const tables: TableSpec[] = [];
	const items: ItemSpec[] = [];
	const toggles: ToggleSpec[] = [];
	const extra = new THREE.Group();
	const block = (x0: number, x1: number, z0: number, z1: number) => room.blockers.push([Math.min(x0, x1), Math.max(x0, x1), Math.min(z0, z1), Math.max(z0, z1)]);

	// ── Shell: floor tiles, walls with the doorway, wainscot, ceiling, door frame ──────────
	const floor = (x0: number, x1: number, z0: number, z1: number, c: V3) => b.quad([x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0], c, 'floor');
	if (type === 'cafe') {
		// Wooden planks: 0.18 m rows, staggered boards.
		for (let z = -d / 2, row = 0; z < d / 2 - 1e-6; z += 0.18, row++) {
			const z1 = Math.min(d / 2, z + 0.18);
			for (let x = -w / 2 - (row % 3) * 0.4, k = 0; x < w / 2; x += 1.2, k++) {
				const t = 0.85 + 0.25 * r();
				const c = hex(k % 2 ? pal.floorA : pal.floorB).map((v) => v * t) as V3;
				floor(Math.max(-w / 2, x), Math.min(w / 2, x + 1.2), z, z1, c);
			}
		}
	} else {
		const s = type === 'shop' ? 0.5 : 0.3;
		for (let x = -w / 2, i = 0; x < w / 2 - 1e-6; x += s, i++)
			for (let z = -d / 2, k = 0; z < d / 2 - 1e-6; z += s, k++) floor(x, Math.min(w / 2, x + s), z, Math.min(d / 2, z + s), hex((i + k) % 2 ? pal.floorA : pal.floorB));
	}
	const wall = hex(pal.wall);
	const div = (len: number) => Math.max(1, Math.round(len / 0.5));
	const wallQuad = (a: V3, b2: V3, c: V3, e: V3, color = wall) => b.quad(a, b2, c, e, color, 'wall', null, div(Math.hypot(b2[0] - a[0], b2[2] - a[2])), div(c[1] - b2[1]));
	const H = ceiling;
	// Back (z = -d/2), left (x = -w/2), right (x = +w/2) walls, facing into the room.
	wallQuad([-w / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, H, -d / 2], [-w / 2, H, -d / 2]);
	wallQuad([-w / 2, 0, d / 2], [-w / 2, 0, -d / 2], [-w / 2, H, -d / 2], [-w / 2, H, d / 2]);
	wallQuad([w / 2, 0, -d / 2], [w / 2, 0, d / 2], [w / 2, H, d / 2], [w / 2, H, -d / 2]);
	// Front wall with the doorway (local x dx ± 0.5, height DOOR_H).
	const g0 = dx - plan.doorWidth / 2,
		g1 = dx + plan.doorWidth / 2;
	wallQuad([w / 2, 0, d / 2], [g1, 0, d / 2], [g1, H, d / 2], [w / 2, H, d / 2]);
	wallQuad([g0, 0, d / 2], [-w / 2, 0, d / 2], [-w / 2, H, d / 2], [g0, H, d / 2]);
	wallQuad([g1, DOOR_H, d / 2], [g0, DOOR_H, d / 2], [g0, H, d / 2], [g1, H, d / 2]);
	// The reveal through the wall to the facade, and a frame.
	const fz = d / 2 + plan.wall;
	b.quad([g0, 0, fz], [g0, 0, d / 2], [g0, DOOR_H, d / 2], [g0, DOOR_H, fz], wall, 'wall'); // faces +X
	b.quad([g1, 0, d / 2], [g1, 0, fz], [g1, DOOR_H, fz], [g1, DOOR_H, d / 2], wall, 'wall'); // faces -X
	b.quad([g0, DOOR_H, d / 2], [g1, DOOR_H, d / 2], [g1, DOOR_H, fz], [g0, DOOR_H, fz], wall, 'wall'); // faces down
	b.quad([g0, 0.002, fz], [g1, 0.002, fz], [g1, 0.002, d / 2], [g0, 0.002, d / 2], hex('#9a948a'), 'floor');
	b.quad([g0, -FLOOR_LIFT, fz], [g1, -FLOOR_LIFT, fz], [g1, 0.002, fz], [g0, 0.002, fz], hex('#8a847a'), 'wall'); // the sill's front, down to the street
	const trim = hex(type === 'cafe' ? '#3e2a1e' : '#f7f5f0');
	b.box(g0 - 0.08, g0, 0, DOOR_H + 0.08, d / 2 - 0.02, d / 2, trim);
	b.box(g1, g1 + 0.08, 0, DOOR_H + 0.08, d / 2 - 0.02, d / 2, trim);
	b.box(g0 - 0.08, g1 + 0.08, DOOR_H, DOOR_H + 0.08, d / 2 - 0.02, d / 2, trim);
	// Wainscot and skirting along all walls (except the doorway).
	const band = hex(pal.wainscot);
	const bandH = type === 'house' ? 0.9 : type === 'cafe' ? 1.0 : 0.12;
	const strips: [number, number, number, number, number][] = [
		[-w / 2, w / 2, -d / 2, -d / 2 + 0.012, 0],
		[-w / 2, -w / 2 + 0.012, -d / 2, d / 2, 0],
		[w / 2 - 0.012, w / 2, -d / 2, d / 2, 0],
		[-w / 2, g0, d / 2 - 0.012, d / 2, 0],
		[g1, w / 2, d / 2 - 0.012, d / 2, 0]
	];
	for (const [x0, x1, z0, z1] of strips) b.box(x0, x1, 0, bandH, z0, z1, band);
	// Ceiling.
	b.quad([-w / 2, H, -d / 2], [w / 2, H, -d / 2], [w / 2, H, d / 2], [-w / 2, H, d / 2], hex(pal.ceiling), 'ceiling', null, div(w), div(d));

	// Windows: shopfronts either side of the door (shop, café), side windows (house).
	/** A pane seen from inside: the street, the buildings across it and the sky, in daylight
	 * (glowing by day only, dark at night). `a`, `c`: its bottom corners, `y0`..`y1`: its height. */
	const view = (a: [number, number], c: [number, number], y0: number, y1: number) => {
		const bands: [number, string, number][] = [
			[0.3, '#8f918b', 1.0], // pavement
			[0.62, '#d3c6ae', 1.15], // facades across the street
			[1, '#d6ebf7', 1.55] // sky
		];
		let lo = y0;
		for (const [t, color, glow] of bands) {
			const hi = y0 + (y1 - y0) * t;
			b.quad([a[0], lo, a[1]], [c[0], lo, c[1]], [c[0], hi, c[1]], [a[0], hi, a[1]], hex(color), 'piece', [glow, 0]);
			lo = hi;
		}
	};
	const shopfront = (x0: number, x1: number) => {
		if (x1 - x0 < 0.8) return;
		view([x1, d / 2 - 0.02], [x0, d / 2 - 0.02], 0.7, Math.min(H - 0.35, 2.4));
		b.box(x0, x1, 0.62, 0.7, d / 2 - 0.08, d / 2, trim);
		for (let x = x0; x <= x1 + 1e-6; x += (x1 - x0) / Math.max(1, Math.round((x1 - x0) / 1.2))) b.box(x - 0.03, x + 0.03, 0.7, Math.min(H - 0.35, 2.4), d / 2 - 0.05, d / 2, trim);
	};
	if (type !== 'house') {
		shopfront(-w / 2 + 0.4, g0 - 0.35);
		shopfront(g1 + 0.35, w / 2 - 0.4);
	} else {
		for (const side of [-1, 1]) {
			const x = side * (w / 2 - 0.02);
			view([x, -side * 0.6], [x, side * 0.6], 1.0, 2.2);
		}
	}

	const lampAt = (x: number, z: number, drop: number, power: number, shade?: string) => {
		const y = H - drop;
		b.cylinder(x, z, y, H, 0.006, hex('#222222'), 4, [0.3, 0]);
		if (shade) b.cylinder(x, z, y - 0.16, y, 0.18, hex(shade), 14, [0.6, 1.4], 0.05);
		else b.cylinder(x, z, y - 0.12, y, 0.07, hex('#fff4dc'), 8, [0.6, 1.6]);
		room.lamps.push({ x, y: y - 0.15, z, power });
	};

	// ── Layouts ─────────────────────────────────────────────────────────────────────────
	if (type === 'cafe') cafe();
	else if (type === 'shop') shop();
	else house();

	/** A chair; its stand-up spot is beside it, on the side towards the middle of the room. */
	function chair(x: number, z: number, yaw: number, id: string, _side = 0) {
		b.at(x, z, yaw);
		const wood = hex('#4a2f20');
		b.box(-0.21, 0.21, 0.42, 0.46, -0.21, 0.21, wood);
		b.box(-0.21, 0.21, 0.46, 0.92, -0.23, -0.19, wood);
		for (const lx of [-0.17, 0.17]) for (const lz of [-0.19, 0.17]) b.box(lx - 0.02, lx + 0.02, 0, 0.42, lz - 0.02, lz + 0.02, wood);
		b.at(0, 0, 0);
		const c = Math.cos(yaw),
			s = Math.sin(yaw);
		const options: XZ[] = [[x + 0.6 * c, z - 0.6 * s], [x - 0.6 * c, z + 0.6 * s]];
		const stand = options.sort((a, b2) => Math.abs(a[0]) / w + Math.abs(a[1]) / d - (Math.abs(b2[0]) / w + Math.abs(b2[1]) / d))[0];
		seats.push({ id, label: 'chair', x, z, yaw, height: 0.46, stand });
	}

	function cafe() {
		// Counter along the back wall with an espresso machine, a pastry case and a menu board.
		const cw = Math.min(w - 1.6, 3.6);
		const cx0 = w / 2 - 0.5 - cw;
		const cz = -d / 2 + 0.95;
		b.box(cx0, cx0 + cw, 0, 1.0, cz - 0.3, cz + 0.3, hex('#6b4530'));
		b.box(cx0 - 0.03, cx0 + cw + 0.03, 1.0, 1.04, cz - 0.33, cz + 0.33, hex('#d9cbb3'));
		block(cx0, cx0 + cw, cz - 0.33, cz + 0.33);
		const mx = cx0 + cw - 0.5;
		b.box(mx - 0.25, mx + 0.25, 1.04, 1.5, cz - 0.2, cz + 0.12, hex('#b8bcbf'));
		b.box(mx - 0.2, mx + 0.2, 1.3, 1.36, cz + 0.12, cz + 0.2, hex('#2a2c2e'));
		const steam = new MeshBuilder();
		for (let k = 0; k < 3; k++) steam.cylinder(mx - 0.08 + k * 0.08, cz + 0.16, 1.16 + k * 0.05, 1.3 + k * 0.08, 0.025, hex('#ffffff'), 6, [1.4, 0.5], 0.04);
		const steamMesh = new THREE.Mesh(steam.geometry(lightUp(steam, room)), interiorMaterial(uniforms));
		steamMesh.name = 'Steam';
		extra.add(steamMesh);
		toggles.push({ id: 'coffee', label: 'Coffee Machine', node: 'Steam', kind: 'flame', x: mx, z: cz + 0.3, y: 1.3 });
		const px = cx0 + 0.75;
		b.box(px - 0.55, px + 0.55, 1.04, 1.38, cz - 0.1, cz + 0.3, hex('#cfe0e6'), [1.0, 0.8]);
		for (let k = 0; k < 6; k++) b.cylinder(px - 0.4 + k * 0.16, cz + 0.1, 1.08, 1.14, 0.05, hex(k % 2 ? '#d7a24a' : '#8a4a2a'), 8);
		items.push({ id: 'pastries', label: 'Pastries', title: 'Pastry case', text: 'Croissants, num kom and banana cake, baked this morning.', x: px, z: cz + 0.3, y: 1.2 });
		const mbx = cx0 + cw / 2;
		b.box(mbx - 0.7, mbx + 0.7, 1.6, 2.4, -d / 2 + 0.01, -d / 2 + 0.04, hex('#2b2b2b'));
		for (let k = 0; k < 5; k++) b.box(mbx - 0.55, mbx + 0.25 - (k % 2) * 0.2, 2.25 - k * 0.13, 2.28 - k * 0.13, -d / 2 + 0.04, -d / 2 + 0.045, hex('#f1e9d8'), [0.9, 0.3]);
		items.push({ id: 'menu', label: 'Menu', title: 'Menu', text: 'Iced coffee with condensed milk · lemongrass tea · fresh coconut · num pang · mango sticky rice.', x: mbx, z: -d / 2 + 0.6, y: 2.0 });
		// Shelf with cups behind the counter.
		b.box(cx0, cx0 + cw, 1.75, 1.78, -d / 2, -d / 2 + 0.25, hex('#6b4530'));
		for (let k = 0; k < Math.floor(cw / 0.18); k++) b.cylinder(cx0 + 0.1 + k * 0.18, -d / 2 + 0.12, 1.78, 1.86, 0.04, hex(k % 3 ? '#f4f1ea' : '#3e6fa3'), 8);
		// Tables for two, in a roomy grid, keeping an aisle from the door to the counter.
		let n = 0;
		const tables0: [number, number][] = [];
		for (let z = d / 2 - 1.4; z > cz + 1.4; z -= 2.3)
			for (let x = -w / 2 + 0.95; x < w / 2 - 0.85; x += 2.2) {
				if (Math.abs(x - dx) < 1.0 && z > d / 2 - 2.6) continue;
				tables0.push([x, z]);
			}
		for (const [x, z] of tables0) {
			n++;
			b.at(x, z);
			b.box(-0.36, 0.36, 0.72, 0.75, -0.36, 0.36, hex('#d9cbb3'));
			b.cylinder(0, 0, 0, 0.72, 0.04, hex('#2a2c2e'), 8);
			b.box(-0.25, 0.25, 0, 0.02, -0.25, 0.25, hex('#2a2c2e'));
			b.cylinder(0.1, 0.05, 0.75, 0.83, 0.035, hex('#f4f1ea'), 8);
			b.cylinder(-0.05, -0.1, 0.75, 0.84, 0.03, hex('#6db33f'), 6);
			b.at(0, 0, 0);
			block(x - 0.38, x + 0.38, z - 0.38, z + 0.38);
			chair(x, z - 0.6, 0, `t${n}a`, 1);
			chair(x, z + 0.6, Math.PI, `t${n}b`, 1);
			tables.push({ id: `table${n}`, label: 'Table', rect: [x - 0.36, x + 0.36, z - 0.36, z + 0.36], seats: [`t${n}a`, `t${n}b`] });
			lampAt(x, z, 0.65, 0.7, '#c9894a');
		}
		lampAt(cx0 + cw / 2, cz, 0.6, 0.6, '#c9894a');
		plant(-w / 2 + 0.4, -d / 2 + 0.4);
		plant(w / 2 - 0.4, d / 2 - 0.45);
		art(-w / 2 + 0.01, 0, '#b5552f');
	}

	function shop() {
		// Counter by the door with a register; shelves along both side walls; an island if wide;
		// a drinks fridge at the back; rice sacks.
		const side = dx > 0 ? -1 : 1; // the counter on the side away from the door
		const ccx = side * (w / 2 - 0.9);
		const ccz = d / 2 - 1.2;
		b.box(ccx - 0.8, ccx + 0.8, 0, 0.95, ccz - 0.3, ccz + 0.3, hex('#c45a2d'));
		b.box(ccx - 0.82, ccx + 0.82, 0.95, 0.99, ccz - 0.32, ccz + 0.32, hex('#efe7d6'));
		b.box(ccx - 0.15, ccx + 0.15, 0.99, 1.22, ccz - 0.12, ccz + 0.12, hex('#2a2c2e'));
		block(ccx - 0.82, ccx + 0.82, ccz - 0.32, ccz + 0.32);
		items.push({ id: 'cards', label: 'Phone Cards', title: 'Phone top-up cards', text: 'Scratch cards for every network, and a QR code to pay by KHQR.', x: ccx, z: ccz, y: 1.1 });
		const shelf = (x: number, z0: number, z1: number, facing: number) => {
			const depth = 0.4;
			const xb = x,
				xf = x + facing * depth;
			const [x0, x1] = [Math.min(xb, xf), Math.max(xb, xf)];
			b.box(x0, x1, 0, 1.8, z0, z0 + 0.03, hex('#8c9aa3'));
			b.box(x0, x1, 0, 1.8, z1 - 0.03, z1, hex('#8c9aa3'));
			b.box(facing > 0 ? x0 : x1 - 0.03, facing > 0 ? x0 + 0.03 : x1, 0, 1.8, z0, z1, hex('#8c9aa3'));
			for (const y of [0.1, 0.55, 1.0, 1.45]) {
				b.box(x0, x1, y, y + 0.03, z0, z1, hex('#d5dbe0'));
				for (let z = z0 + 0.06; z < z1 - 0.12; z += 0.16) {
					const hgt = 0.14 + r() * 0.2;
					const tone = ['#d23b2f', '#f2c230', '#2f7bd2', '#3fa34d', '#f08a24', '#7c4bc9', '#f4f1ea'][Math.floor(r() * 7)];
					const zz = Math.min(z1 - 0.06, z + 0.12);
					b.box(x0 + 0.05, x1 - 0.05, y + 0.03, y + 0.03 + hgt, z + 0.01, zz, hex(tone));
				}
			}
			block(x0, x1, z0, z1);
		};
		const z0 = -d / 2 + 0.3,
			z1 = d / 2 - 2.0;
		if (z1 - z0 > 1.2) {
			shelf(-w / 2, z0, z1, 1);
			shelf(w / 2, z0, z1, -1);
			if (w >= 5.4) {
				shelf(-0.42, z0 + 0.8, z1 - 0.4, 1);
				shelf(0.42, z0 + 0.8, z1 - 0.4, -1);
			}
			items.push({ id: 'snacks', label: 'Snacks', title: 'Snack shelf', text: 'Prawn crackers, dried mango, Khmer coffee sachets and instant noodles.', x: -w / 2 + 0.4, z: (z0 + z1) / 2, y: 1.2 });
		}
		// Drinks fridge on the back wall (glowing glass), rice sacks in a corner.
		const fx = side * -1 * (w / 2 - 1.2);
		b.box(fx - 0.55, fx + 0.55, 0, 2.0, -d / 2, -d / 2 + 0.7, hex('#e8eeef'));
		b.box(fx - 0.5, fx + 0.5, 0.1, 1.9, -d / 2 + 0.7, -d / 2 + 0.72, hex('#cfe8f2'), [0.6, 1.6]);
		for (let k = 0; k < 4; k++) for (let j = 0; j < 6; j++) b.cylinder(fx - 0.38 + j * 0.15, -d / 2 + 0.6, 0.2 + k * 0.42, 0.44 + k * 0.42, 0.035, hex(['#d23b2f', '#3fa34d', '#f2c230', '#2f7bd2'][k]), 6, [0.5, 1.2]);
		block(fx - 0.56, fx + 0.56, -d / 2, -d / 2 + 0.74);
		items.push({ id: 'fridge', label: 'Drinks Fridge', title: 'Drinks fridge', text: 'Cold Angkor beer, sugarcane juice, coconut water and soy milk.', x: fx, z: -d / 2 + 0.75, y: 1.2 });
		const rx = -fx;
		for (let k = 0; k < 3; k++) b.box(rx - 0.35, rx + 0.35, k * 0.22, k * 0.22 + 0.22, -d / 2 + 0.3, -d / 2 + 0.75, hex(k % 2 ? '#e9e1cf' : '#d8ccb0'));
		block(rx - 0.36, rx + 0.36, -d / 2 + 0.28, -d / 2 + 0.76);
		items.push({ id: 'rice', label: 'Rice', title: 'Rice sacks', text: 'Jasmine rice from Battambang, sold by the kilo or by the 25 kg sack.', x: rx, z: -d / 2 + 0.8, y: 0.6 });
		for (let x = -w / 2 + 1.0; x < w / 2 - 0.5; x += 1.6) for (let z = -d / 2 + 1.2; z < d / 2 - 0.5; z += 2.2) tube(x, z);
	}

	function house() {
		// Living area at the front, dining in the middle, a bed at the back (if deep enough).
		const sofaZ = d / 2 - 1.6;
		const sx = -w / 2 + 0.45;
		b.at(sx, sofaZ, Math.PI / 2);
		b.box(-0.95, 0.95, 0.1, 0.44, -0.42, 0.42, hex('#5b6f8a'));
		b.box(-0.95, 0.95, 0.44, 0.82, -0.42, -0.2, hex('#5b6f8a'));
		b.box(-0.9, 0.9, 0.44, 0.5, -0.2, 0.4, hex('#d8b26a'));
		b.at(0, 0, 0);
		block(sx - 0.42, sx + 0.42, sofaZ - 0.95, sofaZ + 0.95);
		// Stand-up spots clear of the sofa and of the coffee table in front of it.
		for (const [k, lz] of [[0, -0.42], [1, 0.42]] as const) seats.push({ id: `sofa${k}`, label: 'sofa', x: sx + 0.06, z: sofaZ + lz, yaw: Math.PI / 2, height: 0.44, stand: [sx + 0.85, sofaZ + lz] });
		b.box(sx + 1.3, sx + 2.0, 0.4, 0.44, sofaZ - 0.28, sofaZ + 0.28, hex('#9a6a3e'));
		block(sx + 1.3, sx + 2.0, sofaZ - 0.28, sofaZ + 0.28);
		const tvx = w / 2 - 0.25;
		b.box(tvx - 0.22, tvx + 0.22, 0, 0.5, sofaZ - 0.7, sofaZ + 0.7, hex('#9a6a3e'));
		b.box(tvx - 0.04, tvx, 0.6, 1.1, sofaZ - 0.45, sofaZ + 0.45, hex('#1d1e20'));
		block(tvx - 0.22, tvx + 0.22, sofaZ - 0.7, sofaZ + 0.7);
		const tz = d > 7 ? 0 : -d / 2 + 1.4;
		b.at(0.3, tz);
		b.box(-0.7, 0.7, 0.72, 0.76, -0.42, 0.42, hex('#9a6a3e'));
		for (const lx of [-0.63, 0.63]) for (const lz of [-0.35, 0.35]) b.box(lx - 0.03, lx + 0.03, 0, 0.72, lz - 0.03, lz + 0.03, hex('#9a6a3e'));
		b.at(0, 0, 0);
		block(-0.42, 1.02, tz - 0.44, tz + 0.44);
		const tableSeats: string[] = [];
		for (const [k, lx, lz, yaw] of [[0, 0.0, -0.72, 0], [1, 0.6, -0.72, 0], [2, 0.0, 0.72, Math.PI], [3, 0.6, 0.72, Math.PI]] as const) {
			chair(lx, tz + lz, yaw, `dining${k}`, lx > 0.3 ? 1 : -1);
			tableSeats.push(`dining${k}`);
		}
		tables.push({ id: 'dining', label: 'Table', rect: [-0.4, 1.0, tz - 0.42, tz + 0.42], seats: tableSeats });
		if (d > 7) {
			const bz = -d / 2 + 1.05;
			b.at(-w / 2 + 1.2, bz);
			b.box(-0.8, 0.8, 0.12, 0.52, -1.0, 1.0, hex('#efe9df'));
			b.box(-0.82, 0.82, 0.5, 0.55, -0.3, 1.0, hex('#b0262c'));
			b.box(-0.85, 0.85, 0.12, 1.1, -1.05, -0.98, hex('#5a3824'));
			b.at(0, 0, 0);
			block(-w / 2 + 0.38, -w / 2 + 2.02, bz - 1.05, bz + 1.0);
			seats.push({ id: 'bed', label: 'bed', x: -w / 2 + 1.2, z: bz + 0.7, yaw: 0, height: 0.52, stand: [-w / 2 + 1.2, bz + 1.35] });
			b.box(w / 2 - 0.6, w / 2, 0, 2.0, -d / 2, -d / 2 + 1.2, hex('#9a6a3e'));
			block(w / 2 - 0.6, w / 2, -d / 2, -d / 2 + 1.2);
		}
		b.box(-w / 2 + 0.01, -w / 2 + 0.3, 1.9, 1.94, d / 2 - 0.9, d / 2 - 0.3, hex('#a8322c'));
		b.cylinder(-w / 2 + 0.16, d / 2 - 0.6, 1.94, 2.12, 0.05, hex('#d4a63f'), 8);
		items.push({ id: 'altar', label: 'Family Altar', title: 'Family altar', text: 'A small Buddha, jasmine and incense, high on the wall as in every Khmer home.', x: -w / 2 + 0.5, z: d / 2 - 0.6, y: 2.0 });
		lampAt(0, sofaZ, 0.3, 1.0);
		lampAt(0.3, tz, 0.5, 0.9, '#e8d2a0');
		if (d > 7) lampAt(-w / 2 + 1.5, -d / 2 + 1.5, 0.3, 0.9);
		plant(w / 2 - 0.4, d / 2 - 0.4);
	}

	function plant(x: number, z: number) {
		b.cylinder(x, z, 0, 0.42, 0.2, hex('#a5583a'), 10, null, 0.16);
		for (let k = 0; k < 8; k++) {
			const a = k * 2.4,
				rr = 0.08 + 0.03 * k;
			b.at(x + Math.cos(a) * rr * 0.5, z + Math.sin(a) * rr * 0.5, a);
			b.box(-0.18, 0.18, 0.5 + k * 0.09, 0.53 + k * 0.09, -0.06, 0.06, hex('#4e7a3a'));
		}
		b.at(0, 0, 0);
		block(x - 0.24, x + 0.24, z - 0.24, z + 0.24);
	}

	function art(x: number, z: number, color: string) {
		b.box(x, x + 0.03, 1.4, 2.1, z - 0.5, z + 0.5, hex('#3e2a1e'));
		b.box(x + 0.03, x + 0.035, 1.46, 2.04, z - 0.44, z + 0.44, hex(color), [0.9, 0.5]);
		items.push({ id: 'art', label: 'Painting', title: 'Painting', text: 'Boats on the Tonle Sap at dusk, by a local artist.', x: x + 0.6, z, y: 1.75 });
	}

	function tube(x: number, z: number) {
		b.box(x - 0.6, x + 0.6, H - 0.05, H - 0.01, z - 0.05, z + 0.05, hex('#ffffff'), [0.6, 1.6]);
		room.lamps.push({ x, y: H - 0.2, z, power: 0.6 });
	}

	const root = new THREE.Group();
	const interior = new THREE.Mesh(b.geometry(lightUp(b, room)), interiorMaterial(uniforms));
	interior.name = 'Interior';
	interior.position.y = FLOOR_LIFT;
	root.add(interior);
	extra.name = 'Extras';
	extra.position.y = FLOOR_LIFT;
	root.add(extra);
	// The door: a leaf on its hinge (left jamb), in the middle of the wall's thickness.
	const hingeX = g0 + 0.02,
		hingeZ = d / 2 + plan.wall / 2;
	const leafW = plan.doorWidth - 0.04;
	const lb = new MeshBuilder().at(hingeX, hingeZ);
	if (type === 'house') {
		lb.box(0, leafW, 0.01, DOOR_H - 0.01, -0.025, 0.025, hex('#6e3f22'));
		lb.box(leafW - 0.16, leafW - 0.06, 1.0, 1.03, -0.06, 0.06, hex('#c8a24a'));
	} else {
		const frame = hex('#9aa3a8');
		lb.box(0, leafW, 0.01, 0.12, -0.025, 0.025, frame);
		lb.box(0, leafW, DOOR_H - 0.12, DOOR_H - 0.01, -0.025, 0.025, frame);
		lb.box(0, 0.06, 0.12, DOOR_H - 0.12, -0.025, 0.025, frame);
		lb.box(leafW - 0.06, leafW, 0.12, DOOR_H - 0.12, -0.025, 0.025, frame);
		lb.box(0.06, leafW - 0.06, 0.12, DOOR_H - 0.12, -0.01, 0.01, hex('#bcd3dc'), [0.9, 0.4]);
		lb.box(leafW - 0.16, leafW - 0.12, 0.8, 1.3, -0.06, 0.06, hex('#d0d4d6'));
	}
	// Lit where it stands, then moved so the node's origin is the hinge (it turns about it).
	const leafGeometry = lb.geometry(lightUp(lb, room)).translate(-hingeX, 0, -hingeZ);
	const leaf = new THREE.Mesh(leafGeometry, interiorMaterial(uniforms));
	const doorNode = new THREE.Group();
	doorNode.name = 'Door_front';
	doorNode.position.set(hingeX, FLOOR_LIFT, hingeZ);
	doorNode.add(leaf);
	root.add(doorNode);
	// The sign: on the facade, centred over the door, kept within the room's width.
	const sign = nameSign(name ?? pal.name, type, Math.min(1.8, w - 0.4));
	if (sign) {
		const sw = Math.min(1.8, w - 0.4);
		sign.position.set(Math.max(-w / 2 + sw / 2, Math.min(w / 2 - sw / 2, dx)), FLOOR_LIFT + DOOR_H + 0.2 + sw / 8, d / 2 + plan.wall + 0.08);
		root.add(sign);
	}

	const rect = (x0: number, x1: number, z0: number, z1: number): XZ[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
	const t = 0.1; // collision walls just behind the interior faces
	const spec: BuildingSpec = {
		version: 2,
		name: name ?? pal.name,
		model: '',
		floor: FLOOR_LIFT,
		wallTop: FLOOR_LIFT + H,
		roofTop: Math.max(FLOOR_LIFT + H + 0.4, plan.height), // the OSM building around the room
		footprint: rect(-w / 2 - plan.wall, w / 2 + plan.wall, -d / 2 - plan.wall, d / 2 + plan.wall),
		interior: { min: [-w / 2, -d / 2], max: [w / 2, d / 2], ceiling: FLOOR_LIFT + H },
		rooms: [{ id: 'main', name: name ?? pal.name, rects: [[-w / 2, w / 2, -d / 2, d / 2]], light: 0 }],
		lights: [{ id: 'main', label: 'Lights', channel: 0, switches: type === 'house' ? [[Math.max(-w / 2 + 0.2, g0 - 0.3), d / 2 - 0.05, 1.3]] : [], materials: [] }],
		walls: [
			rect(-w / 2 - t, w / 2 + t, -d / 2 - t, -d / 2),
			rect(-w / 2 - t, -w / 2, -d / 2, d / 2),
			rect(w / 2, w / 2 + t, -d / 2, d / 2),
			rect(-w / 2 - t, g0, d / 2, d / 2 + t),
			rect(g1, w / 2 + t, d / 2, d / 2 + t)
		],
		lintels: [{ ring: rect(g0, g1, d / 2, d / 2 + t), base: FLOOR_LIFT + DOOR_H }],
		doors: [
			{ id: 'front', label: 'Door', node: 'Door_front', hinge: [hingeX, hingeZ], width: leafW, thickness: 0.05, height: DOOR_H, openYaw: Math.PI / 2, center: [dx, hingeZ], outward: [0, 1] }
		],
		steps: [],
		posts: [],
		blockers: room.blockers.map(([x0, x1, z0, z1]) => rect(x0, x1, z0, z1)),
		seats,
		tables,
		items,
		toggles,
		fans: []
	};
	if (type === 'house') {
		// The house light switch beside the door (drawn on the wall).
		const [sx, sz] = spec.lights[0].switches[0];
		const sb = new MeshBuilder();
		sb.box(sx - 0.04, sx + 0.04, 1.24, 1.36, sz - 0.012, sz, hex('#f4f4f2'), [0.8, 0.6]);
		extra.add(new THREE.Mesh(sb.geometry(lightUp(sb, room)), interiorMaterial(uniforms)));
	}
	return { spec, root, uniforms };
}

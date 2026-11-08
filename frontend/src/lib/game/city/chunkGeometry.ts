/**
 * Chunk payload → plain typed arrays, ready to become Three.js meshes.
 *
 * Runs inside a Web Worker (chunk.worker.ts) so triangulating hundreds of buildings never
 * stalls the render loop. It uses only Three.js core maths and geometry, with no DOM: canvas
 * work (labels, sign text, textures) happens on the main thread in assemble.ts.
 *
 * Geometry is real (OSM footprints and centrelines, plus the terrain mound). Appearance is
 * generated: facade colours and shopfronts, sidewalks, lane markings, park trees, tree species
 * and lamp positions are procedural decoration.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ChunkBuilding, ChunkPayload, ChunkRoad, PolygonRings, XZ } from '$lib/api/types';
import { pointInRing } from './collision';
import { FLAT, type Terrain } from './terrain';

export type MeshKind =
	| 'walls' | 'roofs' | 'khmerRoof' | 'sidewalk' | 'asphalt' | 'asphaltMinor' | 'paving'
	| 'marking' | 'area';
export type PropKind = 'tree-rain' | 'tree-palm' | 'tree-slender' | 'lamp' | 'traffic-signal' | 'sign-post';

export interface MeshData {
	kind: MeshKind;
	area?: string;
	position: Float32Array;
	normal: Float32Array;
	uv?: Float32Array;
	color?: Float32Array;
	/** walls only: (shopfront 0|1, per-building seed 0..1) per vertex, for the facade shader */
	facade?: Float32Array;
}

export interface LabelSpec { title: string; subtitle: string | null; x: number; y: number; z: number }
export interface SignSpec { x: number; y: number; z: number; blades: { en: string; km: string | null; a: number }[] }
export interface ModelSpec { name: string; x: number; y: number; z: number; r: number; h: number }

export interface ChunkBuild {
	key: string;
	meshes: MeshData[];
	instances: { prop: PropKind; matrices: Float32Array }[];
	/** Light pools under lamp heads: x, y, z per pool. */
	pools: Float32Array;
	/** Small round obstacles (trunks, poles): x, z, radius per post. */
	posts: Float32Array;
	labels: LabelSpec[];
	signs: SignSpec[];
	models: ModelSpec[];
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────
export function hash(n: number): number {
	let h = (n | 0) ^ 0x9e3779b9;
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Phnom Penh facade palette: limewash cream, ochre, pale yellow, white, salmon, teal, grey. */
const FACADES = ['#efe6d2', '#e7c98f', '#f2e3a6', '#f4f1ea', '#e8b9a0', '#cfe0d8', '#d4d0c8', '#e9d9bd', '#c9b79c'];
/** Building types whose ground floor is usually a shop in Daun Penh. */
const SHOPHOUSE = new Set(['yes', 'retail', 'commercial', 'residential', 'house', 'apartments', 'terrace', 'mixed_use']);

const ROTATE_TO_GROUND = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

function shapeFrom(rings: PolygonRings): THREE.Shape | null {
	const [outer, ...holes] = rings;
	if (!outer || outer.length < 3) return null;
	// Shape space is (x, -z) so that rotating -90° about X maps extrusion depth to +Y.
	const shape = new THREE.Shape(outer.map(([x, z]) => new THREE.Vector2(x, -z)));
	for (const hole of holes)
		if (hole.length >= 3) shape.holes.push(new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, -z))));
	return shape;
}

function toMeshData(kind: MeshKind, geometry: THREE.BufferGeometry, area?: string): MeshData {
	const attr = (name: string) => geometry.getAttribute(name)?.array as Float32Array | undefined;
	return {
		kind,
		area,
		position: attr('position')!,
		normal: attr('normal')!,
		uv: attr('uv'),
		color: attr('color'),
		facade: attr('facade')
	};
}

function merged(kind: MeshKind, list: THREE.BufferGeometry[], area?: string): MeshData | null {
	if (!list.length) return null;
	const geometry = mergeGeometries(list, false);
	list.forEach((g) => g.dispose());
	return geometry ? toMeshData(kind, geometry, area) : null;
}

/** Copy a vertex range of a non-indexed geometry (one ExtrudeGeometry group). */
function slice(geometry: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
	const out = new THREE.BufferGeometry();
	for (const name of ['position', 'normal', 'uv'] as const) {
		const attr = geometry.getAttribute(name) as THREE.BufferAttribute;
		out.setAttribute(name, new THREE.BufferAttribute(attr.array.slice(start * attr.itemSize, (start + count) * attr.itemSize), attr.itemSize));
	}
	return out;
}

function fill(geometry: THREE.BufferGeometry, name: string, values: number[]) {
	const n = geometry.getAttribute('position').count;
	const data = new Float32Array(n * values.length);
	for (let i = 0; i < n; i++) data.set(values, i * values.length);
	geometry.setAttribute(name, new THREE.BufferAttribute(data, values.length));
}

// ── roads ───────────────────────────────────────────────────────────────────────────────
/** Densify a polyline so segments are at most `step` metres (for terrain following). */
export function densify(pts: XZ[], step: number): XZ[] {
	const out: XZ[] = [pts[0]];
	for (let i = 1; i < pts.length; i++) {
		const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
		const n = Math.ceil(Math.hypot(bx - ax, bz - az) / step);
		for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
	}
	return out;
}

/** Triangle strip of width `w` centred on a polyline, `y` metres above the terrain. */
export function ribbon(pts: XZ[], w: number, y: number, terrain: Terrain = FLAT): THREE.BufferGeometry | null {
	if (pts.length < 2) return null;
	const hilly = pts.some(([x, z]) => terrain.affects(x, z, w));
	if (hilly) pts = densify(pts, 2.5);
	const half = w / 2;
	const left: [number, number][] = [];
	const right: [number, number][] = [];
	for (let i = 0; i < pts.length; i++) {
		const [x, z] = pts[i];
		const [px, pz] = pts[Math.max(0, i - 1)];
		const [nx, nz] = pts[Math.min(pts.length - 1, i + 1)];
		let d1x = x - px, d1z = z - pz, d2x = nx - x, d2z = nz - z;
		const l1 = Math.hypot(d1x, d1z) || 1, l2 = Math.hypot(d2x, d2z) || 1;
		d1x /= l1; d1z /= l1; d2x /= l2; d2z /= l2;
		if (i === 0) { d1x = d2x; d1z = d2z; }
		if (i === pts.length - 1) { d2x = d1x; d2z = d1z; }
		let tx = d1x + d2x, tz = d1z + d2z;
		const tl = Math.hypot(tx, tz) || 1;
		tx /= tl; tz /= tl;
		const cos = Math.max(0.35, tx * d2x + tz * d2z); // capped miter
		const ox = (-tz * half) / cos, oz = (tx * half) / cos;
		left.push([x + ox, z + oz]);
		right.push([x - ox, z - oz]);
	}
	const h = (x: number, z: number) => (hilly ? terrain.height(x, z) : 0) + y;
	const positions: number[] = [];
	for (let i = 0; i < pts.length - 1; i++) {
		const [l0x, l0z] = left[i], [r0x, r0z] = right[i], [l1x, l1z] = left[i + 1], [r1x, r1z] = right[i + 1];
		positions.push(
			l0x, h(l0x, l0z), l0z, r0x, h(r0x, r0z), r0z, l1x, h(l1x, l1z), l1z,
			r0x, h(r0x, r0z), r0z, r1x, h(r1x, r1z), r1z, l1x, h(l1x, l1z), l1z
		);
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	fixWinding(g);
	g.computeVertexNormals();
	if (!hilly) fill(g, 'normal', [0, 1, 0]);
	return g;
}

function fixWinding(g: THREE.BufferGeometry) {
	const p = g.getAttribute('position') as THREE.BufferAttribute;
	for (let i = 0; i < p.count; i += 3) {
		const ax = p.getX(i), az = p.getZ(i), bx = p.getX(i + 1), bz = p.getZ(i + 1), cx = p.getX(i + 2), cz = p.getZ(i + 2);
		// Up-facing triangles: y of (B - A) × (C - A) must be positive.
		if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) < 0) {
			const tx = p.getX(i + 1), ty = p.getY(i + 1), tz = p.getZ(i + 1);
			p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
			p.setXYZ(i + 2, tx, ty, tz);
		}
	}
}

const VEHICLE = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const MAJOR = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const LEVEL: Record<string, number> = { trunk: 6, primary: 6, secondary: 5, tertiary: 4, residential: 3, unclassified: 3, living_street: 3, service: 2, pedestrian: 1, footway: 1, path: 1, cycleway: 1, steps: 1, track: 1 };

function dashes(road: ChunkRoad, y: number, terrain: Terrain): THREE.BufferGeometry[] {
	const out: THREE.BufferGeometry[] = [];
	const DASH = 3, GAP = 6;
	let carry = 0;
	for (let i = 0; i < road.pts.length - 1; i++) {
		const [ax, az] = road.pts[i], [bx, bz] = road.pts[i + 1];
		const len = Math.hypot(bx - ax, bz - az);
		let t = carry;
		while (t < len) {
			const end = Math.min(len, t + DASH);
			const s = t / len, e = end / len;
			const g = ribbon([[ax + (bx - ax) * s, az + (bz - az) * s], [ax + (bx - ax) * e, az + (bz - az) * e]], 0.16, y, terrain);
			if (g) out.push(g);
			t += DASH + GAP;
		}
		carry = t - len;
	}
	return out;
}

function buildRoads(chunk: ChunkPayload, terrain: Terrain): MeshData[] {
	const major: THREE.BufferGeometry[] = [], minor: THREE.BufferGeometry[] = [];
	const paths: THREE.BufferGeometry[] = [], walks: THREE.BufferGeometry[] = [], marks: THREE.BufferGeometry[] = [];
	for (const road of chunk.roads) {
		const level = LEVEL[road.cls.replace(/_link$/, '')] ?? 1;
		const y = 0.04 + level * 0.006;
		if (VEHICLE.has(road.cls)) {
			const asphalt = ribbon(road.pts, road.w, y, terrain);
			if (asphalt) (MAJOR.has(road.cls) ? major : minor).push(asphalt);
			if (road.cls !== 'service') {
				const walk = ribbon(road.pts, road.w + 3.2, 0.035, terrain);
				if (walk) walks.push(walk);
			}
			if (MAJOR.has(road.cls) && !road.oneway && road.w >= 8) marks.push(...dashes(road, y + 0.01, terrain));
		} else {
			const path = ribbon(road.pts, road.w, y, terrain);
			if (path) paths.push(path);
		}
	}
	return [
		merged('sidewalk', walks), merged('asphaltMinor', minor), merged('asphalt', major),
		merged('paving', paths), merged('marking', marks)
	].filter((m): m is MeshData => m !== null);
}

// ── ground areas ────────────────────────────────────────────────────────────────────────
const AREA_Y: Record<string, number> = { water: 0.012, wetland: 0.014, parking: 0.016, plaza: 0.018, temple_grounds: 0.018, grass: 0.02, park: 0.022, pitch: 0.026 };

function buildAreas(chunk: ChunkPayload): MeshData[] {
	const byKind = new Map<string, THREE.BufferGeometry[]>();
	for (const area of chunk.areas) {
		if (!(area.kind in AREA_Y)) continue;
		for (const rings of area.polys) {
			const shape = shapeFrom(rings);
			if (!shape) continue;
			const g = new THREE.ShapeGeometry(shape).toNonIndexed();
			g.applyMatrix4(ROTATE_TO_GROUND);
			g.translate(0, AREA_Y[area.kind], 0);
			const list = byKind.get(area.kind) ?? [];
			list.push(g);
			byKind.set(area.kind, list);
		}
	}
	return [...byKind].map(([kind, list]) => merged('area', list, kind)).filter((m): m is MeshData => m !== null);
}

// ── buildings ───────────────────────────────────────────────────────────────────────────
/** Tiered Khmer roof (two stacked gables with upturned chofa finials) over an oriented box. */
export function khmerRoof(obb: [number, number, number, number, number], baseY: number): THREE.BufferGeometry {
	const [cx, cz, length, width, angle] = obb;
	const ux = Math.sin(angle), uz = Math.cos(angle); // along the ridge
	const vx = Math.cos(angle), vz = -Math.sin(angle); // across
	const P = (u: number, v: number, y: number): [number, number, number] => [cx + ux * u + vx * v, y, cz + uz * u + vz * v];
	const tris: number[] = [];
	const colors: number[] = [];
	const tile = new THREE.Color('#b4532e'), tileDark = new THREE.Color('#923f22');
	const gable = new THREE.Color('#efe2c4'), gold = new THREE.Color('#d9a441');
	const tri = (a: number[], b: number[], c: number[], col: THREE.Color) => {
		tris.push(...a, ...b, ...c);
		for (let i = 0; i < 3; i++) colors.push(col.r, col.g, col.b);
	};
	const quad = (a: number[], b: number[], c: number[], d: number[], col: THREE.Color) => {
		tri(a, b, c, col);
		tri(a, c, d, col);
	};
	const gableRoof = (halfL: number, halfW: number, eave: number, rise: number, col: THREE.Color) => {
		const ridge = eave + rise;
		const a = P(-halfL, -halfW, eave), b = P(halfL, -halfW, eave);
		const c = P(halfL, 0, ridge), d = P(-halfL, 0, ridge);
		const e = P(halfL, halfW, eave), f = P(-halfL, halfW, eave);
		quad(a, b, c, d, col); // slope 1
		quad(f, d, c, e, col); // slope 2
		tri(a, d, f, gable); // gable ends
		tri(b, e, c, gable);
		// Chofa: upturned golden finials at both ridge ends.
		for (const s of [-1, 1]) {
			const base = P(s * halfL, 0, ridge);
			const tip = P(s * (halfL + 0.9), 0, ridge + 1.6);
			const l = P(s * halfL, -0.18, ridge), r = P(s * halfL, 0.18, ridge);
			tri(l, tip, base, gold);
			tri(base, tip, r, gold);
		}
		return ridge;
	};
	const lowerRise = width * 0.42;
	gableRoof(length / 2 + 0.9, width / 2 + 0.9, baseY, lowerRise, tile);
	gableRoof(length * 0.34, width * 0.3, baseY + lowerRise * 0.62, width * 0.55, tileDark);
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
	g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
	g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((tris.length / 3) * 2), 2));
	g.computeVertexNormals();
	return g;
}

function buildBuildings(chunk: ChunkPayload, terrain: Terrain, models: ModelSpec[]): MeshData[] {
	const walls: THREE.BufferGeometry[] = [];
	const roofs: THREE.BufferGeometry[] = [];
	const khmer: THREE.BufferGeometry[] = [];
	const color = new THREE.Color();
	const roofGrey = new THREE.Color('#8f8a82');
	for (const [i, b] of chunk.buildings.entries()) {
		const seed = b.id ?? i + chunk.ix * 1000 + chunk.iz;
		const outer = b.polys[0]?.[0] ?? [];
		const [lo, hi] = terrain.affects(outer[0]?.[0] ?? 0, outer[0]?.[1] ?? 0, 60) ? terrain.range(outer) : [0, 0];
		if (b.model) {
			const [mx, mz] = b.model.c;
			models.push({ name: b.model.name, x: mx, z: mz, y: terrain.height(mx, mz) + b.model.base, r: b.model.r, h: b.h - b.model.base });
			continue;
		}
		const base = colourOf(b, seed);
		// Temples (anything with a Khmer roof) never get shopfronts.
		const shop = SHOPHOUSE.has(b.kind) && b.h <= 30 && !b.roof ? 1 : 0;
		const facadeSeed = hash(seed * 7 + 3);
		const top = Math.max(lo + b.h, hi + 2.5);
		const depth = Math.max(0.6, top - lo - b.min_h);
		for (const rings of b.polys) {
			const shape = shapeFrom(rings);
			if (!shape) continue;
			const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
			geometry.applyMatrix4(ROTATE_TO_GROUND);
			geometry.translate(0, lo + b.min_h, 0);
			const [caps, sides] = geometry.groups;
			if (caps && sides) {
				const roof = slice(geometry, caps.start, caps.count);
				const wall = slice(geometry, sides.start, sides.count);
				// Side-wall UVs are (along-wall metres, 1 - depth): make v the height above the
				// building's base so the storey grid (3.3 m) starts at street level.
				const uv = wall.getAttribute('uv') as THREE.BufferAttribute;
				for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - uv.getY(k) + b.min_h);
				color.set(base);
				fill(wall, 'color', [color.r, color.g, color.b]);
				fill(wall, 'facade', [b.min_h > 0 ? 0 : shop, facadeSeed]);
				color.set(base).multiplyScalar(0.78).lerp(roofGrey, 0.35);
				fill(roof, 'color', [color.r, color.g, color.b]);
				walls.push(wall);
				roofs.push(roof);
			}
			geometry.dispose();
		}
		if (b.roof?.type === 'khmer') khmer.push(khmerRoof(b.roof.obb, lo + b.h));
	}
	return [merged('walls', walls), merged('roofs', roofs), merged('khmerRoof', khmer)].filter((m): m is MeshData => m !== null);
}

function colourOf(b: ChunkBuilding, seed: number): string {
	if (b.colour && /^#[0-9a-f]{6}$/i.test(b.colour)) return b.colour;
	if (b.roof?.type === 'khmer' || b.kind === 'pagoda' || b.kind === 'temple') return '#efe2c4';
	return FACADES[Math.floor(hash(seed) * FACADES.length)];
}

// ── street furniture ────────────────────────────────────────────────────────────────────
/** Deterministic tree positions inside park polygons (procedural decoration, ~1 per 140 m²). */
export function parkTrees(chunk: ChunkPayload): XZ[] {
	const out: XZ[] = [];
	const step = 12;
	for (const area of chunk.areas) {
		if (area.kind !== 'park') continue;
		for (const rings of area.polys) {
			const outer = rings[0];
			let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
			for (const [x, z] of outer) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
			for (let gx = Math.floor(minX / step) * step; gx < maxX; gx += step)
				for (let gz = Math.floor(minZ / step) * step; gz < maxZ; gz += step) {
					const seed = Math.round(gx) * 7919 + Math.round(gz) * 104729;
					const x = gx + hash(seed) * step, z = gz + hash(seed + 1) * step;
					if (hash(seed + 2) < 0.18) continue;
					if (pointInRing(x, z, outer) && !rings.slice(1).some((h) => pointInRing(x, z, h))) out.push([x, z]);
				}
		}
	}
	return out;
}

/** Choose a tree species deterministically (decoration: OSM does not record species here). */
export function treeKind(x: number, z: number): PropKind {
	const r = hash(Math.round(x * 10) * 31 + Math.round(z * 10) * 17);
	return r < 0.5 ? 'tree-rain' : r < 0.82 ? 'tree-slender' : 'tree-palm';
}

const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s3 = new THREE.Vector3(), p3 = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);

function placements(chunk: ChunkPayload, terrain: Terrain) {
	const matrices = new Map<PropKind, number[]>();
	const pools: number[] = [];
	const posts: number[] = [];
	const put = (prop: PropKind, x: number, z: number, yaw: number, scale: number) => {
		q.setFromAxisAngle(UP, yaw);
		m4.compose(p3.set(x, terrain.height(x, z), z), q, s3.set(scale, scale, scale));
		const list = matrices.get(prop) ?? [];
		list.push(...m4.elements);
		matrices.set(prop, list);
	};
	const trees = [...chunk.features.filter((f) => f.k === 'tree').map((f) => f.p), ...parkTrees(chunk)];
	for (const [x, z] of trees) {
		const kind = treeKind(x, z);
		const scale = kind === 'tree-palm' ? 0.85 + hash(Math.round(x * 7)) * 0.3 : 0.75 + hash(Math.round(z * 7 + x)) * 0.5;
		put(kind, x, z, hash(Math.round(x * 13 + z)) * Math.PI * 2, scale);
		posts.push(x, z, 0.45);
	}
	for (const f of chunk.features) {
		const [x, z] = f.p;
		if (f.k === 'lamp_gen' || f.k === 'street_lamp') {
			const yaw = f.a ?? 0;
			put('lamp', x, z, yaw, 1);
			posts.push(x, z, 0.22);
			// Light pools under both lamp heads (model arms point along local x).
			for (const side of [-1, 1]) {
				const hx = x + side * 1.38 * Math.cos(yaw), hz = z - side * 1.38 * Math.sin(yaw);
				pools.push(hx, terrain.height(hx, hz) + 0.07, hz);
			}
		} else if (f.k === 'traffic_signals') {
			put('traffic-signal', x, z, hash(Math.round(x * 3 + z)) * Math.PI * 2, 1);
			posts.push(x, z, 0.2);
		}
	}
	for (const sign of chunk.signs ?? []) {
		put('sign-post', sign.p[0], sign.p[1], 0, 1);
		posts.push(sign.p[0], sign.p[1], 0.15);
	}
	return {
		instances: [...matrices].map(([prop, list]) => ({ prop, matrices: new Float32Array(list) })),
		pools: new Float32Array(pools),
		posts: new Float32Array(posts)
	};
}

// ── labels ──────────────────────────────────────────────────────────────────────────────
function labels(chunk: ChunkPayload, terrain: Terrain, preferKhmer: boolean): LabelSpec[] {
	return chunk.landmarks
		.filter((l) => l.imp >= 3)
		.slice(0, 5)
		.map((lm) => {
			const english = lm.name_en ?? (lm.name_km ? null : lm.name);
			const khmer = lm.name_km ?? (/[ក-៿]/.test(lm.name) ? lm.name : null);
			const title = (preferKhmer ? khmer : english) ?? english ?? khmer ?? lm.name;
			const subtitle = title === khmer ? english : khmer;
			const [x, z] = lm.p;
			return { title, subtitle, x, y: terrain.height(x, z) + 18, z };
		});
}

// ── entry point ─────────────────────────────────────────────────────────────────────────
export function buildChunkData(chunk: ChunkPayload, terrain: Terrain = FLAT, preferKhmer = false): ChunkBuild {
	const models: ModelSpec[] = [];
	const meshes = [...buildAreas(chunk), ...buildRoads(chunk, terrain), ...buildBuildings(chunk, terrain, models)];
	const { instances, pools, posts } = placements(chunk, terrain);
	const signs: SignSpec[] = (chunk.signs ?? []).map((s) => ({
		x: s.p[0], z: s.p[1], y: terrain.height(s.p[0], s.p[1]), blades: s.blades
	}));
	return { key: chunk.key, meshes, instances, pools, posts, labels: labels(chunk, terrain, preferKhmer), signs, models };
}

/** Every ArrayBuffer in a build, for zero-copy postMessage transfer. */
export function transferables(build: ChunkBuild): ArrayBuffer[] {
	const out = new Set<ArrayBuffer>();
	for (const m of build.meshes)
		for (const a of [m.position, m.normal, m.uv, m.color, m.facade]) if (a) out.add(a.buffer as ArrayBuffer);
	for (const i of build.instances) out.add(i.matrices.buffer as ArrayBuffer);
	out.add(build.pools.buffer as ArrayBuffer);
	out.add(build.posts.buffer as ArrayBuffer);
	return [...out];
}

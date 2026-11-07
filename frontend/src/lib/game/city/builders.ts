/**
 * Build Three.js meshes for one streamed chunk. Each chunk becomes a handful of merged
 * meshes (one per material), so the whole neighbourhood stays within a few hundred draw calls.
 *
 * Geometry is real (OSM footprints, road centrelines). Appearance is generated: facade
 * colours, window textures, sidewalk widths, lane markings and park trees are procedural
 * and do not describe the real buildings.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ChunkPayload, ChunkRoad, PolygonRings, XZ } from '$lib/api/types';
import { pointInRing } from './collision';

// ── shared materials ────────────────────────────────────────────────────────────────────
function windowTexture(): THREE.Texture {
	const c = document.createElement('canvas');
	c.width = c.height = 128;
	const g = c.getContext('2d')!;
	g.fillStyle = '#ffffff';
	g.fillRect(0, 0, 128, 128);
	// One storey (3.3 m) × one bay (4 m): a framed window with a balcony line.
	g.fillStyle = '#d9d4cb';
	g.fillRect(0, 118, 128, 10);
	g.fillStyle = '#6f7f86';
	g.fillRect(30, 26, 68, 66);
	g.fillStyle = '#8fa3aa';
	g.fillRect(34, 30, 28, 58);
	g.fillRect(66, 30, 28, 58);
	g.fillStyle = 'rgba(255,255,255,0.35)';
	g.fillRect(36, 32, 10, 54);
	const t = new THREE.CanvasTexture(c);
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 4;
	t.repeat.set(1 / 4, 1 / 3.3);
	return t;
}

const mat = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
	new THREE.MeshStandardMaterial({ color, roughness: 0.92, ...extra });

export class CityMaterials {
	readonly windows = windowTexture();
	readonly walls = new THREE.MeshStandardMaterial({
		vertexColors: true,
		map: this.windows,
		roughness: 0.85
	});
	readonly roofs = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
	readonly asphalt = mat('#3c3f43', { polygonOffset: true, polygonOffsetFactor: -2 });
	readonly asphaltMinor = mat('#4f5256', { polygonOffset: true, polygonOffsetFactor: -2 });
	readonly paving = mat('#c8b796', { polygonOffset: true, polygonOffsetFactor: -2 });
	readonly sidewalk = mat('#b4aa9a', { polygonOffset: true, polygonOffsetFactor: -1 });
	readonly marking = mat('#efe9da', { polygonOffset: true, polygonOffsetFactor: -3 });
	readonly areas: Record<string, THREE.MeshStandardMaterial> = {
		water: mat('#3b7f8c', { roughness: 0.25, metalness: 0.1 }),
		park: mat('#6f8f4e'),
		grass: mat('#86a35d'),
		pitch: mat('#7aa25a'),
		wetland: mat('#6d8a68'),
		plaza: mat('#d5c7aa'),
		parking: mat('#8d8a84'),
		temple_grounds: mat('#d8c49a')
	};
	readonly trunk = mat('#5b4331');
	readonly crown = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
	readonly metal = mat('#4a4f52', { roughness: 0.5, metalness: 0.6 });
	readonly lamp = new THREE.MeshStandardMaterial({ color: '#fff2c8', emissive: '#ffcf7a', emissiveIntensity: 0.6 });

	constructor() {
		for (const m of Object.values(this.areas)) {
			m.polygonOffset = true;
			m.polygonOffsetFactor = -1;
		}
	}

	dispose() {
		this.windows.dispose();
		for (const m of [
			this.walls, this.roofs, this.asphalt, this.asphaltMinor, this.paving, this.sidewalk,
			this.marking, this.trunk, this.crown, this.metal, this.lamp, ...Object.values(this.areas)
		])
			m.dispose();
	}
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

function shapeFrom(rings: PolygonRings): THREE.Shape | null {
	const [outer, ...holes] = rings;
	if (!outer || outer.length < 3) return null;
	// Shape space is (x, -z) so that rotating -90° about X maps extrusion depth to +Y.
	const shape = new THREE.Shape(outer.map(([x, z]) => new THREE.Vector2(x, -z)));
	for (const hole of holes) {
		if (hole.length >= 3) shape.holes.push(new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, -z))));
	}
	return shape;
}

const ROTATE_TO_GROUND = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

function mergeInto(group: THREE.Group, geometries: THREE.BufferGeometry[], material: THREE.Material, opts: { cast?: boolean; receive?: boolean } = {}) {
	if (!geometries.length) return;
	const merged = mergeGeometries(geometries, false);
	geometries.forEach((g) => g.dispose());
	if (!merged) return;
	merged.computeBoundingSphere();
	const mesh = new THREE.Mesh(merged, material);
	mesh.castShadow = !!opts.cast;
	mesh.receiveShadow = opts.receive ?? true;
	mesh.matrixAutoUpdate = false;
	group.add(mesh);
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

function paint(geometry: THREE.BufferGeometry, color: THREE.Color) {
	const n = geometry.getAttribute('position').count;
	const colors = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) colors.set([color.r, color.g, color.b], i * 3);
	geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// ── buildings ───────────────────────────────────────────────────────────────────────────
export function buildBuildings(chunk: ChunkPayload, m: CityMaterials, group: THREE.Group): void {
	const walls: THREE.BufferGeometry[] = [];
	const roofs: THREE.BufferGeometry[] = [];
	const color = new THREE.Color();
	for (const [i, b] of chunk.buildings.entries()) {
		const seed = b.id ?? i + chunk.ix * 1000 + chunk.iz;
		const base = b.colour && /^#[0-9a-f]{6}$/i.test(b.colour) ? b.colour : FACADES[Math.floor(hash(seed) * FACADES.length)];
		const depth = Math.max(0.6, b.h - b.min_h);
		for (const rings of b.polys) {
			const shape = shapeFrom(rings);
			if (!shape) continue;
			const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
			geometry.applyMatrix4(ROTATE_TO_GROUND);
			if (b.min_h) geometry.translate(0, b.min_h, 0);
			const [caps, sides] = geometry.groups;
			if (caps && sides) {
				const roof = slice(geometry, caps.start, caps.count);
				const wall = slice(geometry, sides.start, sides.count);
				// Side-wall UVs are (along-wall metres, 1 - depth). Make v = height above ground so
				// the window grid (one tile per 3.3 m storey) starts at street level, upright.
				const uv = wall.getAttribute('uv') as THREE.BufferAttribute;
				for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - uv.getY(k) + b.min_h);
				paint(wall, color.set(base));
				paint(roof, color.set(base).multiplyScalar(0.78).lerp(new THREE.Color('#8f8a82'), 0.35));
				walls.push(wall);
				roofs.push(roof);
			}
			geometry.dispose();
		}
	}
	mergeInto(group, walls, m.walls, { cast: true });
	mergeInto(group, roofs, m.roofs, { cast: true });
}

// ── roads ───────────────────────────────────────────────────────────────────────────────
const VEHICLE = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const MAJOR = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const LEVEL: Record<string, number> = { trunk: 6, primary: 6, secondary: 5, tertiary: 4, residential: 3, unclassified: 3, living_street: 3, service: 2, pedestrian: 1, footway: 1, path: 1, cycleway: 1, steps: 1, track: 1 };

/** Triangle strip of width `w` centred on a polyline, at height `y`, with mitred joins. */
export function ribbon(pts: XZ[], w: number, y: number): THREE.BufferGeometry | null {
	if (pts.length < 2) return null;
	const half = w / 2;
	const positions: number[] = [];
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
		// Normal of the averaged tangent, scaled to keep the width constant (capped miter).
		const cos = Math.max(0.35, tx * d2x + tz * d2z);
		const ox = (-tz * half) / cos, oz = (tx * half) / cos;
		left.push([x + ox, z + oz]);
		right.push([x - ox, z - oz]);
	}
	for (let i = 0; i < pts.length - 1; i++) {
		const [l0x, l0z] = left[i], [r0x, r0z] = right[i], [l1x, l1z] = left[i + 1], [r1x, r1z] = right[i + 1];
		positions.push(l0x, y, l0z, r0x, y, r0z, l1x, y, l1z, r0x, y, r0z, r1x, y, r1z, l1x, y, l1z);
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	g.computeVertexNormals();
	// Make every face point up regardless of polyline direction.
	const normals = g.getAttribute('normal') as THREE.BufferAttribute;
	for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 0, 1, 0);
	fixWinding(g);
	return g;
}

function fixWinding(g: THREE.BufferGeometry) {
	const p = g.getAttribute('position') as THREE.BufferAttribute;
	for (let i = 0; i < p.count; i += 3) {
		const ax = p.getX(i), az = p.getZ(i), bx = p.getX(i + 1), bz = p.getZ(i + 1), cx = p.getX(i + 2), cz = p.getZ(i + 2);
		// Up-facing triangles have negative signed area in (x, z) with +Y up.
		if ((bx - ax) * (cz - az) - (bz - az) * (cx - ax) > 0) {
			const tx = p.getX(i + 1), ty = p.getY(i + 1), tz = p.getZ(i + 1);
			p.setXYZ(i + 1, cx, p.getY(i + 2), cz);
			p.setXYZ(i + 2, tx, ty, tz);
		}
	}
}

function dashes(road: ChunkRoad, y: number): THREE.BufferGeometry[] {
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
			const g = ribbon([[ax + (bx - ax) * s, az + (bz - az) * s], [ax + (bx - ax) * e, az + (bz - az) * e]], 0.16, y);
			if (g) out.push(g);
			t += DASH + GAP;
		}
		carry = t - len;
	}
	return out;
}

export function buildRoads(chunk: ChunkPayload, m: CityMaterials, group: THREE.Group): void {
	const major: THREE.BufferGeometry[] = [], minor: THREE.BufferGeometry[] = [];
	const paths: THREE.BufferGeometry[] = [], walks: THREE.BufferGeometry[] = [], marks: THREE.BufferGeometry[] = [];
	for (const road of chunk.roads) {
		const level = LEVEL[road.cls.replace(/_link$/, '')] ?? 1;
		const y = 0.04 + level * 0.006;
		if (VEHICLE.has(road.cls)) {
			const asphalt = ribbon(road.pts, road.w, y);
			if (asphalt) (MAJOR.has(road.cls) ? major : minor).push(asphalt);
			if (road.cls !== 'service') {
				const walk = ribbon(road.pts, road.w + 3.2, 0.035);
				if (walk) walks.push(walk);
			}
			if (MAJOR.has(road.cls) && !road.oneway && road.w >= 8) marks.push(...dashes(road, y + 0.01));
		} else {
			const path = ribbon(road.pts, road.w, y);
			if (path) paths.push(path);
		}
	}
	mergeInto(group, walks, m.sidewalk);
	mergeInto(group, minor, m.asphaltMinor);
	mergeInto(group, major, m.asphalt);
	mergeInto(group, paths, m.paving);
	mergeInto(group, marks, m.marking);
}

// ── ground areas ────────────────────────────────────────────────────────────────────────
const AREA_Y: Record<string, number> = { water: 0.012, wetland: 0.014, parking: 0.016, plaza: 0.018, temple_grounds: 0.018, grass: 0.02, park: 0.022, pitch: 0.026 };

export function buildAreas(chunk: ChunkPayload, m: CityMaterials, group: THREE.Group): void {
	const byKind = new Map<string, THREE.BufferGeometry[]>();
	for (const area of chunk.areas) {
		const material = m.areas[area.kind];
		if (!material) continue;
		for (const rings of area.polys) {
			const shape = shapeFrom(rings);
			if (!shape) continue;
			const g = new THREE.ShapeGeometry(shape);
			g.applyMatrix4(ROTATE_TO_GROUND);
			g.translate(0, AREA_Y[area.kind] ?? 0.02, 0);
			const list = byKind.get(area.kind) ?? [];
			list.push(g);
			byKind.set(area.kind, list);
		}
	}
	for (const [kind, list] of byKind) mergeInto(group, list, m.areas[kind]);
}

// ── trees, lamps and signals ────────────────────────────────────────────────────────────
const TREE_TRUNK = new THREE.CylinderGeometry(0.14, 0.2, 2.6, 6).translate(0, 1.3, 0);
const TREE_CROWN = new THREE.IcosahedronGeometry(1.9, 0).translate(0, 3.6, 0);
const LAMP_POLE = new THREE.CylinderGeometry(0.06, 0.09, 6, 6).translate(0, 3, 0);
const LAMP_HEAD = new THREE.BoxGeometry(0.5, 0.16, 0.28).translate(0, 6, 0.1);
const SIGNAL_POLE = new THREE.CylinderGeometry(0.07, 0.07, 3.8, 6).translate(0, 1.9, 0);
const SIGNAL_BOX = new THREE.BoxGeometry(0.32, 0.9, 0.3).translate(0, 3.6, 0);
const CROWN_COLORS = ['#4f7a3a', '#5d8a40', '#476f35', '#6a9446', '#3f6a33'].map((c) => new THREE.Color(c));

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

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, points: XZ[], scaleOf: (i: number) => number, colorOf?: (i: number) => THREE.Color): THREE.InstancedMesh {
	const mesh = new THREE.InstancedMesh(geometry, material, points.length);
	const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
	const up = new THREE.Vector3(0, 1, 0);
	points.forEach(([x, z], i) => {
		const k = scaleOf(i);
		q.setFromAxisAngle(up, hash(i * 31 + Math.round(x)) * Math.PI * 2);
		m4.compose(p.set(x, 0, z), q, s.set(k, k, k));
		mesh.setMatrixAt(i, m4);
		if (colorOf) mesh.setColorAt(i, colorOf(i));
	});
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.computeBoundingSphere();
	return mesh;
}

export function buildFeatures(chunk: ChunkPayload, m: CityMaterials, group: THREE.Group): void {
	const trees = [...chunk.features.filter((f) => f.k === 'tree').map((f) => f.p), ...parkTrees(chunk)];
	if (trees.length) {
		const scale = (i: number) => 0.75 + hash(i * 13 + chunk.ix) * 0.6;
		group.add(instanced(TREE_TRUNK, m.trunk, trees, scale));
		group.add(instanced(TREE_CROWN, m.crown, trees, scale, (i) => CROWN_COLORS[Math.floor(hash(i * 7 + chunk.iz) * CROWN_COLORS.length)]));
	}
	const lamps = chunk.features.filter((f) => f.k === 'street_lamp').map((f) => f.p);
	if (lamps.length) {
		group.add(instanced(LAMP_POLE, m.metal, lamps, () => 1));
		group.add(instanced(LAMP_HEAD, m.lamp, lamps, () => 1));
	}
	const signals = chunk.features.filter((f) => f.k === 'traffic_signals').map((f) => f.p);
	if (signals.length) {
		group.add(instanced(SIGNAL_POLE, m.metal, signals, () => 1));
		group.add(instanced(SIGNAL_BOX, m.metal, signals, () => 1));
	}
}

// ── landmark labels ─────────────────────────────────────────────────────────────────────
export function labelSprite(title: string, subtitle: string | null, accent = '#e8a33d'): THREE.Sprite {
	const c = document.createElement('canvas');
	const g = c.getContext('2d')!;
	const font = '600 44px Inter, "Noto Sans Khmer", sans-serif';
	const small = '400 34px "Noto Sans Khmer", Inter, sans-serif';
	g.font = font;
	const w1 = g.measureText(title).width;
	g.font = small;
	const w2 = subtitle ? g.measureText(subtitle).width : 0;
	const width = Math.ceil(Math.max(w1, w2) + 70);
	const height = subtitle ? 136 : 84;
	c.width = width;
	c.height = height;
	g.fillStyle = 'rgba(11,37,36,0.82)';
	g.beginPath();
	g.roundRect(0, 0, width, height, 28);
	g.fill();
	g.fillStyle = accent;
	g.beginPath();
	g.arc(30, 42, 9, 0, Math.PI * 2);
	g.fill();
	g.fillStyle = '#f6f1e6';
	g.font = font;
	g.textBaseline = 'middle';
	g.fillText(title, 50, 44);
	if (subtitle) {
		g.font = small;
		g.fillStyle = '#bfe0d8';
		g.fillText(subtitle, 50, 100);
	}
	const texture = new THREE.CanvasTexture(c);
	texture.colorSpace = THREE.SRGBColorSpace;
	const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true }));
	// ~11 m wide for a typical name: readable from a street away, not a wall overhead.
	const k = 0.018;
	sprite.scale.set(width * k, height * k, 1);
	sprite.renderOrder = 10;
	return sprite;
}

export function buildLandmarks(chunk: ChunkPayload, group: THREE.Group, preferKhmer: boolean): THREE.Sprite[] {
	const sprites: THREE.Sprite[] = [];
	const chosen = chunk.landmarks.filter((l) => l.imp >= 3).slice(0, 5);
	for (const lm of chosen) {
		const english = lm.name_en ?? (lm.name_km ? null : lm.name);
		const khmer = lm.name_km ?? (/[ក-៿]/.test(lm.name) ? lm.name : null);
		const title = (preferKhmer ? khmer : english) ?? english ?? khmer ?? lm.name;
		const subtitle = title === khmer ? english : khmer;
		const sprite = labelSprite(title, subtitle);
		sprite.position.set(lm.p[0], 18, lm.p[1]);
		group.add(sprite);
		sprites.push(sprite);
	}
	return sprites;
}

export function disposeGroup(group: THREE.Group): void {
	group.traverse((n) => {
		const mesh = n as THREE.Mesh;
		if (mesh.isMesh && !(mesh as unknown as THREE.InstancedMesh).isInstancedMesh) mesh.geometry.dispose();
		if ((n as THREE.InstancedMesh).isInstancedMesh) (n as THREE.InstancedMesh).dispose();
		const sprite = n as THREE.Sprite;
		if (sprite.isSprite) {
			sprite.material.map?.dispose();
			sprite.material.dispose();
		}
	});
	group.removeFromParent();
}

export function buildChunk(chunk: ChunkPayload, m: CityMaterials, preferKhmer: boolean): THREE.Group {
	const group = new THREE.Group();
	group.name = `chunk:${chunk.key}`;
	buildAreas(chunk, m, group);
	buildRoads(chunk, m, group);
	buildBuildings(chunk, m, group);
	buildFeatures(chunk, m, group);
	buildLandmarks(chunk, group, preferKhmer);
	return group;
}

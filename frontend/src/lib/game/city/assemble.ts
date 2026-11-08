/**
 * ChunkBuild (typed arrays from the worker) → Three.js objects. Runs on the main thread and
 * is cheap: it wraps arrays in BufferGeometries, instances Blender props, and draws the few
 * canvas textures (landmark labels, street-sign text) that a worker cannot.
 */
import * as THREE from 'three';
import type { ChunkBuild, MeshData, SignSpec } from './chunkGeometry';
import type { CityMaterials } from './materials';
import { loadGLTF, type PropLibrary, type PropName } from './props';

/** Real-world dimensions the Blender landmark models were built at (see generate_city_assets.py). */
const MODEL_DIMENSIONS: Record<string, { r: number; h: number }> = {
	'phsar-thmei-dome': { r: 23, h: 16 },
	stupa: { r: 5.87, h: 16.9 } // equivalent radius of the 10.4 m square plinth
};

function geometryOf(data: MeshData): THREE.BufferGeometry {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
	g.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
	if (data.uv) g.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
	if (data.color) g.setAttribute('color', new THREE.BufferAttribute(data.color, 3));
	if (data.facade) g.setAttribute('facade', new THREE.BufferAttribute(data.facade, 2));
	g.computeBoundingSphere();
	return g;
}

function materialOf(data: MeshData, m: CityMaterials): THREE.Material | undefined {
	switch (data.kind) {
		case 'area':
			return m.area(data.area);
		case 'walls':
			return m.walls;
		case 'roofs':
			return m.roofs;
		case 'khmerRoof':
			return m.khmerRoof;
		default:
			return m[data.kind];
	}
}

const CASTS = new Set(['walls', 'roofs', 'khmerRoof']);

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

const BLADE_W = 2.1;
const BLADE_H = 0.5;
const ROW_PX = 96;

/** All sign blades of a chunk share one canvas atlas and one mesh. Blue Phnom Penh street
 * signs: Khmer above, English below; each blade is readable from both sides. */
export function signMesh(signs: SignSpec[]): THREE.Mesh | null {
	const blades = signs.flatMap((s) => s.blades.slice(0, 2).map((b, i) => ({ s, b, i }))).slice(0, 40);
	if (!blades.length) return null;
	const canvas = document.createElement('canvas');
	canvas.width = 512;
	canvas.height = blades.length * ROW_PX;
	const g = canvas.getContext('2d')!;
	blades.forEach(({ b }, row) => {
		const y = row * ROW_PX;
		g.fillStyle = '#1f4f8a';
		g.fillRect(0, y, 512, ROW_PX);
		g.strokeStyle = '#f2f2f2';
		g.lineWidth = 5;
		g.strokeRect(5, y + 5, 502, ROW_PX - 10);
		g.fillStyle = '#ffffff';
		g.textAlign = 'center';
		g.textBaseline = 'middle';
		const fit = (text: string, size: number, family: string) => {
			let px = size;
			do g.font = `600 ${px--}px ${family}`;
			while (g.measureText(text).width > 480 && px > 14);
		};
		if (b.km) {
			fit(b.km, 34, '"Noto Sans Khmer", sans-serif');
			g.fillText(b.km, 256, y + 32);
			fit(b.en, 28, 'Inter, sans-serif');
			g.fillText(b.en, 256, y + 70);
		} else {
			fit(b.en, 34, 'Inter, sans-serif');
			g.fillText(b.en, 256, y + ROW_PX / 2);
		}
	});
	const positions: number[] = [];
	const uvs: number[] = [];
	const normals: number[] = [];
	blades.forEach(({ s, b, i }, row) => {
		const dx = Math.sin(b.a), dz = Math.cos(b.a); // along the street
		const nx = Math.cos(b.a), nz = -Math.sin(b.a); // facing the street side
		const y0 = s.y + 2.35 + i * (BLADE_H + 0.06);
		const y1 = y0 + BLADE_H;
		const ax = s.x + dx * 0.05, az = s.z + dz * 0.05;
		const bx = s.x + dx * BLADE_W, bz = s.z + dz * BLADE_W;
		const v0 = 1 - (row + 1) / blades.length, v1 = 1 - row / blades.length;
		for (const side of [1, -1]) {
			const off = 0.012 * side;
			const [px, pz, qx, qz] = side === 1 ? [ax, az, bx, bz] : [bx, bz, ax, az];
			const corners = [
				[px + nx * off, y0, pz + nz * off, 0, v0], [qx + nx * off, y0, qz + nz * off, 1, v0],
				[qx + nx * off, y1, qz + nz * off, 1, v1], [px + nx * off, y1, pz + nz * off, 0, v1]
			];
			for (const k of [0, 1, 2, 0, 2, 3]) {
				const [x, y, z, u, v] = corners[k];
				positions.push(x, y, z);
				uvs.push(u, v);
				normals.push(nx * side, 0, nz * side);
			}
		}
	});
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
	geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6 }));
	mesh.name = 'signs';
	return mesh;
}

const POOL = new THREE.CircleGeometry(5.5, 20).rotateX(-Math.PI / 2);

export function assembleChunk(
	build: ChunkBuild,
	materials: CityMaterials,
	props: PropLibrary,
	shadows: boolean
): THREE.Group {
	const group = new THREE.Group();
	group.name = `chunk:${build.key}`;
	// Small things (props, light pools, sign blades) are hidden for distant chunks (LOD).
	const detail = new THREE.Group();
	detail.name = 'detail';
	group.add(detail);
	group.userData.detail = detail;
	for (const data of build.meshes) {
		const material = materialOf(data, materials);
		if (!material) continue;
		const mesh = new THREE.Mesh(geometryOf(data), material);
		mesh.castShadow = shadows && CASTS.has(data.kind);
		mesh.receiveShadow = true;
		mesh.matrixAutoUpdate = false;
		group.add(mesh);
	}
	const m4 = new THREE.Matrix4();
	for (const { prop, matrices } of build.instances) {
		const list: THREE.Matrix4[] = [];
		for (let i = 0; i < matrices.length; i += 16) list.push(new THREE.Matrix4().fromArray(matrices, i));
		for (const mesh of props.instance(prop as PropName, list, { shadows })) detail.add(mesh);
	}
	if (build.pools.length) {
		const count = build.pools.length / 3;
		const pools = new THREE.InstancedMesh(POOL, materials.pools, count);
		for (let i = 0; i < count; i++) pools.setMatrixAt(i, m4.makeTranslation(build.pools[i * 3], build.pools[i * 3 + 1], build.pools[i * 3 + 2]));
		pools.userData.shared = true;
		pools.renderOrder = 2;
		pools.computeBoundingSphere();
		detail.add(pools);
	}
	for (const l of build.labels) {
		const sprite = labelSprite(l.title, l.subtitle);
		sprite.position.set(l.x, l.y, l.z);
		group.add(sprite);
	}
	const signs = signMesh(build.signs);
	if (signs) detail.add(signs);
	for (const model of build.models) {
		const dims = MODEL_DIMENSIONS[model.name];
		if (!dims) continue;
		loadGLTF(`/models/landmarks/${model.name}.glb`).then((scene) => {
			if (!group.parent) return; // chunk already unloaded
			const clone = scene.clone(true);
			clone.position.set(model.x, model.y, model.z);
			clone.scale.set(model.r / dims.r, model.h / dims.h, model.r / dims.r);
			clone.traverse((n) => {
				n.userData.shared = true;
				(n as THREE.Mesh).castShadow = shadows;
			});
			group.add(clone);
			(group.userData.onChange as (() => void) | undefined)?.(); // e.g. refresh cached shadows
		});
	}
	return group;
}

export function disposeGroup(group: THREE.Group): void {
	group.traverse((n) => {
		const shared = !!n.userData.shared;
		const instanced = n as THREE.InstancedMesh;
		if (instanced.isInstancedMesh) {
			instanced.dispose();
			return;
		}
		const sprite = n as THREE.Sprite;
		if (sprite.isSprite) {
			sprite.material.map?.dispose();
			sprite.material.dispose();
			return;
		}
		const mesh = n as THREE.Mesh;
		if (mesh.isMesh && !shared) {
			mesh.geometry.dispose();
			if (mesh.name === 'signs') {
				const m = mesh.material as THREE.MeshStandardMaterial;
				m.map?.dispose();
				m.dispose();
			}
		}
	});
	group.removeFromParent();
}

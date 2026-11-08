/**
 * Blender props (trees, lamps, signals, sign posts, landmark models) for the city.
 *
 * GLBs are Meshopt-compressed (see `npm run assets:compress`). Each prop is flattened once into
 * one merged geometry per material, so hundreds of copies render as a few InstancedMeshes.
 * Materials are shared by name across all props, so the day/night controller can make every
 * `Lamp` glow at once.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const scenes = new Map<string, Promise<THREE.Group>>();

/** Load (and cache) a GLB scene. Callers clone it before adding it to a scene. */
export function loadGLTF(url: string): Promise<THREE.Group> {
	let promise = scenes.get(url);
	if (!promise) {
		promise = loader.loadAsync(url).then((gltf) => {
			gltf.scene.traverse((n) => {
				const mesh = n as THREE.Mesh;
				if (mesh.isMesh) {
					mesh.castShadow = true;
					mesh.receiveShadow = true;
				}
			});
			return gltf.scene;
		});
		scenes.set(url, promise);
	}
	return promise;
}

export interface PropPart {
	geometry: THREE.BufferGeometry;
	material: THREE.MeshStandardMaterial;
}

export interface Prop {
	parts: PropPart[];
	height: number;
}

export const PROP_NAMES = [
	'tree-rain',
	'tree-palm',
	'tree-slender',
	'lamp',
	'traffic-signal',
	'sign-post'
] as const;
export type PropName = (typeof PROP_NAMES)[number];

/** One shared material per Blender material name, across every prop. */
export class PropMaterials {
	readonly byName = new Map<string, THREE.MeshStandardMaterial>();

	adopt(material: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
		const existing = this.byName.get(material.name);
		if (existing) return existing;
		this.byName.set(material.name, material);
		return material;
	}

	dispose() {
		this.byName.forEach((m) => m.dispose());
		this.byName.clear();
	}
}

/** Flatten a prop's meshes into one geometry per material (positions/normals/uv only). */
export function flattenProp(root: THREE.Object3D, materials: PropMaterials): Prop {
	root.updateMatrixWorld(true);
	const groups = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>();
	const box = new THREE.Box3();
	root.traverse((n) => {
		const mesh = n as THREE.Mesh;
		if (!mesh.isMesh || Array.isArray(mesh.material)) return;
		const material = materials.adopt(mesh.material as THREE.MeshStandardMaterial);
		// Convert quantised attributes to float BEFORE baking the transform (else they clamp).
		const geometry = floatGeometry(mesh.geometry).applyMatrix4(mesh.matrixWorld);
		box.expandByObject(mesh);
		const list = groups.get(material) ?? [];
		list.push(geometry);
		groups.set(material, list);
	});
	const parts: PropPart[] = [];
	for (const [material, list] of groups) {
		const geometry = mergeGeometries(list, false);
		list.forEach((g) => g.dispose());
		if (geometry) parts.push({ geometry, material });
	}
	return { parts, height: box.max.y };
}

/**
 * A non-indexed copy with float32 position/normal/uv only. Meshopt-quantised attributes are
 * normalised integers, so they must be expanded before any transform is applied to them.
 */
export function floatGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
	const indexed = source.index ? source.toNonIndexed() : source;
	const out = new THREE.BufferGeometry();
	for (const name of ['position', 'normal', 'uv'] as const) {
		const attr = indexed.getAttribute(name) as THREE.BufferAttribute | undefined;
		if (!attr) continue;
		const data = new Float32Array(attr.count * attr.itemSize);
		for (let i = 0; i < attr.count; i++)
			for (let c = 0; c < attr.itemSize; c++) data[i * attr.itemSize + c] = attr.getComponent(i, c);
		out.setAttribute(name, new THREE.BufferAttribute(data, attr.itemSize));
	}
	if (!out.getAttribute('uv'))
		out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(out.getAttribute('position').count * 2), 2));
	if (!out.getAttribute('normal')) out.computeVertexNormals();
	if (indexed !== source) indexed.dispose();
	return out;
}

export class PropLibrary {
	readonly materials = new PropMaterials();
	private props = new Map<PropName, Prop>();

	async load(names: readonly PropName[] = PROP_NAMES): Promise<void> {
		await Promise.all(
			names.map(async (name) => {
				const scene = await loadGLTF(`/models/city/${name}.glb`);
				this.props.set(name, flattenProp(scene, this.materials));
			})
		);
	}

	get(name: PropName): Prop | undefined {
		return this.props.get(name);
	}

	/** One InstancedMesh per material of the prop, sharing the given transforms. */
	instance(name: PropName, matrices: THREE.Matrix4[], { shadows = true } = {}): THREE.InstancedMesh[] {
		const prop = this.props.get(name);
		if (!prop || !matrices.length) return [];
		return prop.parts.map(({ geometry, material }) => {
			const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
			matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
			mesh.instanceMatrix.needsUpdate = true;
			mesh.castShadow = shadows;
			mesh.receiveShadow = true;
			mesh.computeBoundingSphere();
			mesh.userData.shared = true; // geometry & material belong to the library
			return mesh;
		});
	}

	dispose() {
		for (const prop of this.props.values()) prop.parts.forEach((p) => p.geometry.dispose());
		this.props.clear();
		this.materials.dispose();
	}
}

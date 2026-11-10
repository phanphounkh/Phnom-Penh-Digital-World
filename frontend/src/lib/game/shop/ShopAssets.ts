/**
 * Models for walk-in shops: fittings (Blender: shelf, table, awning; CampusEats: checkout
 * counter, shopping cart) and product display models (Blender generics + CampusEats food).
 *
 * Every model is normalised once (scaled to a target size, base on y = 0, centred in x/z)
 * and cloned per use. Material names are semantic (see tools/blender/generate_shop_assets.py):
 * `Tint`/`Accent` take a shop's colours, `Label` can show the product's photo.
 */
import * as THREE from 'three';
import type { DisplayModel } from '$lib/api/market';
import { loadGLTF } from '$lib/game/city/props';

const FOOD = new Set(['burger', 'cake', 'coffee', 'drink', 'fries', 'noodles', 'pizza', 'rice']);

export function productModelUrl(model: DisplayModel): string {
	return FOOD.has(model) ? `/models/food/${model}.glb` : `/models/shop/product-${model}.glb`;
}

const FITTINGS = {
	shelf: '/models/shop/shelf.glb',
	table: '/models/shop/table.glb',
	awning: '/models/shop/awning.glb',
	counter: '/models/equipment/checkout-counter.glb',
	cart: '/models/equipment/shopping-cart.glb'
} as const;
export type Fitting = keyof typeof FITTINGS;

/** Target sizes: fittings keep their modelled metres unless listed (largest side, m). */
const FITTING_SIZE: Partial<Record<Fitting, number>> = { counter: 2.0, cart: 1.0 };

const normalised = new Map<string, Promise<THREE.Object3D>>();

/** Scale so the largest horizontal side is `size` m (if given), base at y = 0, centred. */
function normalise(source: THREE.Object3D, size?: number): THREE.Object3D {
	const root = new THREE.Group();
	const model = source.clone(true);
	root.add(model);
	root.updateMatrixWorld(true);
	let box = new THREE.Box3().setFromObject(model);
	if (size) {
		const dims = box.getSize(new THREE.Vector3());
		const largest = Math.max(dims.x, dims.z, dims.y * 0.8);
		if (largest > 0) model.scale.multiplyScalar(size / largest);
		root.updateMatrixWorld(true);
		box = new THREE.Box3().setFromObject(model);
	}
	const centre = box.getCenter(new THREE.Vector3());
	model.position.x -= centre.x;
	model.position.z -= centre.z;
	model.position.y -= box.min.y;
	root.traverse((n) => {
		const mesh = n as THREE.Mesh;
		if (mesh.isMesh) {
			mesh.castShadow = false;
			mesh.receiveShadow = false;
		}
	});
	return root;
}

function cached(url: string, size?: number): Promise<THREE.Object3D> {
	const key = `${url}@${size ?? 'native'}`;
	let p = normalised.get(key);
	if (!p) {
		p = loadGLTF(url).then((scene) => normalise(scene, size));
		normalised.set(key, p);
	}
	return p;
}

export async function fitting(name: Fitting): Promise<THREE.Object3D> {
	return (await cached(FITTINGS[name], FITTING_SIZE[name])).clone(true);
}

/** A product display model, `size` m across, with its own (recolourable) materials. */
export async function productModel(model: DisplayModel, size: number): Promise<THREE.Object3D> {
	const url = productModelUrl(model);
	try {
		return deepCloneMaterials((await cached(url, size)).clone(true));
	} catch {
		return deepCloneMaterials((await cached(productModelUrl('box'), size)).clone(true));
	}
}

function deepCloneMaterials(root: THREE.Object3D): THREE.Object3D {
	root.traverse((n) => {
		const mesh = n as THREE.Mesh;
		if (mesh.isMesh) {
			mesh.material = Array.isArray(mesh.material)
				? mesh.material.map((m) => m.clone())
				: (mesh.material as THREE.Material).clone();
			mesh.userData.ownsMaterial = true;
		}
	});
	return root;
}

/** Recolour `Tint` / `Accent` materials (clones them first: the source is shared). */
export function tint(root: THREE.Object3D, primary: string, accent: string): void {
	root.traverse((n) => {
		const mesh = n as THREE.Mesh;
		if (!mesh.isMesh) return;
		const m = mesh.material as THREE.MeshStandardMaterial;
		if (m.name !== 'Tint' && m.name !== 'Accent') return;
		const copy = m.clone();
		copy.color.set(m.name === 'Tint' ? primary : accent);
		mesh.material = copy;
		mesh.userData.ownsMaterial = true;
	});
}

const textureLoader = new THREE.TextureLoader();
const photos = new Map<string, Promise<THREE.Texture>>();

/** Put a product photo on the model's `Label` material(s). */
export function applyPhoto(root: THREE.Object3D, url: string): void {
	let p = photos.get(url);
	if (!p) {
		p = textureLoader.loadAsync(url).then((t) => {
			t.colorSpace = THREE.SRGBColorSpace;
			t.anisotropy = 4;
			return t;
		});
		photos.set(url, p);
	}
	p.then((texture) =>
		root.traverse((n) => {
			const mesh = n as THREE.Mesh;
			const m = mesh.material as THREE.MeshStandardMaterial | undefined;
			if (mesh.isMesh && m?.name === 'Label') {
				m.map = texture;
				m.color.set('#ffffff');
				m.needsUpdate = true;
			}
		})
	).catch(() => undefined);
}

/** Dispose geometries/materials owned by a shop subtree (shared GLB sources stay cached). */
export function disposeOwned(root: THREE.Object3D): void {
	root.traverse((n) => {
		const mesh = n as THREE.Mesh;
		if (!mesh.isMesh) return;
		if (mesh.userData.ownsGeometry) mesh.geometry.dispose();
		if (mesh.userData.ownsMaterial) {
			const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
			for (const m of mats) {
				// Only canvas textures made for this shop; product photos are shared and cached.
				if (m.userData.ownsMap) (m as THREE.MeshStandardMaterial).map?.dispose();
				m.dispose();
			}
		}
	});
}

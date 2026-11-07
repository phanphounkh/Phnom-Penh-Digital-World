/**
 * Player avatars built from the modular Blender GLB (tools/blender/generate_avatars.py).
 *
 * - Optional parts are named `opt__<group>-<value>__<part>`; only the parts matching the
 *   player's choices stay visible (or are pruned, for in-world avatars).
 * - Semantic materials (Skin, Hair, Top, Bottom, Shoes, Accent) are cloned per avatar and
 *   recoloured, so many players can share one cached GLB without sharing colours.
 * - The joint hierarchy (BodyRoot, Left/Right Leg-Knee-Ankle, Arm-Elbow-Wrist) is the
 *   CampusEats rig, so PlayerAnimations drives it unchanged.
 */
import {
	Color,
	Float32BufferAttribute,
	Mesh,
	MeshStandardMaterial,
	type Material,
	type Object3D,
	type Group,
	type BufferGeometry
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Avatar } from '$lib/api/types';

export const AVATAR_URL = '/models/characters/avatar.glb';
export const AVATAR_SCALE = 0.9; // the rig is ~1.92 m tall; 0.9 ≈ 1.73 m
const OPTION = /^opt__([a-z]+)-([a-z0-9]+)__/;

export const SKIN_TONES = ['#f1d0b5', '#e0b48f', '#c8946b', '#a8744f', '#7e5236', '#5a3824'];
export const HAIR_COLORS = ['#1b1514', '#2b2220', '#4a3021', '#7a4b2a', '#b98a4e', '#8e8a86'];
export const CLOTH_COLORS = [
	'#2f7d6d', '#123b3a', '#e8a33d', '#c4552f', '#f6f1e6', '#343b4a',
	'#6b4fa0', '#d6627a', '#3d6fb6', '#8a9a5b', '#1d2422', '#b9b2a3'
];
export const SHOE_COLORS = ['#eee5d5', '#1d2422', '#c4552f', '#3d6fb6', '#e8a33d', '#8a6a4a'];

export const DEFAULT_AVATAR: Avatar = {
	avatar_name: 'Explorer',
	body: 'a',
	skin_tone: '#c8946b',
	hair_style: 'short',
	hair_color: '#2b2220',
	top_style: 'tee',
	top_color: '#2f7d6d',
	bottom_style: 'trousers',
	bottom_color: '#343b4a',
	shoe_color: '#eee5d5',
	accent_color: '#e8a33d',
	accessories: []
};

const RECOLOR: Record<string, (a: Avatar) => string> = {
	Skin: (a) => a.skin_tone,
	Hair: (a) => a.hair_color,
	Top: (a) => a.top_color,
	Bottom: (a) => a.bottom_color,
	Shoes: (a) => a.shoe_color,
	Accent: (a) => a.accent_color,
	AccentDark: (a) => '#' + new Color(a.accent_color).multiplyScalar(0.45).getHexString()
};

/** `top-tee`-style keys for every option the avatar uses. */
export function selectedOptions(a: Avatar): Set<string> {
	return new Set([
		`body-${a.body}`,
		`top-${a.top_style}`,
		`bottom-${a.bottom_style}`,
		`hair-${a.hair_style}`,
		...a.accessories.map((x) => `acc-${x}`)
	]);
}

export function optionOf(nodeName: string): string | null {
	const m = OPTION.exec(nodeName);
	return m ? `${m[1]}-${m[2]}` : null;
}

export function randomAvatar(name: string, rand: () => number = Math.random): Avatar {
	const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
	const accessories = (['cap', 'glasses', 'backpack', 'krama'] as const).filter(() => rand() < 0.3);
	return {
		avatar_name: name,
		body: pick(['a', 'b'] as const),
		skin_tone: pick(SKIN_TONES),
		hair_style: pick(['short', 'long', 'bun', 'buzz'] as const),
		hair_color: pick(HAIR_COLORS),
		top_style: pick(['hoodie', 'tee'] as const),
		top_color: pick(CLOTH_COLORS),
		bottom_style: pick(['trousers', 'shorts'] as const),
		bottom_color: pick(CLOTH_COLORS),
		shoe_color: pick(SHOE_COLORS),
		accent_color: pick(CLOTH_COLORS),
		accessories: accessories.slice(0, 3)
	};
}

let template: Promise<Group> | null = null;

export function loadAvatarTemplate(url = AVATAR_URL): Promise<Group> {
	template ??= new GLTFLoader().loadAsync(url).then((gltf) => {
		gltf.scene.traverse((n) => {
			if ((n as Mesh).isMesh) {
				n.castShadow = true;
				n.receiveShadow = true;
			}
		});
		return gltf.scene;
	});
	return template;
}

export interface AvatarInstance {
	root: Group;
	/** Update colours and visible parts (preview instances only; batched ones are rebuilt). */
	update(avatar: Avatar): void;
	dispose(): void;
}

function applyColors(materials: Map<string, MeshStandardMaterial>, avatar: Avatar) {
	for (const [name, color] of Object.entries(RECOLOR)) {
		materials.get(name)?.color.setStyle(color(avatar));
	}
}

function applyVisibility(root: Object3D, avatar: Avatar) {
	const selected = selectedOptions(avatar);
	root.traverse((n) => {
		const option = optionOf(n.name);
		if (option) n.visible = selected.has(option);
	});
}

/** Merge static child meshes per joint by material, keeping the animated joint hierarchy. */
export function batchJointMeshes(root: Object3D): void {
	const parents: Object3D[] = [];
	root.traverse((n) => parents.push(n));
	for (const parent of parents) {
		const batches = new Map<Material, BufferGeometry[]>();
		for (const child of [...parent.children]) {
			const mesh = child as Mesh;
			if (!mesh.isMesh || mesh.children.length || Array.isArray(mesh.material)) continue;
			mesh.updateMatrix();
			const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrix);
			for (const name of Object.keys(geometry.attributes)) {
				if (!['position', 'normal', 'uv'].includes(name)) geometry.deleteAttribute(name);
			}
			if (!geometry.attributes.uv) {
				geometry.setAttribute(
					'uv',
					new Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 2), 2)
				);
			}
			const list = batches.get(mesh.material) ?? [];
			list.push(geometry);
			batches.set(mesh.material, list);
			parent.remove(mesh);
		}
		for (const [material, geometries] of batches) {
			const merged = mergeGeometries(geometries.map((g) => (g.index ? g.toNonIndexed() : g)));
			geometries.forEach((g) => g.dispose());
			if (!merged) continue;
			const mesh = new Mesh(merged, material);
			mesh.name = 'JointDetails';
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			parent.add(mesh);
		}
	}
}

/**
 * Create one avatar.
 * - `batch: false` (preview): parts are toggled, so `update()` can restyle it live.
 * - `batch: true` (world): unused parts are removed and meshes merged per joint for fewer
 *   draw calls; rebuild the instance if the avatar changes.
 */
export async function createAvatar(avatar: Avatar, { batch = false } = {}): Promise<AvatarInstance> {
	const source = await loadAvatarTemplate();
	const root = source.clone(true) as Group;
	root.scale.setScalar(AVATAR_SCALE);
	const materials = new Map<string, MeshStandardMaterial>();
	root.traverse((n) => {
		const mesh = n as Mesh;
		if (!mesh.isMesh) return;
		const original = mesh.material as MeshStandardMaterial;
		let own = materials.get(original.name);
		if (!own) {
			own = original.clone();
			materials.set(original.name, own);
		}
		mesh.material = own;
	});
	applyColors(materials, avatar);
	applyVisibility(root, avatar);
	const owned: BufferGeometry[] = [];
	if (batch) {
		const unused: Object3D[] = [];
		root.traverse((n) => {
			if (optionOf(n.name) && !n.visible) unused.push(n);
		});
		unused.forEach((n) => n.removeFromParent());
		batchJointMeshes(root);
		root.traverse((n) => {
			if ((n as Mesh).isMesh && n.name === 'JointDetails') owned.push((n as Mesh).geometry);
		});
	}
	return {
		root,
		update(next: Avatar) {
			applyColors(materials, next);
			if (!batch) applyVisibility(root, next);
		},
		dispose() {
			materials.forEach((m) => m.dispose());
			owned.forEach((g) => g.dispose());
			root.removeFromParent();
		}
	};
}

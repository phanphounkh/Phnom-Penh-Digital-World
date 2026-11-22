/**
 * Realistic avatars (avatar-generator/, MakeHuman CC0 bodies with procedural clothing): one
 * game-quality GLB per body build, cloned per player and recoloured from their avatar choices.
 *
 * Contract (frontend/static/models/characters/realistic/manifest.json, written by
 * avatar-generator/scripts/install_to_game.py):
 * - 52-bone Mixamo skeleton (Three.js names `mixamorigHips`, `mixamorigRightHand`, …), metres,
 *   facing +Z, feet at y = 0. Anatomical left is +X.
 * - Materials: `Skin` (texture × tint), `<kind>_game_hair` (neutral grey × hair colour),
 *   `<kind>.Outfit` (a 16 px-cell palette texture: one cell per original material, so clothing
 *   colours are changed by repainting cells), plus shared eyes/teeth/brows/decals.
 * - Clips: Idle Walk Run Wave Sit Talk Dance Greet Cheer; morphs: Smile Excited Surprised
 *   Thinking Wink Blink MouthOpen.
 * Build A uses the male model and Build B the female one. Hair style, garment styles and
 * accessories belong to the classic avatar; the realistic outfits are fixed, but every colour
 * choice (skin, hair, top, bottom, shoes, accent) applies.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Avatar } from '$lib/api/types';

export const REALISTIC_BASE = '/models/characters/realistic/';
export type RealisticKind = 'male' | 'female';

export interface RealisticEntry {
	kind: RealisticKind;
	file: string;
	height_m: number;
	skin_tone: string;
	hair_color: string;
	hair_texture_mean: number;
	palette: { size: number; cell: number; cells: Record<string, [number, number]> };
	clips: string[];
	morphs: string[];
	walk_speed: number;
	run_speed: number;
	/** Absent in models built before the Sprint clip existed. */
	sprint_speed?: number;
}

export interface RealisticManifest {
	version: number;
	characters: Record<RealisticKind, RealisticEntry>;
}

/** Which palette cells (original material names) each avatar colour choice repaints. */
export const RECOLOR: Record<RealisticKind, Record<'top' | 'bottom' | 'shoe' | 'accent', string[]>> = {
	male: {
		top: ['Jacket'],
		bottom: ['Pants', 'PantsRib'],
		shoe: ['ShoeUpper'],
		accent: ['JacketPanel', 'BackpackAccent', 'ShoeAccent']
	},
	female: {
		top: ['Hoodie', 'HoodieRib'],
		bottom: ['Pants', 'PantsRib'],
		shoe: ['ShoeUpper'],
		accent: ['BackpackAccent', 'ShoeAccent']
	}
};

export function kindFor(avatar: Pick<Avatar, 'body'>): RealisticKind {
	return avatar.body === 'b' ? 'female' : 'male';
}

/** Palette cells to repaint for `avatar`: [x, y, size, colour] in image pixels. */
export function paletteFills(entry: RealisticEntry, avatar: Avatar): [number, number, number, string][] {
	const slots = RECOLOR[entry.kind];
	const colour = { top: avatar.top_color, bottom: avatar.bottom_color, shoe: avatar.shoe_color, accent: avatar.accent_color };
	const fills: [number, number, number, string][] = [];
	for (const slot of Object.keys(slots) as (keyof typeof slots)[]) {
		for (const name of slots[slot]) {
			const cell = entry.palette.cells[name];
			if (cell) fills.push([cell[0], cell[1], entry.palette.cell, colour[slot]]);
		}
	}
	return fills;
}

/** Linear-space multiplier that turns the baked skin tone into `target` (texture detail kept). */
export function skinFactor(baked: string, target: string): [number, number, number] {
	const b = new THREE.Color(baked);
	const t = new THREE.Color(target);
	const ratio = (x: number, y: number) => Math.min(1.8, Math.max(0.15, y / Math.max(x, 1e-4)));
	return [ratio(b.r, t.r), ratio(b.g, t.g), ratio(b.b, t.b)];
}

/** Linear multiplier for the neutral hair texture (average `mean`) to show `hair`. */
export function hairFactor(hair: string, mean: number): [number, number, number] {
	const c = new THREE.Color(hair);
	return [c.r / mean, c.g / mean, c.b / mean];
}

// ── Loading ──────────────────────────────────────────────────────────────────────────────

let manifest: Promise<RealisticManifest> | null = null;
const templates = new Map<RealisticKind, Promise<{ scene: THREE.Group; clips: THREE.AnimationClip[]; entry: RealisticEntry }>>();

export function loadManifest(): Promise<RealisticManifest> {
	manifest ??= fetch(REALISTIC_BASE + 'manifest.json').then((r) => {
		if (!r.ok) throw new Error(`realistic avatars: manifest HTTP ${r.status}`);
		return r.json();
	});
	return manifest;
}

export function loadRealistic(kind: RealisticKind) {
	let t = templates.get(kind);
	if (!t) {
		t = loadManifest().then(async (m) => {
			const entry = m.characters[kind];
			const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(REALISTIC_BASE + entry.file);
			gltf.scene.traverse((o) => {
				const mesh = o as THREE.Mesh;
				if (!mesh.isMesh) return;
				for (const m of [mesh.material].flat() as THREE.MeshStandardMaterial[]) {
					// Hair, brows and decals are alpha-tested: smooth their edges under MSAA.
					if (m.alphaTest > 0) m.alphaToCoverage = true;
				}
			});
			return { scene: gltf.scene, clips: gltf.animations, entry };
		});
		t.catch(() => templates.delete(kind));
		templates.set(kind, t);
	}
	return t;
}

// ── Instances ────────────────────────────────────────────────────────────────────────────

export interface RealisticInstance {
	readonly kind: RealisticKind;
	readonly root: THREE.Group;
	readonly clips: THREE.AnimationClip[];
	readonly entry: RealisticEntry;
	/** Recolour in place (a different build needs a new instance: returns false). */
	update(avatar: Avatar): boolean;
	dispose(): void;
}

function makePalette(source: THREE.Texture, size: number): { canvas: HTMLCanvasElement | OffscreenCanvas; texture: THREE.Texture } {
	const canvas =
		typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
	const g = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	if (source.image) g.drawImage(source.image as CanvasImageSource, 0, 0, size, size);
	const texture = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
	texture.flipY = false; // glTF texture convention
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.magFilter = THREE.NearestFilter;
	texture.minFilter = THREE.NearestMipmapNearestFilter;
	texture.wrapS = source.wrapS;
	texture.wrapT = source.wrapT;
	return { canvas, texture };
}

export async function createRealisticAvatar(avatar: Avatar): Promise<RealisticInstance> {
	const kind = kindFor(avatar);
	const { scene, clips, entry } = await loadRealistic(kind);
	const root = cloneSkinned(scene) as THREE.Group;
	root.name = `realistic:${kind}`;

	// Per-instance copies of the three recolourable materials.
	const owned: THREE.Material[] = [];
	let skin: THREE.MeshStandardMaterial | null = null;
	let hair: THREE.MeshStandardMaterial | null = null;
	let outfit: THREE.MeshStandardMaterial | null = null;
	const copies = new Map<THREE.Material, THREE.Material>();
	root.traverse((o) => {
		const mesh = o as THREE.SkinnedMesh;
		if (!mesh.isMesh) return;
		mesh.frustumCulled = false; // skinned: bind-pose bounds do not follow the animation
		const m = mesh.material as THREE.MeshStandardMaterial;
		const recolour = m.name === 'Skin' || m.name === `${kind}_game_hair` || m.name === `${kind}.Outfit`;
		if (!recolour) return;
		let copy = copies.get(m) as THREE.MeshStandardMaterial | undefined;
		if (!copy) {
			copy = m.clone();
			copies.set(m, copy);
			owned.push(copy);
			if (m.name === 'Skin') skin = copy;
			else if (m.name.endsWith('_game_hair')) hair = copy;
			else outfit = copy;
		}
		mesh.material = copy;
	});
	const palette = outfit && (outfit as THREE.MeshStandardMaterial).map ? makePalette((outfit as THREE.MeshStandardMaterial).map!, entry.palette.size) : null;
	if (palette && outfit) (outfit as THREE.MeshStandardMaterial).map = palette.texture;

	// Shops hold products at the classic rig's `RightWrist`: offer the same socket on the hand
	// (local -Y runs along the hand towards the fingers, like the classic wrist).
	const hand = root.getObjectByName('mixamorigRightHand');
	if (hand) {
		const socket = new THREE.Object3D();
		socket.name = 'RightWrist';
		socket.rotation.x = Math.PI;
		hand.add(socket);
	}

	const apply = (a: Avatar) => {
		if (skin) (skin as THREE.MeshStandardMaterial).color.setRGB(...skinFactor(entry.skin_tone, a.skin_tone), THREE.LinearSRGBColorSpace);
		if (hair) (hair as THREE.MeshStandardMaterial).color.setRGB(...hairFactor(a.hair_color, entry.hair_texture_mean), THREE.LinearSRGBColorSpace);
		if (palette) {
			const g = palette.canvas.getContext('2d') as CanvasRenderingContext2D;
			for (const [x, y, size, colour] of paletteFills(entry, a)) {
				g.fillStyle = colour;
				g.fillRect(x, y, size, size);
			}
			palette.texture.needsUpdate = true;
		}
	};
	apply(avatar);

	return {
		kind,
		root,
		clips,
		entry,
		update(next) {
			if (kindFor(next) !== kind) return false;
			apply(next);
			return true;
		},
		dispose() {
			owned.forEach((m) => m.dispose());
			palette?.texture.dispose();
			root.removeFromParent();
		}
	};
}

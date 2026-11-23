/**
 * Shopkeepers: a person behind each open shop's counter who serves walk-in customers on the
 * seller's behalf. They greet a player who walks in (a sampeah), turn to face them, talk at the
 * counter and thank them when they pay.
 *
 * Who stands at a shop (body, name, skin, hair, clothes) follows from the shop's id, so every
 * player sees the same shopkeeper; the apron is in the shop's colours. They are drawn by each
 * player's own client (nothing is sent over the network) and only at the nearest open shops
 * (MAX within RADIUS), since each is a full character (about 30k triangles, one animation mixer).
 */
import * as THREE from 'three';
import type { Shop } from '$lib/api/market';
import type { Avatar } from '$lib/api/types';
import { createCharacter, type GameCharacter } from '$lib/game/avatar/character';
import { disposeSprite, roundedLabel, speechBubble } from '$lib/game/avatar/labels';

/** Metres: shopkeepers appear at shops closer than this, and go once 10 m further. */
export const RADIUS = 30;
/** At most this many at once (the nearest). */
export const MAX = 2;
const BUBBLE_MS = 5000;
const GREET_AGAIN_MS = 45_000;
const TURN_SPEED = 4; // rad/s
/** How far they turn from facing the door to look at a customer (rad). */
const LOOK_LIMIT = 1.3;

const NAMES: Record<Avatar['body'], string[]> = {
	a: ['Dara', 'Rithy', 'Sokha', 'Vuthy', 'Piseth', 'Visal', 'Sambath', 'Kosal'],
	b: ['Sreymom', 'Bopha', 'Chenda', 'Malis', 'Sophea', 'Kunthea', 'Leakhena', 'Vanna']
};
const SKIN = ['#8d5a3b', '#9b6845', '#a8744f', '#b5815f', '#c08a64', '#cf9c80'];
const HAIR = ['#141012', '#1b1514', '#2a1d17', '#3b2a20'];
const TOP = ['#f3efe6', '#e9e2d0', '#2f3b45', '#5b6b63'];
const BOTTOM = ['#1f2933', '#343b4a', '#2b2b2b'];

/** FNV-1a, 32-bit: a stable number from a string. */
export function hash(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** The shopkeeper of a shop: the same for every player. */
export function keeperFor(shop: Pick<Shop, 'id' | 'accent_color'>): { name: string; avatar: Avatar } {
	const h = hash(shop.id);
	const body: Avatar['body'] = h & 1 ? 'b' : 'a';
	const pick = <T>(list: T[], shift: number) => list[(h >>> shift) % list.length];
	const name = pick(NAMES[body], 1);
	return {
		name,
		avatar: {
			avatar_name: name,
			body,
			skin_tone: pick(SKIN, 5),
			hair_style: body === 'b' ? 'bun' : 'short',
			hair_color: pick(HAIR, 9),
			top_style: 'tee',
			top_color: pick(TOP, 12),
			bottom_style: 'trousers',
			bottom_color: pick(BOTTOM, 15),
			shoe_color: '#2b2b2b',
			accent_color: shop.accent_color,
			accessories: []
		}
	};
}

/** The angle a ∈ (-π, π]. */
function wrapAngle(a: number): number {
	return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Face `target` but turn at most `limit` away from `base` (yaw angles). */
export function faceToward(base: number, target: number, limit: number): number {
	const d = wrapAngle(target - base);
	return base + Math.max(-limit, Math.min(limit, d));
}

/** Turn `current` towards `target` by at most `step` (shortest way round). */
export function turnTowards(current: number, target: number, step: number): number {
	const d = wrapAngle(target - current);
	return Math.abs(d) <= step ? target : current + Math.sign(d) * step;
}

/** Which shops should have a shopkeeper now: the nearest open ones within RADIUS (at most
 *  MAX). One already standing stays until the player is 10 m further than RADIUS, unless its
 *  place is needed for a shop at least SWAP metres nearer (the one the player walks into). */
export const SWAP = 3;
export function planKeepers(
	posts: { id: string; open: boolean; distance: number }[],
	current: string[],
	max = MAX
): { add: string[]; remove: string[] } {
	const at = new Map(posts.map((p) => [p.id, p]));
	const keep = current.filter((id) => {
		const p = at.get(id);
		return !!p && p.open && p.distance <= RADIUS + 10;
	});
	const remove = current.filter((id) => !keep.includes(id));
	const wanted = posts
		.filter((p) => p.open && p.distance < RADIUS)
		.sort((a, b) => a.distance - b.distance)
		.slice(0, max);
	let room = max - keep.length;
	// Fewer allowed than standing (the limit went down): the farthest go.
	while (room < 0) {
		const far = keep.sort((a, b) => at.get(a)!.distance - at.get(b)!.distance).pop()!;
		remove.push(far);
		room++;
	}
	const add: string[] = [];
	for (const p of wanted) {
		if (keep.includes(p.id)) continue;
		if (keep.length + add.length >= max) {
			// Give the farthest one's place to this nearer shop (if clearly nearer).
			const victim = keep
				.filter((id) => !wanted.some((w) => w.id === id))
				.sort((a, b) => at.get(b)!.distance - at.get(a)!.distance)[0];
			if (!victim || at.get(victim)!.distance < p.distance + SWAP) continue;
			keep.splice(keep.indexOf(victim), 1);
			remove.push(victim);
		}
		add.push(p.id);
	}
	return { add, remove };
}

/** Where a shopkeeper stands (behind the counter, facing the door) and how far the player is. */
export interface KeeperPost {
	shop: Shop;
	x: number;
	y: number;
	z: number;
	yaw: number;
	distance: number;
}

interface Keeper {
	shop: Shop;
	name: string;
	group: THREE.Group;
	character: GameCharacter | null;
	tag: THREE.Sprite | null;
	bubble: { sprite: THREE.Sprite; until: number } | null;
	/** What they said last (the bubble fades; this stays). */
	said: string | null;
	base: number;
	yaw: number;
	inside: boolean;
	greetedAt: number;
	talkUntil: number;
	extras: THREE.Mesh[];
	removed: boolean;
}

/** How far forward (+Z, root space) the clothes reach between two heights, near the middle:
 *  measured on the model's own vertices as drawn (skinned: outfit with its straps, and the decals
 *  over it), in the pose it is in now. */
function frontOf(root: THREE.Object3D, from: number, to: number): number {
	const inverse = root.matrixWorld.clone().invert();
	const toRoot = new THREE.Matrix4();
	const v = new THREE.Vector3();
	let front = 0.1;
	root.traverse((o) => {
		const mesh = o as THREE.Mesh;
		const name = (mesh.material as THREE.Material | undefined)?.name ?? '';
		if (!mesh.isMesh || !/Outfit|decals/.test(name)) return;
		toRoot.multiplyMatrices(inverse, mesh.matrixWorld);
		const count = mesh.geometry.attributes.position.count;
		for (let i = 0; i < count; i++) {
			mesh.getVertexPosition(i, v).applyMatrix4(toRoot); // skinned meshes: with the bones
			if (v.y >= from && v.y <= to && Math.abs(v.x) < 0.17 && v.z > front) front = v.z;
		}
	});
	return front;
}

/** An apron in the shop's colours, over the front of a realistic character (bib on the chest,
 *  skirt on the hips; each follows its bone), just in front of the clothes. Classic characters
 *  have no such bones: none. */
function addApron(root: THREE.Object3D, colors: { primary: string; accent: string }): THREE.Mesh[] {
	const hips = root.getObjectByName('mixamorigHips');
	const chest = root.getObjectByName('mixamorigSpine2');
	if (!hips || !chest) return [];
	root.updateMatrixWorld(true);
	const inverse = root.matrixWorld.clone().invert();
	const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverse);
	const hy = at(hips).y;
	const cy = at(chest).y;
	// The bib runs from the chest down to the waistband, tilted to follow the body (further out
	// at the chest than at the waist) yet in front of it all the way; the skirt from there down.
	const bibTop = cy - 0.02; // the chest curves back above this: straps go up to the neck
	const waist = hy + 0.03;
	const band = (bibTop - waist) / 3;
	const yTop = bibTop - band / 2, yMid = waist + band * 1.5, yBot = waist + band / 2;
	const fTop = frontOf(root, bibTop - band, bibTop);
	const fMid = frontOf(root, waist + band, bibTop - band);
	const fBot = frontOf(root, waist, waist + band);
	const slope = (fTop - fBot) / (yTop - yBot);
	const line = (y: number) => fBot + (y - yBot) * slope;
	const lift = Math.max(0, fMid - line(yMid), fTop - line(yTop), fBot - line(yBot)) + 0.012;
	const tilt = Math.atan(slope);
	const skirtZ = frontOf(root, hy - 0.46, waist) + 0.012;
	const piece = (w: number, h: number, color: string, y: number, z: number, bone: THREE.Object3D, tiltX = 0) => {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.012), new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
		mesh.position.set(0, y, z);
		mesh.rotation.x = tiltX; // + leans the top forward
		root.add(mesh);
		bone.attach(mesh); // keeps this pose: follows the bone from here on
		return mesh;
	};
	// Neck straps: from the bib's top corners up and back to the collar.
	const neck = root.getObjectByName('mixamorigNeck');
	const straps: THREE.Mesh[] = [];
	if (neck) {
		const n = at(neck);
		const top = line(bibTop) + lift;
		for (const side of [-1, 1]) {
			const from = new THREE.Vector3(side * 0.13, bibTop, top);
			const to = new THREE.Vector3(side * 0.07, n.y, n.z + 0.06);
			const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.02, from.distanceTo(to), 0.006), new THREE.MeshStandardMaterial({ color: colors.primary, roughness: 0.85 }));
			mesh.position.copy(from).add(to).multiplyScalar(0.5);
			mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
			root.add(mesh);
			chest.attach(mesh);
			straps.push(mesh);
		}
	}
	return [
		...straps,
		piece(0.42, 0.5, colors.primary, waist - 0.25, skirtZ, hips), // skirt
		piece(0.43, 0.05, colors.accent, waist - 0.02, Math.max(skirtZ, line(waist) + lift) + 0.008, hips), // waist band
		piece(0.3, (bibTop - waist) / Math.cos(tilt), colors.primary, (bibTop + waist) / 2, line((bibTop + waist) / 2) + lift, chest, tilt) // bib
	];
}

const view = { frustum: new THREE.Frustum(), matrix: new THREE.Matrix4(), sphere: new THREE.Sphere(new THREE.Vector3(), 1.3) };

export class Shopkeepers {
	private keepers = new Map<string, Keeper>();
	private disposed = false;
	/** How many may stand at once (fewer on the low graphics setting). */
	limit = MAX;

	/** `camera`: shopkeepers out of its view are neither drawn nor animated (skinned characters
	 *  are not culled by three.js, whose bounds do not follow the animation). */
	constructor(
		private scene: THREE.Scene,
		private camera?: THREE.Camera
	) {}

	/** Keep shopkeepers at the nearest open shops (posts are the built shops). */
	sync(posts: KeeperPost[]): void {
		const byId = new Map(posts.map((p) => [p.shop.id, p]));
		// A shop whose colours changed gets its shopkeeper again (the apron).
		for (const [id, k] of this.keepers) {
			const p = byId.get(id);
			if (p && (p.shop.accent_color !== k.shop.accent_color || p.shop.primary_color !== k.shop.primary_color)) this.remove(id);
		}
		const plan = planKeepers(
			posts.map((p) => ({ id: p.shop.id, open: p.shop.is_open, distance: p.distance })),
			[...this.keepers.keys()],
			this.limit
		);
		for (const id of plan.remove) this.remove(id);
		for (const id of plan.add) this.add(byId.get(id)!);
	}

	private add(p: KeeperPost): void {
		const { name, avatar } = keeperFor(p.shop);
		const group = new THREE.Group();
		group.name = `shopkeeper:${p.shop.id}`;
		group.position.set(p.x, p.y, p.z);
		group.rotation.y = p.yaw;
		this.scene.add(group);
		const k: Keeper = { shop: p.shop, name, group, character: null, tag: null, bubble: null, said: null, base: p.yaw, yaw: p.yaw, inside: false, greetedAt: -Infinity, talkUntil: 0, extras: [], removed: false };
		this.keepers.set(p.shop.id, k);
		createCharacter(avatar)
			.then((character) => {
				if (k.removed || this.disposed) return character.dispose();
				k.character = character;
				group.add(character.root);
				character.animations.update(1 / 60, 0); // into the idle pose: the apron is fitted to it
				k.extras = addApron(character.root, { primary: p.shop.primary_color, accent: p.shop.accent_color });
				// Short: the counter stands near a side wall, which would cut a wide tag.
				const tag = roundedLabel(
					[
						{ text: name, font: '600 30px Inter, "Noto Sans Khmer", sans-serif', color: '#f6f1e6' },
						{ text: 'Shopkeeper', font: '400 22px Inter, sans-serif', color: '#f2d39a' }
					],
					'rgba(11,37,36,0.78)'
				);
				tag.scale.multiplyScalar(0.75);
				// Over the counter, in front of them: right behind them is the back wall, which
				// would cut a tag turned towards the camera.
				tag.position.set(0, 2.0, 0.6);
				group.add(tag);
				k.tag = tag;
			})
			.catch((error) => console.warn('Shopkeeper could not be made', error));
	}

	remove(shopId: string): void {
		const k = this.keepers.get(shopId);
		if (!k) return;
		k.removed = true;
		this.keepers.delete(shopId);
		if (k.tag) disposeSprite(k.tag);
		if (k.bubble) disposeSprite(k.bubble.sprite);
		for (const m of k.extras) {
			m.geometry.dispose();
			(m.material as THREE.Material).dispose();
			m.removeFromParent();
		}
		k.character?.dispose();
		k.group.removeFromParent();
	}

	/** Per frame: greet a player who walks in, look at them, animate, end speech. */
	update(dt: number, px: number, pz: number, insideId: string | null): void {
		const now = performance.now();
		if (this.camera) {
			view.matrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
			view.frustum.setFromProjectionMatrix(view.matrix);
		}
		for (const [id, k] of this.keepers) {
			const c = k.character;
			if (!c) continue;
			const inside = insideId === id;
			if (this.camera) {
				view.sphere.center.set(k.group.position.x, k.group.position.y + 0.9, k.group.position.z);
				k.group.visible = view.frustum.intersectsSphere(view.sphere);
			}
			if (inside && !k.inside && now - k.greetedAt > GREET_AGAIN_MS) {
				k.greetedAt = now;
				this.say(id, `សួស្តី! Welcome to ${k.shop.name}.`, 'greet');
			}
			k.inside = inside;
			const target = inside ? faceToward(k.base, Math.atan2(px - k.group.position.x, pz - k.group.position.z), LOOK_LIMIT) : k.base;
			k.yaw = turnTowards(k.yaw, target, TURN_SPEED * dt);
			k.group.rotation.y = k.yaw;
			if (k.group.visible) {
				c.animations.posture?.(now < k.talkUntil ? 'Talk' : null);
				c.animations.update(dt, 0);
				c.emotes.update(dt, false);
			}
			if (k.bubble && now > k.bubble.until) {
				disposeSprite(k.bubble.sprite);
				k.bubble = null;
			}
		}
	}

	/** The shopkeeper speaks (a bubble over their head): talking, greeting (a sampeah), or
	 *  thanking (a sampeah after talking). */
	say(shopId: string, text: string, gesture: 'talk' | 'greet' | 'thanks' = 'talk'): void {
		const k = this.keepers.get(shopId);
		if (!k?.character) return;
		if (k.bubble) disposeSprite(k.bubble.sprite);
		// Smaller than a player's, and drawn over the shop's walls (a counter stands near a side
		// wall, which would cut it; bubbles come only while the player is in the shop).
		const sprite = speechBubble(text, 24);
		sprite.scale.multiplyScalar(0.7);
		sprite.material.depthTest = false;
		sprite.renderOrder = 30;
		sprite.position.set(0, 2.3 + sprite.scale.y / 2, 0.6);
		k.group.add(sprite);
		k.bubble = { sprite, until: performance.now() + BUBBLE_MS };
		k.said = text;
		if (gesture === 'talk') k.talkUntil = performance.now() + 2500;
		else {
			k.talkUntil = 0;
			k.character.animations.posture?.(null);
			k.character.emotes.play('sampeah');
		}
	}

	/** The shopkeeper of a shop (when one stands there), and what they said last. */
	of(shopId: string): { name: string; ready: boolean; line: string | null; visible: boolean } | null {
		const k = this.keepers.get(shopId);
		return k ? { name: k.name, ready: !!k.character, line: k.said, visible: k.group.visible } : null;
	}

	get count(): number {
		return this.keepers.size;
	}

	dispose(): void {
		this.disposed = true;
		for (const id of [...this.keepers.keys()]) this.remove(id);
	}
}

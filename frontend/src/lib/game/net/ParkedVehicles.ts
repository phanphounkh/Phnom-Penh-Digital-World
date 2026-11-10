/**
 * Parked vehicles the server says are in your area (`vspawn` / `vdespawn`): models on the
 * street, a contact shadow, and two small colliders each so nobody walks or rides through them.
 * Your own are marked (`mine`), with a floating label when you are close.
 */
import * as THREE from 'three';
import type { CollisionWorld } from '$lib/game/city/collision';
import type { Terrain } from '$lib/game/city/terrain';
import { createVehicle, type VehicleInstance } from '$lib/game/vehicles/VehicleModels';
import { MOUNT_RANGE_M } from '$lib/game/vehicles/specs';
import type { ParkedCard } from './protocol';

interface Parked {
	card: ParkedCard;
	instance?: VehicleInstance;
	removed: boolean;
}

const LENGTH = { bicycle: 0.85, motorbike: 0.95 } as const;

export class ParkedVehicles {
	private items = new Map<string, Parked>();
	private blob = new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.2, depthWrite: false });
	private blobGeometry = new THREE.CircleGeometry(0.5, 20).rotateX(-Math.PI / 2);

	constructor(
		private scene: THREE.Scene,
		private terrain: Terrain,
		private collision: CollisionWorld
	) {}

	get count(): number {
		return this.items.size;
	}

	/** Every parked vehicle you can see (yours first). */
	list(): ParkedCard[] {
		return [...this.items.values()].map((p) => p.card).sort((a, b) => Number(!!b.mine) - Number(!!a.mine));
	}

	get(id: string): ParkedCard | undefined {
		return this.items.get(id)?.card;
	}

	/** Your nearest parked vehicle within mounting range. */
	mineWithin(x: number, z: number, range = MOUNT_RANGE_M - 0.2): ParkedCard | null {
		let best: ParkedCard | null = null,
			bestD = range;
		for (const { card } of this.items.values()) {
			if (!card.mine) continue;
			const d = Math.hypot(card.x - x, card.z - z);
			if (d <= bestD) {
				best = card;
				bestD = d;
			}
		}
		return best;
	}

	/** Is (x, z) clear of every parked vehicle by at least `gap` metres? (Client parking check.) */
	clear(x: number, z: number, gap: number): boolean {
		for (const { card } of this.items.values()) if (Math.hypot(card.x - x, card.z - z) < gap) return false;
		return true;
	}

	spawn(card: ParkedCard): void {
		const existing = this.items.get(card.id);
		if (existing && existing.card.k === card.k && existing.instance) {
			existing.card = card;
			existing.instance.setColor(card.c);
			this.place(existing);
			return;
		}
		this.despawn(card.id);
		const item: Parked = { card, removed: false };
		this.items.set(card.id, item);
		this.addColliders(card);
		createVehicle(card.k, card.c).then((instance) => {
			if (item.removed) return instance.dispose();
			item.instance = instance;
			const shadow = new THREE.Mesh(this.blobGeometry, this.blob);
			shadow.scale.set(0.9, 1, 2.1);
			shadow.position.y = 0.06;
			instance.root.add(shadow);
			instance.root.name = `parked:${card.id}`;
			this.scene.add(instance.root);
			this.place(item);
		});
	}

	private place(item: Parked): void {
		const { card, instance } = item;
		this.collision.removeOwner(`veh:${card.id}`);
		this.addColliders(card);
		if (!instance) return;
		instance.root.position.set(card.x, this.terrain.height(card.x, card.z), card.z);
		instance.root.rotation.y = card.yaw;
		instance.pose(0, 0, 0);
	}

	private addColliders(card: ParkedCard): void {
		const half = LENGTH[card.k] * 0.55;
		for (const s of [-1, 1])
			this.collision.addCircle(`veh:${card.id}`, card.x + Math.sin(card.yaw) * half * s, card.z + Math.cos(card.yaw) * half * s, 0.3);
	}

	despawn(id: string): void {
		const item = this.items.get(id);
		if (!item) return;
		item.removed = true;
		item.instance?.dispose();
		this.collision.removeOwner(`veh:${id}`);
		this.items.delete(id);
	}

	clearAll(): void {
		for (const id of [...this.items.keys()]) this.despawn(id);
	}

	dispose(): void {
		this.clearAll();
		this.blob.dispose();
		this.blobGeometry.dispose();
	}
}

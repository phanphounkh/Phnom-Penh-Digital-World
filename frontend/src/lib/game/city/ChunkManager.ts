/**
 * Streams world chunks around the player: loads the nearest missing chunks (a few at a
 * time), unloads distant ones (freeing GPU memory and colliders) and answers simple spatial
 * questions (nearest street, nearby landmark) from the loaded data.
 */
import type * as THREE from 'three';
import { world as worldApi } from '$lib/api/endpoints';
import type { ChunkLandmark, ChunkPayload, ChunkRoad } from '$lib/api/types';
import type { WorldProjection } from '$lib/geo/projection';
import { buildChunk, disposeGroup, type CityMaterials } from './builders';
import type { CollisionWorld } from './collision';

interface Loaded {
	payload: ChunkPayload;
	group: THREE.Group;
}

export class ChunkManager {
	private loaded = new Map<string, Loaded>();
	private pending = new Set<string>();
	private failed = new Map<string, number>();
	private abort = new AbortController();
	radius: number;
	maxConcurrent = 3;

	constructor(
		private scene: THREE.Scene,
		private projection: WorldProjection,
		private collision: CollisionWorld,
		private materials: CityMaterials,
		private available: Set<string>,
		private preferKhmer: boolean,
		radius = 420,
		private fetchChunk: (key: string, signal: AbortSignal) => Promise<ChunkPayload> = worldApi.chunk
	) {
		this.radius = radius;
	}

	get loadedCount() {
		return this.loaded.size;
	}

	get pendingCount() {
		return this.pending.size;
	}

	/** Call every frame (cheap): schedules loads and unloads around (x, z). */
	update(x: number, z: number): void {
		const wanted = this.projection
			.keysAround(x, z, this.radius)
			.filter((k) => this.available.has(k));
		for (const key of wanted) {
			if (this.pending.size >= this.maxConcurrent) break;
			if (this.loaded.has(key) || this.pending.has(key)) continue;
			const retryAt = this.failed.get(key);
			if (retryAt && performance.now() < retryAt) continue;
			this.load(key);
		}
		const keep = new Set(this.projection.keysAround(x, z, this.radius + 250));
		for (const key of [...this.loaded.keys()]) if (!keep.has(key)) this.unload(key);
	}

	/** Resolves once every chunk within `radius` of (x, z) is loaded (or failed). */
	async preload(x: number, z: number, radius = 220): Promise<void> {
		const keys = this.projection.keysAround(x, z, radius).filter((k) => this.available.has(k));
		await Promise.all(keys.map((k) => (this.loaded.has(k) ? null : this.load(k))));
	}

	private async load(key: string): Promise<void> {
		this.pending.add(key);
		try {
			const payload = await this.fetchChunk(key, this.abort.signal);
			if (this.abort.signal.aborted || this.loaded.has(key)) return;
			const group = buildChunk(payload, this.materials, this.preferKhmer);
			this.scene.add(group);
			for (const b of payload.buildings)
				for (const rings of b.polys) this.collision.addRing(key, rings[0], b.h);
			for (const a of payload.areas)
				if (a.kind === 'water') for (const rings of a.polys) this.collision.addRing(key, rings[0], 0);
			this.loaded.set(key, { payload, group });
			this.failed.delete(key);
		} catch (error) {
			if (!this.abort.signal.aborted) {
				console.warn(`Chunk ${key} failed to load`, error);
				this.failed.set(key, performance.now() + 5000);
			}
		} finally {
			this.pending.delete(key);
		}
	}

	private unload(key: string): void {
		const chunk = this.loaded.get(key);
		if (!chunk) return;
		disposeGroup(chunk.group);
		this.collision.removeOwner(key);
		this.loaded.delete(key);
	}

	/** Nearest named road within `maxDistance` metres of the road edge. */
	nearestStreet(x: number, z: number, maxDistance = 10): ChunkRoad | null {
		let best: ChunkRoad | null = null;
		let bestD = Infinity;
		for (const { payload } of this.loaded.values())
			for (const road of payload.roads) {
				if (!road.name) continue;
				for (let i = 0; i < road.pts.length - 1; i++) {
					const d = segmentDistance(x, z, road.pts[i], road.pts[i + 1]) - road.w / 2;
					if (d < bestD) {
						bestD = d;
						best = road;
					}
				}
			}
		return bestD <= maxDistance ? best : null;
	}

	nearestLandmark(x: number, z: number, maxDistance = 60): (ChunkLandmark & { d: number }) | null {
		let best: (ChunkLandmark & { d: number }) | null = null;
		for (const { payload } of this.loaded.values())
			for (const lm of payload.landmarks) {
				if (lm.imp < 2) continue;
				const d = Math.hypot(lm.p[0] - x, lm.p[1] - z);
				if (d <= maxDistance && (!best || d - lm.imp * 8 < best.d - best.imp * 8)) best = { ...lm, d };
			}
		return best;
	}

	/** Loaded payloads, for the minimap. */
	payloads(): ChunkPayload[] {
		return [...this.loaded.values()].map((c) => c.payload);
	}

	dispose(): void {
		this.abort.abort();
		for (const key of [...this.loaded.keys()]) this.unload(key);
	}
}

export function segmentDistance(x: number, z: number, a: [number, number], b: [number, number]) {
	const dx = b[0] - a[0], dz = b[1] - a[1];
	const len2 = dx * dx + dz * dz;
	const t = len2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2)) : 0;
	return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
}

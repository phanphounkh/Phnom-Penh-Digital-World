/**
 * Streams world chunks around the player. Geometry is built by a small pool of Web Workers
 * (fetch + triangulate off the main thread); the main thread only assembles meshes, registers
 * colliders and answers spatial questions (nearest street, nearby landmark) from loaded data.
 */
import type * as THREE from 'three';
import { world as worldApi } from '$lib/api/endpoints';
import type { ChunkLandmark, ChunkPayload, ChunkRoad } from '$lib/api/types';
import type { WorldProjection } from '$lib/geo/projection';
import { assembleChunk, disposeGroup } from './assemble';
import { buildChunkData, type ChunkBuild } from './chunkGeometry';
import type { CollisionWorld } from './collision';
import type { CityMaterials } from './materials';
import type { PropLibrary } from './props';
import type { Mound, Terrain } from './terrain';

interface Loaded {
	payload: ChunkPayload;
	group: THREE.Group;
}

type Built = { payload: ChunkPayload; build: ChunkBuild };

export interface ChunkManagerOptions {
	radius?: number;
	preferKhmer?: boolean;
	shadows?: boolean;
	workers?: number;
}

export class ChunkManager {
	private loaded = new Map<string, Loaded>();
	private pending = new Map<string, Promise<void>>();
	private failed = new Map<string, number>();
	private ready: Built[] = [];
	private workers: Worker[] = [];
	private waiting = new Map<string, { resolve: (b: Built) => void; reject: (e: Error) => void }>();
	private next = 0;
	private disposed = false;
	radius: number;
	shadows: boolean;
	maxConcurrent = 4;
	/** Main-thread milliseconds spent assembling chunks (for diagnostics). */
	assembleMs = 0;
	/** Distance (m) within which a chunk shows its props, pools and sign blades. */
	detailRadius = 240;
	/** Set whenever chunks are added/removed or detail visibility changes (shadow cache). */
	changed = false;

	constructor(
		private scene: THREE.Scene,
		private projection: WorldProjection,
		private collision: CollisionWorld,
		private materials: CityMaterials,
		private props: PropLibrary,
		private terrain: Terrain,
		private available: Set<string>,
		private options: ChunkManagerOptions = {}
	) {
		this.radius = options.radius ?? 420;
		this.shadows = options.shadows ?? true;
		this.startWorkers(options.workers ?? 2);
	}

	private startWorkers(count: number) {
		if (typeof Worker === 'undefined') return;
		try {
			for (let i = 0; i < count; i++) {
				const worker = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' });
				worker.postMessage({ type: 'init', mounds: this.terrain.mounds as Mound[], preferKhmer: !!this.options.preferKhmer });
				worker.onmessage = (event: MessageEvent) => {
					const msg = event.data;
					const waiter = this.waiting.get(msg.key);
					if (!waiter) return;
					this.waiting.delete(msg.key);
					if (msg.type === 'built') waiter.resolve({ payload: msg.payload, build: msg.build });
					else waiter.reject(new Error(msg.message));
				};
				this.workers.push(worker);
			}
		} catch (error) {
			console.warn('Chunk workers unavailable; building on the main thread', error);
			this.workers = [];
		}
	}

	get loadedCount() {
		return this.loaded.size;
	}

	get pendingCount() {
		return this.pending.size;
	}

	get workerCount() {
		return this.workers.length;
	}

	private build(key: string): Promise<Built> {
		if (!this.workers.length) {
			return worldApi.chunk(key).then((payload) => ({
				payload,
				build: buildChunkData(payload, this.terrain, !!this.options.preferKhmer)
			}));
		}
		const worker = this.workers[this.next++ % this.workers.length];
		return new Promise((resolve, reject) => {
			this.waiting.set(key, { resolve, reject });
			worker.postMessage({ type: 'build', key });
		});
	}

	/** Call every frame: schedules loads/unloads and assembles at most one ready chunk. */
	update(x: number, z: number): void {
		const wanted = this.projection.keysAround(x, z, this.radius).filter((k) => this.available.has(k));
		for (const key of wanted) {
			if (this.pending.size >= this.maxConcurrent) break;
			if (this.loaded.has(key) || this.pending.has(key)) continue;
			const retryAt = this.failed.get(key);
			if (retryAt && performance.now() < retryAt) continue;
			this.load(key);
		}
		// Spread assembly over frames so streaming never causes a long frame.
		const next = this.ready.shift();
		if (next) this.assemble(next);
		const keep = new Set(this.projection.keysAround(x, z, this.radius + 250));
		for (const key of [...this.loaded.keys()]) if (!keep.has(key)) this.unload(key);
		const size = this.projection.chunkSize;
		for (const { payload, group } of this.loaded.values()) {
			const detail = group.userData.detail as THREE.Group | undefined;
			if (!detail) continue;
			const d = Math.hypot((payload.ix + 0.5) * size - x, (payload.iz + 0.5) * size - z);
			const show = d < this.detailRadius + size * 0.71;
			if (detail.visible !== show) {
				detail.visible = show;
				this.changed = true;
			}
		}
	}

	/** Resolves once every chunk within `radius` of (x, z) is loaded (or failed). */
	async preload(x: number, z: number, radius = 220, onEach?: () => void): Promise<void> {
		const keys = this.projection.keysAround(x, z, radius).filter((k) => this.available.has(k));
		await Promise.all(
			keys.map(async (k) => {
				if (!this.loaded.has(k)) await (this.pending.get(k) ?? this.load(k, true));
				onEach?.();
			})
		);
	}

	private load(key: string, immediate = false): Promise<void> {
		const task = this.build(key)
			.then((built) => {
				if (this.disposed || this.loaded.has(key)) return;
				if (immediate) this.assemble(built);
				else this.ready.push(built);
				this.failed.delete(key);
			})
			.catch((error) => {
				if (!this.disposed) {
					console.warn(`Chunk ${key} failed to load`, error);
					this.failed.set(key, performance.now() + 5000);
				}
			})
			.finally(() => this.pending.delete(key));
		this.pending.set(key, task);
		return task;
	}

	private assemble({ payload, build }: Built): void {
		const key = payload.key;
		if (this.loaded.has(key) || this.disposed) return;
		const started = performance.now();
		const group = assembleChunk(build, this.materials, this.props, this.shadows);
		group.userData.onChange = () => (this.changed = true);
		this.scene.add(group);
		for (const b of payload.buildings)
			for (const rings of b.polys) {
				// Wall heights are absolute (ground + building) so camera rays work on the hill.
				const ground = this.terrain.affects(rings[0][0][0], rings[0][0][1], 60) ? this.terrain.range(rings[0])[0] : 0;
				this.collision.addRing(key, rings[0], ground + b.h);
			}
		for (const a of payload.areas)
			if (a.kind === 'water') for (const rings of a.polys) this.collision.addRing(key, rings[0], 0);
		for (let i = 0; i < build.posts.length; i += 3)
			this.collision.addCircle(key, build.posts[i], build.posts[i + 1], build.posts[i + 2]);
		this.loaded.set(key, { payload, group });
		this.assembleMs += performance.now() - started;
		this.changed = true;
	}

	private unload(key: string): void {
		const chunk = this.loaded.get(key);
		if (!chunk) return;
		disposeGroup(chunk.group);
		this.collision.removeOwner(key);
		this.loaded.delete(key);
		this.changed = true;
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

	payloads(): ChunkPayload[] {
		return [...this.loaded.values()].map((c) => c.payload);
	}

	dispose(): void {
		this.disposed = true;
		this.workers.forEach((w) => w.terminate());
		this.workers = [];
		for (const { reject } of this.waiting.values()) reject(new Error('disposed'));
		this.waiting.clear();
		for (const key of [...this.loaded.keys()]) this.unload(key);
	}
}

export function segmentDistance(x: number, z: number, a: [number, number], b: [number, number]) {
	const dx = b[0] - a[0], dz = b[1] - a[1];
	const len2 = dx * dx + dz * dz;
	const t = len2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2)) : 0;
	return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
}

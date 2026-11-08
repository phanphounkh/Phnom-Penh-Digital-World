/// <reference lib="webworker" />
/**
 * Builds chunk geometry off the main thread: fetch → parse → triangulate → transfer.
 * Messages in:  { type: 'init', mounds, preferKhmer } | { type: 'build', key }
 * Messages out: { type: 'built', key, payload, build } | { type: 'failed', key, message }
 */
import type { ChunkPayload } from '$lib/api/types';
import { buildChunkData, transferables } from './chunkGeometry';
import { Terrain, type Mound } from './terrain';

let terrain = new Terrain();
let preferKhmer = false;

self.onmessage = async (event: MessageEvent) => {
	const msg = event.data;
	if (msg.type === 'init') {
		terrain = new Terrain(msg.mounds as Mound[]);
		preferKhmer = !!msg.preferKhmer;
		return;
	}
	if (msg.type !== 'build') return;
	const key: string = msg.key;
	try {
		const res = await fetch(`/api/v1/world/chunks/${key}`, { credentials: 'same-origin' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const payload = (await res.json()) as ChunkPayload;
		const build = buildChunkData(payload, terrain, preferKhmer);
		(self as unknown as Worker).postMessage({ type: 'built', key, payload, build }, transferables(build));
	} catch (error) {
		(self as unknown as Worker).postMessage({ type: 'failed', key, message: String(error) });
	}
};

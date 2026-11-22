/// <reference lib="webworker" />
/**
 * Builds generated interiors off the main thread (procedural.ts: the floor plan, furniture,
 * per-vertex lighting) and transfers their vertex arrays back.
 * Messages in:  { id, type, plan, seed, name }
 * Messages out: { id, ok: true, data } | { id, ok: false, message }
 */
import { buildInteriorData, interiorTransferables } from './procedural';

self.onmessage = (event: MessageEvent) => {
	const { id, type, plan, seed, name } = event.data;
	try {
		const data = buildInteriorData(type, plan, seed, name);
		(self as unknown as Worker).postMessage({ id, ok: true, data }, interiorTransferables(data));
	} catch (error) {
		(self as unknown as Worker).postMessage({ id, ok: false, message: String(error) });
	}
};

/**
 * Terrain height (metres above street level) in world coordinates.
 * Mirrors backend/app/geography/terrain.py exactly; terrain.test.ts checks both agree.
 */
export interface Mound {
	slug: string;
	x: number;
	z: number;
	height_m: number;
	top_radius_m: number;
	base_radius_m: number;
}

export function moundHeight(m: Mound, x: number, z: number): number {
	const d = Math.hypot(x - m.x, z - m.z);
	if (d <= m.top_radius_m) return m.height_m;
	if (d >= m.base_radius_m) return 0;
	const t = (d - m.top_radius_m) / (m.base_radius_m - m.top_radius_m);
	return m.height_m * 0.5 * (1 + Math.cos(Math.PI * t));
}

export class Terrain {
	constructor(readonly mounds: readonly Mound[] = []) {}

	height(x: number, z: number): number {
		let h = 0;
		for (const m of this.mounds) {
			const v = moundHeight(m, x, z);
			if (v > h) h = v;
		}
		return h;
	}

	/** True when a disc of radius r around (x, z) may touch raised ground. */
	affects(x: number, z: number, r = 0): boolean {
		return this.mounds.some((m) => Math.hypot(x - m.x, z - m.z) < m.base_radius_m + r);
	}

	/** Lowest and highest ground under a set of points. */
	range(points: readonly (readonly [number, number])[]): [number, number] {
		let lo = Infinity,
			hi = -Infinity;
		for (const [x, z] of points) {
			const h = this.height(x, z);
			if (h < lo) lo = h;
			if (h > hi) hi = h;
		}
		return points.length ? [lo, hi] : [0, 0];
	}
}

export const FLAT = new Terrain();

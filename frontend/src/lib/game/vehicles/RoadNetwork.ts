/**
 * The streets as the riding rules see them, from the streamed chunk payloads (pure: no
 * Three.js). Mirrors backend/app/transport/area.py with a smaller margin, so a rider the
 * client allows is always allowed by the server:
 *
 * - `allows(bit, x, z)`: on a road the mode may use (carriageway + RIDE_MARGIN_M) or in a car park;
 * - `parkable(bit, x, z)`: there, but not in the middle of a through road (outside its kerb band);
 * - `oneWayAt(bit, x, z, yaw)`: the one-way street under you, and whether you ride against it;
 * - `nearestParkable(…)`: where "park here" would put the vehicle.
 */
import type { ChunkPayload, XZ } from '$lib/api/types';
import { pointInRing } from '$lib/game/city/collision';
import { KERB_BAND_M, RIDE_MARGIN_M } from './specs';

const THROUGH = new Set([
	'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
	'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'
]);
const CELL = 16;
const key = (cx: number, cz: number) => cx * 73856093 + cz * 19349663;

export interface Strip {
	ax: number;
	az: number;
	bx: number;
	bz: number;
	half: number;
	/** Modes allowed along a→b, against it, and either way. */
	fwd: number;
	bwd: number;
	modes: number;
	through: boolean;
	cls: string;
	name: string | null;
	nameKm: string | null;
	vmax: number | null;
}

interface ChunkRoads {
	grid: Map<number, Strip[]>;
	parking: { ring: XZ[]; holes: XZ[][]; minX: number; minZ: number; maxX: number; maxZ: number }[];
}

export interface OneWayInfo {
	strip: Strip;
	/** True when moving against the permitted direction. */
	against: boolean;
}

function distanceToStrip(x: number, z: number, s: Strip): { d: number; t: number } {
	const dx = s.bx - s.ax,
		dz = s.bz - s.az;
	const len2 = dx * dx + dz * dz;
	const t = len2 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / len2)) : 0;
	return { d: Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz)), t };
}

export class RoadNetwork {
	private chunks = new Map<string, ChunkRoads>();
	private seen = -1;

	get chunkCount(): number {
		return this.chunks.size;
	}

	/** Add newly loaded chunks and drop unloaded ones (cheap when nothing changed). */
	sync(payloads: ChunkPayload[], version: number): void {
		if (version === this.seen) return;
		this.seen = version;
		const keys = new Set(payloads.map((p) => p.key));
		for (const k of [...this.chunks.keys()]) if (!keys.has(k)) this.chunks.delete(k);
		for (const p of payloads) if (!this.chunks.has(p.key)) this.add(p);
	}

	add(payload: ChunkPayload): void {
		const grid = new Map<number, Strip[]>();
		for (const road of payload.roads) {
			const fwd = road.af ?? 15,
				bwd = road.ab ?? 15;
			for (let i = 0; i < road.pts.length - 1; i++) {
				const [ax, az] = road.pts[i];
				const [bx, bz] = road.pts[i + 1];
				const strip: Strip = {
					ax, az, bx, bz, half: road.w / 2, fwd, bwd, modes: fwd | bwd,
					through: THROUGH.has(road.cls), cls: road.cls,
					name: road.name_en ?? road.name, nameKm: road.name_km, vmax: road.vmax ?? null
				};
				const r = strip.half + RIDE_MARGIN_M;
				for (let cx = Math.floor((Math.min(ax, bx) - r) / CELL); cx <= Math.floor((Math.max(ax, bx) + r) / CELL); cx++)
					for (let cz = Math.floor((Math.min(az, bz) - r) / CELL); cz <= Math.floor((Math.max(az, bz) + r) / CELL); cz++) {
						const list = grid.get(key(cx, cz));
						if (list) list.push(strip);
						else grid.set(key(cx, cz), [strip]);
					}
			}
		}
		const parking = payload.areas
			.filter((a) => a.kind === 'parking')
			.flatMap((a) =>
				a.polys.map(([ring, ...holes]) => {
					const xs = ring.map((p) => p[0]),
						zs = ring.map((p) => p[1]);
					return { ring, holes, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
				})
			);
		this.chunks.set(payload.key, { grid, parking });
	}

	/** Road strips whose grid cell contains (x, z). */
	private near(x: number, z: number): Strip[] {
		const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
		const out: Strip[] = [];
		for (const c of this.chunks.values()) {
			const list = c.grid.get(k);
			if (list) for (const s of list) out.push(s);
		}
		return out;
	}

	inParkingArea(x: number, z: number): boolean {
		for (const c of this.chunks.values())
			for (const p of c.parking) {
				if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
				if (pointInRing(x, z, p.ring) && !p.holes.some((h) => pointInRing(x, z, h))) return true;
			}
		return false;
	}

	allows(bit: number, x: number, z: number, margin = RIDE_MARGIN_M): boolean {
		for (const s of this.near(x, z)) if (s.modes & bit && distanceToStrip(x, z, s).d <= s.half + margin) return true;
		return this.inParkingArea(x, z);
	}

	inCarriagewayCore(x: number, z: number): boolean {
		for (const s of this.near(x, z)) {
			if (!s.through || s.half - KERB_BAND_M <= 0.4) continue;
			if (distanceToStrip(x, z, s).d < s.half - KERB_BAND_M + 0.15) return true; // a little stricter
		}
		return false;
	}

	parkable(bit: number, x: number, z: number): boolean {
		if (this.inParkingArea(x, z)) return true;
		return this.allows(bit, x, z, RIDE_MARGIN_M - 0.25) && !this.inCarriagewayCore(x, z);
	}

	/** The closest parkable spot within `maxDistance` (rings of candidates), or null. */
	nearestParkable(
		bit: number,
		x: number,
		z: number,
		maxDistance: number,
		free: (x: number, z: number) => boolean = () => true,
		step = 0.75
	): XZ | null {
		if (this.parkable(bit, x, z) && free(x, z)) return [x, z];
		for (let ring = 1; ring <= Math.max(1, Math.floor(maxDistance / step)); ring++) {
			const radius = ring * step;
			const count = Math.max(8, Math.floor((2 * Math.PI * radius) / step));
			for (let k = 0; k < count; k++) {
				const a = (2 * Math.PI * k) / count;
				const cx = x + radius * Math.cos(a),
					cz = z + radius * Math.sin(a);
				if (this.parkable(bit, cx, cz) && free(cx, cz)) return [cx, cz];
			}
		}
		return null;
	}

	/** The road under (x, z) (on its carriageway), nearest centreline first. */
	roadAt(x: number, z: number, bit = 0): Strip | null {
		let best: Strip | null = null,
			bestD = Infinity;
		for (const s of this.near(x, z)) {
			if (bit && !(s.modes & bit)) continue;
			const { d } = distanceToStrip(x, z, s);
			if (d <= s.half + 0.5 && d < bestD) {
				best = s;
				bestD = d;
			}
		}
		return best;
	}

	/** The one-way street being ridden on, if any, and whether the rider goes against it. */
	oneWayAt(bit: number, x: number, z: number, yaw: number): OneWayInfo | null {
		const s = this.roadAt(x, z, bit);
		if (!s || (s.fwd & bit) === (s.bwd & bit)) return null;
		const dx = s.bx - s.ax,
			dz = s.bz - s.az;
		const len = Math.hypot(dx, dz) || 1;
		const along = (Math.sin(yaw) * dx + Math.cos(yaw) * dz) / len;
		const against = (along > 0.35 && !(s.fwd & bit)) || (along < -0.35 && !(s.bwd & bit));
		return { strip: s, against };
	}
}

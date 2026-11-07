/**
 * Geographic ↔ world coordinates, mirroring backend/app/geography/projection.py.
 *
 * World frame: metres on UTM zone 48N (EPSG:32648) relative to the origin published by
 * /world/config —  x = east, y = up, z = -north.  Latitude/longitude are never used as metres.
 */
import proj4 from 'proj4';
import type { WorldConfig } from '$lib/api/types';

export const UTM48N = '+proj=utm +zone=48 +datum=WGS84 +units=m +no_defs +type=crs';
const toUtm = proj4('WGS84', UTM48N);

export interface WorldPoint {
	x: number;
	z: number;
}

export class WorldProjection {
	constructor(
		readonly originEasting: number,
		readonly originNorthing: number,
		readonly chunkSize = 200
	) {}

	static fromConfig(config: Pick<WorldConfig, 'origin_easting' | 'origin_northing' | 'chunk_size'>) {
		return new WorldProjection(config.origin_easting, config.origin_northing, config.chunk_size);
	}

	toWorld(lat: number, lon: number): WorldPoint {
		const [e, n] = toUtm.forward([lon, lat]);
		return { x: e - this.originEasting, z: -(n - this.originNorthing) };
	}

	toLatLon(x: number, z: number): { lat: number; lon: number } {
		const [lon, lat] = toUtm.inverse([x + this.originEasting, this.originNorthing - z]);
		return { lat, lon };
	}

	chunkOf(x: number, z: number): [number, number] {
		return [Math.floor(x / this.chunkSize), Math.floor(z / this.chunkSize)];
	}

	/** Keys of chunks whose centre lies within `radius` metres of (x, z). */
	keysAround(x: number, z: number, radius: number): string[] {
		const s = this.chunkSize;
		const [cx, cz] = this.chunkOf(x, z);
		const reach = Math.ceil(radius / s) + 1;
		const keys: { key: string; d: number }[] = [];
		for (let ix = cx - reach; ix <= cx + reach; ix++) {
			for (let iz = cz - reach; iz <= cz + reach; iz++) {
				const d = Math.hypot((ix + 0.5) * s - x, (iz + 0.5) * s - z);
				if (d <= radius + s * 0.71) keys.push({ key: chunkKey(ix, iz), d });
			}
		}
		return keys.sort((a, b) => a.d - b.d).map((k) => k.key);
	}
}

export const chunkKey = (ix: number, iz: number) => `${ix}_${iz}`;

/** Compass heading in degrees (0 = north, 90 = east) of a world-space direction. */
export function compassHeading(dx: number, dz: number): number {
	const deg = (Math.atan2(dx, -dz) * 180) / Math.PI;
	return (deg + 360) % 360;
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compassLabel(deg: number): string {
	return POINTS[Math.round(deg / 45) % 8];
}

/** Model yaw (Three.js rotation.y, model faces +Z) for a compass heading. */
export function yawForHeading(deg: number): number {
	return Math.PI - (deg * Math.PI) / 180;
}

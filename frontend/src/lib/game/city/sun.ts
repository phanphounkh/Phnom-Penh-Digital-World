/**
 * Solar position (NOAA-style low-precision formulas, accurate to a fraction of a degree), used
 * to light the city by real Phnom Penh time.
 */
const RAD = Math.PI / 180;

export interface SunPosition {
	/** Degrees above the horizon (negative at night). */
	elevation: number;
	/** Degrees clockwise from north. */
	azimuth: number;
}

export function sunPosition(date: Date, lat: number, lon: number): SunPosition {
	const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // days since J2000
	const L = (280.46 + 0.9856474 * n) % 360;
	const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
	const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
	const eps = (23.439 - 0.0000004 * n) * RAD;
	const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
	const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
	const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
	const ha = (gmst * 15 + lon) * RAD - ra;
	const phi = lat * RAD;
	const elevation = Math.asin(
		Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha)
	);
	const azimuth = Math.atan2(
		-Math.sin(ha),
		Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha)
	);
	return { elevation: elevation / RAD, azimuth: ((azimuth / RAD) % 360 + 360) % 360 };
}

/** Unit vector towards the sun in world space (x = east, y = up, z = -north). */
export function sunDirection({ elevation, azimuth }: SunPosition): [number, number, number] {
	const e = elevation * RAD;
	const a = azimuth * RAD;
	return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

/** 0 by day, 1 at night, smooth through dusk (sun from +4° down to -8°). */
export function nightFactor(elevation: number): number {
	const t = Math.min(1, Math.max(0, (4 - elevation) / 12));
	return t * t * (3 - 2 * t);
}

/** Phnom Penh local time (UTC+7, no daylight saving) as "HH:MM". */
export function phnomPenhClock(date: Date): string {
	const local = new Date(date.getTime() + 7 * 3600_000);
	return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
}

/** A Date on the same Phnom Penh day as `date` at a given local hour (for fixed presets). */
export function atPhnomPenhHour(date: Date, hour: number): Date {
	const local = new Date(date.getTime() + 7 * 3600_000);
	local.setUTCHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
	return new Date(local.getTime() - 7 * 3600_000);
}

/**
 * Route guidance (pure, unit-tested): the line to follow on the street and progress along it.
 *
 * Cambodia drives on the right. Vehicle routes keep to the right-hand lane: the middle of the
 * right half on two-way streets, the right-hand lane on one-way streets. Walking routes keep to
 * the right-hand pavement (centre of road + half width + 0.8 m) except on footways, paths and
 * pedestrian streets, which are walked down the middle.
 */
import type { XZ } from '$lib/api/types';
import type { TravelMode } from './specs';

export interface RouteSegment {
	edge: number;
	pts: XZ[];
	length_m: number;
	w: number;
	cls: string;
	oneway: boolean;
	street: string | null;
	street_km: string | null;
	speed_kmh: number | null;
}

export interface RouteStep {
	type: string;
	street: string | null;
	street_km: string | null;
	bearing: number;
	x: number;
	z: number;
	at_m: number;
	distance_m: number;
}

export interface Route {
	mode: TravelMode;
	distance_m: number;
	duration_s: number;
	from: { x: number; z: number; off_road_m: number };
	to: { x: number; z: number; off_road_m: number };
	points: XZ[];
	segments: RouteSegment[];
	steps: RouteStep[];
}

const FOOT_ONLY = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'living_street']);

/** Sideways offset from the centreline, + = to the right of the direction of travel. */
export function laneOffset(mode: TravelMode, seg: Pick<RouteSegment, 'w' | 'cls' | 'oneway'>): number {
	if (mode === 'foot') return FOOT_ONLY.has(seg.cls) ? 0 : seg.w / 2 + 0.8;
	if (seg.w < 4.5) return 0; // alleys: ride down the middle
	if (seg.oneway) return Math.max(0, seg.w / 2 - 1.7);
	return seg.w / 4;
}

/** Offset a polyline sideways (mitred joints, capped), + = right of the direction of travel. */
export function offsetLine(pts: XZ[], offset: number): XZ[] {
	if (!offset || pts.length < 2) return pts.map(([x, z]) => [x, z]);
	const out: XZ[] = [];
	for (let i = 0; i < pts.length; i++) {
		const prev = pts[Math.max(0, i - 1)],
			next = pts[Math.min(pts.length - 1, i + 1)];
		const a = i > 0 ? dir(prev, pts[i]) : dir(pts[i], next);
		const b = i < pts.length - 1 ? dir(pts[i], next) : a;
		// Right of travel direction (fx, fz) is (-fz, fx) in world x/z.
		let nx = -(a[1] + b[1]),
			nz = a[0] + b[0];
		const len = Math.hypot(nx, nz) || 1;
		nx /= len;
		nz /= len;
		const cos = Math.max(0.5, nx * -a[1] + nz * a[0]); // mitre length, capped at 2×
		out.push([pts[i][0] + (nx * offset) / cos, pts[i][1] + (nz * offset) / cos]);
	}
	return out;
}

function dir(a: XZ, b: XZ): XZ {
	const dx = b[0] - a[0],
		dz = b[1] - a[1];
	const len = Math.hypot(dx, dz) || 1;
	return [dx / len, dz / len];
}

/** The path to follow: each segment offset into its lane, joined end to end. */
export function lanePath(route: Pick<Route, 'mode' | 'segments'>): XZ[] {
	const out: XZ[] = [];
	for (const seg of route.segments) {
		for (const p of offsetLine(seg.pts, laneOffset(route.mode, seg))) {
			const last = out[out.length - 1];
			if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.3) out.push(p);
		}
	}
	return out;
}

export interface Progress {
	/** Metres travelled along the route polyline. */
	along: number;
	remaining: number;
	/** Distance from the route line (m). */
	off: number;
	/** The next manoeuvre ahead and the distance to it. */
	next: RouteStep | null;
	toNext: number;
	arrived: boolean;
}

/** Tracks the rider's progress along a route (projection onto the polyline, forward only). */
export class RouteGuide {
	readonly cum: number[] = [0];
	private index = 0;

	constructor(readonly route: Route) {
		const pts = route.points;
		for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
	}

	get length(): number {
		return this.cum[this.cum.length - 1];
	}

	progress(x: number, z: number): Progress {
		const pts = this.route.points;
		let best = { d: Infinity, i: this.index, along: this.cum[this.index] };
		// Search a window ahead of (and slightly behind) the last match: routes may cross themselves.
		const from = Math.max(0, this.index - 3),
			to = Math.min(pts.length - 1, this.index + 40);
		for (let i = from; i < to; i++) {
			const [ax, az] = pts[i],
				[bx, bz] = pts[i + 1];
			const dx = bx - ax,
				dz = bz - az;
			const len2 = dx * dx + dz * dz;
			const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
			const d = Math.hypot(x - (ax + t * dx), z - (az + t * dz));
			if (d < best.d - 0.01) best = { d, i, along: this.cum[i] + t * Math.sqrt(len2) };
		}
		this.index = best.i;
		const along = best.along;
		const remaining = Math.max(0, this.length - along);
		const next = this.route.steps.find((s) => s.type !== 'depart' && s.at_m > along + 1) ?? null;
		const end = this.route.to;
		return {
			along,
			remaining,
			off: best.d,
			next,
			toNext: next ? Math.max(0, next.at_m - along) : remaining,
			arrived: remaining < 6 && Math.hypot(x - end.x, z - end.z) < 12
		};
	}
}

const TURN_TEXT: Record<string, string> = {
	depart: 'Head off',
	continue: 'Continue onto',
	straight: 'Continue onto',
	slight_left: 'Bear left onto',
	slight_right: 'Bear right onto',
	left: 'Turn left onto',
	right: 'Turn right onto',
	sharp_left: 'Sharp left onto',
	sharp_right: 'Sharp right onto',
	uturn: 'Make a U-turn onto',
	arrive: 'Arrive'
};

/** "Turn left onto Street 108" (English, with the street name when known). */
export function stepText(step: RouteStep): string {
	const verb = TURN_TEXT[step.type] ?? step.type;
	if (step.type === 'arrive') return step.street ? `Arrive on ${step.street}` : 'Arrive';
	if (!step.street) return verb.replace(/ onto$/, '');
	return `${verb} ${step.street}`;
}

export function formatDistance(m: number): string {
	if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
	if (m >= 100) return `${Math.round(m / 10) * 10} m`;
	return `${Math.max(0, Math.round(m))} m`;
}

export function formatDuration(s: number): string {
	if (s < 60) return '< 1 min';
	return `${Math.round(s / 60)} min`;
}

/** Follow a polyline: forward-only projection, look-ahead points and the bend ahead. */
export class PathFollower {
	readonly cum: number[] = [0];
	private index = 0;

	constructor(readonly points: XZ[]) {
		for (let i = 1; i < points.length; i++)
			this.cum.push(this.cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
	}

	get length(): number {
		return this.cum[this.cum.length - 1];
	}

	/** Metres along the path of the closest point to (x, z), searching ahead of the last match. */
	project(x: number, z: number): { along: number; off: number } {
		const pts = this.points;
		let best = { d: Infinity, i: this.index, along: this.cum[this.index] };
		const to = Math.min(pts.length - 1, this.index + 30);
		for (let i = Math.max(0, this.index - 2); i < to; i++) {
			const [ax, az] = pts[i],
				[bx, bz] = pts[i + 1];
			const dx = bx - ax,
				dz = bz - az;
			const len2 = dx * dx + dz * dz;
			const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
			const d = Math.hypot(x - (ax + t * dx), z - (az + t * dz));
			if (d < best.d - 0.01) best = { d, i, along: this.cum[i] + t * Math.sqrt(len2) };
		}
		this.index = best.i;
		return { along: best.along, off: best.d };
	}

	pointAt(along: number): XZ {
		const pts = this.points;
		if (along <= 0) return pts[0];
		for (let i = 1; i < pts.length; i++) {
			if (this.cum[i] >= along) {
				const t = (along - this.cum[i - 1]) / (this.cum[i] - this.cum[i - 1] || 1);
				return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
			}
		}
		return pts[pts.length - 1];
	}

	/** How much the path turns (rad, 0…π) between `along` and `along + ahead`. */
	bendAhead(along: number, ahead: number): number {
		const a = this.pointAt(along),
			b = this.pointAt(along + Math.min(4, ahead / 3)),
			c = this.pointAt(along + ahead - 3),
			d = this.pointAt(along + ahead);
		const h1 = Math.atan2(b[0] - a[0], b[1] - a[1]),
			h2 = Math.atan2(d[0] - c[0], d[1] - c[1]);
		return Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1)));
	}
}

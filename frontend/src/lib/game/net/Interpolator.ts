/**
 * Snapshot interpolation for remote players: render slightly in the past (DELAY ms) so that
 * there are usually two snapshots to interpolate between at 10 Hz. Teleports snap.
 */
export interface Snapshot {
	t: number; // local receive time (ms)
	x: number;
	z: number;
	yaw: number;
	s: number;
}

export const DELAY_MS = 120;
const MAX_EXTRAPOLATE_MS = 200;
const SNAP_DISTANCE = 25;
const KEEP = 20;

function lerpAngle(a: number, b: number, t: number): number {
	const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
	return a + d * t;
}

export class Interpolator {
	private snaps: Snapshot[] = [];

	push(snap: Snapshot): void {
		const last = this.snaps[this.snaps.length - 1];
		if (last && Math.hypot(snap.x - last.x, snap.z - last.z) > SNAP_DISTANCE) this.snaps = [];
		this.snaps.push(snap);
		if (this.snaps.length > KEEP) this.snaps.shift();
	}

	/** Position to draw at local time `now`. */
	sample(now: number): Snapshot | null {
		const snaps = this.snaps;
		if (!snaps.length) return null;
		const t = now - DELAY_MS;
		if (snaps.length === 1 || t <= snaps[0].t) return { ...snaps[0], t };
		for (let i = snaps.length - 1; i > 0; i--) {
			const a = snaps[i - 1];
			const b = snaps[i];
			if (t >= a.t && t <= b.t) {
				const k = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
				return { t, x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, yaw: lerpAngle(a.yaw, b.yaw, k), s: b.s };
			}
		}
		// Newer than every snapshot: extrapolate briefly with the last velocity, then hold.
		const b = snaps[snaps.length - 1];
		const a = snaps[snaps.length - 2];
		const ahead = Math.min(t - b.t, MAX_EXTRAPOLATE_MS);
		const span = b.t - a.t || 1;
		const moving = b.s > 0.05 ? 1 : 0;
		return {
			t,
			x: b.x + ((b.x - a.x) / span) * ahead * moving,
			z: b.z + ((b.z - a.z) / span) * ahead * moving,
			yaw: b.yaw,
			s: b.s * moving
		};
	}

	get latest(): Snapshot | undefined {
		return this.snaps[this.snaps.length - 1];
	}
}

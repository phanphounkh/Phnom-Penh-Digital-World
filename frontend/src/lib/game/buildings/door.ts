/**
 * A hinged door: state, swing animation and the collision shape of its leaf.
 *
 * The state is a plain value ({ open, changedAt }) so it can later be shared between players:
 * a server message only has to call apply(). Today it is local to each player.
 */
import type { DoorSpec, XZ } from './spec';

/** Seconds for a full swing. */
export const SWING_TIME = 0.9;
/** How close (m) to the doorway the player must be to use the door. */
export const DOOR_REACH = 1.7;
/** Collision thickness of the leaf (thicker than the wood, so a fast step cannot pass it). */
const LEAF_COLLISION = 0.12;

export interface DoorState {
	open: boolean;
	/** ms timestamp of the last change (multiplayer: the newest change wins). */
	changedAt: number;
}

const ease = (t: number) => t * t * (3 - 2 * t);

export class Door {
	state: DoorState = { open: false, changedAt: 0 };
	/** Swing progress: 0 closed … 1 open. */
	t = 0;

	/** Unit direction of the closed leaf, from the hinge across the doorway. */
	private across: XZ;

	constructor(readonly spec: DoorSpec) {
		const dx = spec.center[0] - spec.hinge[0],
			dz = spec.center[1] - spec.hinge[1];
		const d = Math.hypot(dx, dz) || 1;
		this.across = [dx / d, dz / d];
	}

	get open(): boolean {
		return this.state.open;
	}

	/** True while the leaf is moving. */
	get moving(): boolean {
		return this.t !== (this.state.open ? 1 : 0);
	}

	/** Current leaf angle (rotation.y of the door node). */
	get angle(): number {
		return this.spec.openYaw * ease(this.t);
	}

	toggle(now = Date.now()): DoorState {
		return this.apply({ open: !this.state.open, changedAt: now });
	}

	/** Take a state (local input or, later, from another player); older states are ignored. */
	apply(state: DoorState): DoorState {
		if (state.changedAt >= this.state.changedAt) this.state = { ...state };
		return this.state;
	}

	/** Advance the swing; returns true if the leaf moved. */
	update(dt: number): boolean {
		const target = this.state.open ? 1 : 0;
		if (this.t === target) return false;
		const step = dt / SWING_TIME;
		this.t = target > this.t ? Math.min(target, this.t + step) : Math.max(target, this.t - step);
		return true;
	}

	/** The leaf's collision rectangle (model space) at an angle. */
	leafRing(angle = this.angle): XZ[] {
		const [hx, hz] = this.spec.hinge;
		const c = Math.cos(angle),
			s = Math.sin(angle);
		// The leaf direction turned by `angle` about +Y (like rotation.y), and its normal.
		const [ax, az] = this.across;
		const ux = ax * c + az * s,
			uz = -ax * s + az * c;
		const nx = -uz,
			nz = ux;
		const w = this.spec.width,
			h = LEAF_COLLISION / 2;
		return ([[0, -h], [w, -h], [w, h], [0, h]] as XZ[]).map(([a, n]) => [hx + ux * a + nx * n, hz + uz * a + nz * n]);
	}

	/** Distance (model space) from a point to the doorway's middle. */
	distance(lx: number, lz: number): number {
		return Math.hypot(lx - this.spec.center[0], lz - this.spec.center[1]);
	}

	/** Would closing now trap a player standing at (lx, lz) (radius r) in the leaf's path? */
	blocksClosing(lx: number, lz: number, r: number): boolean {
		// The closed leaf spans the doorway; the swing sweeps a quarter disc on the inside.
		const [hx, hz] = this.spec.hinge;
		const dx = lx - hx,
			dz = lz - hz;
		const inward = -(dx * this.spec.outward[0] + dz * this.spec.outward[1]);
		const along = dx * this.across[0] + dz * this.across[1];
		const reach = Math.hypot(dx, dz);
		return reach < this.spec.width + r && inward > -r && along > -r;
	}

	/** The prompt for the door ("Open Door" / "Close Door"). */
	get label(): string {
		return this.state.open ? 'Close Door' : 'Open Door';
	}
}

/** Facing check for prompts: within `close` metres any facing is fine, further away the player
 * must roughly look at the target. */
export function facing(px: number, pz: number, yaw: number, tx: number, tz: number, close = 0.8, cos = 0.2): boolean {
	const dx = tx - px,
		dz = tz - pz;
	const d = Math.hypot(dx, dz);
	if (d < close) return true;
	return (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / d > cos;
}

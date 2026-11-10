/**
 * Puts an avatar on a vehicle: hips on the seat, hands on the grips (two-bone arm IK from
 * PlayerAnimations), feet on the pegs or pedalling round the crank (two-bone leg IK), a slight
 * forward lean; the rider leans with the vehicle. Used for the local player and remote riders.
 *
 * Rig (tools/blender/generate_avatars.py, CampusEats): BodyRoot at the feet; hips 0.92, thigh
 * 0.42, shin 0.40 (rig units; the avatar is scaled 0.9). Joint rotation.x < 0 swings a limb
 * forwards; knee rotation.x > 0 bends the shin back.
 */
import * as THREE from 'three';
import type { PlayerAnimations } from '$lib/game/player/PlayerAnimations.js';
import type { VehicleInstance } from './VehicleModels';

const THIGH = 0.42,
	SHIN = 0.4;
const CRANK = 0.165;
const SEAT_CLEARANCE = 0.05;

interface Leg {
	hip: THREE.Object3D;
	knee: THREE.Object3D;
	ankle?: THREE.Object3D;
}

const tmpA = new THREE.Vector3(),
	tmpB = new THREE.Vector3(),
	tmpC = new THREE.Vector3();

function solveLeg(leg: Leg, worldFoot: THREE.Vector3): void {
	const parent = leg.hip.parent!;
	tmpA.copy(worldFoot);
	parent.worldToLocal(tmpA);
	tmpA.sub(leg.hip.position); // hip → foot, rig units in the body's frame
	const ty = tmpA.y,
		tz = tmpA.z;
	const d = THREE.MathUtils.clamp(Math.hypot(ty, tz), 0.15, THIGH + SHIN - 0.002);
	const phi = Math.atan2(tz, -ty); // + when the foot is ahead of the hip
	const atHip = Math.acos(THREE.MathUtils.clamp((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d), -1, 1));
	const atKnee = Math.acos(THREE.MathUtils.clamp((THIGH * THIGH + SHIN * SHIN - d * d) / (2 * THIGH * SHIN), -1, 1));
	leg.hip.rotation.set(-(phi + atHip), 0, 0);
	leg.knee.rotation.set(Math.PI - atKnee, 0, 0);
	if (leg.ankle) leg.ankle.rotation.set(-(leg.hip.rotation.x + leg.knee.rotation.x), 0, 0);
}

export class Rider {
	private body: THREE.Object3D | null;
	private legs: [Leg | null, Leg | null];
	private pedal = new THREE.Vector3();
	private previousParent: THREE.Object3D | null;

	constructor(
		private avatar: THREE.Object3D,
		private animations: PlayerAnimations,
		readonly vehicle: VehicleInstance
	) {
		this.previousParent = avatar.parent;
		this.body = avatar.getObjectByName('BodyRoot') ?? null;
		const leg = (side: string): Leg | null => {
			const hip = avatar.getObjectByName(side + 'Leg'),
				knee = avatar.getObjectByName(side + 'Knee');
			return hip && knee ? { hip, knee, ankle: avatar.getObjectByName(side + 'Ankle') } : null;
		};
		this.legs = [leg('Left'), leg('Right')];
		avatar.position.set(0, 0, 0);
		avatar.rotation.set(0, 0, 0);
		vehicle.lean.add(avatar);
	}

	/** Pose the rider for this frame (after the vehicle's root transform and pose are set). */
	update(dt: number, wheel: number): void {
		const v = this.vehicle;
		const body = this.body;
		if (body) {
			body.position.set(0, 0, 0);
			body.rotation.set(v.kind === 'bicycle' ? 0.16 : 0.06, 0, 0);
		}
		// Hips onto the seat: measure where they are, move the avatar by the difference.
		v.root.updateMatrixWorld(true);
		const [l, r] = this.legs;
		if (l && r) {
			const hips = l.hip.getWorldPosition(tmpA).add(r.hip.getWorldPosition(tmpB)).multiplyScalar(0.5);
			const seat = v.anchors.seat.getWorldPosition(tmpC);
			seat.y += SEAT_CLEARANCE;
			const parent = this.avatar.parent!;
			parent.worldToLocal(hips);
			parent.worldToLocal(seat);
			this.avatar.position.add(seat.sub(hips));
			this.avatar.updateMatrixWorld(true);
		}
		// Feet: pegs on the motorbike, pedals turning with the rear wheel on the bicycle.
		this.legs.forEach((leg, i) => {
			if (!leg) return;
			const peg = i === 0 ? v.anchors.pegL : v.anchors.pegR;
			if (v.anchors.crank) {
				const phase = wheel * 0.42 + (i === 0 ? Math.PI : 0);
				this.pedal.copy(peg.position);
				this.pedal.y = v.anchors.crank.position.y - Math.cos(phase) * CRANK;
				this.pedal.z = v.anchors.crank.position.z + Math.sin(phase) * CRANK;
				peg.parent!.localToWorld(this.pedal);
				solveLeg(leg, this.pedal);
			} else solveLeg(leg, peg.getWorldPosition(tmpA));
		});
		this.avatar.updateMatrixWorld(true);
		// Hands on the grips.
		const arms = (this.animations as unknown as { arms: { shoulder?: THREE.Object3D }[] }).arms;
		const grips = [v.anchors.gripL, v.anchors.gripR];
		arms.forEach((arm, i) => {
			if (arm.shoulder) this.animations.solveArm(arm, grips[i].getWorldPosition(tmpA), Math.max(dt, 0.2));
		});
	}

	/** Take the avatar off the vehicle (back to its previous parent, standing pose). */
	detach(to: THREE.Object3D | null = this.previousParent): void {
		if (this.body) this.body.rotation.set(0, 0, 0);
		for (const leg of this.legs) {
			if (!leg) continue;
			leg.hip.rotation.set(0, 0, 0);
			leg.knee.rotation.set(0, 0, 0);
			leg.ankle?.rotation.set(0, 0, 0);
		}
		this.avatar.position.set(0, 0, 0);
		if (to) to.add(this.avatar);
		else this.avatar.removeFromParent();
	}
}

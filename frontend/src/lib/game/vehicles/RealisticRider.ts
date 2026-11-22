/**
 * Puts a realistic (Mixamo-rigged) avatar on a vehicle, like Rider does for the classic rig:
 * hips on the seat, feet on the pegs or pedalling round the crank, hands on the grips, a forward
 * lean; the rider leans with the vehicle. Limbs use rig-agnostic two-bone IK (avatar/ik.ts).
 *
 * Sides: the vehicle anchors follow the classic rig (`L` = −X); a realistic avatar faces +Z with
 * its anatomical left at +X, so its left hand takes `gripR` and its left foot `pegR`.
 */
import * as THREE from 'three';
import { aimBone, solveTwoBone } from '$lib/game/avatar/ik';
import type { RealisticAnimations } from '$lib/game/avatar/RealisticAnimations';
import type { VehicleInstance } from './VehicleModels';

const CRANK = 0.165;
/** Hip joints sit this far above the seat surface (thigh and buttock thickness). */
const SEAT_CLEARANCE = 0.1;
/** Starting forward lean (rad); increased on the first frame if the grips are out of reach. */
const LEAN = { bicycle: 0.32, motorbike: 0.18 };
const MAX_LEAN = 1.0;
const MAX_SLIDE = 0.12;

interface Limb {
	upper: THREE.Object3D;
	lower: THREE.Object3D;
	end: THREE.Object3D;
	tip?: THREE.Object3D;
}

const tmpA = new THREE.Vector3(),
	tmpB = new THREE.Vector3(),
	tmpC = new THREE.Vector3(),
	tmpD = new THREE.Vector3(),
	tmpQ = new THREE.Quaternion(),
	tmpW = new THREE.Quaternion();

/** Rotate `bone` by `angle` about a world-space axis. */
function rotateWorld(bone: THREE.Object3D, axis: THREE.Vector3, angle: number): void {
	tmpQ.setFromAxisAngle(axis, angle);
	bone.getWorldQuaternion(tmpW);
	const parent = new THREE.Quaternion();
	bone.parent?.getWorldQuaternion(parent);
	bone.quaternion.copy(parent.invert().multiply(tmpQ).multiply(tmpW));
	bone.updateWorldMatrix(false, true);
}

export class RealisticRider {
	private previousParent: THREE.Object3D | null;
	private bone: (name: string) => THREE.Object3D | undefined;
	private legs: [Limb | null, Limb | null]; // [+X (anatomical left), −X]
	private arms: [Limb | null, Limb | null];
	private spines: THREE.Object3D[];
	private head?: THREE.Object3D;
	private pedal = new THREE.Vector3();
	/** Posture fitted to this vehicle on the first frame: forward lean and slide on the seat. */
	private lean: number;
	private slide = 0;
	private fitted = false;

	constructor(
		private avatar: THREE.Object3D,
		private animations: RealisticAnimations,
		readonly vehicle: VehicleInstance
	) {
		this.previousParent = avatar.parent;
		this.bone = (n) => avatar.getObjectByName('mixamorig' + n);
		const limb = (a: string, b: string, c: string, d?: string): Limb | null => {
			const [upper, lower, end] = [this.bone(a), this.bone(b), this.bone(c)];
			return upper && lower && end ? { upper, lower, end, tip: d ? this.bone(d) : undefined } : null;
		};
		this.legs = [limb('LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase'), limb('RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase')];
		this.arms = [limb('LeftArm', 'LeftForeArm', 'LeftHand'), limb('RightArm', 'RightForeArm', 'RightHand')];
		this.spines = ['Spine', 'Spine1', 'Spine2'].map((n) => this.bone(n)).filter((b): b is THREE.Object3D => !!b);
		this.head = this.bone('Head');
		this.lean = LEAN[vehicle.kind] ?? 0.2;
		animations.stopEmote();
		animations.riding = true;
		avatar.position.set(0, 0, 0);
		avatar.rotation.set(0, 0, 0);
		vehicle.lean.add(avatar);
	}

	/** Pose the rider for this frame (after the vehicle's root transform and pose are set). */
	update(_dt: number, wheel: number): void {
		const v = this.vehicle;
		v.root.updateMatrixWorld(true);
		const { side, fwd, up } = this.seat();
		if (!this.fitted) this.fit();

		// Feet: pegs on the motorbike, pedals turning with the rear wheel on the bicycle.
		// Feet: pegs on the motorbike, pedals turning with the rear wheel on the bicycle.
		this.legs.forEach((leg, i) => {
			if (!leg) return;
			const peg = i === 0 ? v.anchors.pegR : v.anchors.pegL;
			let target: THREE.Vector3;
			if (v.anchors.crank) {
				const phase = wheel * 0.42 + (i === 0 ? 0 : Math.PI);
				this.pedal.copy(peg.position);
				this.pedal.y = v.anchors.crank.position.y - Math.cos(phase) * CRANK;
				this.pedal.z = v.anchors.crank.position.z + Math.sin(phase) * CRANK;
				target = peg.parent!.localToWorld(this.pedal);
			} else target = peg.getWorldPosition(tmpD);
			const hip = leg.upper.getWorldPosition(new THREE.Vector3());
			const pole = hip.clone().addScaledVector(fwd, 0.8).addScaledVector(up, 0.3);
			solveTwoBone(leg.upper, leg.lower, leg.end, target, pole);
			// Sole roughly level, toes forward.
			if (leg.tip) {
				const ankle = leg.end.getWorldPosition(new THREE.Vector3());
				const toe = leg.tip.getWorldPosition(new THREE.Vector3());
				const len = ankle.distanceTo(toe);
				aimBone(leg.end, toe, ankle.clone().addScaledVector(fwd, len * 0.95).addScaledVector(up, -len * 0.3));
			}
		});

		// Hands on the grips, elbows out and down.
		this.arms.forEach((arm, i) => {
			if (!arm) return;
			const grip = (i === 0 ? v.anchors.gripR : v.anchors.gripL).getWorldPosition(new THREE.Vector3());
			const shoulder = arm.upper.getWorldPosition(new THREE.Vector3());
			const out = side.clone().multiplyScalar(i === 0 ? 1 : -1);
			const pole = shoulder.clone().addScaledVector(out, 0.35).addScaledVector(up, -0.45).addScaledVector(fwd, -0.1);
			solveTwoBone(arm.upper, arm.lower, arm.end, grip, pole);
		});
	}

	/** Bind pose, forward lean (spread over the spine), hips onto the seat. Returns the avatar's
	 * world axes: side (+X), forward (+Z) and up. */
	private seat(): { side: THREE.Vector3; fwd: THREE.Vector3; up: THREE.Vector3 } {
		const v = this.vehicle;
		this.animations.restPose();
		this.avatar.updateMatrixWorld(true);
		const m = this.avatar.matrixWorld;
		const side = new THREE.Vector3().setFromMatrixColumn(m, 0).normalize();
		const fwd = new THREE.Vector3().setFromMatrixColumn(m, 2).normalize();
		const up = new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
		// Spread the lean over the spine bones (most in the lower back); shares sum to 1.
		const weights = [0.5, 0.3, 0.2].slice(0, this.spines.length);
		const total = weights.reduce((a, b) => a + b, 0);
		this.spines.forEach((b, i) => rotateWorld(b, side, (this.lean * weights[i]) / total));
		if (this.head) rotateWorld(this.head, side, -this.lean * 0.7); // eyes on the road
		const [l, r] = this.legs;
		if (l && r) {
			const hips = l.upper.getWorldPosition(tmpA).add(r.upper.getWorldPosition(tmpB)).multiplyScalar(0.5);
			const seat = v.anchors.seat.getWorldPosition(tmpC).addScaledVector(up, SEAT_CLEARANCE).addScaledVector(fwd, this.slide);
			const parent = this.avatar.parent!;
			parent.worldToLocal(hips);
			parent.worldToLocal(seat);
			this.avatar.position.add(seat.sub(hips));
			this.avatar.updateMatrixWorld(true);
		}
		return { side, fwd, up };
	}

	/** First frame: sit further forward, then lean further, until both grips are in reach. */
	private fit(): void {
		this.fitted = true;
		const reach = this.arms.map((a) =>
			a ? a.upper.getWorldPosition(new THREE.Vector3()).distanceTo(a.lower.getWorldPosition(tmpA)) + a.lower.getWorldPosition(tmpA).distanceTo(a.end.getWorldPosition(tmpB)) : 0
		);
		for (let i = 0; i < 12; i++) {
			let excess = 0;
			this.arms.forEach((a, k) => {
				if (!a) return;
				const grip = (k === 0 ? this.vehicle.anchors.gripR : this.vehicle.anchors.gripL).getWorldPosition(tmpC);
				excess = Math.max(excess, a.upper.getWorldPosition(tmpD).distanceTo(grip) - reach[k] * 0.97);
			});
			if (excess <= 0) break;
			if (this.slide < MAX_SLIDE) this.slide = Math.min(MAX_SLIDE, this.slide + excess);
			else if (this.lean < MAX_LEAN) this.lean = Math.min(MAX_LEAN, this.lean + Math.max(0.03, excess * 1.6));
			else break; // best effort: arms point at the grips
			this.seat();
		}
	}

	/** Take the avatar off the vehicle (back to its previous parent, gait animation resumes). */
	detach(to: THREE.Object3D | null = this.previousParent): void {
		this.animations.riding = false;
		this.animations.restPose();
		this.avatar.position.set(0, 0, 0);
		if (to) to.add(this.avatar);
		else this.avatar.removeFromParent();
	}
}

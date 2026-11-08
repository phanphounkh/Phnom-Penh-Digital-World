/**
 * Emotes are short pose layers on top of the gait animation (PlayerAnimations): they blend in,
 * hold for a few seconds and blend out; walking cancels them.
 *
 * Rig conventions (CampusEats rig, character faces +Z): shoulder rotation.x < 0 raises the arm
 * forwards; rotation.z moves the hand towards +X (so +z lifts the +X arm sideways and -z the
 * -X arm); elbow rotation.x < 0 bends the forearm forwards.
 */
import { MathUtils, type Object3D } from 'three';
import type { EmoteName } from '$lib/game/net/protocol';

interface Joints {
	body?: Object3D;
	leftArm?: Object3D; // at -X
	rightArm?: Object3D; // at +X
	leftElbow?: Object3D;
	rightElbow?: Object3D;
}

type Pose = (t: number, j: Required<Pick<Joints, 'leftArm' | 'rightArm' | 'leftElbow' | 'rightElbow'>>) => {
	l: [number, number, number]; // shoulder x, shoulder z, elbow x (the -X arm)
	r: [number, number, number]; // the +X arm
	bodyX?: number;
	bodyZ?: number;
};

const POSES: Record<EmoteName, { duration: number; pose: Pose }> = {
	wave: {
		duration: 2.6,
		pose: (t) => ({ l: [0, 0, -0.12], r: [-0.25, 2.55, -0.55 + Math.sin(t * 11) * 0.45] })
	},
	// Sampeah: palms pressed together in front of the chest, with a gentle bow.
	sampeah: {
		duration: 2.8,
		pose: () => ({ l: [-0.62, 0.42, -2.05], r: [-0.62, -0.42, -2.05], bodyX: 0.22 })
	},
	cheer: {
		duration: 2.2,
		pose: (t) => ({ l: [-0.1, -2.75, -0.25], r: [-0.1, 2.75, -0.25], bodyX: -0.05 + Math.sin(t * 9) * 0.03 })
	},
	dance: {
		duration: 3.6,
		pose: (t) => {
			const s = Math.sin(t * 6.5);
			return {
				l: [-0.4 - s * 0.3, -1.1 + s * 0.6, -1.1],
				r: [-0.4 + s * 0.3, 1.1 + s * 0.6, -1.1],
				bodyZ: s * 0.14
			};
		}
	}
};

const BLEND = 0.25;

export class EmotePlayer {
	private j: Joints;
	private current: EmoteName | null = null;
	private time = 0;

	constructor(model: Object3D) {
		this.j = {
			body: model.getObjectByName('BodyRoot'),
			leftArm: model.getObjectByName('LeftArm'),
			rightArm: model.getObjectByName('RightArm'),
			leftElbow: model.getObjectByName('LeftElbow'),
			rightElbow: model.getObjectByName('RightElbow')
		};
	}

	get playing(): EmoteName | null {
		return this.current;
	}

	play(name: EmoteName): void {
		this.current = name;
		this.time = 0;
	}

	stop(): void {
		this.current = null;
		if (this.j.body) this.j.body.rotation.set(0, 0, 0);
	}

	/** Call after the gait animation has posed the arms for this frame. */
	update(dt: number, moving: boolean): void {
		if (!this.current) return;
		if (moving) return this.stop();
		const spec = POSES[this.current];
		this.time += dt;
		if (this.time >= spec.duration) return this.stop();
		const { leftArm, rightArm, leftElbow, rightElbow, body } = this.j;
		if (!leftArm || !rightArm || !leftElbow || !rightElbow) return;
		const w = Math.min(1, this.time / BLEND, (spec.duration - this.time) / BLEND);
		const p = spec.pose(this.time, { leftArm, rightArm, leftElbow, rightElbow });
		const mix = (obj: Object3D, axis: 'x' | 'z', target: number) =>
			(obj.rotation[axis] = MathUtils.lerp(obj.rotation[axis], target, w));
		mix(leftArm, 'x', p.l[0]);
		mix(leftArm, 'z', p.l[1]);
		mix(leftElbow, 'x', p.l[2]);
		mix(rightArm, 'x', p.r[0]);
		mix(rightArm, 'z', p.r[1]);
		mix(rightElbow, 'x', p.r[2]);
		if (body) {
			body.rotation.x = (p.bodyX ?? 0) * w;
			body.rotation.z = (p.bodyZ ?? 0) * w;
		}
	}
}

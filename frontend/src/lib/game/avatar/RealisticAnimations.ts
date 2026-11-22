/**
 * Animation for realistic avatars, with the same `update()` signature as PlayerAnimations so
 * the engine drives either rig the same way.
 *
 * - Gait: Idle / Walk / Run clips, chosen with hysteresis (gaitState below). Walk and
 *   Run share one stride cycle, so a switch keeps the phase; playback speed follows the ground
 *   speed (`speeds` = each clip's foot-sliding-free speed, measured by the generator).
 * - Emotes: wave → Wave, sampeah → Greet, cheer → Cheer, dance → Dance (looped 3.6 s); they fade
 *   in over the gait and back out.
 * - Holding a product: the right arm is solved (two-bone IK) into a carry pose on top.
 * - Riding: the vehicle rider owns the pose (`riding = true` stops the mixer).
 */
import * as THREE from 'three';
import type { EmoteName } from '$lib/game/net/protocol';
import { solveTwoBone } from './ik';

/** Gait thresholds (m/s) around PlayerAnimations' 0.07 / 4.0, with hysteresis so a speed hovering
 * near one (sliding along a wall, network jitter on remote players) does not flicker clips. */
export const GAIT = { idleBelow: 0.07, moveAbove: 0.1, runAbove: 4.3, walkBelow: 3.7, idleFade: 0.16, strideFade: 0.25 };

/** Next gait for `speed`, given the current one. */
export function gaitState(current: string, speed: number, holding = false): 'idle' | 'walk' | 'run' | 'carry' {
	const moving = current && current !== 'idle' ? speed >= GAIT.idleBelow : speed > GAIT.moveAbove;
	if (!moving) return 'idle';
	if (holding) return 'carry';
	const running = current === 'run' ? speed > GAIT.walkBelow : speed > GAIT.runAbove;
	return running ? 'run' : 'walk';
}

const GAIT_CLIP: Record<string, string> = { idle: 'Idle', walk: 'Walk', carry: 'Walk', run: 'Run' };
const STRIDE = new Set(['Walk', 'Run']);
export const EMOTE_CLIP: Record<EmoteName, { clip: string; duration?: number }> = {
	wave: { clip: 'Wave' },
	sampeah: { clip: 'Greet' },
	cheer: { clip: 'Cheer' },
	dance: { clip: 'Dance', duration: 3.6 }
};
const EMOTE_FADE = 0.25;
/** Playback-rate limits: beyond them the cadence looks wrong, so feet slide a little instead. */
export const RATE_LIMITS: [number, number] = [0.45, 2.0];

/** Playback rate for a gait clip at `speed` m/s (signed: walking backwards plays in reverse). */
export function gaitRate(clip: string, speed: number, direction: number, speeds: { walk: number; run: number }): number {
	if (clip !== 'Walk' && clip !== 'Run') return 1;
	const natural = clip === 'Walk' ? speeds.walk : speeds.run;
	const rate = THREE.MathUtils.clamp(speed / natural, RATE_LIMITS[0], RATE_LIMITS[1]);
	return direction < 0 ? -rate : rate;
}

export class RealisticAnimations {
	readonly mixer: THREE.AnimationMixer;
	/** Set by the vehicle rider: it poses the bones itself, so the mixer pauses. */
	riding = false;
	private actions = new Map<string, THREE.AnimationAction>();
	private state = '';
	private emote: { name: EmoteName; action: THREE.AnimationAction; time: number; duration: number } | null = null;
	private carry = 0;
	private rest: [THREE.Object3D, THREE.Vector3, THREE.Quaternion][] = [];
	private arm: { arm?: THREE.Object3D; fore?: THREE.Object3D; hand?: THREE.Object3D };
	private qa = new THREE.Quaternion();
	private qf = new THREE.Quaternion();
	private qik = new THREE.Quaternion();
	private target = new THREE.Vector3();
	private pole = new THREE.Vector3();

	constructor(
		readonly root: THREE.Object3D,
		clips: THREE.AnimationClip[],
		private speeds: { walk: number; run: number },
		private height = 1.72
	) {
		this.mixer = new THREE.AnimationMixer(root);
		for (const clip of clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
		root.traverse((o) => {
			if ((o as THREE.Bone).isBone) this.rest.push([o, o.position.clone(), o.quaternion.clone()]);
		});
		this.arm = {
			arm: root.getObjectByName('mixamorigRightArm'),
			fore: root.getObjectByName('mixamorigRightForeArm'),
			hand: root.getObjectByName('mixamorigRightHand')
		};
	}

	/** The mixer action of a clip (inspection and tests). */
	action(clip: string): THREE.AnimationAction | undefined {
		return this.actions.get(clip);
	}

	get gait(): string {
		return this.state;
	}

	get playing(): EmoteName | null {
		return this.emote?.name ?? null;
	}

	/** Same arguments as PlayerAnimations.update (picking/targets are mall-only and unused). */
	update(dt: number, speed: number, holding = false, _picking = false, _targets: unknown = null, _travel = 0, direction = 1): void {
		if (this.riding) return;
		const next = gaitState(this.state, speed, holding);
		if (next !== this.state) this.switchGait(next);
		const clip = GAIT_CLIP[this.state];
		const action = this.actions.get(clip);
		if (action) action.timeScale = gaitRate(clip, speed, direction, this.speeds);
		if (this.emote) {
			this.emote.time += dt;
			if (this.emote.time >= this.emote.duration - EMOTE_FADE) this.stopEmote();
		}
		this.mixer.update(dt);
		this.carryPose(dt, holding);
	}

	private switchGait(next: string): void {
		const prev = this.actions.get(GAIT_CLIP[this.state]);
		const cur = this.actions.get(GAIT_CLIP[next]);
		this.state = next;
		if (!cur || prev === cur) return;
		const stride = !!prev && STRIDE.has(prev.getClip().name) && STRIDE.has(cur.getClip().name);
		const fade = stride ? GAIT.strideFade : GAIT.idleFade;
		cur.reset();
		if (stride && prev) cur.time = (prev.time / prev.getClip().duration) * cur.getClip().duration;
		if (this.emote) {
			// The emote owns the pose; the new gait waits underneath at zero weight.
			prev?.stop();
			cur.setEffectiveWeight(0).play();
			return;
		}
		prev?.fadeOut(fade);
		cur.fadeIn(fade).play();
	}

	playEmote(name: EmoteName): void {
		const spec = EMOTE_CLIP[name];
		const action = this.actions.get(spec.clip);
		if (!action || this.riding) return;
		this.stopEmote();
		const gait = this.actions.get(GAIT_CLIP[this.state]);
		gait?.fadeOut(EMOTE_FADE);
		action.reset();
		action.setLoop(spec.duration ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
		action.clampWhenFinished = true;
		action.fadeIn(EMOTE_FADE).play();
		this.emote = { name, action, time: 0, duration: spec.duration ?? action.getClip().duration };
	}

	stopEmote(): void {
		if (!this.emote) return;
		this.emote.action.fadeOut(EMOTE_FADE);
		this.emote = null;
		const gait = this.actions.get(GAIT_CLIP[this.state] ?? 'Idle');
		if (gait) gait.reset().setEffectiveWeight(1).fadeIn(EMOTE_FADE).play();
	}

	/** Right hand in front of the waist, forearm level, while a product is held. */
	private carryPose(dt: number, holding: boolean): void {
		this.carry += ((holding ? 1 : 0) - this.carry) * (1 - Math.exp(-dt * 10));
		const { arm, fore, hand } = this.arm;
		if (this.carry < 0.01 || !arm || !fore || !hand) return;
		this.qa.copy(arm.quaternion);
		this.qf.copy(fore.quaternion);
		const h = this.height / 1.72;
		this.root.updateWorldMatrix(true, false);
		this.root.localToWorld(this.target.set(-0.17 * h, 0.98 * h, 0.3 * h));
		this.root.localToWorld(this.pole.set(-0.5 * h, 0.8 * h, -0.5 * h));
		solveTwoBone(arm, fore, hand, this.target, this.pole);
		// Blend animated → IK (copy first: slerpQuaternions overwrites its target before reading).
		arm.quaternion.slerpQuaternions(this.qa, this.qik.copy(arm.quaternion), this.carry);
		fore.quaternion.slerpQuaternions(this.qf, this.qik.copy(fore.quaternion), this.carry);
	}

	/** Every bone back to the bind (A) pose. */
	restPose(): void {
		for (const [bone, p, q] of this.rest) {
			bone.position.copy(p);
			bone.quaternion.copy(q);
		}
	}

	dispose(): void {
		this.mixer.stopAllAction();
		this.mixer.uncacheRoot(this.root);
	}
}

/** EmotePlayer-compatible facade (the engine calls play/stop/update(dt, moving)). */
export class RealisticEmotes {
	constructor(private animations: RealisticAnimations) {}

	get playing(): EmoteName | null {
		return this.animations.playing;
	}

	play(name: EmoteName): void {
		this.animations.playEmote(name);
	}

	stop(): void {
		this.animations.stopEmote();
	}

	/** Walking cancels an emote (timing runs inside RealisticAnimations.update). */
	update(_dt: number, moving: boolean): void {
		if (moving && this.animations.playing) this.animations.stopEmote();
	}
}

/**
 * Animation for realistic avatars, with the same `update()` signature as PlayerAnimations so
 * the engine drives either rig the same way.
 *
 * - Gait: Idle / Walk / Run (jog) / Sprint, chosen by ground speed with hysteresis (gaitState).
 *   The locomotion clips are retargeted motion capture (CMU), each cut from left heel strike to
 *   left heel strike, so a switch between them keeps the stride phase and the crossfade stays in
 *   step. Playback speed follows the ground speed (`speeds` = each clip's no-foot-sliding speed,
 *   measured by the generator), so the feet do not skate.
 * - Air: Jump → Fall → Land one-shot clips, driven by `airborne()` (the engine owns the physics).
 * - Posture: a held pose such as Sit (on a chair), set and cleared by the engine with posture().
 * - Lean: the whole body tilts about the feet into turns (from the yaw rate and speed) and
 *   forward/back while speeding up or braking. It is derived from the root's own motion, so it
 *   works for remote players too.
 * - Emotes: wave → Wave, sampeah → Greet, cheer → Cheer, dance → Dance (looped 3.6 s); they fade
 *   in over the gait and back out.
 * - Holding a product: the right arm is solved (two-bone IK) into a carry pose on top.
 * - Riding: the vehicle rider owns the pose (`riding = true` stops the mixer).
 * Any missing clip is skipped: an old model without Sprint jogs faster, one without Jump/Fall/Land
 * keeps its gait in the air.
 */
import * as THREE from 'three';
import type { EmoteName } from '$lib/game/net/protocol';
import { solveTwoBone } from './ik';

/** Natural (no-slide) speed of each locomotion clip, m/s. */
export interface GaitSpeeds {
	walk: number;
	run: number;
	sprint?: number;
}
export type GaitName = 'idle' | 'walk' | 'run' | 'sprint';
export type AirState = '' | 'jump' | 'fall' | 'land';

/** The male avatar's measured clip speeds (used when a caller has none). */
export const DEFAULT_SPEEDS: GaitSpeeds = { walk: 1.5, run: 2.58, sprint: 4.75 };

/** Idle thresholds (m/s), the hysteresis band around the gait switch speeds (±fraction) and the
 * crossfade times (s). The band keeps a speed hovering near a switch (sliding along a wall,
 * network jitter on remote players) from flickering clips. */
export const GAIT = { idleBelow: 0.07, moveAbove: 0.1, band: 0.06, idleFade: 0.16, strideFade: 0.25, airFade: 0.08, landFade: 0.22 };

/** Speeds where the gait changes: the geometric mean of the two neighbouring clips' natural
 * speeds (where both would play equally far from 1×), widened by the hysteresis band. */
export function gaitThresholds(s: GaitSpeeds): { runAbove: number; walkBelow: number; sprintAbove: number; runBelow: number } {
	const wr = Math.sqrt(s.walk * s.run);
	const rs = s.sprint ? Math.sqrt(s.run * s.sprint) : Infinity;
	return { runAbove: wr * (1 + GAIT.band), walkBelow: wr * (1 - GAIT.band), sprintAbove: rs * (1 + GAIT.band), runBelow: rs * (1 - GAIT.band) };
}

/** Next gait for `speed`, given the current one. Holding a product caps it at a jog. */
export function gaitState(current: string, speed: number, holding = false, speeds: GaitSpeeds = DEFAULT_SPEEDS): GaitName {
	const moving = current && current !== 'idle' ? speed >= GAIT.idleBelow : speed > GAIT.moveAbove;
	if (!moving) return 'idle';
	const t = gaitThresholds(speeds);
	if (!holding && (current === 'sprint' ? speed > t.runBelow : speed > t.sprintAbove)) return 'sprint';
	const running = current === 'run' || current === 'sprint' ? speed > t.walkBelow : speed > t.runAbove;
	return running ? 'run' : 'walk';
}

const GAIT_CLIP: Record<GaitName, string> = { idle: 'Idle', walk: 'Walk', run: 'Run', sprint: 'Sprint' };
const AIR_CLIP: Record<Exclude<AirState, ''>, string> = { jump: 'Jump', fall: 'Fall', land: 'Land' };
const STRIDE = new Set(['Walk', 'Run', 'Sprint']);
export const EMOTE_CLIP: Record<EmoteName, { clip: string; duration?: number }> = {
	wave: { clip: 'Wave' },
	sampeah: { clip: 'Greet' },
	cheer: { clip: 'Cheer' },
	dance: { clip: 'Dance', duration: 3.6 }
};
const EMOTE_FADE = 0.25;
/** Playback-rate limits: beyond them the cadence looks wrong, so feet slide a little instead. */
export const RATE_LIMITS: [number, number] = [0.45, 2.0];
/** Air clips: where Jump starts (s; skips most of the crouch, since the engine takes off at once),
 * Fall's playback rate (the clip is shorter than a fall), where Land starts, and how long Land
 * holds before the gait takes over when the avatar lands moving / standing. */
export const AIR = { jumpFrom: 0.1, fallRate: 0.8, landFrom: 0.03, landMoving: 0.14, landStanding: 0.42 };
/** Crossfade into and out of a held posture (sitting down takes about this long). */
export const POSTURE_FADE = 0.6;
/** Lean: share of the physical lean angle (atan(a / g)) the body takes, and the limits (rad). */
export const LEAN = { turn: 0.7, maxRoll: 0.2, accel: 0.6, maxPitch: 0.1 };

/** Playback rate for a gait clip at `speed` m/s (signed: walking backwards plays in reverse). */
export function gaitRate(clip: string, speed: number, direction: number, speeds: GaitSpeeds): number {
	const natural = clip === 'Walk' ? speeds.walk : clip === 'Run' ? speeds.run : clip === 'Sprint' ? (speeds.sprint ?? speeds.run) : 0;
	if (!natural) return 1;
	const rate = THREE.MathUtils.clamp(speed / natural, RATE_LIMITS[0], RATE_LIMITS[1]);
	return direction < 0 ? -rate : rate;
}

const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);

export class RealisticAnimations {
	readonly mixer: THREE.AnimationMixer;
	/** Set by the vehicle rider: it poses the bones itself, so the mixer pauses. */
	riding = false;
	private actions = new Map<string, THREE.AnimationAction>();
	private state: GaitName | '' = '';
	/** The action that owns the pose (a gait or an air clip) and a stride clip fading out under it. */
	private base: THREE.AnimationAction | null = null;
	private fading: THREE.AnimationAction | null = null;
	private air: AirState = '';
	private posed: THREE.AnimationAction | null = null;
	private landed = 0;
	private flying = false;
	private vy = 0;
	private emote: { name: EmoteName; action: THREE.AnimationAction; time: number; duration: number } | null = null;
	private carry = 0;
	private rest: [THREE.Object3D, THREE.Vector3, THREE.Quaternion][] = [];
	private arm: { arm?: THREE.Object3D; fore?: THREE.Object3D; hand?: THREE.Object3D };
	private hips?: THREE.Object3D;
	private qa = new THREE.Quaternion();
	private qf = new THREE.Quaternion();
	private qik = new THREE.Quaternion();
	private target = new THREE.Vector3();
	private pole = new THREE.Vector3();
	// Lean state.
	private heading = NaN;
	private turnRate = 0;
	private ground = 0;
	private accel = 0;
	private roll = 0;
	private pitch = 0;
	private leaned = false;
	private savedPos = new THREE.Vector3();
	private savedQuat = new THREE.Quaternion();
	private qLean = new THREE.Quaternion();
	private eLean = new THREE.Euler();
	private pivot = new THREE.Vector3();

	constructor(
		readonly root: THREE.Object3D,
		clips: THREE.AnimationClip[],
		private speeds: GaitSpeeds = DEFAULT_SPEEDS,
		private height = 1.72
	) {
		this.mixer = new THREE.AnimationMixer(root);
		for (const clip of clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
		for (const name of Object.values(AIR_CLIP)) {
			const a = this.actions.get(name);
			if (a) {
				a.setLoop(THREE.LoopOnce, 1);
				a.clampWhenFinished = true;
			}
		}
		root.traverse((o) => {
			if ((o as THREE.Bone).isBone) this.rest.push([o, o.position.clone(), o.quaternion.clone()]);
		});
		this.hips = root.getObjectByName('mixamorigHips');
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
		return this.posed ? this.posed.getClip().name.toLowerCase() : this.air || this.state;
	}

	get playing(): EmoteName | null {
		return this.emote?.name ?? null;
	}

	/** Current body lean (rad): roll into turns (+ = left), pitch while accelerating (+ = forward). */
	get lean(): { roll: number; pitch: number } {
		return { roll: this.roll, pitch: this.pitch };
	}

	/** The engine's vertical state: off the ground or not, and the vertical speed (m/s, + = up). */
	airborne(flying: boolean, vy = 0): void {
		this.flying = flying;
		this.vy = vy;
	}

	/** Same arguments as PlayerAnimations.update (picking/targets are mall-only and unused). */
	update(dt: number, speed: number, holding = false, _picking = false, _targets: unknown = null, _travel = 0, direction = 1): void {
		if (this.riding) {
			this.leaned = false;
			this.heading = NaN;
			this.roll = this.pitch = this.turnRate = this.accel = 0;
			return;
		}
		if (this.leaned && this.hips) {
			// Undo last frame's lean before the mixer writes (or does not write) the hips.
			this.hips.position.copy(this.savedPos);
			this.hips.quaternion.copy(this.savedQuat);
			this.leaned = false;
		}
		if (this.posed) {
			// Held posture (seated): no gait or air changes until the engine clears it.
			this.mixer.update(dt);
			this.applyLean(dt, 0);
			this.carryPose(dt, holding);
			return;
		}
		this.updateAir(dt, speed);
		const next = gaitState(this.state, speed, holding, this.speeds);
		if (next !== this.state) this.switchGait(next);
		const action = this.gaitAction(this.state);
		if (action) action.timeScale = gaitRate(action.getClip().name, speed, direction, this.speeds);
		this.lockFadingPhase();
		if (this.emote) {
			this.emote.time += dt;
			if (this.emote.time >= this.emote.duration - EMOTE_FADE) this.stopEmote();
		}
		this.mixer.update(dt);
		this.applyLean(dt, speed);
		this.carryPose(dt, holding);
	}

	/** The gait's clip, or the nearest one the model has (Sprint → Run). */
	private gaitAction(state: GaitName | ''): THREE.AnimationAction | undefined {
		if (!state) return undefined;
		return this.actions.get(GAIT_CLIP[state]) ?? (state === 'sprint' ? this.actions.get('Run') : undefined);
	}

	/** Jump → Fall → Land → gait, following the engine's vertical state. */
	private updateAir(dt: number, speed: number): void {
		if (this.flying) {
			if (this.air === '' || this.air === 'land') this.enterAir(this.vy > 0 ? 'jump' : 'fall');
			else if (this.air === 'jump' && this.vy <= 0) this.enterAir('fall');
		} else if (this.air === 'jump' || this.air === 'fall') {
			this.enterAir('land');
		} else if (this.air === 'land') {
			this.landed += dt;
			if (this.landed >= (speed > GAIT.moveAbove ? AIR.landMoving : AIR.landStanding)) this.leaveAir();
		}
	}

	private enterAir(state: Exclude<AirState, ''>): void {
		const clip = this.actions.get(AIR_CLIP[state]);
		if (!clip) return; // the model has no air clips: the gait carries on
		if (this.emote) this.stopEmote();
		this.air = state;
		this.landed = 0;
		clip.reset();
		clip.time = state === 'jump' ? AIR.jumpFrom : state === 'land' ? AIR.landFrom : 0;
		clip.timeScale = state === 'fall' ? AIR.fallRate : 1;
		this.crossfade(clip, GAIT.airFade, false);
	}

	private leaveAir(): void {
		this.air = '';
		const gait = this.gaitAction(this.state);
		if (gait) this.crossfade(gait.reset(), GAIT.landFade, false);
	}

	private switchGait(next: GaitName): void {
		const prev = this.gaitAction(this.state);
		const cur = this.gaitAction(next);
		this.state = next;
		if (!cur || prev === cur || this.air) return; // in the air: the gait waits for the landing
		const stride = !!prev && this.base === prev && STRIDE.has(prev.getClip().name) && STRIDE.has(cur.getClip().name);
		const phase = stride && prev ? prev.time / prev.getClip().duration : 0;
		cur.reset();
		if (stride) cur.time = phase * cur.getClip().duration;
		if (this.emote) {
			// The emote owns the pose; the new gait waits underneath at zero weight.
			prev?.stop();
			cur.setEffectiveWeight(0).play();
			this.base = cur;
			return;
		}
		this.crossfade(cur, stride ? GAIT.strideFade : GAIT.idleFade, stride);
	}

	/** Fade `next` in over the current base action. */
	private crossfade(next: THREE.AnimationAction, fade: number, stride: boolean): void {
		const prev = this.base;
		if (prev && prev !== next) prev.fadeOut(fade);
		if (this.fading && this.fading !== next && this.fading !== prev) this.fading.stop();
		this.fading = stride && prev && prev !== next ? prev : null;
		next.setEffectiveWeight(1).fadeIn(fade).play();
		this.base = next;
	}

	/** A stride clip fading out keeps advancing in step with the one fading in (same phase
	 * speed), so the legs of the two never disagree during the blend. */
	private lockFadingPhase(): void {
		const f = this.fading;
		const b = this.base;
		if (!f || !b) return;
		if (!f.isRunning() || f.getEffectiveWeight() <= 0) {
			this.fading = null;
			return;
		}
		const bd = b.getClip().duration;
		const fd = f.getClip().duration;
		f.time = (b.time / bd) * fd;
		f.timeScale = b.timeScale * (fd / bd);
	}

	/** Lean the whole body about the ground under the hips: into turns, and forward/back while
	 * speeding up/braking. Measured from the root's own motion (heading and speed). */
	private applyLean(dt: number, speed: number): void {
		if (dt <= 0) return;
		this.root.updateWorldMatrix(true, false);
		const e = this.root.matrixWorld.elements;
		const heading = Math.atan2(e[8], e[10]);
		let rate = 0;
		if (!Number.isNaN(this.heading)) {
			const d = heading - this.heading;
			rate = THREE.MathUtils.clamp(Math.atan2(Math.sin(d), Math.cos(d)) / dt, -8, 8);
		}
		this.heading = heading;
		this.turnRate += (rate - this.turnRate) * ease(dt, 10);
		const prev = this.ground;
		this.ground += (speed - this.ground) * ease(dt, 10);
		const accel = THREE.MathUtils.clamp((this.ground - prev) / dt, -15, 15);
		this.accel += (accel - this.accel) * ease(dt, 6);

		const airborne = this.air === 'jump' || this.air === 'fall';
		const moving = this.ground > 0.3 && !airborne && !this.emote;
		const roll = moving ? THREE.MathUtils.clamp(Math.atan((this.ground * this.turnRate) / 9.81) * LEAN.turn, -LEAN.maxRoll, LEAN.maxRoll) : 0;
		const pitch = !airborne && !this.emote ? THREE.MathUtils.clamp(Math.atan(this.accel / 9.81) * LEAN.accel, -LEAN.maxPitch, LEAN.maxPitch) : 0;
		this.roll += (roll - this.roll) * ease(dt, 8);
		this.pitch += (pitch - this.pitch) * ease(dt, 8);

		const hips = this.hips;
		if (!hips || Math.abs(this.roll) + Math.abs(this.pitch) < 1e-4) return;
		this.savedPos.copy(hips.position);
		this.savedQuat.copy(hips.quaternion);
		this.leaned = true;
		// Hips' parent space = the model's space (facing +Z, left at +X, feet at y = 0).
		// A left turn tips the head towards +X (−Z rotation); speeding up tips it towards +Z.
		this.qLean.setFromEuler(this.eLean.set(this.pitch, 0, -this.roll));
		this.pivot.set(hips.position.x, 0, hips.position.z);
		hips.position.sub(this.pivot).applyQuaternion(this.qLean).add(this.pivot);
		hips.quaternion.premultiply(this.qLean);
	}

	/** Hold a posture clip (e.g. 'Sit'), crossfading from whatever plays; null returns to the
	 * idle gait. A model without the clip ignores it. */
	posture(clip: string | null): void {
		if (clip) {
			const action = this.actions.get(clip);
			if (!action || this.posed === action || this.riding) return;
			if (this.emote) this.stopEmote();
			this.air = '';
			action.reset();
			action.setLoop(THREE.LoopRepeat, Infinity);
			this.crossfade(action, POSTURE_FADE, false);
			this.posed = action;
		} else if (this.posed) {
			this.posed = null;
			this.state = 'idle';
			const idle = this.gaitAction('idle');
			if (idle) this.crossfade(idle.reset(), POSTURE_FADE, false);
		}
	}

	playEmote(name: EmoteName): void {
		const spec = EMOTE_CLIP[name];
		const action = this.actions.get(spec.clip);
		if (!action || this.riding || this.air || this.posed) return;
		this.stopEmote();
		this.base?.fadeOut(EMOTE_FADE);
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
		const gait = this.gaitAction(this.state || 'idle');
		if (gait) {
			gait.reset().setEffectiveWeight(1).fadeIn(EMOTE_FADE).play();
			this.base = gait;
		}
	}

	/** Right hand in front of the waist, forearm level, while a product is held. */
	private carryPose(dt: number, holding: boolean): void {
		this.carry += ((holding ? 1 : 0) - this.carry) * ease(dt, 10);
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
		this.leaned = false;
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

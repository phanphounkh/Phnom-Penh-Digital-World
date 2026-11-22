import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AIR, LEAN, RATE_LIMITS, RealisticAnimations, RealisticEmotes, gaitRate, gaitState, gaitThresholds } from './RealisticAnimations';
import { RealisticRider } from '$lib/game/vehicles/RealisticRider';
import type { VehicleInstance } from '$lib/game/vehicles/VehicleModels';

const SPEEDS = { walk: 1.5, run: 2.6, sprint: 4.75 };

/** A small Mixamo-named skeleton (metres, facing +Z, anatomical left at +X). */
function skeleton() {
	const root = new THREE.Group();
	const bone = (name: string, parent: THREE.Object3D, x: number, y: number, z = 0) => {
		const b = new THREE.Bone();
		b.name = 'mixamorig' + name;
		b.position.set(x, y, z);
		parent.add(b);
		return b;
	};
	const hips = bone('Hips', root, 0, 0.95);
	const spine = bone('Spine', hips, 0, 0.1);
	const spine2 = bone('Spine2', spine, 0, 0.3);
	bone('Head', bone('Neck', spine2, 0, 0.12), 0, 0.08);
	for (const [side, sx] of [['Left', 1], ['Right', -1]] as const) {
		const arm = bone(side + 'Arm', bone(side + 'Shoulder', spine2, sx * 0.06, 0.05), sx * 0.12, 0);
		bone(side + 'Hand', bone(side + 'ForeArm', arm, sx * 0.19, -0.19), sx * 0.18, -0.18);
		const up = bone(side + 'UpLeg', hips, sx * 0.09, -0.06);
		bone(side + 'ToeBase', bone(side + 'Foot', bone(side + 'Leg', up, 0, -0.43), 0, -0.42), 0, -0.05, 0.12);
	}
	root.updateWorldMatrix(true, true);
	return root;
}

/** Clips that move a marker bone so tests can see which clip is driving the rig. */
const NAMES = ['Idle', 'Walk', 'Run', 'Wave', 'Greet', 'Dance', 'Cheer', 'Sit', 'Talk', 'Sprint', 'Jump', 'Fall', 'Land'];
function clips(without: string[] = []): THREE.AnimationClip[] {
	const durations: Record<string, number> = { Walk: 1.0, Run: 0.75, Sprint: 0.7, Dance: 2, Wave: 3, Greet: 3, Cheer: 2.2, Jump: 0.37, Fall: 0.2, Land: 0.63 };
	return NAMES.filter((n) => !without.includes(n)).map((name) => {
		const d = durations[name] ?? 4;
		const i = NAMES.indexOf(name);
		const track = new THREE.NumberKeyframeTrack('mixamorigHead.position[x]', [0, d], [i, i]);
		return new THREE.AnimationClip(name, d, [track]);
	});
}
const marker = (name: string) => NAMES.indexOf(name);

describe('gait selection', () => {
	const t = gaitThresholds(SPEEDS);

	it('switches between neighbouring clips where both play equally far from 1x', () => {
		expect((t.runAbove + t.walkBelow) / 2).toBeCloseTo(Math.sqrt(1.5 * 2.6), 6);
		expect((t.sprintAbove + t.runBelow) / 2).toBeCloseTo(Math.sqrt(2.6 * 4.75), 6);
		expect(gaitThresholds({ walk: 1.5, run: 2.6 }).sprintAbove).toBe(Infinity); // no Sprint clip
	});

	it('uses hysteresis around every threshold', () => {
		expect(gaitState('', 0, false, SPEEDS)).toBe('idle');
		expect(gaitState('idle', 0.08, false, SPEEDS)).toBe('idle');
		expect(gaitState('idle', 0.2, false, SPEEDS)).toBe('walk');
		const wr = Math.sqrt(1.5 * 2.6);
		expect(gaitState('walk', wr, false, SPEEDS)).toBe('walk');
		expect(gaitState('walk', t.runAbove + 0.01, false, SPEEDS)).toBe('run');
		expect(gaitState('run', wr, false, SPEEDS)).toBe('run');
		expect(gaitState('run', t.walkBelow - 0.01, false, SPEEDS)).toBe('walk');
		const rs = Math.sqrt(2.6 * 4.75);
		expect(gaitState('run', rs, false, SPEEDS)).toBe('run');
		expect(gaitState('run', t.sprintAbove + 0.01, false, SPEEDS)).toBe('sprint');
		expect(gaitState('sprint', rs, false, SPEEDS)).toBe('sprint');
		expect(gaitState('sprint', t.runBelow - 0.01, false, SPEEDS)).toBe('run');
		expect(gaitState('sprint', 0.05, false, SPEEDS)).toBe('idle');
	});

	it("plays the game's speeds near 1x: 2.6 m/s jogs, 6.5 m/s sprints", () => {
		expect(gaitState('idle', 2.6, false, SPEEDS)).toBe('run');
		expect(gaitState('idle', 6.5, false, SPEEDS)).toBe('sprint');
		expect(gaitRate('Run', 2.6, 1, SPEEDS)).toBeCloseTo(1);
		expect(gaitRate('Sprint', 6.5, 1, SPEEDS)).toBeCloseTo(6.5 / 4.75);
	});

	it('caps the gait at a jog while holding a product', () => {
		expect(gaitState('run', 6.5, true, SPEEDS)).toBe('run');
		expect(gaitState('idle', 1, true, SPEEDS)).toBe('walk');
	});

	it('plays gait clips at the ground speed, reversed when walking backwards', () => {
		expect(gaitRate('Walk', 1.5, 1, SPEEDS)).toBeCloseTo(1);
		expect(gaitRate('Walk', 2.0, 1, SPEEDS)).toBeCloseTo(2.0 / 1.5);
		expect(gaitRate('Sprint', 12, 1, SPEEDS)).toBe(RATE_LIMITS[1]);
		expect(gaitRate('Sprint', 3, 1, { walk: 1.5, run: 2.6 })).toBeCloseTo(3 / 2.6); // falls back to Run's speed
		expect(gaitRate('Walk', 1.2, -1, SPEEDS)).toBeLessThan(0);
		expect(gaitRate('Idle', 0, 1, SPEEDS)).toBe(1);
	});
});

describe('RealisticAnimations', () => {
	const head = (root: THREE.Object3D) => root.getObjectByName('mixamorigHead')!.position.x;

	const phase = (a: RealisticAnimations, clip: string) => a.action(clip)!.time / a.action(clip)!.getClip().duration;
	const run = (a: RealisticAnimations, frames: number, speed: number, dt = 0.016) => {
		for (let i = 0; i < frames; i++) a.update(dt, speed);
	};

	it('crossfades idle → walk → run → sprint and keeps the stride phase', () => {
		const root = skeleton();
		const a = new RealisticAnimations(root, clips(), SPEEDS);
		a.update(0.016, 0);
		expect(a.gait).toBe('idle');
		run(a, 30, 1.5);
		expect(a.gait).toBe('walk');
		const walk = phase(a, 'Walk');
		a.update(0.016, 2.6);
		expect(a.gait).toBe('run');
		// Same point of the stride cycle, plus this frame's advance at the jog rate.
		expect(phase(a, 'Run')).toBeCloseTo(walk + (0.016 * (2.6 / 2.6)) / 0.75, 2);
		run(a, 40, 2.6);
		expect(head(root)).toBeCloseTo(marker('Run')); // the jog fully owns the pose
		const jog = phase(a, 'Run');
		a.update(0.016, 6.5);
		expect(a.gait).toBe('sprint');
		expect(phase(a, 'Sprint')).toBeCloseTo((jog + (0.016 * (6.5 / 4.75)) / 0.7) % 1, 2);
		run(a, 40, 6.5);
		expect(head(root)).toBeCloseTo(marker('Sprint'));
	});

	it('keeps the clip fading out in step with the one fading in', () => {
		const a = new RealisticAnimations(skeleton(), clips(), SPEEDS);
		run(a, 30, 1.5);
		run(a, 8, 2.6); // halfway through the 0.25 s stride crossfade
		expect(a.action('Walk')!.getEffectiveWeight()).toBeGreaterThan(0);
		expect(phase(a, 'Walk')).toBeCloseTo(phase(a, 'Run'), 2);
	});

	it('jumps, falls and lands, then hands back to the gait', () => {
		const root = skeleton();
		const a = new RealisticAnimations(root, clips(), SPEEDS);
		run(a, 20, 0);
		a.airborne(true, 3.6);
		a.update(0.016, 0);
		expect(a.gait).toBe('jump');
		expect(a.action('Jump')!.time).toBeGreaterThanOrEqual(AIR.jumpFrom);
		run(a, 10, 0);
		expect(head(root)).toBeCloseTo(marker('Jump'));
		a.airborne(true, -0.5);
		a.update(0.016, 0);
		expect(a.gait).toBe('fall');
		a.airborne(false);
		a.update(0.016, 0);
		expect(a.gait).toBe('land');
		run(a, 10, 0);
		expect(head(root)).toBeCloseTo(marker('Land'));
		run(a, Math.ceil(AIR.landStanding / 0.016), 0);
		expect(a.gait).toBe('idle');
		run(a, 30, 0);
		expect(head(root)).toBeCloseTo(marker('Idle'));
	});

	it('lands into the gait quickly when moving', () => {
		const root = skeleton();
		const a = new RealisticAnimations(root, clips(), SPEEDS);
		run(a, 30, 2.6);
		a.airborne(true, -1);
		run(a, 10, 2.6);
		expect(a.gait).toBe('fall');
		a.airborne(false);
		run(a, Math.ceil(AIR.landMoving / 0.016) + 1, 2.6);
		expect(a.gait).toBe('run');
		run(a, 30, 2.6);
		expect(head(root)).toBeCloseTo(marker('Run'));
	});

	it('copes with models that lack Sprint and the air clips', () => {
		const root = skeleton();
		const a = new RealisticAnimations(root, clips(['Sprint', 'Jump', 'Fall', 'Land']), SPEEDS);
		run(a, 60, 6.5);
		expect(head(root)).toBeCloseTo(marker('Run')); // sprints on the jog clip
		a.airborne(true, 3);
		run(a, 10, 6.5);
		expect(a.gait).toBe('sprint');
		a.airborne(false);
		run(a, 10, 0);
		expect(a.gait).toBe('idle');
	});

	it('holds a posture (Sit) over everything else and returns to idle', () => {
		const root = skeleton();
		const a = new RealisticAnimations(root, clips(), SPEEDS);
		run(a, 20, 0);
		a.posture('Sit');
		run(a, 60, 0);
		expect(a.gait).toBe('sit');
		expect(head(root)).toBeCloseTo(marker('Sit'));
		a.playEmote('wave'); // no emotes while seated
		expect(a.playing).toBeNull();
		run(a, 10, 3); // speed is ignored while seated
		expect(a.gait).toBe('sit');
		a.posture(null);
		run(a, 60, 0);
		expect(a.gait).toBe('idle');
		expect(head(root)).toBeCloseTo(marker('Idle'));
		a.posture('NoSuchClip'); // missing clips are ignored
		expect(a.gait).toBe('idle');
	});

	it('leans into turns about the feet, and forward when speeding up', () => {
		const holder = new THREE.Group();
		const root = skeleton();
		holder.add(root);
		const a = new RealisticAnimations(root, clips(), SPEEDS);
		const neck = () => root.worldToLocal(root.getObjectByName('mixamorigNeck')!.getWorldPosition(new THREE.Vector3()));
		const foot = () => root.worldToLocal(root.getObjectByName('mixamorigLeftFoot')!.getWorldPosition(new THREE.Vector3()));
		run(a, 40, 0);
		const still = { neck: neck(), foot: foot() };
		// Speeding up: the head goes forward (+Z).
		for (let i = 0; i < 20; i++) a.update(0.016, Math.min(6.5, i * 0.1));
		expect(a.lean.pitch).toBeGreaterThan(0.02);
		expect(neck().z).toBeGreaterThan(still.neck.z + 0.01);
		run(a, 120, 4);
		expect(Math.abs(a.lean.pitch)).toBeLessThan(0.005); // steady speed: upright
		// Turning left (heading increasing) at 4 m/s, 0.6 rad/s: the head tips left (+X).
		for (let i = 0; i < 60; i++) {
			holder.rotation.y += 0.6 * 0.016;
			a.update(0.016, 4);
		}
		expect(a.lean.roll).toBeCloseTo(Math.atan((4 * 0.6) / 9.81) * LEAN.turn, 2);
		expect(neck().x).toBeGreaterThan(0.05);
		// A hard turn stays within the limit; turning right leans right.
		for (let i = 0; i < 60; i++) {
			holder.rotation.y -= 3 * 0.016;
			a.update(0.016, 6.5);
		}
		expect(a.lean.roll).toBeCloseTo(-LEAN.maxRoll, 3);
		expect(neck().x).toBeLessThan(-0.05);
		// The pivot is the ground: the feet barely move sideways, the head does.
		expect(Math.abs(foot().x - still.foot.x)).toBeLessThan(Math.abs(neck().x) * 0.3);
		// Stopping and riding clear the lean.
		a.riding = true;
		a.update(0.016, 0);
		expect(a.lean.roll).toBe(0);
	});

	it('emotes take over, then hand the pose back; walking cancels them', () => {
		const root = skeleton();
		const a = new RealisticAnimations(root, clips(), SPEEDS);
		const e = new RealisticEmotes(a);
		for (let i = 0; i < 20; i++) a.update(0.016, 0);
		e.play('sampeah');
		expect(e.playing).toBe('sampeah');
		for (let i = 0; i < 30; i++) a.update(0.016, 0);
		expect(head(root)).toBeCloseTo(4); // Greet
		for (let i = 0; i < 200; i++) a.update(0.016, 0);
		expect(e.playing).toBeNull(); // finished after the clip
		e.play('dance');
		e.update(0.016, true);
		expect(e.playing).toBeNull();
	});

	it('pauses while riding and restores the bind pose on request', () => {
		const root = skeleton();
		const a = new RealisticAnimations(root, clips(), SPEEDS);
		const arm = root.getObjectByName('mixamorigRightArm')!;
		const rest = arm.quaternion.clone();
		a.riding = true;
		const t = a.mixer.time;
		a.update(0.5, 2);
		expect(a.mixer.time).toBe(t);
		arm.quaternion.setFromEuler(new THREE.Euler(1, 0, 0));
		a.restPose();
		expect(arm.quaternion.angleTo(rest)).toBeLessThan(1e-6);
	});

	it('carry pose brings the right hand in front of the waist', () => {
		const root = skeleton();
		const a = new RealisticAnimations(root, clips(), SPEEDS);
		for (let i = 0; i < 60; i++) a.update(0.016, 0, true);
		const hand = root.getObjectByName('mixamorigRightHand')!.getWorldPosition(new THREE.Vector3());
		expect(hand.z).toBeGreaterThan(0.15); // in front
		expect(hand.x).toBeLessThan(0); // right side (−X)
		expect(hand.y).toBeGreaterThan(0.85);
	});
});

describe('RealisticRider', () => {
	function vehicle(): VehicleInstance {
		const root = new THREE.Group();
		const lean = new THREE.Group();
		root.add(lean);
		const anchor = (x: number, y: number, z: number) => {
			const o = new THREE.Object3D();
			o.position.set(x, y, z);
			lean.add(o);
			return o;
		};
		return {
			kind: 'motorbike',
			root,
			lean,
			anchors: {
				// The motorbike GLB's anchors.
				seat: anchor(0, 0.86, -0.22),
				gripL: anchor(-0.33, 1.03, 0.44),
				gripR: anchor(0.33, 1.03, 0.44),
				pegL: anchor(-0.17, 0.32, -0.04),
				pegR: anchor(0.17, 0.32, -0.04)
			},
			setColor() {},
			pose() {},
			dispose() {}
		};
	}

	it('seats the avatar with hands on the grips and feet on the pegs', () => {
		const holder = new THREE.Group();
		const root = skeleton();
		holder.add(root);
		const a = new RealisticAnimations(root, clips(), SPEEDS);
		const v = vehicle();
		const rider = new RealisticRider(holder, a, v);
		rider.update(0.016, 0);
		const w = (name: string) => root.getObjectByName('mixamorig' + name)!.getWorldPosition(new THREE.Vector3());
		const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
		// Anatomical left (+X) takes the +X anchors.
		expect(w('LeftHand').distanceTo(at(v.anchors.gripR))).toBeLessThan(0.02);
		expect(w('RightHand').distanceTo(at(v.anchors.gripL))).toBeLessThan(0.02);
		expect(w('LeftFoot').distanceTo(at(v.anchors.pegR))).toBeLessThan(0.02);
		expect(w('RightFoot').distanceTo(at(v.anchors.pegL))).toBeLessThan(0.02);
		const hips = w('LeftUpLeg').add(w('RightUpLeg')).multiplyScalar(0.5);
		expect(hips.y - at(v.anchors.seat).y).toBeCloseTo(0.1, 2);
		rider.detach(null);
		expect(a.riding).toBe(false);
	});
});

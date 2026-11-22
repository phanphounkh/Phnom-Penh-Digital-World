import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GAIT, RATE_LIMITS, RealisticAnimations, RealisticEmotes, gaitRate, gaitState } from './RealisticAnimations';
import { RealisticRider } from '$lib/game/vehicles/RealisticRider';
import type { VehicleInstance } from '$lib/game/vehicles/VehicleModels';

const SPEEDS = { walk: 1.8, run: 3.3 };

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
function clips(): THREE.AnimationClip[] {
	const names = ['Idle', 'Walk', 'Run', 'Wave', 'Greet', 'Dance', 'Cheer', 'Sit', 'Talk'];
	const durations: Record<string, number> = { Walk: 0.95, Run: 0.7, Dance: 2, Wave: 3, Greet: 3, Cheer: 2.2 };
	return names.map((name, i) => {
		const d = durations[name] ?? 4;
		const track = new THREE.NumberKeyframeTrack('mixamorigHead.position[x]', [0, d], [i, i]);
		return new THREE.AnimationClip(name, d, [track]);
	});
}

describe('gait selection', () => {
	it('uses hysteresis around the walk/run threshold', () => {
		expect(gaitState('', 0)).toBe('idle');
		expect(gaitState('idle', 0.08)).toBe('idle');
		expect(gaitState('idle', 0.2)).toBe('walk');
		expect(gaitState('walk', 4.0)).toBe('walk');
		expect(gaitState('walk', GAIT.runAbove + 0.1)).toBe('run');
		expect(gaitState('run', 4.0)).toBe('run');
		expect(gaitState('run', GAIT.walkBelow - 0.1)).toBe('walk');
		expect(gaitState('walk', 2, true)).toBe('carry');
	});

	it('plays gait clips at the ground speed, reversed when walking backwards', () => {
		expect(gaitRate('Walk', 1.8, 1, SPEEDS)).toBeCloseTo(1);
		expect(gaitRate('Walk', 2.6, 1, SPEEDS)).toBeCloseTo(2.6 / 1.8);
		expect(gaitRate('Run', 6.5, 1, SPEEDS)).toBeCloseTo(6.5 / 3.3);
		expect(gaitRate('Run', 9, 1, SPEEDS)).toBe(RATE_LIMITS[1]);
		expect(gaitRate('Walk', 1.2, -1, SPEEDS)).toBeLessThan(0);
		expect(gaitRate('Idle', 0, 1, SPEEDS)).toBe(1);
	});
});

describe('RealisticAnimations', () => {
	const head = (root: THREE.Object3D) => root.getObjectByName('mixamorigHead')!.position.x;

	it('crossfades idle → walk → run and keeps the stride phase', () => {
		const root = skeleton();
		const a = new RealisticAnimations(root, clips(), SPEEDS);
		a.update(0.016, 0);
		expect(a.gait).toBe('idle');
		for (let i = 0; i < 30; i++) a.update(0.016, 2.6);
		expect(a.gait).toBe('walk');
		const phase = a.action('Walk')!.time / 0.95;
		a.update(0.016, 6.5);
		expect(a.gait).toBe('run');
		// Same point of the stride cycle (plus this frame's advance at the run rate).
		expect(a.action('Run')!.time / 0.7).toBeCloseTo(phase + (0.016 * (6.5 / 3.3)) / 0.7, 2);
		for (let i = 0; i < 40; i++) a.update(0.016, 6.5);
		expect(head(root)).toBeCloseTo(2); // the Run clip fully owns the pose
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

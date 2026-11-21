import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GAIT, PlayerAnimations, gaitState } from './PlayerAnimations.js';

/** The articulated pivots PlayerAnimations drives (a minimal stand-in for the Blender rig). */
function rig() {
	const model = new THREE.Group();
	const body = new THREE.Group();
	body.name = 'BodyRoot';
	model.add(body);
	for (const side of ['Left', 'Right']) {
		const leg = new THREE.Group();
		leg.name = side + 'Leg';
		body.add(leg);
		const knee = new THREE.Group();
		knee.name = side + 'Knee';
		leg.add(knee);
	}
	return model;
}

const DT = 1 / 60;
/** The clip actions by name (the JS class keeps them in an untyped object). */
const clips = (anim: PlayerAnimations) => anim.actions as Record<string, THREE.AnimationAction>;

describe('gaitState (hysteresis)', () => {
	it('picks idle, walk, run and carry as before away from the thresholds', () => {
		expect(gaitState('', 0)).toBe('idle');
		expect(gaitState('idle', 2.6)).toBe('walk');
		expect(gaitState('walk', 6.5)).toBe('run');
		expect(gaitState('run', 2.6)).toBe('walk');
		expect(gaitState('walk', 2.6, true)).toBe('carry');
		expect(gaitState('run', 0)).toBe('idle');
	});

	it('does not flicker between walk and run when the speed hovers around 4 m/s', () => {
		let state = 'walk';
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			state = gaitState(state, 4 + Math.sin(i) * 0.25);
			seen.add(state);
		}
		expect([...seen]).toEqual(['walk']);
		state = 'run';
		for (let i = 0; i < 200; i++) state = gaitState(state, 4 + Math.sin(i) * 0.25);
		expect(state).toBe('run');
	});

	it('does not flicker in and out of idle around the stop threshold', () => {
		expect(gaitState('idle', (GAIT.idleBelow + GAIT.moveAbove) / 2)).toBe('idle');
		expect(gaitState('walk', (GAIT.idleBelow + GAIT.moveAbove) / 2)).toBe('walk');
	});
});

describe('PlayerAnimations transitions', () => {
	it('keeps the stride phase when switching from walk to run (no foot pop)', () => {
		const model = rig();
		const anim = new PlayerAnimations(model);
		for (let i = 0; i < 30; i++) anim.update(DT, 2.6, false, false, null, 2.6 * DT);
		const phase = clips(anim).walk.time;
		expect(phase).toBeGreaterThan(0.2);
		expect(phase).toBeLessThan(0.9);
		anim.update(DT, 5, false, false, null, 5 * DT);
		expect(anim.state).toBe('run');
		// The run clip continues from the walk's place in the stride instead of restarting at 0.
		expect(Math.abs(clips(anim).run.time - phase)).toBeLessThan(0.1);
		anim.dispose();
	});

	it('the incoming clip puts the same foot forward as the outgoing one, whenever the switch comes', () => {
		// Left hip angle of a clip at time t (track 0 is LeftLeg.rotation[x]).
		const hipAt = (action: THREE.AnimationAction, t: number) =>
			(action.getClip().tracks[0] as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant().evaluate(t)[0] as number;
		for (const frames of [12, 20, 27, 33, 45]) {
			const anim = new PlayerAnimations(rig());
			for (let i = 0; i < frames; i++) anim.update(DT, 2.6, false, false, null, 2.6 * DT);
			const walk = clips(anim).walk;
			const out = hipAt(walk, walk.time);
			anim.update(DT, 6.5, false, false, null, 6.5 * DT);
			const run = clips(anim).run;
			const incoming = hipAt(run, run.time);
			if (Math.abs(out) > 0.1) expect(Math.sign(incoming)).toBe(Math.sign(out));
			anim.dispose();
		}
	});

	it('walks backwards with a reversed stride and still blends', () => {
		const anim = new PlayerAnimations(rig());
		for (let i = 0; i < 10; i++) anim.update(DT, 2, false, false, null, 2 * DT, -1);
		expect(clips(anim).walk.timeScale).toBeLessThan(0);
		anim.dispose();
	});

	it('still starts a step from the neutral pose after standing still', () => {
		const model = rig();
		const anim = new PlayerAnimations(model);
		for (let i = 0; i < 30; i++) anim.update(DT, 0);
		anim.update(DT, 2.6, false, false, null, 2.6 * DT);
		expect(anim.state).toBe('walk');
		expect(clips(anim).walk.time).toBeLessThan(0.05);
		anim.dispose();
	});
});

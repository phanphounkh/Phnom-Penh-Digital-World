import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { aimBone, solveTwoBone } from './ik';

/** A 3-joint chain with arbitrary bone orientations (like a Mixamo limb). */
function chain(seed: number) {
	let s = seed;
	const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
	const root = new THREE.Group();
	root.position.set(rand(), 1 + rand(), rand());
	root.quaternion.setFromEuler(new THREE.Euler(rand(), rand(), rand()));
	const upper = new THREE.Bone();
	upper.position.set(0.1, 0.2, 0);
	upper.quaternion.setFromEuler(new THREE.Euler(rand() * 2, rand() * 2, rand() * 2));
	const lower = new THREE.Bone();
	lower.position.set(0, 0.3, 0);
	lower.quaternion.setFromEuler(new THREE.Euler(rand(), rand(), rand()));
	const end = new THREE.Bone();
	end.position.set(0, 0.28, 0);
	root.add(upper);
	upper.add(lower);
	lower.add(end);
	root.updateWorldMatrix(true, true);
	return { root, upper, lower, end };
}

const world = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

describe('two-bone IK', () => {
	it('reaches targets within reach for any bone orientation', () => {
		for (let seed = 1; seed < 40; seed++) {
			const { upper, lower, end } = chain(seed * 7919);
			const A = world(upper);
			const dir = new THREE.Vector3(Math.sin(seed), Math.cos(seed * 1.3), Math.sin(seed * 0.7)).normalize();
			const target = A.clone().addScaledVector(dir, 0.2 + (seed % 5) * 0.07); // 0.2 … 0.48 < 0.58
			const pole = A.clone().add(new THREE.Vector3(0, 0, 1).cross(dir).normalize());
			solveTwoBone(upper, lower, end, target, pole);
			expect(world(end).distanceTo(target)).toBeLessThan(1e-3);
			// Bone lengths are preserved (rotations only).
			expect(world(upper).distanceTo(world(lower))).toBeCloseTo(0.3, 5);
			expect(world(lower).distanceTo(world(end))).toBeCloseTo(0.28, 5);
		}
	});

	it('bends the middle joint toward the pole', () => {
		const { upper, lower, end } = chain(42);
		const A = world(upper);
		const target = A.clone().add(new THREE.Vector3(0, -0.4, 0));
		for (const side of [1, -1]) {
			const pole = A.clone().add(new THREE.Vector3(0, -0.2, side));
			solveTwoBone(upper, lower, end, target, pole);
			expect(Math.sign(world(lower).z - A.z)).toBe(side);
		}
	});

	it('points a straight limb at out-of-reach targets', () => {
		const { upper, lower, end } = chain(5);
		const A = world(upper);
		const target = A.clone().add(new THREE.Vector3(2, 0, 0));
		solveTwoBone(upper, lower, end, target, A.clone().add(new THREE.Vector3(0, 1, 0)));
		const reach = world(end).sub(A);
		expect(reach.length()).toBeCloseTo(0.58, 2);
		expect(reach.normalize().x).toBeGreaterThan(0.999);
	});

	it('aimBone swings a carried point onto a direction', () => {
		const { upper, end } = chain(9);
		const A = world(upper);
		const goal = A.clone().add(new THREE.Vector3(0, 0, -1));
		aimBone(upper, world(end), goal);
		const d = world(end).sub(A).normalize();
		expect(d.z).toBeLessThan(-0.999);
	});
});

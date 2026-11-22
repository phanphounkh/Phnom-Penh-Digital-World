/**
 * Rig-agnostic inverse kinematics on Three.js bones (any bone orientation): aim a bone so a
 * point it carries moves toward a target, and two-bone limbs (arm/leg) that reach a target with
 * the middle joint bending toward a pole.
 */
import * as THREE from 'three';

const _o = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _wq = new THREE.Quaternion();
const _pq = new THREE.Quaternion();

/** Rotate `bone` about its own origin so the world point `from` (carried by it) swings to
 * point at `to`. Updates the bone's subtree world matrices. */
export function aimBone(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
	bone.getWorldPosition(_o);
	_a.subVectors(from, _o);
	_b.subVectors(to, _o);
	if (_a.lengthSq() < 1e-12 || _b.lengthSq() < 1e-12) return;
	_q.setFromUnitVectors(_a.normalize(), _b.normalize()); // world-space delta
	bone.getWorldQuaternion(_wq);
	if (bone.parent) bone.parent.getWorldQuaternion(_pq);
	else _pq.identity();
	bone.quaternion.copy(_pq.invert().multiply(_q).multiply(_wq));
	bone.updateWorldMatrix(false, true);
}

const _A = new THREE.Vector3();
const _B = new THREE.Vector3();
const _C = new THREE.Vector3();
const _E = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Two-bone IK: `upper` (shoulder/hip) → `lower` (elbow/knee) → `end` (wrist/ankle) reaches
 * `target` (world), bending the middle joint toward the world point `pole`. Bone lengths come
 * from the current pose; out-of-reach targets give a straight limb pointing at them.
 */
export function solveTwoBone(
	upper: THREE.Object3D,
	lower: THREE.Object3D,
	end: THREE.Object3D,
	target: THREE.Vector3,
	pole: THREE.Vector3
): void {
	upper.updateWorldMatrix(true, true);
	upper.getWorldPosition(_A);
	lower.getWorldPosition(_B);
	end.getWorldPosition(_C);
	const l1 = _A.distanceTo(_B);
	const l2 = _B.distanceTo(_C);
	_d.subVectors(target, _A);
	const dist = THREE.MathUtils.clamp(_d.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
	_d.normalize();
	// Elbow: along the reach by `a`, then out toward the pole by `h` (law of cosines).
	const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
	const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
	_p.subVectors(pole, _A);
	_p.addScaledVector(_d, -_p.dot(_d));
	if (_p.lengthSq() < 1e-10) _p.set(0, 1, 0).addScaledVector(_d, -_d.y);
	_p.normalize();
	_E.copy(_A).addScaledVector(_d, a).addScaledVector(_p, h);
	aimBone(upper, _B, _E);
	end.getWorldPosition(_C);
	_E.copy(_A).addScaledVector(_d, dist); // where the end must go (clamped reach)
	aimBone(lower, _C, _E);
}

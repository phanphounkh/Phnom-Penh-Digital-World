/**
 * Vehicle models (tools/blender/generate_vehicle_assets.py): one cached GLB per kind, cloned
 * per vehicle. `Paint`/`PaintDark` are recoloured per vehicle; lights are shared and glow at
 * night. Wheels spin with the distance travelled, the `Steer` node turns the bars and front
 * wheel, and the whole vehicle leans into turns (with its rider).
 */
import * as THREE from 'three';
import { loadGLTF } from '$lib/game/city/props';
import { HANDLING, type VehicleKind } from './specs';

export const VEHICLE_URL: Record<VehicleKind, string> = {
	bicycle: '/models/vehicles/bicycle.glb',
	motorbike: '/models/vehicles/motorbike.glb'
};

export interface Anchors {
	seat: THREE.Object3D;
	gripL: THREE.Object3D;
	gripR: THREE.Object3D;
	pegL: THREE.Object3D;
	pegR: THREE.Object3D;
	crank?: THREE.Object3D;
}

export interface VehicleInstance {
	kind: VehicleKind;
	/** Placed at ground level and turned to the heading by the owner. */
	root: THREE.Group;
	/** Child of root: leans (rotation.z) with the rider. */
	lean: THREE.Group;
	anchors: Anchors;
	setColor(color: string): void;
	/** Wheel rotation (rad), steering angle (+ right), lean (+ right). */
	pose(wheel: number, steer: number, lean: number): void;
	dispose(): void;
}

const shared = new Set<THREE.MeshStandardMaterial>();

/** Headlights and tail lights glow with the night factor (0 day … 1 night). */
export function setVehicleNight(night: number): void {
	for (const m of shared) {
		if (m.name === 'Light') m.emissiveIntensity = 0.4 + 3.5 * night;
		else if (m.name === 'TailLight') m.emissiveIntensity = 0.3 + 1.6 * night;
	}
}

async function source(kind: VehicleKind): Promise<THREE.Group> {
	const scene = await loadGLTF(VEHICLE_URL[kind]);
	scene.traverse((n) => {
		const mesh = n as THREE.Mesh;
		if (!mesh.isMesh) return;
		mesh.castShadow = false; // a contact blob is cheaper than the shadow cache
		mesh.receiveShadow = false;
		const m = mesh.material as THREE.MeshStandardMaterial;
		if (m.name === 'Light' || m.name === 'TailLight') {
			m.emissive.copy(m.color);
			shared.add(m);
		}
	});
	return scene;
}

export async function createVehicle(kind: VehicleKind, color: string): Promise<VehicleInstance> {
	const model = (await source(kind)).clone(true);
	const root = new THREE.Group();
	root.name = `vehicle:${kind}`;
	const lean = new THREE.Group();
	root.add(lean);
	lean.add(model);
	const paints: THREE.MeshStandardMaterial[] = [];
	model.traverse((n) => {
		const mesh = n as THREE.Mesh;
		if (!mesh.isMesh) return;
		const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
		const own = mats.map((m) => {
			if (m.name !== 'Paint' && m.name !== 'PaintDark') return m;
			const copy = (m as THREE.MeshStandardMaterial).clone();
			paints.push(copy);
			return copy;
		});
		mesh.material = Array.isArray(mesh.material) ? own : own[0];
	});
	const get = (name: string) => {
		const node = model.getObjectByName(name);
		if (!node) throw new Error(`${kind} model has no ${name}`);
		return node;
	};
	const steer = get('Steer');
	const wheels = [get('WheelFront'), get('WheelRear')];
	const anchors: Anchors = {
		seat: get('Seat'),
		gripL: get('GripL'),
		gripR: get('GripR'),
		pegL: get('PegL'),
		pegR: get('PegR'),
		crank: model.getObjectByName('Crank') ?? undefined
	};
	const setColor = (c: string) => {
		const base = new THREE.Color(c);
		for (const m of paints) m.color.copy(m.name === 'PaintDark' ? base.clone().multiplyScalar(0.45) : base);
	};
	setColor(color);
	const maxSteer = HANDLING[kind].maxSteer;
	return {
		kind,
		root,
		lean,
		anchors,
		setColor,
		pose(wheel, steerAngle, leanAngle) {
			for (const w of wheels) w.rotation.x = wheel;
			// Steering right turns the front towards -X (the rider's right when facing +Z).
			steer.rotation.y = -Math.max(-maxSteer, Math.min(maxSteer, steerAngle));
			lean.rotation.z = leanAngle;
		},
		dispose() {
			paints.forEach((m) => m.dispose());
			root.removeFromParent();
		}
	};
}

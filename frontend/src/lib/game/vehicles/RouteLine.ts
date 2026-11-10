/**
 * The route drawn in the world: a translucent ribbon along the lane to follow, with chevrons
 * pointing the way, slightly above the street (it follows Wat Phnom's hill), and a beacon at
 * the destination. One draw call for the ribbon, one for the beacon.
 */
import * as THREE from 'three';
import type { XZ } from '$lib/api/types';
import type { Terrain } from '$lib/game/city/terrain';

const WIDTH = 1.1;
const LIFT = 0.12;

function chevronTexture(): THREE.CanvasTexture {
	const c = document.createElement('canvas');
	c.width = 64;
	c.height = 128;
	const g = c.getContext('2d')!;
	g.fillStyle = 'rgba(232,163,61,0.55)';
	g.fillRect(0, 0, 64, 128);
	g.strokeStyle = 'rgba(255,248,230,0.95)';
	g.lineWidth = 12;
	g.lineCap = 'round';
	g.lineJoin = 'round';
	g.beginPath();
	g.moveTo(12, 84);
	g.lineTo(32, 52);
	g.lineTo(52, 84);
	g.stroke();
	const t = new THREE.CanvasTexture(c);
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.colorSpace = THREE.SRGBColorSpace;
	return t;
}

export class RouteLine {
	readonly group = new THREE.Group();
	private texture = chevronTexture();
	private material = new THREE.MeshBasicMaterial({
		map: this.texture,
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
		fog: true
	});
	private ribbon: THREE.Mesh | null = null;
	private beacon: THREE.Mesh;

	constructor(private terrain: Terrain) {
		this.group.name = 'route';
		this.group.renderOrder = 5;
		this.beacon = new THREE.Mesh(
			new THREE.CylinderGeometry(0.5, 0.5, 30, 16, 1, true),
			new THREE.MeshBasicMaterial({ color: '#e8a33d', transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide })
		);
		this.beacon.visible = false;
		this.group.add(this.beacon);
	}

	set(points: XZ[] | null, destination?: XZ): void {
		if (this.ribbon) {
			this.ribbon.geometry.dispose();
			this.ribbon.removeFromParent();
			this.ribbon = null;
		}
		this.beacon.visible = false;
		if (!points || points.length < 2) return;
		const positions: number[] = [],
			uvs: number[] = [],
			index: number[] = [];
		let v = 0;
		for (let i = 0; i < points.length; i++) {
			const prev = points[Math.max(0, i - 1)],
				next = points[Math.min(points.length - 1, i + 1)];
			let dx = next[0] - prev[0],
				dz = next[1] - prev[1];
			const len = Math.hypot(dx, dz) || 1;
			dx /= len;
			dz /= len;
			const [x, z] = points[i];
			if (i > 0) v += Math.hypot(x - points[i - 1][0], z - points[i - 1][1]) / (WIDTH * 2);
			for (const side of [-1, 1]) {
				const px = x - dz * side * (WIDTH / 2),
					pz = z + dx * side * (WIDTH / 2);
				positions.push(px, this.terrain.height(px, pz) + LIFT, pz);
				uvs.push(side < 0 ? 0 : 1, v); // +v = direction of travel (the chevrons point up the texture)
			}
			if (i > 0) {
				const a = (i - 1) * 2;
				index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
			}
		}
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
		geometry.setIndex(index);
		this.ribbon = new THREE.Mesh(geometry, this.material);
		this.ribbon.renderOrder = 5;
		this.group.add(this.ribbon);
		const end = destination ?? points[points.length - 1];
		this.beacon.position.set(end[0], this.terrain.height(end[0], end[1]) + 15, end[1]);
		this.beacon.visible = true;
	}

	/** Chevrons drift forward so the direction reads at a glance. */
	update(dt: number): void {
		this.texture.offset.y -= dt * 0.6;
	}

	dispose(): void {
		this.set(null);
		this.texture.dispose();
		this.material.dispose();
		this.beacon.geometry.dispose();
		(this.beacon.material as THREE.Material).dispose();
		this.group.removeFromParent();
	}
}

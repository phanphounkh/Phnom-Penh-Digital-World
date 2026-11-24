import * as THREE from 'three';
import type { ChunkManager } from './ChunkManager';

/** Fixed light budget: the nearest four lamp heads light people, bark and paving. */
export class StreetLighting {
	private lights = Array.from({ length: 4 }, () => new THREE.PointLight('#ffd18b', 0, 24, 2));
	private version = -1;
	private positions: THREE.Vector3[] = [];
	private timer = 1;
	constructor(scene: THREE.Scene, private chunks: ChunkManager) { this.lights.forEach(l => l.visible = false); scene.add(...this.lights); }
	update(dt: number, x: number, z: number, night: number, enabled: boolean, limit = 4) {
		this.timer += dt;
		if (this.timer < .35) return;
		this.timer = 0;
		if (this.version !== this.chunks.version) {
			this.version = this.chunks.version;
			this.positions = this.chunks.lampPositions();
		}
		const nearby = enabled && night > .02 ? this.positions
			.map(p => ({ p, d: (p.x-x)**2+(p.z-z)**2 }))
			.filter(c => c.d < 32**2).sort((a,b) => a.d-b.d).slice(0,Math.max(0,Math.min(4,Math.floor(limit)))) : [];
		this.lights.forEach((light,i) => {
			const candidate = nearby[i];
			light.visible = !!candidate;
			light.intensity = candidate ? 70 * night * (1-THREE.MathUtils.smoothstep(Math.sqrt(candidate.d),24,32)) : 0;
			if(candidate) light.position.copy(candidate.p);
		});
	}
	dispose() { this.lights.forEach(l => { l.removeFromParent(); l.dispose(); }); }
}

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FOLIAGE_FADE, FOLIAGE_MATERIALS, FoliageFade, bayer4, foliageFadeAt, patchFoliageShader } from './foliageFade';
import { PropMaterials } from './props';

// Camera 7.5 m behind and above a player whose head is at (0, 1.55, 0).
const camera = { x: 0, y: 4.3, z: 7 };
const head = { x: 0, y: 1.55, z: 0 };

describe('foliageFadeAt (camera → player cone)', () => {
	it('fades a canopy standing between the camera and the player', () => {
		const between = { x: 0, y: 3.2, z: 3 };
		expect(foliageFadeAt(between, camera, head)).toBeCloseTo(FOLIAGE_FADE.maxFade, 5);
	});

	it('leaves canopies beside the line of sight and behind the player alone', () => {
		expect(foliageFadeAt({ x: 6, y: 4, z: 3 }, camera, head)).toBe(0);
		expect(foliageFadeAt({ x: 0, y: 5, z: -6 }, camera, head)).toBe(0);
	});

	it('is wider near the lens than at the player (leaves by the lens fill the screen)', () => {
		const nearCam = { x: 2.0, y: camera.y, z: camera.z - 0.3 };
		const nearHead = { x: 2.0, y: head.y, z: head.z + 0.3 };
		expect(foliageFadeAt(nearCam, camera, head)).toBeGreaterThan(0);
		expect(foliageFadeAt(nearHead, camera, head)).toBe(0);
	});

	it('falls off smoothly at the edge of the cone (no popping)', () => {
		let previous = foliageFadeAt({ x: 0, y: 3, z: 3.5 }, camera, head);
		expect(previous).toBeGreaterThan(0.5);
		for (let x = 0; x <= 3; x += 0.05) {
			const f = foliageFadeAt({ x, y: 3, z: 3.5 }, camera, head);
			expect(f).toBeLessThanOrEqual(previous + 1e-9);
			expect(previous - f).toBeLessThan(0.2);
			previous = f;
		}
		expect(previous).toBe(0);
	});
});

describe('ordered dither', () => {
	it('gives the 16 thresholds 0, 1/16 … 15/16 across a 4×4 tile', () => {
		const values = new Set<number>();
		for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) values.add(Math.round(bayer4(x + 0.5, y + 0.5) * 16));
		expect([...values].sort((a, b) => a - b)).toEqual([...Array(16).keys()]);
	});

	it('never discards an unfaded leaf and keeps a ghost of a fully faded one', () => {
		const thresholds: number[] = [];
		for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) thresholds.push(bayer4(x + 0.5, y + 0.5));
		expect(thresholds.filter((b) => 0 > b).length).toBe(0); // shader: discard if fade > threshold
		const kept = thresholds.filter((b) => !(FOLIAGE_FADE.maxFade > b)).length;
		expect(kept).toBeGreaterThanOrEqual(2);
		expect(kept).toBeLessThanOrEqual(4);
	});
});

describe('shader patch', () => {
	const fresh = () => ({
		vertexShader: THREE.ShaderLib.standard.vertexShader,
		fragmentShader: THREE.ShaderLib.standard.fragmentShader,
		uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms)
	});

	it('injects the fade into the standard (PBR) shader of this three.js version', () => {
		const fade = new FoliageFade();
		const shader = fresh();
		patchFoliageShader(shader, fade.uniforms);
		expect(shader.vertexShader).toContain('vPpwFadeWorld = ( modelMatrix * ppwFadeWorld ).xyz;');
		expect(shader.vertexShader).toContain('instanceMatrix * ppwFadeWorld');
		expect(shader.fragmentShader).toContain('discard;');
		// The fade runs after the declarations it needs and before any lighting work.
		const fs = shader.fragmentShader;
		expect(fs.indexOf('uniform vec3 ppwFadeFrom;')).toBeLessThan(fs.indexOf('void main()'));
		expect(fs.indexOf('ppwFoliageFade( vPpwFadeWorld )')).toBeLessThan(fs.indexOf('#include <lights_fragment_begin>'));
		// The uniforms are the shared objects (one update moves every leaf material).
		expect(shader.uniforms.ppwFadeFrom).toBe(fade.uniforms.ppwFadeFrom);
	});

	it('fails loudly when a three.js upgrade moves the anchors', () => {
		const shader = { ...fresh(), fragmentShader: 'void main() {}' };
		expect(() => patchFoliageShader(shader, new FoliageFade().uniforms)).toThrow(/anchor/);
	});

	it('patches only the leaf materials, and the uniforms follow the camera', () => {
		const materials = new PropMaterials();
		for (const name of [...FOLIAGE_MATERIALS, 'Bark', 'Metal', 'Lamp']) {
			const m = new THREE.MeshStandardMaterial();
			m.name = name;
			materials.adopt(m);
		}
		const fade = new FoliageFade();
		fade.apply(materials);
		fade.apply(materials); // idempotent
		expect(fade.patched.map((m) => m.name).sort()).toEqual([...FOLIAGE_MATERIALS].sort());
		expect(materials.byName.get('Bark')!.customProgramCacheKey()).not.toBe('ppw-foliage-fade');
		const shader = fresh();
		fade.patched[0].onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
		expect(shader.fragmentShader).toContain('ppwFoliageFade');

		fade.setView(camera, head);
		expect(fade.uniforms.ppwFadeFrom.value.toArray()).toEqual([camera.x, camera.y, camera.z]);
		expect(fade.fadeAt({ x: 0, y: 3.2, z: 3 })).toBeGreaterThan(0.5);
		fade.enabled = false;
		expect(fade.uniforms.ppwFadeShape.value.w).toBe(0);
		expect(fade.fadeAt({ x: 0, y: 3.2, z: 3 })).toBe(0);

		fade.dispose();
		expect(fade.patched.length).toBe(0);
		expect(materials.byName.get('Leaves')!.customProgramCacheKey()).not.toBe('ppw-foliage-fade');
	});
});

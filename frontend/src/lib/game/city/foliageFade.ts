/**
 * See-through tree canopies for the third-person camera.
 *
 * Trees only block walking (their colliders have no height), so the camera never pulls in for
 * them and a rain-tree canopy (≈ 4–8 m up, right at camera height) could hide the avatar.
 * Instead, the shared Blender leaf materials are patched so that leaves inside a cone between
 * the camera and the player are dithered away (ordered 4×4 screen-door). Everything else stays
 * the same: the materials remain opaque (no sorting), trunks stay solid, the cached shadow map
 * uses its own depth material (shadows keep their full canopy) and collision is untouched.
 * The cost is two shared uniforms per frame plus a few ALU ops per leaf fragment.
 */
import * as THREE from 'three';
import type { PropMaterials } from './props';

/** Blender material names used only by tree canopies (tree-rain, tree-slender, tree-palm). */
export const FOLIAGE_MATERIALS = ['Leaves', 'LeavesLight', 'PalmLeaves'] as const;

export interface FoliageFadeShape {
	/** Cone radius at the camera end (m): wide, because leaves near the lens fill the screen. */
	camRadius: number;
	/** Cone radius at the player's head (m). */
	focusRadius: number;
	/** Soft edge of the cone (m). */
	feather: number;
	/** Strongest fade (0–1); a sparse ghost of the canopy stays visible for orientation. */
	maxFade: number;
}

export const FOLIAGE_FADE: FoliageFadeShape = { camRadius: 2.6, focusRadius: 0.9, feather: 0.9, maxFade: 0.8 };

type V3 = { x: number; y: number; z: number };

const smoothstep = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/**
 * How strongly a leaf at `p` is faded (0 = drawn normally, `maxFade` = mostly see-through) for a
 * camera at `from` looking at `to`. CPU mirror of the GLSL below (tests and diagnostics).
 */
export function foliageFadeAt(p: V3, from: V3, to: V3, shape: FoliageFadeShape = FOLIAGE_FADE): number {
	const abx = to.x - from.x,
		aby = to.y - from.y,
		abz = to.z - from.z;
	const len2 = Math.max(abx * abx + aby * aby + abz * abz, 1e-4);
	const t = Math.min(1, Math.max(0, ((p.x - from.x) * abx + (p.y - from.y) * aby + (p.z - from.z) * abz) / len2));
	const d = Math.hypot(p.x - (from.x + abx * t), p.y - (from.y + aby * t), p.z - (from.z + abz * t));
	const r = shape.camRadius + (shape.focusRadius - shape.camRadius) * t;
	return shape.maxFade * (1 - smoothstep(r - shape.feather, r, d));
}

/** 4×4 ordered-dither threshold in [0, 1) for a pixel (same formula as the shader). */
export function bayer4(x: number, y: number): number {
	const b2 = (ax: number, ay: number) => {
		const fx = Math.floor(ax),
			fy = Math.floor(ay);
		const v = fx * 0.5 + fy * fy * 0.75;
		return v - Math.floor(v);
	};
	return b2(x * 0.5, y * 0.5) * 0.25 + b2(x, y);
}

const VERTEX_DECL = /* glsl */ `
varying vec3 vPpwFadeWorld;`;

const VERTEX_BODY = /* glsl */ `
	vec4 ppwFadeWorld = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		ppwFadeWorld = batchingMatrix * ppwFadeWorld;
	#endif
	#ifdef USE_INSTANCING
		ppwFadeWorld = instanceMatrix * ppwFadeWorld;
	#endif
	vPpwFadeWorld = ( modelMatrix * ppwFadeWorld ).xyz;`;

const FRAGMENT_DECL = /* glsl */ `
uniform vec3 ppwFadeFrom;
uniform vec3 ppwFadeTo;
uniform vec4 ppwFadeShape; // camRadius, focusRadius, feather, maxFade
varying vec3 vPpwFadeWorld;
float ppwBayer2( vec2 a ) { a = floor( a ); return fract( a.x * 0.5 + a.y * a.y * 0.75 ); }
float ppwBayer4( vec2 a ) { return ppwBayer2( 0.5 * a ) * 0.25 + ppwBayer2( a ); }
float ppwFoliageFade( vec3 p ) {
	vec3 ab = ppwFadeTo - ppwFadeFrom;
	float t = clamp( dot( p - ppwFadeFrom, ab ) / max( dot( ab, ab ), 1e-4 ), 0.0, 1.0 );
	float d = length( p - ( ppwFadeFrom + ab * t ) );
	float r = mix( ppwFadeShape.x, ppwFadeShape.y, t );
	return ppwFadeShape.w * ( 1.0 - smoothstep( r - ppwFadeShape.z, r, d ) );
}`;

const FRAGMENT_BODY = /* glsl */ `
	if ( ppwFoliageFade( vPpwFadeWorld ) > ppwBayer4( gl_FragCoord.xy ) ) discard;`;

export interface FadeUniforms {
	ppwFadeFrom: { value: THREE.Vector3 };
	ppwFadeTo: { value: THREE.Vector3 };
	ppwFadeShape: { value: THREE.Vector4 };
}

/** Insert `code` after `anchor` in `source`; throws if the anchor is missing (three.js upgrade). */
function inject(source: string, anchor: string, code: string): string {
	if (!source.includes(anchor)) throw new Error(`foliage fade: shader anchor ${anchor} not found`);
	return source.replace(anchor, `${anchor}${code}`);
}

/** Patch a MeshStandardMaterial shader (as given to onBeforeCompile) with the canopy fade. */
export function patchFoliageShader(
	shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> },
	uniforms: FadeUniforms
): void {
	shader.vertexShader = inject(shader.vertexShader, '#include <common>', VERTEX_DECL);
	shader.vertexShader = inject(shader.vertexShader, '#include <project_vertex>', VERTEX_BODY);
	shader.fragmentShader = inject(shader.fragmentShader, '#include <common>', FRAGMENT_DECL);
	shader.fragmentShader = inject(shader.fragmentShader, '#include <clipping_planes_fragment>', FRAGMENT_BODY);
	Object.assign(shader.uniforms, uniforms);
}

export class FoliageFade {
	readonly uniforms: FadeUniforms = {
		ppwFadeFrom: { value: new THREE.Vector3() },
		ppwFadeTo: { value: new THREE.Vector3() },
		ppwFadeShape: { value: new THREE.Vector4() }
	};
	/** Materials patched by `apply` (diagnostics and tests). */
	readonly patched: THREE.Material[] = [];
	private shape: FoliageFadeShape;
	private on = true;

	constructor(shape: FoliageFadeShape = FOLIAGE_FADE) {
		this.shape = { ...shape };
		this.writeShape();
	}

	/** Patch the shared leaf materials of the prop library (call once, after it has loaded). */
	apply(materials: PropMaterials): void {
		for (const name of FOLIAGE_MATERIALS) {
			const material = materials.byName.get(name);
			if (!material || this.patched.includes(material)) continue;
			material.onBeforeCompile = (shader) => patchFoliageShader(shader, this.uniforms);
			material.customProgramCacheKey = () => 'ppw-foliage-fade';
			material.needsUpdate = true;
			this.patched.push(material);
		}
	}

	/** Where the camera is and what it looks at (the player's head); call every frame. */
	setView(camera: V3, focus: V3): void {
		this.uniforms.ppwFadeFrom.value.set(camera.x, camera.y, camera.z);
		this.uniforms.ppwFadeTo.value.set(focus.x, focus.y, focus.z);
	}

	get enabled(): boolean {
		return this.on;
	}

	/** Off: every leaf is drawn (the shader keeps running with a zero fade). */
	set enabled(on: boolean) {
		this.on = on;
		this.writeShape();
	}

	/** The fade (0–maxFade) the shader applies at world point `p` right now. */
	fadeAt(p: V3): number {
		if (!this.on) return 0;
		return foliageFadeAt(p, this.uniforms.ppwFadeFrom.value, this.uniforms.ppwFadeTo.value, this.shape);
	}

	private writeShape() {
		const s = this.shape;
		this.uniforms.ppwFadeShape.value.set(s.camRadius, s.focusRadius, s.feather, this.on ? s.maxFade : 0);
	}

	dispose(): void {
		for (const material of this.patched) {
			material.onBeforeCompile = THREE.Material.prototype.onBeforeCompile;
			material.customProgramCacheKey = THREE.Material.prototype.customProgramCacheKey;
			material.needsUpdate = true;
		}
		this.patched.length = 0;
	}
}

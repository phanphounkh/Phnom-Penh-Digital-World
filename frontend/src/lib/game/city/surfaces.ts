/**
 * Procedural surface detail for the city's flat-colour materials, computed in the fragment
 * shader from world position, so it needs no textures, UVs or extra geometry:
 *
 * - paving / plaza: stone tiles with grout and per-tile tint; sidewalk: smaller pavers and a
 *   concrete kerb along the road edge (ribbons carry `uv` = across/along metres, `band` = width);
 * - asphalt: grain, stains and patched areas, darker gutters with drain grates at the kerb;
 * - grass / park: patchy greens and dry tones; terrain and the ground plane: soil variation;
 * - water: animated ripples that perturb the normal (glints with the sky environment map);
 * - foliage (instanced trees and shrubs): a stable per-tree tint so rows of trees differ.
 *
 * Detail fades out with screen-space derivatives (no shimmering in the distance). Each kind adds
 * one MeshStandardMaterial variant; cost is a few noise lookups per fragment.
 */
import type * as THREE from 'three';

export type SurfaceKind = 'paving' | 'plaza' | 'sidewalk' | 'asphalt' | 'grass' | 'water' | 'soil' | 'ground';

const COMMON = /* glsl */ `
varying vec3 vPpwW;
varying vec3 vPpwBand;
float ppwH(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
float ppwN(vec2 p) {
	vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
	return mix(mix(ppwH(i), ppwH(i + vec2(1.0, 0.0)), u.x), mix(ppwH(i + vec2(0.0, 1.0)), ppwH(i + vec2(1.0, 1.0)), u.x), u.y);
}
float ppwFbm(vec2 p) { return ppwN(p) * 0.5 + ppwN(p * 2.03 + 7.1) * 0.3 + ppwN(p * 4.07 + 3.7) * 0.2; }
/** 1 near the camera, 0 where a feature of size s would be smaller than ~2 pixels. */
float ppwFade(float s) { return 1.0 - smoothstep(0.25, 0.7, length(fwidth(vPpwW.xz)) / s); }
/** Grout mask for square tiles of size s (1 on grout lines). */
float ppwGrout(vec2 p, float s, float w) {
	vec2 g = abs(fract(p / s) - 0.5) * 2.0;
	return smoothstep(1.0 - w / s * 2.0, 1.0, max(g.x, g.y)) * ppwFade(s * 0.5);
}
`;

const DETAIL: Record<SurfaceKind, string> = {
	paving: /* glsl */ `
	{
		vec2 p = vPpwW.xz;
		vec2 tile = floor(p / 0.6);
		float t = ppwH(tile) - 0.5;
		diffuseColor.rgb *= 1.0 + t * 0.12 * ppwFade(0.6) + (ppwFbm(p * 0.35) - 0.5) * 0.16;
		diffuseColor.rgb *= 1.0 - 0.28 * ppwGrout(p, 0.6, 0.025);
	}`,
	plaza: /* glsl */ `
	{
		vec2 p = vPpwW.xz;
		vec2 q = vec2(p.x + step(1.0, mod(floor(p.y / 0.5), 2.0)) * 0.5, p.y); // running bond
		float t = ppwH(floor(q / vec2(1.0, 0.5))) - 0.5;
		diffuseColor.rgb *= 1.0 + t * 0.1 * ppwFade(0.5) + (ppwFbm(p * 0.25) - 0.5) * 0.14;
		vec2 g = abs(fract(q / vec2(1.0, 0.5)) - 0.5) * 2.0;
		float grout = max(smoothstep(0.96, 1.0, g.x), smoothstep(0.92, 1.0, g.y)) * ppwFade(0.25);
		diffuseColor.rgb *= 1.0 - 0.25 * grout;
	}`,
	sidewalk: /* glsl */ `
	{
		vec2 p = vPpwW.xz;
		float t = ppwH(floor(p / 0.4)) - 0.5;
		diffuseColor.rgb *= 1.0 + t * 0.1 * ppwFade(0.4) + (ppwFbm(p * 0.5) - 0.5) * 0.14;
		diffuseColor.rgb *= 1.0 - 0.22 * ppwGrout(p, 0.4, 0.02);
		// Kerb: the strip of sidewalk next to the carriageway (1.6 m in from the outer edge).
		float edge = min(vPpwBand.x, vPpwBand.z - vPpwBand.x);
		float kerb = smoothstep(1.32, 1.36, edge) * (1.0 - smoothstep(1.56, 1.6, edge));
		diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.78, 0.74) * (0.95 + 0.1 * ppwN(p * 3.0)), kerb * 0.85);
	}`,
	asphalt: /* glsl */ `
	{
		vec2 p = vPpwW.xz;
		float grain = (ppwN(p * 9.0) - 0.5) * 0.10 * ppwFade(0.12);
		float stains = (ppwFbm(p * 0.18) - 0.5) * 0.22;
		float patches = smoothstep(0.62, 0.66, ppwN(p * 0.07 + 3.3)) * 0.07;
		diffuseColor.rgb *= 1.0 + grain + stains - patches;
		// Gutter and drain grates along both kerbs.
		float edge = min(vPpwBand.x, vPpwBand.z - vPpwBand.x);
		if (vPpwBand.z > 5.0) {
			diffuseColor.rgb *= 1.0 - 0.18 * (1.0 - smoothstep(0.25, 0.45, edge));
			float grate = step(edge, 0.4) * step(fract(vPpwBand.y / 14.0), 0.045);
			float bars = step(0.5, fract(vPpwBand.y * 6.0));
			diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.13) * (0.7 + 0.6 * bars), grate * ppwFade(0.1));
		}
	}`,
	grass: /* glsl */ `
	{
		vec2 p = vPpwW.xz;
		float a = ppwFbm(p * 0.09), b = ppwFbm(p * 0.6 + 11.0), c = ppwN(p * 5.0);
		vec3 dry = vec3(1.12, 1.06, 0.72), lush = vec3(0.82, 0.95, 0.78);
		diffuseColor.rgb *= mix(lush, dry, smoothstep(0.42, 0.75, a)) * (0.9 + 0.2 * b);
		diffuseColor.rgb *= 1.0 + (c - 0.5) * 0.12 * ppwFade(0.2);
	}`,
	// Land with no mapped surface (the ground plane): patches of packed earth, dry and green
	// grass at 30–60 m scale, with fine grain. Absolute colours (the plane is white).
	ground: /* glsl */ `
	{
		vec2 p = vPpwW.xz;
		float a = ppwFbm(p * 0.018), b = ppwFbm(p * 0.07 + 5.0), c = ppwN(p * 1.7), d = ppwN(p * 6.0);
		vec3 earth = vec3(0.30, 0.25, 0.17), dry = vec3(0.29, 0.28, 0.13), lush = vec3(0.13, 0.22, 0.07);
		float grassy = smoothstep(0.38, 0.62, a + (b - 0.5) * 0.35);
		vec3 col = mix(earth, mix(lush, dry, smoothstep(0.35, 0.75, b)), grassy);
		col *= 0.88 + 0.2 * c + (d - 0.5) * 0.1 * ppwFade(0.15);
		diffuseColor.rgb = col;
	}`,
	soil: /* glsl */ `
	{
		vec2 p = vPpwW.xz;
		diffuseColor.rgb *= 0.9 + 0.2 * ppwFbm(p * 0.05) + (ppwN(p * 2.0) - 0.5) * 0.08 * ppwFade(0.5);
	}`,
	water: /* glsl */ `
	{
		vec2 p = vPpwW.xz;
		diffuseColor.rgb *= 0.88 + 0.24 * ppwFbm(p * 0.03 + vec2(uPpwTime * 0.01, 0.0));
	}`
};

/** Water: ripple normal in world space, rotated into view space for lighting. */
const WATER_NORMAL = /* glsl */ `
{
	vec2 p = vPpwW.xz;
	float t = uPpwTime;
	vec2 g = vec2(0.0);
	g += vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 1.3 + t * 1.1) * 0.6;
	g += vec2(-0.5, 0.86) * cos(dot(p, vec2(-0.5, 0.86)) * 2.1 + t * 1.7) * 0.35;
	g += vec2(0.97, -0.24) * cos(dot(p, vec2(0.97, -0.24)) * 3.7 + t * 2.3) * 0.2;
	g *= 0.06 * ppwFade(1.5);
	vec3 nw = normalize(vec3(-g.x, 1.0, -g.y));
	normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
}
`;

export interface SurfaceUniforms {
	time: { value: number };
	/** 1 = procedural detail on (Quality), 0 = flat colours (Performance: near-zero cost). */
	detail: { value: number };
}

const KINDS: SurfaceKind[] = ['paving', 'plaza', 'sidewalk', 'asphalt', 'grass', 'water', 'soil', 'ground'];

/** All surface kinds in one shader: one program for every surface material (fast start-up,
 * especially without a GPU), the kind chosen by a uniform (a uniform branch costs ~nothing). */
const SURFACE_FRAGMENT = KINDS.map((k, i) => `${i ? 'else ' : ''}if (uPpwKind == ${i}) ${DETAIL[k].trim()}`).join('\n');

/** Add world-space detail of `kind` to a city material (chained with any onBeforeCompile). */
export function addSurfaceDetail(material: THREE.MeshStandardMaterial, kind: SurfaceKind, uniforms: SurfaceUniforms): void {
	const previous = material.onBeforeCompile.bind(material);
	const kindUniform = { value: KINDS.indexOf(kind) };
	material.onBeforeCompile = (shader, renderer) => {
		previous(shader, renderer);
		shader.uniforms.uPpwTime = uniforms.time;
		shader.uniforms.uPpwKind = kindUniform;
		shader.uniforms.uPpwDetail = uniforms.detail;
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nattribute float band;\nvarying vec3 vPpwW;\nvarying vec3 vPpwBand;')
			.replace(
				'#include <worldpos_vertex>',
				`#include <worldpos_vertex>
vPpwW = (modelMatrix * vec4(transformed, 1.0)).xyz;
vPpwBand = vec3(uv, band); // ribbons: across/along metres and width (0 where absent)`
			);
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', `#include <common>\nuniform float uPpwTime;\nuniform int uPpwKind;\nuniform float uPpwDetail;\n${COMMON}`)
			.replace(
				'#include <map_fragment>',
				// The ground plane is white: without detail it takes a plain earth colour.
				`#include <map_fragment>\nif (uPpwDetail > 0.5) {\n${SURFACE_FRAGMENT}\n} else if (uPpwKind == ${KINDS.indexOf('ground')}) diffuseColor.rgb = vec3(0.26, 0.24, 0.15);`
			)
			.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\nif (uPpwDetail > 0.5 && uPpwKind == ${KINDS.indexOf('water')}) ${WATER_NORMAL.trim()}`);
	};
	const key = material.customProgramCacheKey.bind(material);
	material.customProgramCacheKey = () => `${key()}|ppw-surface`;
	material.needsUpdate = true;
}

/** Per-tree tint for instanced foliage (stable: hashed from the instance position). */
export function addFoliageVariation(material: THREE.MeshStandardMaterial): void {
	if (material.userData.ppwFoliage) return;
	material.userData.ppwFoliage = true;
	const previous = material.onBeforeCompile.bind(material);
	material.onBeforeCompile = (shader, renderer) => {
		previous(shader, renderer);
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nvarying float vPpwTint;')
			.replace(
				'#include <begin_vertex>',
				`#include <begin_vertex>
#ifdef USE_INSTANCING
vec2 ppwT = instanceMatrix[3].xz;
#else
vec2 ppwT = modelMatrix[3].xz;
#endif
vPpwTint = fract(sin(dot(floor(ppwT * 3.0), vec2(12.9898, 78.233))) * 43758.5453);`
			);
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', '#include <common>\nvarying float vPpwTint;')
			.replace(
				'#include <map_fragment>',
				`#include <map_fragment>
diffuseColor.rgb *= mix(vec3(0.86, 0.94, 0.80), vec3(1.10, 1.06, 0.86), vPpwTint);`
			);
	};
	const key = material.customProgramCacheKey.bind(material);
	material.customProgramCacheKey = () => `${key()}|ppw-foliage-tint`;
	material.needsUpdate = true;
}

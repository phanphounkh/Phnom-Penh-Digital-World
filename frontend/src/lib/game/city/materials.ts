/**
 * Shared city materials (main thread: they use canvas textures).
 *
 * The facade material is a MeshStandardMaterial extended with a small shader:
 *  - walls are tiled with 4 m × 3.3 m bays from an atlas: four window styles (modern, colonial
 *    shutters, balconies, sun louvres with AC units) and two shopfronts (open shop, café);
 *    each building picks a style from its seed (facade.y), with per-bay variation;
 *  - the ground storey of shophouse-type buildings (facade.x = 1) uses a shopfront bay;
 *  - street grime at the base, faint streaks higher up; glass is glossy by day (sky reflections);
 *  - at night (uNight → 1) a stable, per-building pseudo-random subset of windows and every
 *    shopfront glows warm. Lighting is decorative and says nothing about real occupancy.
 */
import * as THREE from 'three';
import { addSurfaceDetail, type SurfaceKind } from './surfaces';

/** Walk-in shop doorways drawn at once (the nearest ones) and the opening height (m). */
export const MAX_DOORS = 16;
export const DOOR_HEIGHT = 2.9;

/** A doorway in an OSM facade: centre and along-wall unit (world), base y, half width, height
 * (default DOOR_HEIGHT). */
export interface Doorway {
	x: number;
	z: number;
	ux: number;
	uz: number;
	y: number;
	halfWidth: number;
	height?: number;
}

const BAY = 128;
/** Atlas bays (128 px = one 4 m × 3.3 m bay each): window styles 0–3, shopfronts 4–5. */
export const FACADE_BAYS = 6;

/**
 * The facade atlas, drawn on a canvas. White areas take the building's colour (vertex colour),
 * coloured details (shutters, awnings, railings) tint it. `mask` draws the glass/glow mask
 * instead: white where windows are glazed (they reflect the sky by day and glow at night).
 */
function facadeCanvas(mask: boolean): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = BAY * FACADE_BAYS;
	c.height = BAY;
	const g = c.getContext('2d')!;
	const paint = (colour: string, glow: string) => (g.fillStyle = mask ? glow : colour);
	const rect = (x: number, y: number, w: number, h: number) => g.fillRect(x, y, w, h);
	const WALL = ['#ffffff', '#000000'] as const;
	const GLASS = ['#5d6d73', '#ffffff'] as const;
	const GLASS_HI = ['#8ea1a7', '#ffffff'] as const;
	const SLAB = ['#d6d0c6', '#000000'] as const;

	// ── 0: modern window with sill ──
	let x0 = 0;
	paint(...WALL); rect(x0, 0, BAY, BAY);
	paint(...SLAB); rect(x0, BAY - 9, BAY, 9);
	paint(...GLASS); rect(x0 + 28, 22, 72, 70);
	paint(...GLASS_HI); rect(x0 + 32, 26, 30, 62); rect(x0 + 66, 26, 30, 62);
	paint('rgba(255,255,255,0.35)', '#ffffff'); rect(x0 + 34, 28, 9, 58);
	paint('#cfc9bf', '#000000'); rect(x0 + 24, 92, 80, 6);

	// ── 1: colonial window with louvred shutters (French-era shophouses) ──
	x0 = BAY;
	paint(...WALL); rect(x0, 0, BAY, BAY);
	paint(...SLAB); rect(x0, BAY - 9, BAY, 9);
	paint('#e2ddd3', '#000000'); rect(x0 + 30, 8, 68, 8); // moulded lintel
	paint('#3e4a4c', '#ffffff'); rect(x0 + 48, 18, 32, 80); // glazed opening
	paint('#7d9397', '#ffffff'); rect(x0 + 52, 22, 11, 72); rect(x0 + 65, 22, 11, 72);
	for (const sx of [32, 80]) {
		paint('#4f8f86', '#000000'); rect(x0 + sx, 18, 16, 80); // shutter leaf
		paint('#3b6f68', '#000000');
		for (let y = 22; y < 96; y += 5) rect(x0 + sx + 2, y, 12, 2); // louvres
	}
	paint('#d9d3c8', '#000000'); rect(x0 + 28, 98, 72, 6);

	// ── 2: balcony door with iron railing and pots ──
	x0 = BAY * 2;
	paint(...WALL); rect(x0, 0, BAY, BAY);
	paint('#4a4440', '#000000'); rect(x0 + 38, 10, 52, 98); // door frame
	paint(...GLASS); rect(x0 + 42, 14, 21, 90); rect(x0 + 65, 14, 21, 90);
	paint('rgba(255,255,255,0.3)', '#ffffff'); rect(x0 + 44, 16, 6, 86);
	paint('#cfc9bf', '#000000'); rect(x0 + 6, 106, 116, 8); // balcony slab
	paint('#2c2d30', '#000000');
	rect(x0 + 6, 80, 116, 3); // handrail
	for (let x = 8; x < 122; x += 7) rect(x0 + x, 83, 2, 23); // balusters
	paint('#6b8f3c', '#000000'); g.beginPath(); g.arc(x0 + 20, 76, 8, 0, Math.PI * 2); g.arc(x0 + 108, 76, 8, 0, Math.PI * 2); g.fill();
	paint('#a5603e', '#000000'); rect(x0 + 14, 76, 12, 6); rect(x0 + 102, 76, 12, 6);

	// ── 3: window under concrete sun louvres, with an air-conditioning unit ──
	x0 = BAY * 3;
	paint(...WALL); rect(x0, 0, BAY, BAY);
	paint(...SLAB); rect(x0, BAY - 9, BAY, 9);
	paint(...GLASS); rect(x0 + 24, 30, 80, 56);
	paint(...GLASS_HI); rect(x0 + 28, 34, 34, 48); rect(x0 + 66, 34, 34, 48);
	paint('#e4ded3', '#000000');
	for (let y = 12; y < 30; y += 6) rect(x0 + 18, y, 92, 3); // brise-soleil fins
	rect(x0 + 16, 12, 5, 76); rect(x0 + 107, 12, 5, 76);
	paint('#d8d8d4', '#000000'); rect(x0 + 80, 92, 28, 20); // AC unit
	paint('#9a9a96', '#000000'); g.beginPath(); g.arc(x0 + 94, 102, 7, 0, Math.PI * 2); g.fill();

	// ── 4: open shopfront, rolled-up shutter ──
	x0 = BAY * 4;
	paint(...WALL); rect(x0, 0, BAY, BAY);
	paint('#f3eee4', '#000000'); rect(x0 + 4, 6, BAY - 8, 22); // sign board (tinted by the facade colour)
	paint('#3b3631', '#ffffff'); rect(x0 + 8, 34, BAY - 16, BAY - 34); // interior
	paint('#8c8a84', '#000000');
	for (let y = 34; y < 62; y += 4) rect(x0 + 8, y, BAY - 16, 2); // shutter
	paint('#5b544b', '#7f7f7f'); rect(x0 + 16, 86, 34, 42); rect(x0 + 78, 92, 34, 36); // goods

	// ── 5: café / glazed shopfront under a striped awning ──
	x0 = BAY * 5;
	paint(...WALL); rect(x0, 0, BAY, BAY);
	paint('#f6f2ea', '#000000'); rect(x0 + 6, 4, BAY - 12, 14); // sign board
	for (let i = 0; i < 16; i++) {
		paint(i % 2 ? '#f4efe6' : '#b8432f', '#000000');
		rect(x0 + i * 8, 20, 8, 18); // awning stripes
	}
	paint('#4b3a2c', '#ffffff'); rect(x0 + 6, 44, BAY - 12, BAY - 44); // warm interior
	paint('#7f8f94', '#ffffff'); rect(x0 + 10, 48, 44, 70); rect(x0 + 74, 48, 44, 70); // glazing
	paint('#2b2b2d', '#000000');
	rect(x0 + 54, 44, 20, BAY - 44); // door
	rect(x0 + 6, 44, 4, BAY - 44); rect(x0 + BAY - 10, 44, 4, BAY - 44); rect(x0 + 31, 48, 2, 70); rect(x0 + 95, 48, 2, 70);
	return c;
}

function canvasTexture(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
	const t = new THREE.CanvasTexture(canvas);
	t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
	t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
	t.anisotropy = 4;
	return t;
}

function poolTexture(): THREE.CanvasTexture {
	const c = document.createElement('canvas');
	c.width = c.height = 64;
	const g = c.getContext('2d')!;
	const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
	grad.addColorStop(0, 'rgba(255,255,255,1)');
	grad.addColorStop(0.45, 'rgba(255,255,255,0.45)');
	grad.addColorStop(1, 'rgba(255,255,255,0)');
	g.fillStyle = grad;
	g.fillRect(0, 0, 64, 64);
	return new THREE.CanvasTexture(c);
}

const mat = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
	new THREE.MeshStandardMaterial({ color, roughness: 0.92, ...extra });

export class CityMaterials {
	readonly facadeMap = canvasTexture(facadeCanvas(false), true);
	readonly glassMask = canvasTexture(facadeCanvas(true), false);
	readonly poolMap = poolTexture();
	/** 0 by day → 1 at night; drives windows, lamps and light pools. */
	readonly night = { value: 0 };
	/** Seconds, for animated surfaces (water ripples). */
	readonly time = { value: 0 };
	/** Procedural surface detail on (1, Quality) or off (0, Performance). */
	readonly detail = { value: 1 };

	readonly walls = new THREE.MeshStandardMaterial({ vertexColors: true, map: this.facadeMap, roughness: 0.85 });
	readonly roofs = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
	readonly khmerRoof = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide });
	readonly asphalt = mat('#4a4d52', { polygonOffset: true, polygonOffsetFactor: -2 });
	readonly asphaltMinor = mat('#5c5f63', { polygonOffset: true, polygonOffsetFactor: -2 });
	readonly paving = mat('#c8b796', { polygonOffset: true, polygonOffsetFactor: -2 });
	readonly sidewalk = mat('#b4aa9a', { polygonOffset: true, polygonOffsetFactor: -1 });
	readonly marking = mat('#efe9da', { polygonOffset: true, polygonOffsetFactor: -3 });
	readonly areas: Record<string, THREE.MeshStandardMaterial> = {
		water: mat('#2f6a74', { roughness: 0.22, metalness: 0.0, envMapIntensity: 0.7 }),
		park: mat('#6f8f4e'),
		grass: mat('#86a35d'),
		pitch: mat('#7aa25a'),
		wetland: mat('#6d8a68'),
		plaza: mat('#d5c7aa'),
		parking: mat('#8d8a84'),
		temple_grounds: mat('#d8c49a')
	};
	readonly pools = new THREE.MeshBasicMaterial({
		color: '#ffb35c',
		map: this.poolMap,
		transparent: true,
		opacity: 0,
		blending: THREE.AdditiveBlending,
		depthWrite: false,
		polygonOffset: true,
		polygonOffsetFactor: -4
	});
	readonly terrain = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1 });

	constructor() {
		for (const m of Object.values(this.areas)) {
			m.polygonOffset = true;
			m.polygonOffsetFactor = -1;
		}
		this.installFacadeShader();
		// World-space surface detail (surfaces.ts): pavers, asphalt grain and gutters, grass, water.
		const detail: [THREE.MeshStandardMaterial, SurfaceKind][] = [
			[this.paving, 'paving'],
			[this.sidewalk, 'sidewalk'],
			[this.asphalt, 'asphalt'],
			[this.asphaltMinor, 'asphalt'],
			[this.terrain, 'soil'],
			[this.areas.plaza, 'plaza'],
			[this.areas.temple_grounds, 'plaza'],
			[this.areas.parking, 'asphalt'],
			[this.areas.park, 'grass'],
			[this.areas.grass, 'grass'],
			[this.areas.pitch, 'grass'],
			[this.areas.wetland, 'grass'],
			[this.areas.water, 'water']
		];
		for (const [material, kind] of detail) addSurfaceDetail(material, kind, { time: this.time, detail: this.detail });
	}

	/**
	 * Doorways cut into OSM facades (walk-in shops, enterable buildings): wall fragments inside
	 * an opening are discarded, so a frontage opens into its interior without rebuilding the
	 * chunk. A: (centre x, centre z, along-wall unit x, along-wall unit z); B: (base y, half
	 * width, height). Each system owns a set (setDoorSet); at most MAX_DOORS are cut, the sets
	 * of enterable buildings first (there are few of them).
	 */
	readonly doorA = { value: Array.from({ length: MAX_DOORS }, () => new THREE.Vector4()) };
	readonly doorB = { value: Array.from({ length: MAX_DOORS }, () => new THREE.Vector3()) };
	readonly doorCount = { value: 0 };
	private doorSets = new Map<string, Doorway[]>();

	/** The walk-in shops' doorways (Storefronts). */
	setDoors(doors: Doorway[]) {
		this.setDoorSet('shops', doors);
	}

	setDoorSet(owner: string, doors: Doorway[]) {
		if (doors.length) this.doorSets.set(owner, doors);
		else this.doorSets.delete(owner);
		const all = [...[...this.doorSets].filter(([o]) => o !== 'shops').flatMap(([, d]) => d), ...(this.doorSets.get('shops') ?? [])];
		const n = Math.min(MAX_DOORS, all.length);
		for (let i = 0; i < n; i++) {
			const d = all[i];
			this.doorA.value[i].set(d.x, d.z, d.ux, d.uz);
			this.doorB.value[i].set(d.y, d.halfWidth, d.height ?? DOOR_HEIGHT);
		}
		this.doorCount.value = n;
	}

	private installFacadeShader() {
		const night = this.night;
		const glass = this.glassMask;
		const { doorA, doorB, doorCount } = this;
		this.walls.onBeforeCompile = (shader) => {
			shader.uniforms.uNight = night;
			shader.uniforms.uGlass = { value: glass };
			shader.uniforms.uDoorA = doorA;
			shader.uniforms.uDoorB = doorB;
			shader.uniforms.uDoorCount = doorCount;
			shader.vertexShader = shader.vertexShader
				.replace(
					'#include <common>',
					'#include <common>\nattribute vec2 facade;\nvarying vec2 vFacade;\nvarying vec2 vWall;\nvarying vec3 vPpwWorld;'
				)
				.replace(
					'#include <uv_vertex>',
					'#include <uv_vertex>\nvFacade = facade;\nvWall = uv;\nvPpwWorld = (modelMatrix * vec4(position, 1.0)).xyz;'
				);
			shader.fragmentShader = shader.fragmentShader
				.replace(
					'#include <common>',
					`#include <common>
uniform float uNight;
uniform sampler2D uGlass;
uniform vec4 uDoorA[${MAX_DOORS}];
uniform vec3 uDoorB[${MAX_DOORS}];
uniform int uDoorCount;
varying vec2 vFacade;
varying vec2 vWall;
varying vec3 vPpwWorld;
float ppwHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`
				)
				.replace(
					'#include <clipping_planes_fragment>',
					`#include <clipping_planes_fragment>
for (int i = 0; i < ${MAX_DOORS}; i++) {
	if (i >= uDoorCount) break;
	vec2 ppwD = vPpwWorld.xz - uDoorA[i].xy;
	float ppwAlong = dot(ppwD, uDoorA[i].zw);
	float ppwAcross = dot(ppwD, vec2(-uDoorA[i].w, uDoorA[i].z));
	if (abs(ppwAlong) < uDoorB[i].y && abs(ppwAcross) < 0.3 && vPpwWorld.y < uDoorB[i].x + uDoorB[i].z) discard;
}`
				)
				.replace(
					'#include <map_fragment>',
					`vec2 ppwCell = vWall / vec2(4.0, 3.3);
float ppwStorey = floor(ppwCell.y);
float ppwShop = step(0.5, vFacade.x) * (1.0 - step(0.5, ppwStorey));
float ppwStyle = floor(vFacade.y * 4.0); // the building's window style (0..3)
float ppwR = ppwHash(vec3(floor(ppwCell.x), ppwStorey, vFacade.y * 97.0));
float ppwBay = ppwStyle;
if (ppwStyle < 0.5 && ppwR > 0.8) ppwBay = 3.0; // a few AC units on modern blocks
if (ppwStyle > 1.5 && ppwStyle < 2.5 && mod(ppwStorey, 2.0) < 1.0) ppwBay = 1.0; // balconies on alternate floors
// Shopfronts vary along the street in 8 m pairs of bays: ~40 % café fronts, the rest open shops.
if (ppwShop > 0.5) ppwBay = 4.0 + step(0.6, ppwHash(vec3(floor(ppwCell.x * 0.5), 3.0, vFacade.y * 31.0)));
vec2 ppwLocal = fract(ppwCell);
vec2 ppwAtlas = vec2((ppwLocal.x + ppwBay) / ${FACADE_BAYS}.0, ppwLocal.y);
vec2 ppwGrad = ppwCell * vec2(1.0 / ${FACADE_BAYS}.0, 1.0);
diffuseColor *= textureGrad(map, ppwAtlas, dFdx(ppwGrad), dFdy(ppwGrad));
float ppwGlass = textureGrad(uGlass, ppwAtlas, dFdx(ppwGrad), dFdy(ppwGrad)).r;
// Street grime at the foot of the walls and faint rain streaks higher up.
float ppwStreak = 0.93 + 0.07 * fract(sin(floor(vWall.x * 2.5) * 12.9898 + vFacade.y * 78.23) * 43758.5453);
diffuseColor.rgb *= (0.76 + 0.24 * smoothstep(0.0, 0.9, vWall.y)) * mix(1.0, ppwStreak, smoothstep(1.5, 6.0, vWall.y));`
				)
				.replace(
					'#include <roughnessmap_fragment>',
					`#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.15, ppwGlass * (1.0 - uNight)); // glass reflects the sky`
				)
				.replace(
					'#include <emissivemap_fragment>',
					`#include <emissivemap_fragment>
float ppwLit = max(step(0.58, ppwHash(vec3(floor(ppwCell.x), ppwStorey, vFacade.y * 97.0))), ppwShop);
totalEmissiveRadiance += uNight * ppwLit * ppwGlass * vec3(1.0, 0.6, 0.28) * 1.2;`
				);
		};
		this.walls.customProgramCacheKey = () => 'ppw-facade-v5';
	}

	area(kind: string | undefined): THREE.Material | undefined {
		return kind ? this.areas[kind] : undefined;
	}

	dispose() {
		this.facadeMap.dispose();
		this.glassMask.dispose();
		this.poolMap.dispose();
		for (const m of [
			this.walls, this.roofs, this.khmerRoof, this.asphalt, this.asphaltMinor, this.paving,
			this.sidewalk, this.marking, this.pools, this.terrain, ...Object.values(this.areas)
		])
			m.dispose();
	}
}

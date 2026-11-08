/**
 * Shared city materials (main thread: they use canvas textures).
 *
 * The facade material is a MeshStandardMaterial extended with a small shader:
 *  - walls are tiled with 4 m × 3.3 m bays from an atlas (window bay | shopfront bay);
 *  - the ground storey of shophouse-type buildings (facade.x = 1) uses the shopfront bay;
 *  - at night (uNight → 1) a stable, per-building pseudo-random subset of windows and every
 *    shopfront glows warm. Lighting is decorative and says nothing about real occupancy.
 */
import * as THREE from 'three';

const BAY = 128;

function facadeCanvas(mask: boolean): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = BAY * 2;
	c.height = BAY;
	const g = c.getContext('2d')!;
	const paint = (colour: string, glow: string) => (g.fillStyle = mask ? glow : colour);
	// ── window bay (left) ──
	paint('#ffffff', '#000000');
	g.fillRect(0, 0, BAY, BAY);
	paint('#d6d0c6', '#000000');
	g.fillRect(0, BAY - 9, BAY, 9); // floor slab
	paint('#69777c', '#ffffff');
	g.fillRect(28, 22, 72, 70); // glazing
	paint('#8ea1a7', '#ffffff');
	g.fillRect(32, 26, 30, 62);
	g.fillRect(66, 26, 30, 62);
	paint('rgba(255,255,255,0.35)', '#ffffff');
	g.fillRect(34, 28, 9, 58);
	paint('#cfc9bf', '#000000');
	g.fillRect(24, 92, 80, 6); // sill
	// ── shopfront bay (right) ──
	const x0 = BAY;
	paint('#ffffff', '#000000');
	g.fillRect(x0, 0, BAY, BAY);
	paint('#f3eee4', '#000000');
	g.fillRect(x0 + 4, 6, BAY - 8, 22); // sign board (tinted by the facade colour)
	paint('#3b3631', '#ffffff');
	g.fillRect(x0 + 8, 34, BAY - 16, BAY - 34); // open shop / interior
	paint('#8c8a84', '#000000');
	for (let y = 34; y < 62; y += 4) g.fillRect(x0 + 8, y, BAY - 16, 2); // rolled-up shutter
	paint('#5b544b', '#7f7f7f');
	g.fillRect(x0 + 16, 86, 34, 42); // goods / counter
	g.fillRect(x0 + 78, 92, 34, 36);
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

	readonly walls = new THREE.MeshStandardMaterial({ vertexColors: true, map: this.facadeMap, roughness: 0.85 });
	readonly roofs = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
	readonly khmerRoof = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide });
	readonly asphalt = mat('#4a4d52', { polygonOffset: true, polygonOffsetFactor: -2 });
	readonly asphaltMinor = mat('#5c5f63', { polygonOffset: true, polygonOffsetFactor: -2 });
	readonly paving = mat('#c8b796', { polygonOffset: true, polygonOffsetFactor: -2 });
	readonly sidewalk = mat('#b4aa9a', { polygonOffset: true, polygonOffsetFactor: -1 });
	readonly marking = mat('#efe9da', { polygonOffset: true, polygonOffsetFactor: -3 });
	readonly areas: Record<string, THREE.MeshStandardMaterial> = {
		water: mat('#3b7f8c', { roughness: 0.22, metalness: 0.1 }),
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
	}

	private installFacadeShader() {
		const night = this.night;
		const glass = this.glassMask;
		this.walls.onBeforeCompile = (shader) => {
			shader.uniforms.uNight = night;
			shader.uniforms.uGlass = { value: glass };
			shader.vertexShader = shader.vertexShader
				.replace(
					'#include <common>',
					'#include <common>\nattribute vec2 facade;\nvarying vec2 vFacade;\nvarying vec2 vWall;'
				)
				.replace('#include <uv_vertex>', '#include <uv_vertex>\nvFacade = facade;\nvWall = uv;');
			shader.fragmentShader = shader.fragmentShader
				.replace(
					'#include <common>',
					`#include <common>
uniform float uNight;
uniform sampler2D uGlass;
varying vec2 vFacade;
varying vec2 vWall;
float ppwHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`
				)
				.replace(
					'#include <map_fragment>',
					`vec2 ppwCell = vWall / vec2(4.0, 3.3);
float ppwStorey = floor(ppwCell.y);
float ppwShop = step(0.5, vFacade.x) * (1.0 - step(0.5, ppwStorey));
vec2 ppwLocal = fract(ppwCell);
vec2 ppwAtlas = vec2((ppwLocal.x + ppwShop) * 0.5, ppwLocal.y);
vec2 ppwGrad = ppwCell * 0.5;
diffuseColor *= textureGrad(map, ppwAtlas, dFdx(ppwGrad), dFdy(ppwGrad));`
				)
				.replace(
					'#include <emissivemap_fragment>',
					`#include <emissivemap_fragment>
float ppwLit = max(step(0.58, ppwHash(vec3(floor(ppwCell.x), ppwStorey, vFacade.y * 97.0))), ppwShop);
float ppwGlass = textureGrad(uGlass, ppwAtlas, dFdx(ppwGrad), dFdy(ppwGrad)).r;
totalEmissiveRadiance += uNight * ppwLit * ppwGlass * vec3(1.0, 0.6, 0.28) * 1.2;`
				);
		};
		this.walls.customProgramCacheKey = () => 'ppw-facade-v2';
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

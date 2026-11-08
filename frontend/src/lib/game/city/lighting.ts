/**
 * Day/night lighting driven by the real sun over Phnom Penh (or a fixed preset).
 * Sets the sun or moon light, sky, fog and exposure, and the night factor shared with the
 * facade shader, lamp glow and light pools.
 */
import * as THREE from 'three';
import type { Sky } from 'three/addons/objects/Sky.js';
import type { CityMaterials } from './materials';
import type { PropLibrary } from './props';
import { atPhnomPenhHour, nightFactor, phnomPenhClock, sunDirection, sunPosition } from './sun';

export type TimeMode = 'live' | 'morning' | 'noon' | 'sunset' | 'night';
export const TIME_PRESETS: Record<Exclude<TimeMode, 'live'>, number> = {
	morning: 7.5,
	noon: 12,
	sunset: 17.35,
	night: 21
};

export interface LightingRefs {
	renderer: THREE.WebGLRenderer;
	scene: THREE.Scene;
	sun: THREE.DirectionalLight;
	hemi: THREE.HemisphereLight;
	sky: Sky;
	fog: THREE.Fog;
	materials: CityMaterials;
	props: PropLibrary;
}

const DAY_FOG = new THREE.Color('#c9d8db');
const DUSK_FOG = new THREE.Color('#d9b796');
const NIGHT_FOG = new THREE.Color('#1a2433');
const DAY_SUN = new THREE.Color('#fff0d4');
const LOW_SUN = new THREE.Color('#ffae66');
const MOON = new THREE.Color('#8fa6d6');
const DAY_SKY = new THREE.Color('#dfeaf0');
const NIGHT_SKY = new THREE.Color('#5a6a92');
const DAY_GROUND = new THREE.Color('#8c806a');
const NIGHT_GROUND = new THREE.Color('#3a3128');
const MOON_DIR = new THREE.Vector3(0.35, 0.8, 0.45).normalize();

export class DayNight {
	mode: TimeMode = 'live';
	night = 0;
	elevation = 0;
	clock = '';
	/** Unit vector towards the main light (sun by day, moon by night). */
	readonly lightDir = new THREE.Vector3(-0.6, 0.7, 0.3).normalize();
	private tmp = new THREE.Color();

	constructor(private refs: LightingRefs, private lat: number, private lon: number) {}

	update(now = new Date()): void {
		const date = this.mode === 'live' ? now : atPhnomPenhHour(now, TIME_PRESETS[this.mode]);
		const pos = sunPosition(date, this.lat, this.lon);
		this.elevation = pos.elevation;
		this.clock = phnomPenhClock(date);
		this.night = nightFactor(pos.elevation);
		const { renderer, sun, hemi, sky, fog, materials, props } = this.refs;
		const [dx, dy, dz] = sunDirection(pos);
		const day = 1 - this.night;

		if (pos.elevation > -3) {
			this.lightDir.set(dx, Math.max(dy, 0.06), dz).normalize();
			const warmth = THREE.MathUtils.clamp(pos.elevation / 25, 0, 1);
			sun.color.copy(LOW_SUN).lerp(DAY_SUN, warmth);
			sun.intensity = 3.2 * THREE.MathUtils.clamp(Math.sin((pos.elevation + 3) * THREE.MathUtils.DEG2RAD) * 2.2, 0, 1);
		} else {
			this.lightDir.copy(MOON_DIR);
			sun.color.copy(MOON);
			sun.intensity = 0.7 * this.night;
		}
		// Keep nights playable: a city sky glow plus moonlight, never pitch black.
		hemi.intensity = 0.9 + 0.6 * day;
		hemi.color.copy(NIGHT_SKY).lerp(DAY_SKY, day);
		hemi.groundColor.copy(NIGHT_GROUND).lerp(DAY_GROUND, day);

		sky.material.uniforms.sunPosition.value.set(dx, dy, dz);
		sky.visible = this.night < 0.97;
		const dusk = THREE.MathUtils.clamp(1 - Math.abs(pos.elevation - 2) / 10, 0, 1);
		this.tmp.copy(DAY_FOG).lerp(DUSK_FOG, dusk * 0.7).lerp(NIGHT_FOG, this.night);
		fog.color.copy(this.tmp);
		this.refs.scene.background = this.night >= 0.97 ? this.tmp.clone() : null;
		renderer.toneMappingExposure = 0.62 + 0.45 * this.night;

		materials.night.value = this.night;
		materials.pools.opacity = 0.95 * this.night;
		const lamp = props.materials.byName.get('Lamp');
		if (lamp) {
			lamp.emissive.set('#ffcf7a');
			lamp.emissiveIntensity = 0.15 + 4 * this.night;
		}
	}
}

/**
 * Day/night lighting driven by the real sun over Phnom Penh (or a fixed preset).
 * Sets the sun or moon light, sky, fog and exposure, and the night factor shared with the
 * facade shader, lamp glow and light pools.
 *
 * Image-based lighting: the sky is rendered into a small prefiltered environment map (PMREM)
 * whenever the sun has moved noticeably (about once a minute in live mode, on preset changes),
 * so every material gets sky-coloured ambient light and soft reflections (water, glass) for the
 * cost of one cube render now and then — no per-frame cost.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
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
const DUSK_SKY = new THREE.Color('#f3c9a2');
const DUSK_GROUND = new THREE.Color('#9a7a5c');
const NIGHT_SKY = new THREE.Color('#5a6a92');
const DAY_GROUND = new THREE.Color('#8c806a');
const NIGHT_GROUND = new THREE.Color('#3a3128');
const MOON_DIR = new THREE.Vector3(0.35, 0.8, 0.45).normalize();

/** Indoors: a warm fill like the house's lamps (ceiling bulb, floor lamp) and its tiled floor. */
const INDOOR_FILL = 1.7;
const INDOOR_SKY = new THREE.Color('#ffe2bd');
const INDOOR_GROUND = new THREE.Color('#9c7a5c');
/** Indoors by day with the lamps off: soft daylight from the windows. */
const INDOOR_DAY = new THREE.Color('#eef0ec');

export class DayNight {
	mode: TimeMode = 'live';
	night = 0;
	elevation = 0;
	clock = '';
	/** Unit vector towards the main light (sun by day, moon by night). */
	readonly lightDir = new THREE.Vector3(-0.6, 0.7, 0.3).normalize();
	private tmp = new THREE.Color();
	private pmrem: THREE.PMREMGenerator | null = null;
	private envScene: THREE.Scene | null = null;
	private envSky: Sky | null = null;
	private envTarget: THREE.WebGLRenderTarget | null = null;
	private envGround: THREE.Mesh | null = null;
	private envKey = '';
	/** Sky environment lighting (Quality); off in Performance mode. */
	environment = true;
	/** The sun's (or moon's) and the sky fill's settings from the time of day, before `indoor`. */
	private sunIntensity = 3.1;
	private hemiIntensity = 1;
	private hemiSky = new THREE.Color();
	private hemiGround = new THREE.Color();
	private indoor = 0;
	private indoorLamp = 1;
	private indoorShadows = true;
	private tmpIndoor = new THREE.Color();

	/** Indoors (0 … 1, eased by the engine): the avatar and other lit objects take the room's
	 * light instead of the sun and sky: warm when its lamps are on (`lamp` 0 … 1), daylight
	 * through the windows by day, dim in a dark room at night. Cheap: call every frame; no new
	 * lights. */
	setIndoor(k: number, shadows: boolean, lamp = 1): void {
		if (Math.abs(k - this.indoor) < 1e-4 && Math.abs(lamp - this.indoorLamp) < 1e-4 && shadows === this.indoorShadows) return;
		this.indoor = k;
		this.indoorLamp = lamp;
		this.indoorShadows = shadows;
		this.applyIndoor();
	}

	private applyIndoor(): void {
		const { sun, hemi } = this.refs;
		const k = this.indoor;
		// With shadows the roof already shades the sun; without them, soften it more.
		sun.intensity = this.sunIntensity * (1 - k * (this.indoorShadows ? 0.25 : 0.6));
		const lit = Math.max(this.indoorLamp, 1 - this.night);
		hemi.intensity = THREE.MathUtils.lerp(this.hemiIntensity, INDOOR_FILL * (0.25 + 0.75 * lit), k);
		this.tmpIndoor.copy(INDOOR_DAY).lerp(INDOOR_SKY, this.indoorLamp);
		hemi.color.copy(this.hemiSky).lerp(this.tmpIndoor, k);
		hemi.groundColor.copy(this.hemiGround).lerp(INDOOR_GROUND, k);
	}

	constructor(private refs: LightingRefs, private lat: number, private lon: number) {}

	/** Re-render the sky environment map when the sun moved enough to matter. */
	private updateEnvironment(dx: number, dy: number, dz: number, day: number): void {
		if (!this.environment) {
			if (this.refs.scene.environment) this.refs.scene.environment = null;
			this.envKey = '';
			return;
		}
		// Quantised so live mode regenerates about every few minutes, not every update.
		const key = [dx, dy, dz, day].map((v) => (Math.round(v * 25) / 25).toFixed(2)).join(',');
		if (key === this.envKey) return;
		this.envKey = key;
		const { renderer, scene, sky } = this.refs;
		if (!this.pmrem) {
			this.pmrem = new THREE.PMREMGenerator(renderer);
			this.envScene = new THREE.Scene();
			this.envSky = new Sky();
			this.envSky.scale.setScalar(50); // inside the PMREM cube camera's far plane
			this.envScene.add(this.envSky);
			// The Sky shader is dark violet below the horizon: give the environment a ground, so
			// surfaces facing down (under tree crowns, eaves) get warm bounce light instead.
			this.envGround = new THREE.Mesh(
				new THREE.CircleGeometry(45, 24).rotateX(-Math.PI / 2).translate(0, -1, 0),
				new THREE.MeshBasicMaterial({ color: DAY_GROUND })
			);
			this.envScene.add(this.envGround);
		}
		(this.envGround!.material as THREE.MeshBasicMaterial).color.copy(NIGHT_GROUND).lerp(DAY_GROUND, day).multiplyScalar(0.55 + 0.45 * day);
		const u = this.envSky!.material.uniforms;
		for (const name of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG'])
			u[name].value = sky.material.uniforms[name].value;
		u.sunPosition.value.set(dx, Math.max(dy, -0.2), dz);
		const target = this.pmrem.fromScene(this.envScene!, 0, 0.1, 100);
		this.envTarget?.dispose();
		this.envTarget = target;
		scene.environment = target.texture;
		// Sky light: strong by day, a faint city glow at night.
		scene.environmentIntensity = 0.1 + 0.35 * day;
	}

	dispose(): void {
		this.envTarget?.dispose();
		this.pmrem?.dispose();
		this.envSky?.material.dispose();
		this.envSky?.geometry.dispose();
		this.envGround?.geometry.dispose();
		(this.envGround?.material as THREE.Material | undefined)?.dispose();
		if (this.refs.scene.environment === this.envTarget?.texture) this.refs.scene.environment = null;
	}

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
			this.sunIntensity = 3.2 * THREE.MathUtils.clamp(Math.sin((pos.elevation + 3) * THREE.MathUtils.DEG2RAD) * 2.2, 0, 1);
		} else {
			this.lightDir.copy(MOON_DIR);
			sun.color.copy(MOON);
			this.sunIntensity = 0.7 * this.night;
		}
		// Keep nights playable: a city sky glow plus moonlight, never pitch black. The sky
		// environment map now carries part of the daylight fill, so the hemisphere is weaker.
		const dusk = THREE.MathUtils.clamp(1 - Math.abs(pos.elevation - 4) / 12, 0, 1) * day;
		this.hemiIntensity = this.environment ? 0.75 + 0.25 * day : 0.9 + 0.6 * day; // no env map: the old fill
		this.hemiSky.copy(NIGHT_SKY).lerp(DAY_SKY, day).lerp(DUSK_SKY, dusk * 0.6);
		this.hemiGround.copy(NIGHT_GROUND).lerp(DAY_GROUND, day).lerp(DUSK_GROUND, dusk * 0.5);
		this.applyIndoor();

		sky.material.uniforms.sunPosition.value.set(dx, dy, dz);
		sky.visible = this.night < 0.97;
		this.updateEnvironment(dx, dy, dz, day);
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

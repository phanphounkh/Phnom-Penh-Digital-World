import * as THREE from 'three';
import type { Sky } from 'three/addons/objects/Sky.js';

/** Original, seamless packed density atlas. Not weather data or a scene background image.
 * No canvas or downloads: RGB noise bands are generated once into a 128² DataTexture. */
export function cloudDensity(size = 128): Uint8Array {
	const data = new Uint8Array(size * size * 4);
	const hash = (x: number, y: number) => {
		let n = Math.imul(x + 29, 374761393) ^ Math.imul(y + 53, 668265263);
		n = Math.imul(n ^ (n >>> 13), 1274126177);
		return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
	};
	const noise = (x: number, y: number, period: number) => {
		const ix = Math.floor(x),
			iy = Math.floor(y),
			fx = x - ix,
			fy = y - iy;
		const u = fx * fx * (3 - 2 * fx),
			v = fy * fy * (3 - 2 * fy);
		const a = hash(ix % period, iy % period),
			b = hash((ix + 1) % period, iy % period);
		const c = hash(ix % period, (iy + 1) % period),
			d = hash((ix + 1) % period, (iy + 1) % period);
		return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
	};
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			const i = (y * size + x) * 4;
			data[i] = Math.round(noise((x / size) * 8, (y / size) * 8, 8) * 255);
			data[i + 1] = Math.round(
				noise((x / size) * 24, (y / size) * 24, 24) * 255
			);
			data[i + 2] = Math.round(noise((x / size) * 4, (y / size) * 4, 4) * 255);
			data[i + 3] = 255;
		}
	return data;
}

/** Adds a single filtered density lookup to the existing atmospheric sky draw call.
 * The solar lighting, terrain, camera, collision and night sky stay independent. */
export class DaylightClouds {
	private texture = new THREE.DataTexture(
		cloudDensity(),
		128,
		128,
		THREE.RGBAFormat
	);
	private time = { value: 0 };
	private day = { value: 1 };
	constructor(sky: Sky) {
		this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
		this.texture.magFilter = THREE.LinearFilter;
		this.texture.minFilter = THREE.LinearMipmapLinearFilter;
		this.texture.generateMipmaps = true;
		this.texture.needsUpdate = true;
		Object.assign(sky.material.uniforms, {
			uPpwCloudMap: { value: this.texture },
			uPpwCloudTime: this.time,
			uPpwCloudDay: this.day
		});
		sky.material.fragmentShader = sky.material.fragmentShader
			.replace(
				'varying vec3 vWorldPosition;',
				`varying vec3 vWorldPosition;
uniform sampler2D uPpwCloudMap;
uniform float uPpwCloudTime;
uniform float uPpwCloudDay;`
			)
			.replace(
				'gl_FragColor = vec4( retColor, 1.0 );',
				`
// A projected cloud layer: a sky effect, not geometry or shadows attributed to map data.
vec2 ppwCloudUv = direction.xz / max(.12, direction.y + .18) * .44 + vec2(uPpwCloudTime * .0008, .13);
vec3 ppwDensity = texture2D(uPpwCloudMap, ppwCloudUv).rgb;
float ppwBillow = ppwDensity.r * .72 + ppwDensity.g * .20 + ppwDensity.b * .08;
float ppwCloud = smoothstep(.58, .72, ppwBillow) * smoothstep(.035, .18, direction.y) * uPpwCloudDay;
float ppwEdgeLight = 1. - smoothstep(.56, .79, ppwBillow);
vec3 ppwWarmth = mix(vec3(1., .73, .48), vec3(1.), smoothstep(.05, .4, vSunDirection.y));
vec3 ppwCloudColour = mix(vec3(.74, .87, 1.04), vec3(2.65, 2.65, 2.6), .48 + .52 * ppwEdgeLight) * ppwWarmth;
// Retain the atmospheric horizon; a restrained clear-weather blue at higher elevations.
retColor = mix(retColor, vec3(.22, .49, 1.08), smoothstep(.06, .5, direction.y) * .42 * uPpwCloudDay);
retColor = mix(retColor, ppwCloudColour, ppwCloud * .92);
gl_FragColor = vec4(retColor, 1.);`
			);
		sky.material.needsUpdate = true;
		this.update(0);
	}
	update(night: number, now = Date.now()): void {
		this.day.value = 1 - night;
		this.time.value = (now / 1000) % 10000;
	}
	diagnostics() {
		return { size: 128, day: this.day.value, time: this.time.value };
	}
	dispose() {
		this.texture.dispose();
	}
}

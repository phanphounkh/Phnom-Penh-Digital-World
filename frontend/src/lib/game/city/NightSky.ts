import * as THREE from 'three';

/** A distant sky, with no textures to download and no effect on world collision. */
export class NightSky {
	private material = new THREE.ShaderMaterial({
		side: THREE.BackSide, depthWrite: false, fog: false,
		uniforms: { night: { value: 0 }, time: { value: 0 }, detail: { value: 1 } },
		vertexShader: `varying vec3 direction;
		void main() { direction = position; vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0); gl_Position = p.xyww; }`,
		fragmentShader: `
		uniform float night, time, detail;
		varying vec3 direction;
		float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
		float noise(vec2 p) {
			vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
			return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);
		}
		void main() {
			vec3 d=normalize(direction);
			float altitude=max(d.y,0.);
			vec3 col=mix(vec3(.035,.065,.105),vec3(.006,.016,.045),smoothstep(0.,.8,altitude));
			vec3 moonDir=normalize(vec3(.35,.8,.45));
			float dist=length(d-moonDir);
			float disc=1.-smoothstep(.018,.020,dist);
			float craters=.8+.2*noise(d.xz*700.);
			col+=vec3(.56,.67,.85)*exp(-dist*22.)*.19;
			col=mix(col,vec3(.82,.88,1.)*craters*1.8,disc);
			vec2 p=d.xz/max(.12,d.y)*2.5+vec2(time*.0015,0.);
			float cloud=0.;
			if(detail>.5) {
				float n=noise(p)*.55+noise(p*2.03)*.28+noise(p*4.07)*.17;
				cloud=smoothstep(.47,.72,n)*smoothstep(.01,.18,altitude);
			}
			col=mix(col,vec3(.07,.105,.16)+vec3(.1,.13,.18)*exp(-dist*5.),cloud*.85);
			vec2 starUV=vec2(atan(d.z,d.x),asin(d.y))*500.;
			float star=step(.997,hash(floor(starUV)))*(1.-smoothstep(.04,.18,length(fract(starUV)-.5)));
			col+=star*smoothstep(.05,.3,altitude)*(1.-cloud)*.35;
			gl_FragColor=vec4(col,night);
			#include <tonemapping_fragment>
			#include <colorspace_fragment>
		}`,
		transparent: true
	});
	readonly mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 24, 12), this.material);
	constructor(scene: THREE.Scene) {
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = -10;
		scene.add(this.mesh);
	}
	update(night: number, time: number, detailed: boolean) {
		this.mesh.visible = night > 0.01;
		this.material.uniforms.night.value = night;
		this.material.uniforms.time.value = time;
		this.material.uniforms.detail.value = detailed ? 1 : 0;
	}
	dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.material.dispose(); }
}

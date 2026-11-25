/** Upper-storey frame/sill relief following the existing wall's UV-to-world transform.
 * Original modular approximation inspired by the catalogued Daun Penh photographs, not
 * surveyed façade geometry. No ground-storey geometry: door/interior openings stay clear. */
import * as THREE from 'three';
import type { MeshData } from './chunkGeometry';

type V = [number, number, number];
const fraction = (x: number) => x - Math.floor(x);
/** Mirrors the façade shader's per-bay style selection; use float arithmetic like GLSL. */
function randomBay(x: number, y: number, z: number): number {
	const f = Math.fround;
	const p = [x, y, z].map((n) => f(fraction(f(f(n * 0.3183099) + 0.1)) * 17));
	return fraction(f(f(f(f(p[0] * p[1]) * p[2]) * f(f(p[0] + p[1]) + p[2]))));
}
export function reliefStyle(seed: number, bay: number, floor: number): number {
	let style = Math.floor(Math.fround(seed) * 4);
	if (style === 0 && randomBay(bay, floor, Math.fround(seed * 97)) > 0.8)
		style = 3;
	if (style === 2 && floor % 2 === 0) style = 1;
	return style;
}
const OPENINGS = [
	[28, 22, 72, 70],
	[48, 18, 32, 80],
	[38, 10, 52, 98],
	[24, 30, 80, 56]
];

export class FacadeRelief {
	private positions: number[] = [];
	private normals: number[] = [];
	private colours: number[] = [];
	private count = 0;
	constructor(readonly budget = 48) {}
	get frames(): number {
		return this.count;
	}

	add(
		wall: THREE.BufferGeometry,
		seed: number,
		colour: THREE.Color,
		buildingBudget: number,
		canopy?: (point: V) => boolean
	): number {
		if (this.count >= this.budget || buildingBudget <= 0) return 0;
		const p = wall.getAttribute('position'),
			uv = wall.getAttribute('uv'),
			normal = wall.getAttribute('normal');
		const before = this.count;
		// ExtrudeGeometry emits one six-vertex wall quad per ring edge (one depth step).
		for (
			let start = 0;
			start + 5 < p.count &&
			this.count < this.budget &&
			this.count - before < buildingBudget;
			start += 6
		) {
			const a: V = [p.getX(start), p.getY(start), p.getZ(start)];
			const b: V = [p.getX(start + 1), p.getY(start + 1), p.getZ(start + 1)];
			const c: V = [p.getX(start + 2), p.getY(start + 2), p.getZ(start + 2)];
			const au = uv.getX(start),
				av = uv.getY(start);
			const bu = uv.getX(start + 1) - au,
				bv = uv.getY(start + 1) - av;
			const cu = uv.getX(start + 2) - au,
				cv = uv.getY(start + 2) - av;
			const det = bu * cv - cu * bv;
			if (Math.abs(det) < 1e-6) continue;
			const world = (u: number, v: number): V => {
				const s = ((u - au) * cv - (v - av) * cu) / det,
					t = (bu * (v - av) - bv * (u - au)) / det;
				return a.map((n, k) => n + (b[k] - n) * s + (c[k] - n) * t) as V;
			};
			const along = world(au + 1, av).map((n, k) => n - a[k]) as V;
			const scale = Math.hypot(...along);
			if (scale < 0.001) continue;
			const axis = along.map((n) => n / scale) as V;
			const out: V = [
				normal.getX(start),
				normal.getY(start),
				normal.getZ(start)
			];
			let minU = Infinity,
				maxU = -Infinity,
				minV = Infinity,
				maxV = -Infinity;
			for (let k = start; k < start + 6; k++) {
				minU = Math.min(minU, uv.getX(k));
				maxU = Math.max(maxU, uv.getX(k));
				minV = Math.min(minV, uv.getY(k));
				maxV = Math.max(maxV, uv.getY(k));
			}
			// A few overhead canopies, only where the caller verifies a nearby street.
			if(canopy && minV<=.05 && maxV>=3.15 && this.count< this.budget && this.count-before<buildingBudget) {
				for(let bay=Math.ceil(minU/4);bay*4+3.8<maxU;bay++) {
					const u0=bay*4+.2,u1=bay*4+3.8;
					if(randomBay(Math.floor(bay*.5),3,Math.fround(seed*31))<=.6)continue;
					const middle=(u0+u1)/2,point=world(middle,0);
					if(!canopy(point))continue;
					const finish=randomBay(Math.floor(bay*.5),11,Math.fround(seed*53));
					const palette=[[.20,.25,.21],[.045,.14,.15],[.10,.14,.23],[.34,.24,.11],[.36,.15,.09]];
					const rgb=palette[Math.min(4,Math.floor(finish*5))];
					const fabric=new THREE.Color().setRGB(rgb[0],rgb[1],rgb[2]);
					this.box(world(middle,3.02),axis,out,[(u1-u0)*scale,.06,.8],.4,fabric,.18);
					this.box(world(middle,2.80),axis,out,[(u1-u0)*scale,.14,.04],.78,fabric.clone().multiplyScalar(.8));
					this.count++;break;
				}
			}
			let onWall = 0;
			for (
				let floor = Math.max(1, Math.ceil(minV / 3.3));
				floor * 3.3 + 3.3 <= maxV + 0.01 && onWall < 2;
				floor++
			)
				for (
					let bay = Math.floor(minU / 4);
					bay * 4 < maxU &&
					onWall < 2 &&
					this.count < this.budget &&
					this.count - before < buildingBudget;
					bay++
				) {
					const [x, y, w, h] = OPENINGS[reliefStyle(seed, bay, floor)];
					const u0 = bay * 4 + (x / 128) * 4,
						u1 = u0 + (w / 128) * 4;
					const v0 = floor * 3.3 + (1 - (y + h) / 128) * 3.3,
						v1 = floor * 3.3 + (1 - y / 128) * 3.3;
					if (
						u0 < minU + 0.12 ||
						u1 > maxU - 0.12 ||
						v0 < minV ||
						v1 > maxV - 0.08
					)
						continue;
					const mid = (u0 + u1) / 2,
						high = (v0 + v1) / 2,
						width = (u1 - u0) * scale;
					for (const u of [u0, u1])
						this.box(
							world(u, high),
							axis,
							out,
							[0.065, v1 - v0 + 0.07, 0.1],
							0.04,
							colour
						);
					this.box(
						world(mid, v1),
						axis,
						out,
						[width + 0.09, 0.065, 0.1],
						0.04,
						colour
					);
					this.box(
						world(mid, v0),
						axis,
						out,
						[width + 0.09, 0.065, 0.1],
						0.04,
						colour
					);
					this.box(
						world(mid, v0 - 0.045),
						axis,
						out,
						[width + 0.2, 0.075, 0.22],
						0.08,
						colour
					);
					this.count++;
					onWall++;
				}
		}
		return this.count - before;
	}

	private box(
		centre: V,
		axis: V,
		out: V,
		size: V,
		offset: number,
		colour: THREE.Color,
		slope = 0
	) {
		const signs = [
			[-1, -1, -1],
			[1, -1, -1],
			[1, 1, -1],
			[-1, 1, -1],
			[-1, -1, 1],
			[1, -1, 1],
			[1, 1, 1],
			[-1, 1, 1]
		];
		const corners = signs.map(
			([u, v, n]) =>
				centre.map(
					(x, k) =>
						x +
						(axis[k] * u * size[0]) / 2 +
						(k === 1 ? (v * size[1]) / 2 - (n + 1) * slope / 2 : 0) +
						out[k] * (offset + (n * size[2]) / 2)
				) as V
		);
		const handed = axis[0] * out[2] - axis[2] * out[0];
		for (const quad of [
			[4, 5, 6, 7],
			[1, 0, 3, 2],
			[0, 4, 7, 3],
			[5, 1, 2, 6],
			[3, 7, 6, 2],
			[0, 1, 5, 4]
		]) {
			const order = handed > 0 ? quad : [quad[0], quad[3], quad[2], quad[1]];
			const [a, b, c] = order.map((i) => new THREE.Vector3(...corners[i]));
			const n = new THREE.Vector3()
				.subVectors(b, a)
				.cross(new THREE.Vector3().subVectors(c, a))
				.normalize();
			for (const k of [0, 1, 2, 0, 2, 3]) {
				this.positions.push(...corners[order[k]]);
				this.normals.push(n.x, n.y, n.z);
				this.colours.push(colour.r, colour.g, colour.b);
			}
		}
	}
	mesh(): MeshData | null {
		return this.count
			? {
					kind: 'facadeRelief',
					position: new Float32Array(this.positions),
					normal: new Float32Array(this.normals),
					color: new Float32Array(this.colours)
				}
			: null;
	}
}

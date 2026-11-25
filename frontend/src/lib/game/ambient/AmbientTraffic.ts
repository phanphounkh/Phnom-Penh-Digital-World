import * as THREE from 'three';
import type { CityController } from '$lib/game/city/CityEngine';
import { createCharacter, type GameCharacter, type Mount } from '$lib/game/avatar/character';
import { keeperFor, turnTowards } from '$lib/game/shop/Shopkeepers';
import { npcFaceFor } from '$lib/game/avatar/npcIdentity';
import { createVehicle, type VehicleInstance } from '$lib/game/vehicles/VehicleModels';
import { HANDLING, type VehicleKind } from '$lib/game/vehicles/specs';
import { moveCircle } from '$lib/game/city/collision';
import {
	laneClear,
	lanePosition,
	nearbyTrafficRoutes,
	playerAhead,
	trafficRoute,
	type TrafficRoute
} from './trafficRoutes';
interface Rider {
	vehicle: VehicleInstance;
	character: GameCharacter;
	mount: Mount;
	route: TrafficRoute;
	along: number;
	speed: number;
	wheel: number;
	wait: number;
	endWait: number;
	braking: boolean;
}
/** One nearby decorative rider at a time, disabled in Low; no player vehicles or wallets touched. */
export class AmbientTraffic {
	private rider: Rider | null = null;
	private pending = false;
	private generation = 0;
	private disposed = false;
	private clock = 0;
	private nextKind: VehicleKind = 'motorbike';
	private moved = 0;
	private brakes = 0;
	private completed = 0;
	private owner = 'ambient-traffic-rider';
	constructor(private city: CityController) {}
	private remove(): void {
		this.generation++;
		this.pending = false;
		this.city.collision.removeOwner(this.owner);
		if (this.rider) {
			this.rider.mount.detach(null);
			this.rider.character.dispose();
			this.rider.vehicle.dispose();
			this.rider = null;
		}
	}
	private async spawn(route: TrafficRoute, kind: VehicleKind): Promise<void> {
		const generation = ++this.generation;
		this.pending = true;
		let vehicle: VehicleInstance | null = null,
			character: GameCharacter | null = null;
		try {
			vehicle = await createVehicle(kind, kind === 'motorbike' ? '#292b29' : '#38685b');
			if (this.disposed || generation !== this.generation) {
				vehicle.dispose();
				return;
			}
			const person = keeperFor({
				id: `rider:${route.key}`,
				accent_color: '#64747c'
			});
			character = await createCharacter(person.avatar, {
				npcFace: npcFaceFor(route.key)
			});
			if (this.disposed || generation !== this.generation) {
				character.dispose();
				vehicle.dispose();
				return;
			}
			const holder = new THREE.Group();
			holder.add(character.root);
			const mount = character.mount(vehicle, holder);
			const me = this.city.localState();
			let nearest = 0,
				best = Infinity;
			for (let at = 0; at < route.length - 5; at += 2) {
				const p = lanePosition(route, at),
					d = Math.hypot(p.x - me.x, p.z - me.z);
				if (d < best) {
					best = d;
					nearest = at;
				}
			}
			let along = Math.max(0, nearest - 22),
				p = lanePosition(route, along);
			if (Math.hypot(p.x - me.x, p.z - me.z) < 12) {
				along = Math.min(route.length - 8, nearest + 18);
				p = lanePosition(route, along);
			}
			if (Math.hypot(p.x - me.x, p.z - me.z) < 8) {
				character.dispose();
				vehicle.dispose();
				return;
			}
			vehicle.root.position.set(p.x, this.city.terrain.height(p.x, p.z), p.z);
			vehicle.root.rotation.y = p.yaw;
			this.city.scene.add(vehicle.root);
			this.rider = {
				vehicle,
				character,
				mount,
				route,
				along,
				speed: 0,
				wheel: 0,
				wait: 1,
				endWait: 0,
				braking: false
			};
			vehicle.pose(0, 0, 0);
			character.animations.update(0.016, 0);
			mount.update(0.016, 0);
		} catch {
			character?.dispose();
			vehicle?.dispose();
		} finally {
			if (generation === this.generation) this.pending = false;
		}
	}
	update(dt: number): void {
		if (this.disposed) return;
		if (this.city.quality === 'low') {
			if (this.rider || this.pending) this.remove();
			return;
		}
		const me = this.city.localState();
		this.clock -= dt;
		const rider = this.rider;
		if (rider) {
			const root = rider.vehicle.root,
				p = root.position;
			if (Math.hypot(p.x - me.x, p.z - me.z) > 110) {
				this.nextKind = rider.vehicle.kind === 'bicycle' ? 'motorbike' : 'bicycle';
				this.remove();
				return;
			}
			this.city.collision.removeOwner(this.owner);
			const elapsed = Math.min(dt, 0.1),
				look = lanePosition(rider.route, rider.along + Math.max(3, rider.speed * 1.4));
			const obstacle =
				moveCircle(this.city.collision, p.x, p.z, look.x - p.x, look.z - p.z, 0.6).blocked ||
				!!this.city.collision.containing(look.x, look.z);
			const player = playerAhead([p.x, p.z], [look.x, look.z], [me.x, me.z], this.city.riding ? 2 : 1.4);
			rider.wait = Math.max(0, rider.wait - elapsed);
			const braking = obstacle || player || rider.wait > 0 || rider.along >= rider.route.length - 0.5;
			if (braking && !rider.braking) this.brakes++;
			rider.braking = braking;
			const target = braking ? 0 : rider.route.speed;
			rider.speed = THREE.MathUtils.lerp(rider.speed, target, 1 - Math.exp(-elapsed * (braking ? 8 : 1.4)));
			const nextAlong = Math.min(rider.route.length, rider.along + rider.speed * elapsed),
				next = lanePosition(rider.route, nextAlong);
			const move = moveCircle(this.city.collision, p.x, p.z, next.x - p.x, next.z - p.z, 0.6);
			if (!move.blocked && !this.city.collision.containing(move.x, move.z)) {
				const travel = Math.hypot(move.x - p.x, move.z - p.z);
				p.set(move.x, this.city.terrain.height(move.x, move.z), move.z);
				rider.along = nextAlong;
				rider.wheel += travel / HANDLING[rider.vehicle.kind].wheelRadius;
				this.moved += travel;
			} else rider.speed = 0;
			const old = root.rotation.y;
			root.rotation.y = turnTowards(old, next.yaw, elapsed * 2);
			const turn = Math.atan2(Math.sin(next.yaw - old), Math.cos(next.yaw - old));
			rider.vehicle.pose(
				rider.wheel,
				THREE.MathUtils.clamp(turn, -0.35, 0.35),
				THREE.MathUtils.clamp(-turn * 0.3, -0.18, 0.18)
			);
			rider.character.animations.update(elapsed, 0);
			rider.mount.update(elapsed, rider.wheel);
			this.city.collision.addCircle(this.owner, p.x, p.z, 0.6);
			if (rider.along >= rider.route.length - 0.5) {
				rider.endWait += elapsed;
				if (rider.endWait > 2.5 && this.clock <= 0) {
					this.clock = 5;
					this.continueRoute(rider);
				}
			}
		} else if (!this.pending && this.clock <= 0) {
			this.clock = 6;
			const kind = this.nextKind,
				routes = nearbyTrafficRoutes(this.city.chunkData(), me.x, me.z, kind, this.city);
			if (routes[0]) void this.spawn(routes[0], kind);
		}
	}
	private continueRoute(rider: Rider): void {
		this.city.collision.removeOwner(this.owner);
		const p = rider.vehicle.root.position,
			end = lanePosition(rider.route, rider.route.length),
			direction = [Math.sin(end.yaw), Math.cos(end.yaw)];
		const options = nearbyTrafficRoutes(this.city.chunkData(), p.x, p.z, rider.vehicle.kind, this.city);
		for (const route of options) {
			if (route.key === rider.route.key) continue;
			const start = route.points[0],
				next = route.points[1];
			const gap = Math.hypot(start[0] - p.x, start[1] - p.z),
				dx = next[0] - start[0],
				dz = next[1] - start[1],
				length = Math.hypot(dx, dz);
			if (gap > 12 || (direction[0] * dx + direction[1] * dz) / length < -0.1) continue;
			const points: [[number, number], ...[number, number][]] = [[p.x, p.z], ...route.points];
			if (!laneClear(points, rider.vehicle.kind, this.city)) continue;
			rider.route = trafficRoute(route.key, points, route.speed);
			rider.along = 0;
			rider.endWait = 0;
			rider.wait = 1;
			this.completed++;
			return;
		}
		this.city.collision.addCircle(this.owner, p.x, p.z, 0.6);
	}
	diagnostics() {
		return {
			active: !!this.rider,
			pending: this.pending,
			kind: this.rider?.vehicle.kind ?? null,
			distance: this.moved,
			brakes: this.brakes,
			connections: this.completed,
			face: this.rider ? npcFaceFor(this.rider.route.key) : null,
			position: this.rider
				? {
						x: this.rider.vehicle.root.position.x,
						z: this.rider.vehicle.root.position.z,
						speed: this.rider.speed
					}
				: null
		};
	}
	dispose(): void {
		this.disposed = true;
		this.remove();
	}
}

import { npcFaceFor, npcSeed, npcWalkSpeed } from '$lib/game/avatar/npcIdentity';
import * as THREE from 'three';
import type { Shop } from '$lib/api/market';
import type { CityController } from '$lib/game/city/CityEngine';
import { createCharacter, type GameCharacter } from '$lib/game/avatar/character';
import { roundedLabel, disposeSprite } from '$lib/game/avatar/labels';
import { keeperFor, turnTowards } from '$lib/game/shop/Shopkeepers';
import { moveCircle, rayFraction } from '$lib/game/city/collision';
import { sidewalkRoutes, type WalkRoute } from './sidewalkRoutes';
interface Walker {
	route: WalkRoute;
	group: THREE.Group;
	character: GameCharacter | null;
	alive: boolean;
	progress: number;
	direction: number;
	wait: number;
	clock: number;
	bubble: THREE.Sprite | null;
	name: string;
	distance: number;
	pace: number;
	state: 'walking' | 'idle' | 'browsing' | 'talking' | 'jumping';
	nextPause: number;
	lift: number;
	vy: number;
	hopCooldown: number;
	bag: THREE.Group | null;
	browsed: boolean;
	shopTarget: { x: number; z: number } | null;
	shadow: THREE.Mesh;
	shopClock: number;
}
/** A bounded, local street population. Never uses random world-space spawn positions. */
export class StreetLife {
	private actors = new Map<string, Walker>();
	private planClock = 0;
	private disposed = false;
	private walked = 0;
	private greetings = 0;
	private hops = 0;
	private shopping = 0;
	private playerWasAirborne = false;
	private bagGeometry = new THREE.BoxGeometry(0.16, 0.22, 0.1);
	private handleGeometry = new THREE.TorusGeometry(0.045, 0.005, 4, 12, Math.PI);
	private bagMaterial = new THREE.MeshStandardMaterial({
		color: 0xa58052,
		roughness: 0.95
	});
	private bagParent = new THREE.Quaternion();
	private bagFacing = new THREE.Quaternion();
	private shadowGeometry = new THREE.PlaneGeometry(0.75, 0.75);
	private shadowMaterial: THREE.MeshBasicMaterial;
	constructor(
		private city: CityController,
		private shops: () => Shop[] = () => []
	) {
		this.shadowMaterial = new THREE.MeshBasicMaterial({
			color: 0x000000,
			map: city.materials.poolMap,
			transparent: true,
			opacity: 0.24,
			depthWrite: false,
			polygonOffset: true,
			polygonOffsetFactor: -2
		});
	}
	private owner(id: string) {
		return `street-life:${id}`;
	}
	private remove(id: string): void {
		const actor = this.actors.get(id);
		if (!actor) return;
		actor.alive = false;
		this.city.collision.removeOwner(this.owner(id));
		if (actor.bubble) disposeSprite(actor.bubble);
		actor.bag?.removeFromParent();
		actor.character?.root.removeFromParent();
		actor.character?.dispose();
		actor.group.removeFromParent();
		this.actors.delete(id);
	}
	private spawn(route: WalkRoute, index: number): void {
		const person = keeperFor({ id: route.id, accent_color: '#867251' });
		const group = new THREE.Group();
		group.name = 'ambient-street-neighbour';
		const shadow = new THREE.Mesh(this.shadowGeometry, this.shadowMaterial);
		shadow.rotation.x = -Math.PI / 2;
		shadow.position.y = 0.06;
		group.add(shadow);
		const progress = index % 2 ? 0.7 : 0.25;
		const x = THREE.MathUtils.lerp(route.a[0], route.b[0], progress),
			z = THREE.MathUtils.lerp(route.a[1], route.b[1], progress);
		group.position.set(x, this.city.terrain.height(x, z), z);
		this.city.scene.add(group);
		const actor: Walker = {
			route,
			group,
			character: null,
			alive: true,
			progress,
			direction: index % 2 ? -1 : 1,
			wait: index * 0.5,
			clock: 0,
			bubble: null,
			name: person.name,
			distance: 100,
			pace: npcWalkSpeed(route.id),
			state: 'walking',
			nextPause: 8 + (npcSeed(route.id) % 9),
			lift: 0,
			vy: 0,
			hopCooldown: 0,
			bag: null,
			browsed: false,
			shopTarget: null,
			shadow,
			shopClock: (npcSeed(route.id) % 20) / 10
		};
		this.actors.set(route.id, actor);
		void createCharacter(person.avatar, { npcFace: npcFaceFor(route.id) })
			.then((character) => {
				if (!actor.alive || this.disposed) {
					character.dispose();
					return;
				}
				actor.character = character;
				group.add(character.root);
				this.city.collision.addCircle(this.owner(route.id), x, z, 0.3);
			})
			.catch(() => {
				if (this.actors.get(route.id) === actor) this.remove(route.id);
			});
	}
	update(dt: number): void {
		if (this.disposed) return;
		const me = this.city.localState(),
			limit = this.city.quality === 'low' ? 1 : this.city.quality === 'medium' ? 2 : 3;
		if (this.city.airborne && !this.playerWasAirborne) this.jumpNearby();
		this.playerWasAirborne = this.city.airborne;
		this.planClock -= dt;
		for (const [id, actor] of this.actors) {
			actor.distance = Math.hypot(actor.group.position.x - me.x, actor.group.position.z - me.z);
			if (actor.distance > 65 || this.actors.size > limit) {
				this.remove(id);
				continue;
			}
			if (!actor.character) continue;
			actor.clock += dt;
			const tick = actor.distance < 20 ? 1 / 30 : 1 / 12;
			if (actor.clock < tick) continue;
			const elapsed = Math.min(actor.clock, 0.15);
			actor.clock = 0;
			this.city.collision.removeOwner(this.owner(id));
			if (this.city.collision.containing(actor.group.position.x, actor.group.position.z)) {
				this.remove(id);
				continue;
			}
			actor.wait = Math.max(0, actor.wait - elapsed);
			actor.hopCooldown = Math.max(0, actor.hopCooldown - elapsed);
			if (actor.state === 'jumping') {
				actor.vy -= 9.8 * elapsed;
				actor.lift = Math.max(0, actor.lift + actor.vy * elapsed);
				if (actor.lift === 0) {
					actor.vy = 0;
					actor.state = 'idle';
					actor.wait = 0.5;
				}
			} else if (actor.state === 'browsing' && actor.wait === 0) {
				this.giveBag(actor);
				this.shopping++;
				actor.browsed = true;
				actor.state = 'walking';
			} else if ((actor.state === 'talking' || actor.state === 'idle') && actor.wait === 0) actor.state = 'walking';
			if (actor.state === 'walking') {
				actor.nextPause -= elapsed;
				actor.shopClock -= elapsed;
				const target = !actor.browsed && actor.shopClock <= 0 ? this.shopNear(actor) : null;
				if (actor.shopClock <= 0) actor.shopClock = 1.5;
				if (target) {
					actor.shopTarget = target;
					actor.state = 'browsing';
					actor.wait = 4 + (npcSeed(id) % 3);
				} else if (actor.nextPause <= 0) {
					actor.state = 'idle';
					actor.wait = 1.2 + (npcSeed(id) % 4) * 0.5;
					actor.nextPause = 10 + (npcSeed(id) % 12);
				}
			}
			let travel = 0;
			if (actor.state === 'walking' && actor.wait === 0 && actor.distance > 1.3) {
				const length = Math.hypot(actor.route.b[0] - actor.route.a[0], actor.route.b[1] - actor.route.a[1]);
				const next = THREE.MathUtils.clamp(actor.progress + (actor.direction * elapsed * actor.pace) / length, 0, 1);
				const x = THREE.MathUtils.lerp(actor.route.a[0], actor.route.b[0], next),
					z = THREE.MathUtils.lerp(actor.route.a[1], actor.route.b[1], next);
				const p = actor.group.position,
					moved = moveCircle(this.city.collision, p.x, p.z, x - p.x, z - p.z, 0.3);
				if (moved.blocked || this.city.collision.containing(moved.x, moved.z)) {
					actor.direction *= -1;
					actor.wait = 1.5;
				} else {
					travel = Math.hypot(x - p.x, z - p.z);
					p.set(x, this.city.terrain.height(x, z), z);
					actor.progress = next;
					this.walked += travel;
					const target = Math.atan2(
						(actor.route.b[0] - actor.route.a[0]) * actor.direction,
						(actor.route.b[1] - actor.route.a[1]) * actor.direction
					);
					actor.group.rotation.y = turnTowards(actor.group.rotation.y, target, elapsed * 4);
				}
				if (next === 0 || next === 1) {
					actor.direction *= -1;
					actor.wait = 1.5 + (npcSeed(id) % 3);
					actor.state = 'idle';
				}
			} else if (actor.state === 'browsing' && actor.shopTarget) {
				actor.group.rotation.y = turnTowards(
					actor.group.rotation.y,
					Math.atan2(actor.shopTarget.x - actor.group.position.x, actor.shopTarget.z - actor.group.position.z),
					elapsed * 2
				);
			} else if (actor.distance < 3) {
				actor.group.rotation.y = turnTowards(
					actor.group.rotation.y,
					Math.atan2(me.x - actor.group.position.x, me.z - actor.group.position.z),
					elapsed * 3
				);
			}
			if (actor.wait === 0 && actor.bubble) {
				disposeSprite(actor.bubble);
				actor.bubble = null;
			}
			actor.group.position.y = this.city.terrain.height(actor.group.position.x, actor.group.position.z) + actor.lift;
			actor.shadow.position.y = 0.06 - actor.lift;
			actor.character.animations.airborne?.(actor.lift > 0, actor.vy);
			actor.character.animations.posture?.(actor.state === 'browsing' ? 'Talk' : null);
			actor.character.animations.update(elapsed, travel / elapsed, !!actor.bag, false, null, travel);
			if (actor.bag?.parent) {
				actor.bag.parent.getWorldQuaternion(this.bagParent);
				actor.group.getWorldQuaternion(this.bagFacing);
				actor.bag.quaternion.copy(this.bagParent.invert().multiply(this.bagFacing));
			}
			actor.character.emotes.update(elapsed, travel > 0.01);
			this.city.collision.addCircle(this.owner(id), actor.group.position.x, actor.group.position.z, 0.3);
		}
		if (this.planClock <= 0) {
			this.planClock = 4;
			if (this.actors.size < limit) {
				const routes = sidewalkRoutes(this.city.chunkData(), me.x, me.z, this.city.collision, this.city.terrain);
				for (const route of routes) {
					if (this.actors.size >= limit) break;
					if (this.actors.has(route.id)) continue;
					const mx = (route.a[0] + route.b[0]) / 2,
						mz = (route.a[1] + route.b[1]) / 2;
					if ([...this.actors.values()].some((a) => Math.hypot(a.group.position.x - mx, a.group.position.z - mz) < 9))
						continue;
					this.spawn(route, this.actors.size);
				}
			}
		}
	}
	private shopNear(actor: Walker): { x: number; z: number } | null {
		const p = actor.group.position;
		const shop = this.shops().find((s) => s.is_open && Math.hypot(s.unit.door_x - p.x, s.unit.door_z - p.z) < 4.5);
		if (shop) return { x: shop.unit.door_x, z: shop.unit.door_z };
		// Generic storefronts are decorative approximations; this does not place a marketplace order.
		for (const chunk of this.city.chunkData())
			for (const b of chunk.buildings ?? []) {
				if (!['yes', 'retail', 'commercial', 'residential', 'house'].includes(b.kind) || b.h > 30 || b.roof || b.model)
					continue;
				for (const ring of b.polys.flat())
					for (let i = 0; i < ring.length; i++) {
						const a = ring[i],
							c = ring[(i + 1) % ring.length],
							dx = c[0] - a[0],
							dz = c[1] - a[1],
							length = dx * dx + dz * dz;
						const t = length ? Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.z - a[1]) * dz) / length)) : 0;
						const x = a[0] + dx * t,
							z = a[1] + dz * t;
						if (Math.hypot(x - p.x, z - p.z) < 2.2) return { x, z };
					}
			}
		return null;
	}
	private giveBag(actor: Walker): void {
		const wrist = actor.character?.root.getObjectByName('RightWrist');
		if (!wrist) return;
		const bag = new THREE.Group();
		bag.name = 'npc-shopping-bag';
		const body = new THREE.Mesh(this.bagGeometry, this.bagMaterial);
		body.position.y = -0.19;
		bag.add(body);
		const handle = new THREE.Mesh(this.handleGeometry, this.bagMaterial);
		handle.position.y = -0.075;
		bag.add(handle);
		wrist.add(bag);
		actor.bag = bag;
	}
	jumpNearby(): boolean {
		const target = this.nearest();
		if (!target || this.city.riding) return false;
		const actor = this.actors.get(target.id)!;
		if (actor.hopCooldown > 0 || actor.bag || actor.state === 'browsing') return false;
		actor.character?.emotes.stop?.();
		actor.state = 'jumping';
		actor.vy = 2.5;
		actor.lift = 0.01;
		actor.hopCooldown = 8;
		this.hops++;
		return true;
	}
	nearest(): { id: string; name: string } | null {
		const actor = [...this.actors.values()]
			.filter((a) => {
				if (!a.character || a.distance >= 3) return false;
				const me = this.city.localState();
				return (
					rayFraction(
						this.city.collision,
						me.x,
						this.city.terrain.height(me.x, me.z) + 1.4,
						me.z,
						a.group.position.x,
						a.group.position.y + 1.4,
						a.group.position.z
					) > 0.98
				);
			})
			.sort((a, b) => a.distance - b.distance)[0];
		return actor ? { id: actor.route.id, name: actor.name } : null;
	}
	greet(): boolean {
		const nearest = this.nearest();
		if (!nearest || this.city.riding) return false;
		const actor = this.actors.get(nearest.id)!;
		if (actor.wait > 3 || actor.state === 'jumping') return false;
		if (actor.bubble) disposeSprite(actor.bubble);
		actor.bubble = roundedLabel(
			[
				{
					text: 'សួស្តី! Hello, neighbour.',
					font: '600 22px sans-serif',
					color: '#fff4d7'
				}
			],
			'#123b3a'
		);
		actor.bubble.scale.multiplyScalar(0.6);
		actor.bubble.position.y = 2.15;
		actor.group.add(actor.bubble);
		actor.wait = 5;
		actor.state = 'talking';
		actor.character?.emotes.play('sampeah');
		this.greetings++;
		return true;
	}
	diagnostics() {
		return {
			actors: [...this.actors.values()].filter((a) => !!a.character).length,
			pending: [...this.actors.values()].filter((a) => !a.character).length,
			walkedMeters: this.walked,
			greetings: this.greetings,
			hops: this.hops,
			shopping: this.shopping,
			routes: [...this.actors.values()].map((a) => ({
				id: a.route.id,
				a: a.route.a,
				b: a.route.b,
				x: a.group.position.x,
				z: a.group.position.z,
				face: npcFaceFor(a.route.id),
				model: a.character?.root.name,
				state: a.state,
				lift: a.lift,
				bag: !!a.bag,
				pace: a.pace
			}))
		};
	}
	dispose(): void {
		this.disposed = true;
		for (const id of [...this.actors.keys()]) this.remove(id);
		this.shadowGeometry.dispose();
		this.shadowMaterial.dispose();
		this.bagGeometry.dispose();
		this.handleGeometry.dispose();
		this.bagMaterial.dispose();
	}
}

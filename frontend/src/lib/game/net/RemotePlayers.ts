/**
 * Other players in the world: avatars built from their customisation, interpolated movement,
 * gait animation, emotes, name tags and chat bubbles. Everything here is cosmetic — the server
 * decides who exists and where.
 */
import * as THREE from 'three';
import { createCharacter, type GameCharacter, type Mount } from '$lib/game/avatar/character';
import { disposeSprite, roundedLabel, speechBubble } from '$lib/game/avatar/labels';
import type { Terrain } from '$lib/game/city/terrain';
import { createVehicle, type VehicleInstance } from '$lib/game/vehicles/VehicleModels';
import { HANDLING } from '$lib/game/vehicles/specs';
import { Interpolator } from './Interpolator';
import type { EmoteName, PlayerCard, PlayerState, RideCard } from './protocol';

const TAG_DISTANCE = 45;
const BUBBLE_MS = 6000;

interface Remote {
	card: PlayerCard;
	interp: Interpolator;
	group: THREE.Group;
	character?: GameCharacter;
	/** Bumped when the avatar is (re)built, so a slow load cannot replace a newer one. */
	avatarToken: number;
	tag: THREE.Sprite;
	bubble?: { sprite: THREE.Sprite; until: number };
	x: number;
	z: number;
	/** The storey of the building they are in (0: the ground floor or outside). */
	level: number;
	removed: boolean;
	/** Riding (Phase 5): the vehicle, the rider rig and the visual state derived from motion. */
	vehicle?: VehicleInstance;
	rider?: Mount;
	rideToken: number;
	yaw: number;
	wheel: number;
	lean: number;
	steer: number;
}

export interface RemoteSummary {
	id: number;
	username: string;
	name: string;
	distance: number;
	x: number;
	z: number;
}

export class RemotePlayers {
	private players = new Map<number, Remote>();

	constructor(
		private scene: THREE.Scene,
		private terrain: Terrain
	) {}

	get count(): number {
		return this.players.size;
	}

	spawn(card: PlayerCard): void {
		this.despawn(card.id);
		const group = new THREE.Group();
		group.name = `remote:${card.u}`;
		const tag = roundedLabel(
			[
				{ text: card.n, font: '600 30px Inter, "Noto Sans Khmer", sans-serif', color: '#f6f1e6' },
				{ text: `@${card.u}`, font: '400 22px Inter, sans-serif', color: '#bfe0d8' }
			],
			'rgba(11,37,36,0.78)'
		);
		tag.position.y = 2.15;
		group.add(tag);
		const remote: Remote = {
			card, interp: new Interpolator(), group, tag, x: card.x, z: card.z, level: card.l ?? 0, removed: false,
			rideToken: 0, avatarToken: 0, yaw: card.yaw, wheel: 0, lean: 0, steer: 0
		};
		remote.interp.push({ t: performance.now(), x: card.x, z: card.z, yaw: card.yaw, s: 0 });
		group.position.set(card.x, this.ground(card.x, card.z, remote.level), card.z);
		this.scene.add(group);
		this.players.set(card.id, remote);
		this.dress(remote);
	}

	/** Load (or reload, after a style change) a remote player's avatar. */
	private dress(remote: Remote): void {
		const token = ++remote.avatarToken;
		createCharacter(remote.card.av).then((character) => {
			if (remote.removed || token !== remote.avatarToken) return character.dispose();
			const wasRiding = !!remote.rider;
			if (wasRiding) this.dismount(remote);
			remote.character?.dispose();
			remote.character = character;
			character.root.traverse((n) => ((n as THREE.Mesh).castShadow = false));
			character.root.rotation.y = remote.yaw;
			remote.group.add(character.root);
			if (remote.card.v) this.mount(remote, remote.card.v);
		});
	}

	/** A player got on (v) or off (null) a vehicle. */
	ride(id: number, v: RideCard | null): void {
		const remote = this.players.get(id);
		if (!remote) return;
		remote.card = { ...remote.card, v: v ?? undefined };
		if (!remote.character) return; // mounted once the avatar has loaded
		if (v) this.mount(remote, v);
		else this.dismount(remote);
	}

	get ridingCount(): number {
		let n = 0;
		for (const r of this.players.values()) if (r.card.v) n++;
		return n;
	}

	private mount(remote: Remote, v: RideCard): void {
		this.dismount(remote);
		const token = ++remote.rideToken;
		createVehicle(v.k, v.c).then((instance) => {
			const character = remote.character;
			if (remote.removed || token !== remote.rideToken || !character) return instance.dispose();
			remote.vehicle = instance;
			remote.group.add(instance.root);
			character.emotes.stop();
			remote.rider = character.mount(instance, character.root);
			remote.tag.position.y = 2.4;
		});
	}

	private dismount(remote: Remote): void {
		remote.rideToken++;
		remote.rider?.detach(remote.group);
		remote.rider = undefined;
		remote.vehicle?.dispose();
		remote.vehicle = undefined;
		remote.tag.position.y = 2.15;
		remote.lean = remote.steer = 0;
	}

	despawn(id: number): void {
		const remote = this.players.get(id);
		if (!remote) return;
		remote.removed = true;
		this.dismount(remote);
		remote.character?.dispose();
		disposeSprite(remote.tag);
		if (remote.bubble) disposeSprite(remote.bubble.sprite);
		remote.group.removeFromParent();
		this.players.delete(id);
	}

	state(entries: PlayerState[]): void {
		const now = performance.now();
		for (const [id, x, z, yaw, s, l] of entries) {
			const remote = this.players.get(id);
			if (!remote) continue;
			remote.interp.push({ t: now, x, z, yaw, s });
			remote.level = l ?? 0;
		}
	}

	emote(id: number, e: EmoteName): void {
		this.players.get(id)?.character?.emotes.play(e);
	}

	say(id: number, text: string): void {
		const remote = this.players.get(id);
		if (!remote) return;
		if (remote.bubble) disposeSprite(remote.bubble.sprite);
		const sprite = speechBubble(text);
		sprite.position.y = 2.55 + sprite.scale.y / 2;
		remote.group.add(sprite);
		remote.bubble = { sprite, until: performance.now() + BUBBLE_MS };
	}

	/** No name tags (the wardrobe: a close view of the player's own avatar). */
	hideTags = false;

	/** Floors that differ from the terrain (enterable buildings, on a storey): a height, or null. */
	groundAt: ((x: number, z: number, storey: number) => number | null) | null = null;

	private ground(x: number, z: number, storey: number): number {
		return this.groundAt?.(x, z, storey) ?? this.terrain.height(x, z);
	}

	/** A remote player's storey (inspection and tests). */
	storeyOf(id: number): number | null {
		return this.players.get(id)?.level ?? null;
	}

	update(dt: number, viewer: THREE.Vector3): void {
		const now = performance.now();
		for (const remote of this.players.values()) {
			const snap = remote.interp.sample(now);
			if (!snap) continue;
			const travel = Math.hypot(snap.x - remote.x, snap.z - remote.z);
			remote.x = snap.x;
			remote.z = snap.z;
			remote.group.position.set(snap.x, this.ground(snap.x, snap.z, remote.level), snap.z);
			if (remote.vehicle && remote.rider) {
				// Riding: wheels from the distance covered, steering and lean from the turn rate.
				const kind = remote.vehicle.kind;
				const h = HANDLING[kind];
				let turn = snap.yaw - remote.yaw;
				turn = Math.atan2(Math.sin(turn), Math.cos(turn));
				const yawRate = dt > 0 ? turn / dt : 0;
				const speed = dt > 0 ? Math.min(travel / dt, 20) : 0;
				const k = 1 - Math.exp(-dt * 6);
				remote.wheel += travel / h.wheelRadius;
				remote.lean += (Math.max(-h.maxLean, Math.min(h.maxLean, Math.atan((speed * -yawRate) / 9.81))) - remote.lean) * k;
				remote.steer += (Math.atan((h.wheelbase * -yawRate) / Math.max(speed, 1)) - remote.steer) * k;
				remote.vehicle.root.rotation.y = snap.yaw;
				remote.vehicle.pose(remote.wheel, remote.steer, remote.lean);
				remote.rider.update(dt, remote.wheel);
			} else {
				const character = remote.character;
				if (character) {
					character.root.rotation.y = snap.yaw;
					const speed = dt > 0 ? Math.min(travel / dt, 8) : 0;
					character.animations.update(dt, speed, false, false, null, travel, 1);
					character.emotes.update(dt, speed > 0.3);
				}
			}
			remote.yaw = snap.yaw;
			remote.tag.visible = !this.hideTags && remote.group.position.distanceTo(viewer) < TAG_DISTANCE;
			if (remote.bubble && now > remote.bubble.until) {
				disposeSprite(remote.bubble.sprite);
				remote.bubble = undefined;
			}
		}
	}

	list(fromX: number, fromZ: number): RemoteSummary[] {
		return [...this.players.entries()]
			.map(([id, r]) => ({ id, username: r.card.u, name: r.card.n, x: r.x, z: r.z, distance: Math.hypot(r.x - fromX, r.z - fromZ) }))
			.sort((a, b) => a.distance - b.distance);
	}

	clear(): void {
		for (const id of [...this.players.keys()]) this.despawn(id);
	}
}

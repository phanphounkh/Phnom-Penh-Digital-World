/**
 * Other players in the world: avatars built from their customisation, interpolated movement,
 * gait animation, emotes, name tags and chat bubbles. Everything here is cosmetic — the server
 * decides who exists and where.
 */
import * as THREE from 'three';
import { createAvatar, type AvatarInstance } from '$lib/game/avatar/avatar';
import { EmotePlayer } from '$lib/game/avatar/emotes';
import { PlayerAnimations } from '$lib/game/player/PlayerAnimations.js';
import type { Terrain } from '$lib/game/city/terrain';
import { Interpolator } from './Interpolator';
import type { EmoteName, PlayerCard, PlayerState } from './protocol';

const TAG_DISTANCE = 45;
const BUBBLE_MS = 6000;

interface Remote {
	card: PlayerCard;
	interp: Interpolator;
	group: THREE.Group;
	avatar?: AvatarInstance;
	animations?: PlayerAnimations;
	emotes?: EmotePlayer;
	tag: THREE.Sprite;
	bubble?: { sprite: THREE.Sprite; until: number };
	x: number;
	z: number;
	removed: boolean;
}

export interface RemoteSummary {
	id: number;
	username: string;
	name: string;
	distance: number;
	x: number;
	z: number;
}

function roundedLabel(lines: { text: string; font: string; color: string }[], bg: string, pad = 22) {
	const c = document.createElement('canvas');
	const g = c.getContext('2d')!;
	const widths = lines.map((l) => {
		g.font = l.font;
		return g.measureText(l.text).width;
	});
	const lineH = 44;
	c.width = Math.ceil(Math.max(...widths) + pad * 2);
	c.height = lineH * lines.length + pad;
	g.fillStyle = bg;
	g.beginPath();
	g.roundRect(0, 0, c.width, c.height, 22);
	g.fill();
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	lines.forEach((l, i) => {
		g.font = l.font;
		g.fillStyle = l.color;
		g.fillText(l.text, c.width / 2, pad / 2 + lineH * (i + 0.5));
	});
	const texture = new THREE.CanvasTexture(c);
	texture.colorSpace = THREE.SRGBColorSpace;
	const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true }));
	sprite.scale.set(c.width * 0.0075, c.height * 0.0075, 1);
	sprite.renderOrder = 20;
	return sprite;
}

function wrap(text: string, max = 34): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let line = '';
	for (const w of words) {
		if ((line + ' ' + w).trim().length > max && line) {
			lines.push(line);
			line = w;
		} else line = (line + ' ' + w).trim();
	}
	if (line) lines.push(line);
	return lines.slice(0, 4);
}

function disposeSprite(s: THREE.Sprite) {
	s.material.map?.dispose();
	s.material.dispose();
	s.removeFromParent();
}

export class RemotePlayers {
	private players = new Map<number, Remote>();

	constructor(private scene: THREE.Scene, private terrain: Terrain) {}

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
		const remote: Remote = { card, interp: new Interpolator(), group, tag, x: card.x, z: card.z, removed: false };
		remote.interp.push({ t: performance.now(), x: card.x, z: card.z, yaw: card.yaw, s: 0 });
		group.position.set(card.x, this.terrain.height(card.x, card.z), card.z);
		this.scene.add(group);
		this.players.set(card.id, remote);
		createAvatar(card.av, { batch: true }).then((avatar) => {
			if (remote.removed) return avatar.dispose();
			remote.avatar = avatar;
			remote.animations = new PlayerAnimations(avatar.root);
			remote.emotes = new EmotePlayer(avatar.root);
			avatar.root.traverse((n) => ((n as THREE.Mesh).castShadow = false));
			group.add(avatar.root);
		});
	}

	despawn(id: number): void {
		const remote = this.players.get(id);
		if (!remote) return;
		remote.removed = true;
		remote.animations?.dispose();
		remote.avatar?.dispose();
		disposeSprite(remote.tag);
		if (remote.bubble) disposeSprite(remote.bubble.sprite);
		remote.group.removeFromParent();
		this.players.delete(id);
	}

	state(entries: PlayerState[]): void {
		const now = performance.now();
		for (const [id, x, z, yaw, s] of entries) this.players.get(id)?.interp.push({ t: now, x, z, yaw, s });
	}

	emote(id: number, e: EmoteName): void {
		this.players.get(id)?.emotes?.play(e);
	}

	say(id: number, text: string): void {
		const remote = this.players.get(id);
		if (!remote) return;
		if (remote.bubble) disposeSprite(remote.bubble.sprite);
		const sprite = roundedLabel(
			wrap(text).map((line) => ({ text: line, font: '500 28px Inter, "Noto Sans Khmer", sans-serif', color: '#1d2422' })),
			'rgba(246,241,230,0.95)'
		);
		sprite.position.y = 2.55 + sprite.scale.y / 2;
		remote.group.add(sprite);
		remote.bubble = { sprite, until: performance.now() + BUBBLE_MS };
	}

	update(dt: number, viewer: THREE.Vector3): void {
		const now = performance.now();
		for (const remote of this.players.values()) {
			const snap = remote.interp.sample(now);
			if (!snap) continue;
			const travel = Math.hypot(snap.x - remote.x, snap.z - remote.z);
			remote.x = snap.x;
			remote.z = snap.z;
			remote.group.position.set(snap.x, this.terrain.height(snap.x, snap.z), snap.z);
			if (remote.avatar) remote.avatar.root.rotation.y = snap.yaw;
			const speed = dt > 0 ? Math.min(travel / dt, 8) : 0;
			remote.animations?.update(dt, speed, false, false, null, travel, 1);
			remote.emotes?.update(dt, speed > 0.3);
			remote.tag.visible = remote.group.position.distanceTo(viewer) < TAG_DISTANCE;
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

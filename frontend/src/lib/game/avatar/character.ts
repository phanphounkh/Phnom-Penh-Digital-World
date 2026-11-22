/**
 * One avatar in the world, whatever its style: model, gait animation, emotes and the vehicle
 * rider, behind one interface so CityEngine and RemotePlayers do not care which rig it is.
 *
 * - `realistic` (default): avatar-generator's MakeHuman-based characters (realistic.ts).
 * - `classic`: the original modular Blender avatar (avatar.ts) with every style option.
 * The style is a local display preference (like graphics quality): it changes how this browser
 * draws every avatar, not what other players see, and needs no server or database change.
 * If the realistic models cannot load, the classic avatar is used.
 */
import type * as THREE from 'three';
import type { Avatar } from '$lib/api/types';
import type { EmoteName } from '$lib/game/net/protocol';
import type { VehicleInstance } from '$lib/game/vehicles/VehicleModels';

export type AvatarStyle = 'realistic' | 'classic';
export const AVATAR_STYLES: AvatarStyle[] = ['realistic', 'classic'];
export const STYLE_KEY = 'ppw.avatarStyle';

export function loadAvatarStyle(): AvatarStyle {
	try {
		const v = globalThis.localStorage?.getItem(STYLE_KEY);
		if (v === 'realistic' || v === 'classic') return v;
	} catch {
		/* storage blocked: use the default */
	}
	return 'realistic';
}

export function saveAvatarStyle(style: AvatarStyle): void {
	try {
		globalThis.localStorage?.setItem(STYLE_KEY, style);
	} catch {
		/* storage blocked: the choice lasts for this page only */
	}
}

export interface Gait {
	update(dt: number, speed: number, holding?: boolean, picking?: boolean, targets?: null, travel?: number, direction?: number): void;
	/** Vertical state from the engine (jumping/falling); rigs without air clips ignore it. */
	airborne?(flying: boolean, vy: number): void;
	dispose(): void;
}

export interface Emotes {
	readonly playing: EmoteName | null;
	play(name: EmoteName): void;
	stop(): void;
	update(dt: number, moving: boolean): void;
}

export interface Mount {
	update(dt: number, wheel: number): void;
	detach(to?: THREE.Object3D | null): void;
}

export interface GameCharacter {
	/** The style actually in use (realistic falls back to classic if its models fail to load). */
	readonly style: AvatarStyle;
	readonly root: THREE.Object3D;
	readonly animations: Gait;
	readonly emotes: Emotes;
	/** Seat `holder` (the object that carries this avatar in the world) on a vehicle. */
	mount(vehicle: VehicleInstance, holder: THREE.Object3D): Mount;
	dispose(): void;
}

async function realisticCharacter(avatar: Avatar): Promise<GameCharacter> {
	const [{ createRealisticAvatar }, { RealisticAnimations, RealisticEmotes }, { RealisticRider }] = await Promise.all([
		import('./realistic'),
		import('./RealisticAnimations'),
		import('$lib/game/vehicles/RealisticRider')
	]);
	const instance = await createRealisticAvatar(avatar);
	const { entry } = instance;
	const animations = new RealisticAnimations(instance.root, instance.clips, { walk: entry.walk_speed, run: entry.run_speed, sprint: entry.sprint_speed }, entry.height_m);
	return {
		style: 'realistic',
		root: instance.root,
		animations,
		emotes: new RealisticEmotes(animations),
		mount: (vehicle, holder) => new RealisticRider(holder, animations, vehicle),
		dispose() {
			animations.dispose();
			instance.dispose();
		}
	};
}

async function classicCharacter(avatar: Avatar): Promise<GameCharacter> {
	const [{ createAvatar }, { PlayerAnimations }, { EmotePlayer }, { Rider }] = await Promise.all([
		import('./avatar'),
		import('$lib/game/player/PlayerAnimations.js'),
		import('./emotes'),
		import('$lib/game/vehicles/Rider')
	]);
	const instance = await createAvatar(avatar, { batch: true });
	const animations = new PlayerAnimations(instance.root);
	return {
		style: 'classic',
		root: instance.root,
		animations,
		emotes: new EmotePlayer(instance.root),
		mount: (vehicle, holder) => new Rider(holder, animations, vehicle),
		dispose() {
			animations.dispose();
			instance.dispose();
		}
	};
}

export async function createCharacter(avatar: Avatar, style: AvatarStyle): Promise<GameCharacter> {
	if (style === 'realistic') {
		try {
			return await realisticCharacter(avatar);
		} catch (error) {
			console.warn('Realistic avatar unavailable, using the classic one:', error);
		}
	}
	return classicCharacter(avatar);
}

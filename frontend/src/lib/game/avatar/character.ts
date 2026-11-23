/**
 * One avatar in the world, whatever its style: model, gait animation, emotes and the vehicle
 * rider, behind one interface so CityEngine and RemotePlayers do not care which rig it is.
 *
 * - `realistic`: avatar-generator's MakeHuman-based characters (realistic.ts), the game's look.
 * - `classic`: the original modular Blender avatar (avatar.ts), only drawn when the realistic
 *   models cannot load, so the game never ends up without avatars.
 */
import type * as THREE from 'three';
import type { Avatar } from '$lib/api/types';
import type { EmoteName } from '$lib/game/net/protocol';
import type { VehicleInstance } from '$lib/game/vehicles/VehicleModels';

export type AvatarStyle = 'realistic' | 'classic';

export interface Gait {
	update(dt: number, speed: number, holding?: boolean, picking?: boolean, targets?: null, travel?: number, direction?: number): void;
	/** Vertical state from the engine (jumping/falling); rigs without air clips ignore it. */
	airborne?(flying: boolean, vy: number): void;
	/** Hold a pose such as 'Sit' (null: back to the gait); rigs without it ignore it. */
	posture?(clip: string | null): void;
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
	/** Wear a changed avatar in place (colours, and parts where the model can); false when it
	 * has to be built again (another realistic build, or other classic parts). */
	update(avatar: Avatar): boolean;
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
		update: (next) => instance.update(next),
		dispose() {
			animations.dispose();
			instance.dispose();
		}
	};
}

async function classicCharacter(avatar: Avatar): Promise<GameCharacter> {
	const [{ createAvatar, selectedOptions }, { PlayerAnimations }, { EmotePlayer }, { Rider }] = await Promise.all([
		import('./avatar'),
		import('$lib/game/player/PlayerAnimations.js'),
		import('./emotes'),
		import('$lib/game/vehicles/Rider')
	]);
	const instance = await createAvatar(avatar, { batch: true });
	const animations = new PlayerAnimations(instance.root);
	// The world's classic avatar keeps only the parts it wears (merged per joint): colours
	// change in place, other parts need a new build.
	const parts = (a: Avatar) => [...selectedOptions(a)].sort().join(',');
	const wearing = parts(avatar);
	return {
		style: 'classic',
		root: instance.root,
		animations,
		emotes: new EmotePlayer(instance.root),
		mount: (vehicle, holder) => new Rider(holder, animations, vehicle),
		update(next) {
			if (parts(next) !== wearing) return false;
			instance.update(next);
			return true;
		},
		dispose() {
			animations.dispose();
			instance.dispose();
		}
	};
}

/** The realistic avatar, or the classic one if the realistic models cannot load. */
export async function createCharacter(avatar: Avatar): Promise<GameCharacter> {
	try {
		return await realisticCharacter(avatar);
	} catch (error) {
		console.warn('Realistic avatar unavailable, using the classic one:', error);
	}
	return classicCharacter(avatar);
}

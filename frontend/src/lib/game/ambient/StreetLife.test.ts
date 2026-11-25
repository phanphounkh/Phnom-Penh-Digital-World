import { expect, it, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { StreetLife } from './StreetLife';
import { createCharacter, type GameCharacter } from '$lib/game/avatar/character';
import { CollisionWorld } from '$lib/game/city/collision';
import { Terrain } from '$lib/game/city/terrain';
import type { CityController } from '$lib/game/city/CityEngine';
import type { ChunkPayload } from '$lib/api/types';
vi.mock('$lib/game/avatar/character', () => ({ createCharacter: vi.fn() }));
vi.mock('$lib/game/avatar/labels', () => ({
	roundedLabel: () => new THREE.Sprite(),
	disposeSprite: (s: THREE.Sprite) => s.removeFromParent()
}));
function person() {
	return {
		root: new THREE.Group(),
		animations: { update: vi.fn() },
		emotes: { update: vi.fn(), play: vi.fn() },
		dispose: vi.fn()
	} as unknown as GameCharacter;
}
function setup() {
	let position = { x: 50, z: 0, yaw: 0, speed: 0 };
	const raw = {
		scene: new THREE.Scene(),
		materials: { poolMap: new THREE.Texture() },
		terrain: new Terrain([]),
		collision: new CollisionWorld(),
		quality: 'medium',
		riding: null,
		localState: () => position,
		chunkData: () =>
			[
				{
					roads: [
						{
							id: 1,
							name: 'Mapped street',
							cls: 'residential',
							w: 8,
							bridge: false,
							layer: 0,
							af: 7,
							ab: 7,
							pts: [
								[0, 0],
								[100, 0]
							]
						}
					]
				}
			] as ChunkPayload[]
	};
	return {
		raw,
		life: new StreetLife(raw as unknown as CityController),
		move: (x: number, z: number) => (position = { ...position, x, z })
	};
}
beforeEach(() => {
	vi.mocked(createCharacter).mockReset();
});
it('caps population by quality, moves on the planned pavement, greets nearby players and cleans colliders', async () => {
	vi.mocked(createCharacter).mockImplementation(async () => person());
	const { life, raw, move } = setup();
	life.update(0.1);
	await Promise.resolve();
	expect(life.diagnostics().actors).toBe(2);
	for (let i = 0; i < 40; i++) life.update(0.1);
	expect(life.diagnostics().walkedMeters).toBeGreaterThan(1);
	const actor = life.diagnostics().routes[0];
	move(actor.x + 0.7, actor.z);
	life.update(0.1);
	expect(life.greet()).toBe(true);
	expect(life.diagnostics().greetings).toBe(1);
	expect(life.greet()).toBe(false);
	raw.quality = 'low';
	life.update(0.1);
	expect(life.diagnostics().actors).toBe(1);
	life.dispose();
	expect(raw.scene.children).toHaveLength(0);
	expect(raw.collision.ownerCount).toBe(0);
});
it('rejects stale character loads after the player leaves', async () => {
	const pending: ((p: GameCharacter) => void)[] = [];
	vi.mocked(createCharacter).mockImplementation(() => new Promise((r) => pending.push(r)));
	const { life, move, raw } = setup();
	life.update(0.1);
	move(1000, 1000);
	life.update(0.1);
	const people = pending.map(() => person());
	pending.forEach((done, i) => done(people[i]));
	await Promise.resolve();
	people.forEach((p) => expect(p.dispose).toHaveBeenCalled());
	expect(life.diagnostics().actors).toBe(0);
	expect(raw.collision.ownerCount).toBe(0);
	life.dispose();
});
it('responds to a nearby player jump with a bounded hop and landing', async () => {
	vi.mocked(createCharacter).mockImplementation(async () => person());
	const { life, move } = setup();
	life.update(0.1);
	await Promise.resolve();
	const actor = life.diagnostics().routes[0];
	move(actor.x + 0.7, actor.z);
	life.update(0.1);
	expect(life.jumpNearby()).toBe(true);
	expect(life.jumpNearby()).toBe(false);
	expect(life.greet()).toBe(false); // A greeting must not interrupt gravity and leave a floating NPC.
	for (let i = 0; i < 30; i++) life.update(0.05);
	expect(life.diagnostics().hops).toBe(1);
	expect(life.diagnostics().routes.every((a) => a.lift === 0)).toBe(true);
	life.dispose();
});
it('browses a nearby virtual shop and carries a bag without touching marketplace state', async () => {
	vi.mocked(createCharacter).mockImplementation(async () => {
		const p = person(),
			wrist = new THREE.Object3D();
		wrist.name = 'RightWrist';
		p.root.add(wrist);
		return p;
	});
	const f = setup();
	f.life.dispose();
	const life = new StreetLife(
		f.raw as unknown as CityController,
		() => [{ is_open: true, unit: { door_x: 44, door_z: -5 } }] as unknown as import('$lib/api/market').Shop[]
	);
	life.update(0.1);
	await Promise.resolve();
	for (let i = 0; i < 120; i++) life.update(0.1);
	expect(life.diagnostics().shopping).toBeGreaterThan(0);
	expect(life.diagnostics().routes.some((a) => a.bag)).toBe(true);
	life.dispose();
});

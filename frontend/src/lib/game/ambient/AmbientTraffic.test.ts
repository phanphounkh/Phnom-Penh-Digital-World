import { expect, it, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { AmbientTraffic } from './AmbientTraffic';
import { createCharacter, type GameCharacter } from '$lib/game/avatar/character';
import { createVehicle, type VehicleInstance } from '$lib/game/vehicles/VehicleModels';
import { CollisionWorld } from '$lib/game/city/collision';
import { RoadNetwork } from '$lib/game/vehicles/RoadNetwork';
import { Terrain } from '$lib/game/city/terrain';
import type { CityController } from '$lib/game/city/CityEngine';
import type { ChunkPayload } from '$lib/api/types';
vi.mock('$lib/game/avatar/character', () => ({ createCharacter: vi.fn() }));
vi.mock('$lib/game/vehicles/VehicleModels', () => ({ createVehicle: vi.fn() }));
function fixture() {
	let position = { x: 50, z: 8, yaw: 0, speed: 0 };
	const payload = {
		key: '0_0',
		roads: [
			{
				id: 1,
				name: 'Road',
				name_km: null,
				pts: [
					[0, 0],
					[100, 0]
				],
				cls: 'residential',
				w: 8,
				af: 7,
				ab: 7,
				bridge: false,
				layer: 0,
				oneway: false
			}
		],
		areas: []
	} as unknown as ChunkPayload;
	const network = new RoadNetwork();
	network.add(payload);
	const raw = {
		scene: new THREE.Scene(),
		terrain: new Terrain([]),
		collision: new CollisionWorld(),
		network,
		quality: 'medium',
		riding: null,
		localState: () => position,
		chunkData: () => [payload]
	};
	const vehicle = {
		kind: 'motorbike',
		root: new THREE.Group(),
		lean: new THREE.Group(),
		pose: vi.fn(),
		dispose: vi.fn(function (this: VehicleInstance) {
			this.root.removeFromParent();
		})
	} as unknown as VehicleInstance;
	const character = {
		root: new THREE.Group(),
		animations: { update: vi.fn() },
		mount: vi.fn(() => ({ update: vi.fn(), detach: vi.fn() })),
		dispose: vi.fn()
	} as unknown as GameCharacter;
	vi.mocked(createVehicle).mockResolvedValue(vehicle);
	vi.mocked(createCharacter).mockResolvedValue(character);
	return {
		raw,
		vehicle,
		character,
		traffic: new AmbientTraffic(raw as unknown as CityController),
		move: (x: number, z: number) => (position = { ...position, x, z })
	};
}
beforeEach(() => {
	vi.mocked(createVehicle).mockReset();
	vi.mocked(createCharacter).mockReset();
});
const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};
it('mounts one NPC rider, animates wheels while moving, brakes for the player, and clears in Low', async () => {
	const { traffic, raw, vehicle, character, move } = fixture();
	traffic.update(0.1);
	await flush();
	expect(traffic.diagnostics().active).toBe(true);
	expect(character.mount).toHaveBeenCalled();
	for (let i = 0; i < 150; i++) traffic.update(0.05);
	expect(traffic.diagnostics().distance).toBeGreaterThan(5);
	expect(vehicle.pose).toHaveBeenCalled();
	const p = traffic.diagnostics().position!;
	move(p.x + 2, p.z);
	const before = traffic.diagnostics().brakes;
	for (let i = 0; i < 30; i++) traffic.update(0.05);
	expect(traffic.diagnostics().brakes).toBeGreaterThan(before);
	raw.quality = 'low';
	traffic.update(0.1);
	expect(traffic.diagnostics().active).toBe(false);
	expect(vehicle.dispose).toHaveBeenCalled();
	expect(raw.collision.ownerCount).toBe(0);
	traffic.dispose();
});
it('disposes assets that load after the controller is removed', async () => {
	const f = fixture();
	let finish!: (v: VehicleInstance) => void;
	vi.mocked(createVehicle).mockImplementation(() => new Promise((r) => (finish = r)));
	f.traffic.update(0.1);
	f.traffic.dispose();
	finish(f.vehicle);
	await flush();
	expect(f.vehicle.dispose).toHaveBeenCalled();
	expect(createCharacter).not.toHaveBeenCalled();
});

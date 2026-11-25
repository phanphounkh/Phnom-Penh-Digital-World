import { expect, it } from 'vitest';
import type { ChunkPayload, ChunkRoad } from '$lib/api/types';
import { CollisionWorld } from '$lib/game/city/collision';
import { RoadNetwork } from '$lib/game/vehicles/RoadNetwork';
import { lanePosition, nearbyTrafficRoutes, playerAhead } from './trafficRoutes';
const road: ChunkRoad = {
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
};
function world(r: ChunkRoad) {
	const payload = {
		key: '0_0',
		roads: [r],
		areas: []
	} as unknown as ChunkPayload;
	const network = new RoadNetwork();
	network.add(payload);
	return { payload, city: { network, collision: new CollisionWorld() } };
}
it('uses right-hand lanes and recorded direction/access bits for both rider kinds', () => {
	for (const kind of ['bicycle', 'motorbike'] as const) {
		const { payload, city } = world({ ...road, af: 4, ab: 0 });
		const routes = nearbyTrafficRoutes([payload], 50, 8, kind, city);
		if (kind === 'bicycle') expect(routes).toEqual([]);
		else {
			expect(routes).toHaveLength(1);
			const p = lanePosition(routes[0], 10);
			expect(p.x).toBeCloseTo(10);
			expect(p.z).toBeCloseTo(2);
		}
	}
	const { payload, city } = world({ ...road, af: 0, ab: 4 });
	const route = nearbyTrafficRoutes([payload], 50, 8, 'motorbike', city)[0];
	expect(lanePosition(route, 10).x).toBeCloseTo(90);
	expect(lanePosition(route, 10).z).toBeCloseTo(-2);
});
it('rejects building/water obstacles, bridges and raised roads', () => {
	const { payload, city } = world(road);
	city.collision.addRing(
		'water',
		[
			[40, -5],
			[60, -5],
			[60, 5],
			[40, 5]
		],
		0
	);
	expect(nearbyTrafficRoutes([payload], 50, 8, 'motorbike', city)).toEqual([]);
	for (const r of [
		{ ...road, bridge: true },
		{ ...road, layer: 1 }
	]) {
		const w = world(r);
		expect(nearbyTrafficRoutes([w.payload], 50, 8, 'motorbike', w.city)).toEqual([]);
	}
});
it('brakes for players in the upcoming corridor but not those standing clear of it', () => {
	expect(playerAhead([0, 0], [0, 6], [0, 4])).toBe(true);
	expect(playerAhead([0, 0], [0, 6], [3, 4])).toBe(false);
	expect(playerAhead([0, 0], [0, 6], [0, -3])).toBe(false);
});

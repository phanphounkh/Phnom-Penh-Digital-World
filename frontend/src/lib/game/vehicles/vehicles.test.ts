import { describe, expect, it } from 'vitest';
import type { ChunkPayload } from '$lib/api/types';
import fixture from './specs.fixture.json';
import { pursuitSteer, rideState, rideStep, steerLimit } from './kinematics';
import { RoadNetwork } from './RoadNetwork';
import { RouteGuide, lanePath, laneOffset, offsetLine, stepText, type Route } from './route';
import { BITS, KERB_BAND_M, MODES, RIDE_MARGIN_M } from './specs';

describe('specs', () => {
	it('mirror the server (shared fixture written from app/transport/specs.py)', () => {
		expect(BITS).toEqual({ foot: 1, bicycle: 2, motorbike: 4, car: 8 });
		expect(MODES.motorbike.topSpeed).toBe(fixture.modes.motorbike.top_speed);
		expect(MODES.bicycle.bit).toBe(2);
		// The server tolerates more than the client stops at, so honest riders are never corrected.
		expect(RIDE_MARGIN_M).toBeLessThan(2.75);
	});
});

describe('riding physics', () => {
	it('accelerates to the top speed and no further', () => {
		const s = rideState();
		for (let i = 0; i < 400; i++) rideStep('motorbike', s, { throttle: 1, steer: 0 }, 0.05);
		expect(s.speed).toBeCloseTo(MODES.motorbike.topSpeed, 1);
		const bike = rideState();
		for (let i = 0; i < 400; i++) rideStep('bicycle', bike, { throttle: 1, steer: 0 }, 0.05);
		expect(bike.speed).toBeLessThanOrEqual(MODES.bicycle.topSpeed + 1e-9);
	});

	it('brakes, then reverses slowly (motorbike) or not at all (bicycle)', () => {
		const s = { ...rideState(), speed: 10 };
		for (let i = 0; i < 60; i++) rideStep('motorbike', s, { throttle: -1, steer: 0 }, 0.05);
		expect(s.speed).toBeLessThan(0);
		expect(s.speed).toBeGreaterThanOrEqual(-1.2);
		const b = { ...rideState(), speed: 5 };
		for (let i = 0; i < 60; i++) rideStep('bicycle', b, { throttle: -1, steer: 0 }, 0.05);
		expect(b.speed).toBe(0);
	});

	it('steering right turns clockwise (yaw decreases) and leans into the turn', () => {
		const s = { ...rideState(), speed: 6 };
		let yaw = 0;
		for (let i = 0; i < 20; i++) yaw += rideStep('motorbike', s, { throttle: 0.3, steer: 1 }, 0.05).dyaw;
		expect(yaw).toBeLessThan(-0.3);
		expect(s.lean).toBeGreaterThan(0.05);
		expect(steerLimit('motorbike', 12)).toBeLessThan(steerLimit('motorbike', 1));
	});

	it('pure pursuit steers towards the target', () => {
		// Facing +z (yaw 0); a target ahead and to the right (-x, since right of +z is -x).
		expect(pursuitSteer('motorbike', 5, 0, -3, 10)).toBeGreaterThan(0);
		expect(pursuitSteer('motorbike', 5, 0, 3, 10)).toBeLessThan(0);
		expect(pursuitSteer('motorbike', 5, 0, 0, 10)).toBeCloseTo(0);
	});
});

function chunk(roads: Partial<ChunkPayload['roads'][number]>[], areas: ChunkPayload['areas'] = []): ChunkPayload {
	return {
		key: '0_0', ix: 0, iz: 0, size: 200, buildings: [], landmarks: [], features: [], areas,
		roads: roads.map((r) => ({ id: 1, name: 'Street 13', name_km: 'ផ្លូវ១៣', cls: 'primary', w: 14, oneway: false, bridge: false, layer: 0, af: 15, ab: 15, pts: [[0, 0], [100, 0]], ...r }))
	};
}

describe('road network (riding and parking rules)', () => {
	const net = new RoadNetwork();
	net.sync(
		[
			chunk(
				[
					{}, // a 14 m primary along z = 0, x 0 → 100
					{ name: 'Alley', cls: 'footway', w: 2.5, af: 3, ab: 3, pts: [[0, 40], [100, 40]] },
					{ name: 'Street 108', cls: 'tertiary', w: 9, oneway: true, af: 15, ab: 1, pts: [[0, -60], [100, -60]] }
				],
				[{ kind: 'parking', name: null, polys: [[[[40, 15], [60, 15], [60, 30], [40, 30]]]] }]
			)
		],
		1
	);
	const MOTO = BITS.motorbike,
		BIKE = BITS.bicycle;

	it('lets vehicles ride on the carriageway and pavement only, by mode', () => {
		expect(net.allows(MOTO, 50, 0)).toBe(true);
		expect(net.allows(MOTO, 50, 7 + RIDE_MARGIN_M - 0.1)).toBe(true); // the pavement
		expect(net.allows(MOTO, 50, 7 + RIDE_MARGIN_M + 0.3)).toBe(false); // beyond it
		expect(net.allows(MOTO, 50, 40)).toBe(false); // a footway
		expect(net.allows(BIKE, 50, 40)).toBe(true); // bicycles may use it
		expect(net.allows(MOTO, 50, 20)).toBe(true); // a car park
	});

	it('allows parking at the kerb and in car parks, not mid-road', () => {
		expect(net.parkable(MOTO, 50, 0)).toBe(false);
		expect(net.parkable(MOTO, 50, 7 - KERB_BAND_M + 0.6)).toBe(true);
		expect(net.parkable(MOTO, 50, 22)).toBe(true);
		const spot = net.nearestParkable(MOTO, 50, 1, 6)!;
		expect(spot).not.toBeNull();
		expect(Math.abs(spot[1])).toBeGreaterThan(7 - KERB_BAND_M);
		// Another vehicle already there: the next free spot is found instead.
		const taken = (x: number, z: number) => Math.hypot(x - spot[0], z - spot[1]) > 1.3;
		const other = net.nearestParkable(MOTO, 50, 1, 6, taken)!;
		expect(Math.hypot(other[0] - spot[0], other[1] - spot[1])).toBeGreaterThan(1.3);
	});

	it('knows one-way streets and the wrong way', () => {
		// Allowed direction is +x (yaw = π/2 faces +x).
		expect(net.oneWayAt(MOTO, 50, -60, Math.PI / 2)).toMatchObject({ against: false });
		expect(net.oneWayAt(MOTO, 50, -60, -Math.PI / 2)).toMatchObject({ against: true });
		expect(net.oneWayAt(BITS.foot, 50, -60, -Math.PI / 2)).toBeNull(); // pedestrians: two-way
		expect(net.oneWayAt(MOTO, 50, 0, 0)).toBeNull();
		expect(net.roadAt(50, 1)?.name).toBe('Street 13');
	});

	it('drops unloaded chunks', () => {
		const n = new RoadNetwork();
		n.sync([chunk([{}])], 1);
		expect(n.allows(MOTO, 50, 0)).toBe(true);
		n.sync([], 2);
		expect(n.allows(MOTO, 50, 0)).toBe(false);
	});
});

describe('route guidance', () => {
	const route: Route = {
		mode: 'motorbike',
		distance_m: 150,
		duration_s: 20,
		from: { x: 0, z: 0, off_road_m: 2 },
		to: { x: 100, z: 50, off_road_m: 1 },
		points: [[0, 0], [100, 0], [100, 50]],
		segments: [
			{ edge: 1, pts: [[0, 0], [100, 0]], length_m: 100, w: 12, cls: 'primary', oneway: false, street: 'Street 13', street_km: null, speed_kmh: 40 },
			{ edge: 2, pts: [[100, 0], [100, 50]], length_m: 50, w: 9, cls: 'tertiary', oneway: true, street: 'Street 108', street_km: null, speed_kmh: null }
		],
		steps: [
			{ type: 'depart', street: 'Street 13', street_km: null, bearing: 90, x: 0, z: 0, at_m: 0, distance_m: 100 },
			{ type: 'right', street: 'Street 108', street_km: null, bearing: 180, x: 100, z: 0, at_m: 100, distance_m: 50 },
			{ type: 'arrive', street: 'Street 108', street_km: null, bearing: 180, x: 100, z: 50, at_m: 150, distance_m: 0 }
		]
	};

	it('keeps to the right-hand lane (Cambodia drives on the right)', () => {
		// Travelling +x, the right-hand side is +z (right of (1, 0) is (-0, 1)).
		const [p] = offsetLine([[0, 0], [10, 0]], 3);
		expect(p).toEqual([0, 3]);
		expect(laneOffset('motorbike', { w: 12, cls: 'primary', oneway: false })).toBe(3);
		expect(laneOffset('motorbike', { w: 9, cls: 'tertiary', oneway: true })).toBeCloseTo(2.8);
		expect(laneOffset('foot', { w: 12, cls: 'primary', oneway: false })).toBeCloseTo(6.8);
		expect(laneOffset('foot', { w: 3, cls: 'footway', oneway: false })).toBe(0);
		const path = lanePath(route);
		expect(path[0][1]).toBeCloseTo(3);
		expect(path[path.length - 1][0]).toBeCloseTo(100 - 2.8); // travelling +z, right is -x
	});

	it('tracks progress and announces the next turn', () => {
		const guide = new RouteGuide(route);
		const p = guide.progress(40, 2);
		expect(p.along).toBeCloseTo(40);
		expect(p.next?.type).toBe('right');
		expect(p.toNext).toBeCloseTo(60);
		expect(stepText(p.next!)).toBe('Turn right onto Street 108');
		expect(guide.progress(101, 48).arrived).toBe(true);
	});
});

describe('path follower', () => {
	it('projects forward, looks ahead and measures bends', async () => {
		const { PathFollower } = await import('./route');
		const f = new PathFollower([[0, 0], [50, 0], [50, 50]]);
		expect(f.length).toBe(100);
		expect(f.project(20, 1).along).toBeCloseTo(20);
		expect(f.pointAt(60)).toEqual([50, 10]);
		expect(f.bendAhead(10, 15)).toBeLessThan(0.05);
		expect(f.bendAhead(40, 25)).toBeCloseTo(Math.PI / 2, 1);
	});
});

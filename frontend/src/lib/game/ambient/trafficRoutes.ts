/** Local ambient riders use the existing road widths, access bits and right-hand lane offsets. */
import type { ChunkPayload, XZ } from '$lib/api/types';
import type { CityController } from '$lib/game/city/CityEngine';
import { moveCircle } from '$lib/game/city/collision';
import { laneOffset, offsetLine } from '$lib/game/vehicles/route';
import { BITS, type VehicleKind } from '$lib/game/vehicles/specs';
export interface TrafficRoute {
	key: string;
	points: XZ[];
	cumulative: number[];
	length: number;
	speed: number;
}
export function trafficRoute(key: string, points: XZ[], speed: number): TrafficRoute {
	const cumulative = [0];
	for (let i = 1; i < points.length; i++)
		cumulative.push(cumulative[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
	return { key, points, cumulative, length: cumulative.at(-1) ?? 0, speed };
}
export function lanePosition(route: TrafficRoute, along: number): { x: number; z: number; yaw: number } {
	along = Math.max(0, Math.min(route.length, along));
	let i = 1;
	while (i < route.cumulative.length - 1 && route.cumulative[i] < along) i++;
	const a = route.points[i - 1],
		b = route.points[i],
		len = route.cumulative[i] - route.cumulative[i - 1],
		t = len ? (along - route.cumulative[i - 1]) / len : 0;
	return {
		x: a[0] + (b[0] - a[0]) * t,
		z: a[1] + (b[1] - a[1]) * t,
		yaw: Math.atan2(b[0] - a[0], b[1] - a[1])
	};
}
export function laneClear(
	points: XZ[],
	kind: VehicleKind,
	city: Pick<CityController, 'collision' | 'network'>
): boolean {
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1],
			b = points[i],
			steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2));
		for (let k = 0; k <= steps; k++) {
			const x = a[0] + ((b[0] - a[0]) * k) / steps,
				z = a[1] + ((b[1] - a[1]) * k) / steps;
			if (!city.network.allows(BITS[kind], x, z, 0.1) || city.collision.containing(x, z)) return false;
			const p = moveCircle(city.collision, x, z, 0, 0, 0.6);
			if (Math.hypot(p.x - x, p.z - z) > 0.01) return false;
		}
	}
	return true;
}
export function nearbyTrafficRoutes(
	payloads: ChunkPayload[],
	x: number,
	z: number,
	kind: VehicleKind,
	city: Pick<CityController, 'collision' | 'network'>
): TrafficRoute[] {
	const seen = new Set<string>(),
		routes: TrafficRoute[] = [];
	for (const chunk of payloads)
		for (const road of chunk.roads) {
			if (
				road.bridge ||
				road.layer !== 0 ||
				road.w < 5 ||
				!['residential', 'tertiary', 'secondary', 'primary', 'unclassified'].includes(road.cls)
			)
				continue;
			for (const direction of [1, -1]) {
				if (((direction === 1 ? (road.af ?? 15) : (road.ab ?? 15)) & BITS[kind]) === 0) continue;
				const original = direction === 1 ? road.pts : [...road.pts].reverse();
				if (original.length < 2) continue;
				const key = `${kind}:${road.id}:${original[0].join(',')}:${original.at(-1)!.join(',')}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const points = offsetLine(original, laneOffset(kind, { w: road.w, cls: road.cls, oneway: road.oneway }));
				const route = trafficRoute(
					key,
					points,
					Math.min(kind === 'motorbike' ? 4.2 : 2.6, road.vmax && road.vmax > 0 ? road.vmax / 3.6 : 10)
				);
				if (route.length < 30 || route.length > 400) continue;
				let nearest = Infinity;
				for (let at = 0; at <= route.length; at += 5) {
					const p = lanePosition(route, at);
					nearest = Math.min(nearest, Math.hypot(x - p.x, z - p.z));
				}
				if (nearest < 45) routes.push(route);
			}
		}
	return routes
		.sort(
			(a, b) => Math.hypot(a.points[0][0] - x, a.points[0][1] - z) - Math.hypot(b.points[0][0] - x, b.points[0][1] - z)
		)
		.slice(0, 12)
		.filter((r) => laneClear(r.points, kind, city));
}
export function playerAhead(from: XZ, to: XZ, player: XZ, radius = 1.5): boolean {
	const dx = to[0] - from[0],
		dz = to[1] - from[1],
		length = dx * dx + dz * dz;
	const t = length ? Math.max(0, Math.min(1, ((player[0] - from[0]) * dx + (player[1] - from[1]) * dz) / length)) : 0;
	return Math.hypot(player[0] - from[0] - t * dx, player[1] - from[1] - t * dz) < radius;
}

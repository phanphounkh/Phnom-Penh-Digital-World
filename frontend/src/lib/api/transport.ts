/** Transport endpoints (Phase 5): the garage, routes on the real streets, road positions. */
import type { Route } from '$lib/game/vehicles/route';
import type { TravelMode, VehicleKind } from '$lib/game/vehicles/specs';
import { api } from './client';

export interface Vehicle {
	id: string;
	kind: VehicleKind;
	name: string;
	color: string;
	plate: string;
	status: 'parked' | 'in_use';
	x: number;
	z: number;
	yaw: number;
	street: string | null;
	street_km: string | null;
	odometer_m: number;
	parked_at: string | null;
	created_at: string;
}

export interface RoadPosition {
	edge_id: number;
	road_id: number;
	along_m: number;
	length_m: number;
	x: number;
	z: number;
	bearing: number;
	distance_m: number;
	street: string | null;
	street_km: string | null;
	highway: string;
	width_m: number;
	modes_forward: number;
	modes_backward: number;
	max_speed_kmh: number | null;
}

export const VEHICLE_COLORS = ['#c4552f', '#2f7d6d', '#e8a33d', '#3d6fb6', '#1d2422', '#f6f1e6', '#6b4fa0', '#d6627a'];

export const transport = {
	vehicles: () => api<Vehicle[]>('/vehicles'),
	create: (kind: VehicleKind, color?: string, name?: string) =>
		api<Vehicle>('/vehicles', { method: 'POST', body: { kind, color, name } }),
	update: (id: string, body: { name?: string; color?: string }) =>
		api<Vehicle>(`/vehicles/${id}`, { method: 'PATCH', body }),
	summon: (id: string) => api<Vehicle>(`/vehicles/${id}/summon`, { method: 'POST' }),
	remove: (id: string) => api<void>(`/vehicles/${id}`, { method: 'DELETE' }),
	route: (from: [number, number], to: [number, number], mode: TravelMode, signal?: AbortSignal) =>
		api<Route>('/routes', {
			query: { from_x: from[0].toFixed(2), from_z: from[1].toFixed(2), to_x: to[0].toFixed(2), to_z: to[1].toFixed(2), mode },
			signal
		}),
	snap: (x: number, z: number, mode: TravelMode) => api<RoadPosition>('/roads/snap', { query: { x, z, mode } })
};

/**
 * Where enterable buildings stand (world metres: x east, z = -north). Each one is a model made by
 * tools/blender/generate_house.py; add more entries (or other models) to place more buildings.
 *
 * The riverside house sits on open, unmapped land 25 m north-west of the Riverside spawn point,
 * clear of OSM buildings, roads, trees and park shrubs (checked against the loaded chunk data),
 * with its front door facing the Tonle Sap (east).
 */
import type { BuildingPlacement } from './spec';
import type { InteriorType } from './osm';

/** The System Office: an OSM building (buildings.id, the same in every import). */
export const SYSTEM_OFFICE_ID = 1518;
/** Its front door (world metres, from its plan's facade): where directions lead. */
export const SYSTEM_OFFICE_DOOR = { x: 16.7, z: 107.9, label: 'System Office' };

export const PLACEMENTS: BuildingPlacement[] = [
	{ id: 'riverside-house', spec: '/models/buildings/house-riverside.json', x: 1005, z: -70, yaw: Math.PI / 2 }
];

/**
 * Real OpenStreetMap buildings with a fixed interior type and name (by building id); every other
 * eligible building opens in auto mode below. See footprint.ts for which buildings qualify
 * (`__ppwBuildings.scan(x, z)` in the browser lists the eligible ones near a point).
 */
export const ENTERABLE: { id: number; type: InteriorType; name?: string }[] = [
	// Sisowath Quay, across the road from the Riverside spawn (unnamed buildings in OSM; named
	// ones, such as the hotels next door, are left as they are).
	{ id: 308, type: 'cafe', name: 'Riverside Café' },
	{ id: 1683, type: 'shop', name: 'Quay Mini-mart' },
	{ id: 1635, type: 'house', name: 'House' },
	// The System Office, where players register a work role (seller or driver): 30 m south of the
	// Central Market spawn. The server checks players are at it (backend
	// app/multiplayer/buildings.py SYSTEM_OFFICE: keep the two in step).
	{ id: SYSTEM_OFFICE_ID, type: 'office', name: 'System Office' }
];

/** Auto mode: every eligible building near the player gets an interior (a home, shop or café by
 * its OSM kind), only the `max` nearest within `radius` at a time, built as the player comes
 * near and freed as they leave. */
export const AUTO_ENTERABLE = { enabled: true, radius: 45, max: 8 };

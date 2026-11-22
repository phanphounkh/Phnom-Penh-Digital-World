/**
 * Where enterable buildings stand (world metres: x east, z = -north). Each one is a model made by
 * tools/blender/generate_house.py; add more entries (or other models) to place more buildings.
 *
 * The riverside house sits on open, unmapped land 25 m north-west of the Riverside spawn point,
 * clear of OSM buildings, roads, trees and park shrubs (checked against the loaded chunk data),
 * with its front door facing the Tonle Sap (east).
 */
import type { BuildingPlacement } from './spec';

export const PLACEMENTS: BuildingPlacement[] = [
	{ id: 'riverside-house', spec: '/models/buildings/house-riverside.json', x: 1005, z: -70, yaw: Math.PI / 2 }
];

/**
 * Real OpenStreetMap buildings with a fixed interior type and name (by building id); every other
 * eligible building opens in auto mode below. See footprint.ts for which buildings qualify
 * (`__ppwBuildings.scan(x, z)` in the browser lists the eligible ones near a point).
 */
export const ENTERABLE: { id: number; type: 'house' | 'shop' | 'cafe'; name?: string }[] = [
	// Sisowath Quay, across the road from the Riverside spawn (unnamed buildings in OSM; named
	// ones, such as the hotels next door, are left as they are).
	{ id: 308, type: 'cafe', name: 'Riverside Café' },
	{ id: 1683, type: 'shop', name: 'Quay Mini-mart' },
	{ id: 1635, type: 'house', name: 'House' }
];

/** Auto mode: every eligible building near the player gets an interior (a home, shop or café by
 * its OSM kind), only the `max` nearest within `radius` at a time, built as the player comes
 * near and freed as they leave. */
export const AUTO_ENTERABLE = { enabled: true, radius: 45, max: 8 };

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

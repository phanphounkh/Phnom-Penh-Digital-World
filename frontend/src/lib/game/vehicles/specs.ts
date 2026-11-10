/**
 * Travel modes and vehicle types: a mirror of backend/app/transport/specs.py. The shared
 * `specs.fixture.json` (written from the Python values) is compared in specs.test.ts and in the
 * backend's test_transport.py, so the two can never drift apart silently.
 */
import fixture from './specs.fixture.json';

export type VehicleKind = 'bicycle' | 'motorbike';
export type TravelMode = 'foot' | VehicleKind;

export const BITS = fixture.bits as { foot: number; bicycle: number; motorbike: number; car: number };

export interface ModeSpec {
	mode: TravelMode;
	bit: number;
	label: string;
	labelKm: string;
	/** Fastest the client moves in this mode (m/s). */
	topSpeed: number;
	/** Used for travel-time estimates (m/s). */
	cruiseSpeed: number;
	/** Collision radius (m). */
	radius: number;
	parkingSpacing: number;
}

const LABELS: Record<TravelMode, [string, string]> = {
	foot: ['On foot', 'ដើរ'],
	bicycle: ['Bicycle', 'កង់'],
	motorbike: ['Motorbike', 'ម៉ូតូ']
};

export const MODES = Object.fromEntries(
	(Object.keys(fixture.modes) as TravelMode[]).map((mode) => {
		const m = fixture.modes[mode];
		return [
			mode,
			{
				mode,
				bit: BITS[mode],
				label: LABELS[mode][0],
				labelKm: LABELS[mode][1],
				topSpeed: m.top_speed,
				cruiseSpeed: m.cruise_speed,
				radius: m.radius,
				parkingSpacing: m.parking_spacing
			} satisfies ModeSpec
		];
	})
) as Record<TravelMode, ModeSpec>;

export const VEHICLE_KINDS: VehicleKind[] = ['bicycle', 'motorbike'];
export const MOUNT_RANGE_M = fixture.mount_range_m;
/** Riders are stopped this far beyond the carriageway edge (the server allows a little more). */
export const RIDE_MARGIN_M = fixture.ride_margin_client_m;
/** Parking is allowed in the outer band of a through road's carriageway (and beyond). */
export const KERB_BAND_M = fixture.kerb_band_m;
/** How far the server looks for a legal spot when you park ("pulling over"). */
export const PULL_OVER_M = fixture.pull_over_m;

/** Handling per vehicle (client-side feel; the server only checks the top speed). */
export interface Handling {
	accel: number; // m/s² at full throttle
	brake: number; // m/s² braking
	drag: number; // 1/s rolling + air drag when coasting
	reverse: number; // max reverse speed (m/s)
	wheelbase: number; // m
	maxSteer: number; // rad at low speed
	steerRate: number; // rad/s the bars turn
	wheelRadius: number; // m (for wheel spin)
	maxLean: number; // rad, visual lean in turns
}

export const HANDLING: Record<VehicleKind, Handling> = {
	bicycle: { accel: 1.6, brake: 4.5, drag: 0.12, reverse: 0, wheelbase: 1.05, maxSteer: 0.6, steerRate: 2.4, wheelRadius: 0.33, maxLean: 0.38 },
	motorbike: { accel: 3.4, brake: 6.5, drag: 0.08, reverse: 1.2, wheelbase: 1.24, maxSteer: 0.55, steerRate: 2.2, wheelRadius: 0.29, maxLean: 0.5 }
};

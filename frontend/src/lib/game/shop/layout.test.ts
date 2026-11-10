import { describe, expect, it } from 'vitest';
import type { ShopUnitWorld } from '$lib/api/market';

import { doorway, frameOf, interiorLayout, isInside, toLocal, toWorld, yawFacing } from './layout';

const same = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-6;

// A unit facing south onto a street at z < 0: front edge along x from (10,0) to (16,0),
// extending 8 m north... in world z terms "inward" is +z here.
const UNIT: ShopUnitWorld = {
	code: 'DP-0001',
	corners: [[10, 0], [16, 0], [16, 8], [10, 8]],
	door_x: 13,
	door_z: 0,
	heading: Math.PI, // facing -z (the street)
	width_m: 6,
	depth_m: 8,
	ceiling_m: 3.6,
	street_name: 'Street 136'
};

describe('shop layout', () => {
	const f = frameOf(UNIT);

	it('places the frame at the middle of the street wall, pointing inwards', () => {
		expect([f.ox, f.oz]).toEqual([13, 0]);
		expect([f.nx, f.nz]).toEqual([0, 1]);
		expect(same(f.outYaw, UNIT.heading)).toBe(true);
		expect(toWorld(f, 3, 8)).toEqual([16, 8]);
		expect(toLocal(f, 16, 8)).toEqual([3, 8]);
	});

	it('knows inside from outside', () => {
		expect(isInside(f, 13, 4)).toBe(true);
		expect(isInside(f, 13, -1)).toBe(false);
		expect(isInside(f, 13, -1, 1.5)).toBe(true);
		expect(isInside(f, 20, 4)).toBe(false);
	});

	it('cuts a 5 m doorway centred in the 6 m frontage', () => {
		const d = doorway(f);
		expect([d.ax, d.az, d.bx, d.bz]).toEqual([10.5, 0, 15.5, 0]);
	});

	it('keeps every display slot, the counter and the cart inside the unit', () => {
		const layout = interiorLayout(f);
		expect(layout.slots.length).toBe(4 * 3 * 4 + 6);
		for (const p of [...layout.slots, layout.counter, layout.cart, layout.table]) {
			const [x, z] = toWorld(f, p.a, p.n);
			expect(isInside(f, x, z)).toBe(true);
		}
		// Shelves face the aisle; the counter faces the door.
		expect(layout.shelves[0].fa).toBe(1);
		expect(same(yawFacing(f, 0, -1), f.outYaw)).toBe(true);
	});
});

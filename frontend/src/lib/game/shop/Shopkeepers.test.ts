import { describe, expect, it } from 'vitest';
import { faceToward, hash, keeperFor, planKeepers, turnTowards } from './Shopkeepers';

const shop = (id: string) => ({ id, accent_color: '#e8a33d' });

describe('keeperFor', () => {
	it('gives a shop the same shopkeeper every time (every player sees the same person)', () => {
		const id = '3f9a1c2e-8d4b-4c7e-9a10-5b6c7d8e9f01';
		expect(keeperFor(shop(id))).toEqual(keeperFor(shop(id)));
	});

	it('varies between shops: both bodies and several names', () => {
		const keepers = Array.from({ length: 40 }, (_, i) => keeperFor(shop(`shop-${i}`)));
		expect(new Set(keepers.map((k) => k.avatar.body))).toEqual(new Set(['a', 'b']));
		expect(new Set(keepers.map((k) => k.name)).size).toBeGreaterThan(6);
		expect(new Set(keepers.map((k) => k.avatar.skin_tone)).size).toBeGreaterThan(3);
	});

	it('is a complete avatar, its name matching the body, in the shop’s accent colour', () => {
		for (let i = 0; i < 20; i++) {
			const k = keeperFor(shop(`s${i}`));
			expect(k.avatar.avatar_name).toBe(k.name);
			expect(k.avatar.accent_color).toBe('#e8a33d');
			expect(k.avatar.accessories).toEqual([]); // no backpack behind the counter
			expect(k.avatar.model).toBe('outfit');
			expect(['tee', 'shirt']).toContain(k.avatar.top_style);
			expect(['a', 'b']).toContain(k.avatar.body);
			for (const key of ['skin_tone', 'hair_color', 'top_color', 'bottom_color', 'shoe_color'] as const)
				expect(k.avatar[key]).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	it('hashes strings to stable unsigned numbers', () => {
		expect(hash('a')).toBe(hash('a'));
		expect(hash('a')).not.toBe(hash('b'));
		expect(hash('anything')).toBeGreaterThanOrEqual(0);
	});
});

describe('turning to face a customer', () => {
	it('looks at the customer, but not further round than the limit from the door', () => {
		expect(faceToward(0, 0.5, 1.3)).toBeCloseTo(0.5);
		expect(faceToward(0, 2.5, 1.3)).toBeCloseTo(1.3);
		expect(faceToward(0, -2.5, 1.3)).toBeCloseTo(-1.3);
		// Across ±π: the short way.
		expect(faceToward(3, -3, 1.3)).toBeCloseTo(3 + (2 * Math.PI - 6));
	});

	it('turns at a limited speed, the short way round', () => {
		expect(turnTowards(0, 1, 0.25)).toBeCloseTo(0.25);
		expect(turnTowards(0, -1, 0.25)).toBeCloseTo(-0.25);
		expect(turnTowards(0.9, 1, 0.25)).toBe(1);
		expect(turnTowards(3.1, -3.1, 0.05)).toBeCloseTo(3.15);
	});
});

describe('which shops have a shopkeeper', () => {
	const post = (id: string, distance: number, open = true) => ({ id, open, distance });

	it('puts them at the nearest open shops within reach, at most two', () => {
		const plan = planKeepers([post('far', 29), post('near', 5), post('mid', 12), post('closed', 2, false), post('out', 31)], []);
		expect(plan).toEqual({ add: ['near', 'mid'], remove: [] });
	});

	it('keeps one standing a little beyond reach, and lets it go further out', () => {
		expect(planKeepers([post('a', 35)], ['a'])).toEqual({ add: [], remove: [] });
		expect(planKeepers([post('a', 41)], ['a'])).toEqual({ add: [], remove: ['a'] });
		expect(planKeepers([post('a', 5, false)], ['a'])).toEqual({ add: [], remove: ['a'] });
		expect(planKeepers([], ['gone'])).toEqual({ add: [], remove: ['gone'] });
	});

	it('gives a farther one’s place to the shop the player walks into', () => {
		// Walked past a and b (both still near), now in c.
		const plan = planKeepers([post('a', 18), post('b', 14), post('c', 1)], ['a', 'b']);
		expect(plan).toEqual({ add: ['c'], remove: ['a'] });
	});

	it('does not swap for a shop only slightly nearer (no flicker at the edge)', () => {
		expect(planKeepers([post('a', 20), post('b', 19), post('c', 18.5)], ['a', 'b'])).toEqual({ add: [], remove: [] });
	});
});

describe('fewer shopkeepers on the low graphics setting', () => {
	const post = (id: string, distance: number) => ({ id, open: true, distance });
	it('keeps only the nearest when the limit drops to one', () => {
		expect(planKeepers([post('a', 4), post('b', 12)], ['a', 'b'], 1)).toEqual({ add: [], remove: ['b'] });
		expect(planKeepers([post('a', 4), post('b', 12)], [], 1)).toEqual({ add: ['a'], remove: [] });
	});
});

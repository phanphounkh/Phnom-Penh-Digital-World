import { describe, expect, it } from 'vitest';
import type { Avatar } from '$lib/api/types';
import { CLOTH_COLORS, DEFAULT_AVATAR, HAIR_COLORS, SKIN_TONES } from './avatar';
import { CATEGORIES, MAX_EXTRAS, describe as wearing, wheels } from './wardrobe';

const base: Avatar = { ...DEFAULT_AVATAR, accessories: [] };

describe('the wardrobe', () => {
	it('every category has wheels whose value is one of their choices', () => {
		for (const c of CATEGORIES) {
			const list = wheels(c.id, base);
			expect(list.length).toBeGreaterThan(0);
			for (const w of list) {
				expect(w.choices.map((x) => x.id)).toContain(w.value);
				expect(new Set(w.choices.map((x) => x.id)).size).toBe(w.choices.length);
				expect(w.choices.every((x) => x.label && !x.label.startsWith('#'))).toBe(true);
			}
		}
	});

	it('turning a wheel gives a new avatar and leaves the old one as it was', () => {
		const [item, colour] = wheels('top', base);
		const hoodie = item.pick(base, 'hoodie');
		expect(hoodie.top_style).toBe('hoodie');
		expect(base.top_style).not.toBe('hoodie');
		const saffron = colour.pick(hoodie, '#e8a33d');
		expect(saffron).toMatchObject({ top_style: 'hoodie', top_color: '#e8a33d' });
		expect(wearing('top', saffron)).toBe('Saffron hoodie');
		expect(wheels('top', saffron)[0].value).toBe('hoodie');
	});

	it('hair, body, bottom and shoes wheels change their own fields', () => {
		const [style, colour] = wheels('hair', base);
		expect(colour.pick(style.pick(base, 'bun'), HAIR_COLORS[4])).toMatchObject({ hair_style: 'bun', hair_color: HAIR_COLORS[4] });
		const [build, skin] = wheels('body', base);
		expect(skin.pick(build.pick(base, 'b'), SKIN_TONES[5])).toMatchObject({ body: 'b', skin_tone: SKIN_TONES[5] });
		expect(wheels('bottom', base)[0].pick(base, 'shorts').bottom_style).toBe('shorts');
		expect(wheels('shoes', base)[0].pick(base, '#3d6fb6').shoe_color).toBe('#3d6fb6');
		expect(wearing('shoes', { ...base, shoe_color: '#3d6fb6' })).toBe('Blue shoes');
	});

	it('extras go on and off, share one colour, and stop at the limit', () => {
		const [hat, hatColour] = wheels('hat', base);
		expect(hat.value).toBe('none');
		const capped = hat.pick(base, 'cap');
		expect(capped.accessories).toEqual(['cap']);
		expect(wearing('hat', capped)).toMatch(/^[A-Z][a-z]+ cap$/); // its colour, then the item
		expect(hatColour.pick(capped, CLOTH_COLORS[3]).accent_color).toBe(CLOTH_COLORS[3]);
		expect(wheels('hat', capped)[0].pick(capped, 'none').accessories).toEqual([]);
		expect(wheels('glasses', base)).toHaveLength(1); // glasses have no colour

		const full: Avatar = { ...base, accessories: ['glasses', 'backpack', 'krama'] };
		expect(MAX_EXTRAS).toBe(3);
		const blocked = wheels('hat', full)[0];
		expect(blocked.choices.find((c) => c.id === 'cap')?.blocked).toMatch(/take one off/);
		expect(blocked.pick(full, 'cap').accessories).toEqual(full.accessories); // never a fourth
		expect(wheels('bag', full)[0].choices.every((c) => !c.blocked)).toBe(true); // ones worn stay free
		expect(wearing('hat', full)).toBe('No hat');
	});
});
